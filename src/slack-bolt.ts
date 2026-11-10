import { App, LogLevel } from "@slack/bolt";

import type { Mention } from "./mention-handler";

import { log } from "./log";
import { SlackUserNotFoundError, type SlackFile, type SlackPort, type ThreadMessage } from "./slack-port";

export interface SlackConfig {
    botToken: string;
    /** App-level token (xapp-…) with `connections:write`, for Socket Mode. */
    appToken: string;
    /** Channel for operational alerts (e.g. the T3 token can't be renewed). */
    adminChannel?: string;
}

export interface SlackConnection {
    port: SlackPort;
    botUserId: string;
    workspaceTeamId: string;
    /** Posts an operational alert in the admin channel (logged only when none is set). */
    alertAdmin(text: string): Promise<void>;
    /** Starts receiving `app_mention` events and 1:1 direct messages. */
    start(onMention: (mention: Mention) => Promise<void>): Promise<void>;
    stop(): Promise<void>;
}

const HISTORY_PAGE_SIZE = 200;
const HISTORY_MAX_PAGES = 5;

/** Slack over Bolt in Socket Mode: no public URL, the app dials out to Slack. */
export async function connectSlack(config: SlackConfig): Promise<SlackConnection> {
    const app = new App({
        token: config.botToken,
        appToken: config.appToken,
        socketMode: true,
        logLevel: LogLevel.WARN,
    });
    const auth = await app.client.auth.test();
    if (!auth.user_id || !auth.team_id) throw new Error("Slack auth.test returned no bot user or team");

    const port: SlackPort = {
        async getUser(userId) {
            const { user } = await app.client.users.info({ user: userId }).catch((error: unknown) => {
                if (slackErrorCode(error) === "user_not_found") throw new SlackUserNotFoundError(userId);
                throw error;
            });
            if (!user?.id || !user.team_id) throw new SlackUserNotFoundError(userId);
            return {
                id: user.id,
                name: user.profile?.display_name || user.real_name || user.name || user.id,
                teamId: user.team_id,
                isBot: user.is_bot ?? false,
                isRestricted: user.is_restricted ?? false,
                isUltraRestricted: user.is_ultra_restricted ?? false,
                isStranger: user.is_stranger ?? false,
            };
        },

        async postMessage({ channel, threadTs, text }) {
            const result = await app.client.chat.postMessage({
                channel,
                thread_ts: threadTs,
                text,
                unfurl_links: false,
                unfurl_media: false,
            });
            if (!result.ts) throw new Error("Slack chat.postMessage returned no ts");
            return { ts: result.ts };
        },

        async deleteMessage({ channel, ts }) {
            await app.client.chat.delete({ channel, ts });
        },

        // conversations.replies pages from the oldest message, so read the whole
        // thread (bounded) and keep the most recent messages.
        async getThreadHistory({ channel, threadTs, limit }) {
            const messages: ThreadMessage[] = [];
            let cursor: string | undefined;
            for (let page = 0; page < HISTORY_MAX_PAGES; page++) {
                const result = await app.client.conversations.replies({
                    channel,
                    ts: threadTs,
                    limit: HISTORY_PAGE_SIZE,
                    cursor,
                });
                for (const message of result.messages ?? []) {
                    if (!message.ts) continue;
                    messages.push({
                        userId: message.user ?? message.bot_id ?? "unknown",
                        text: message.text ?? "",
                        ts: message.ts,
                        files: toSlackFiles(message.files),
                    });
                }
                cursor = result.response_metadata?.next_cursor || undefined;
                if (!cursor) break;
            }
            return messages.slice(-limit);
        },

        async downloadFile(file) {
            if (!file.url) throw new Error(`Slack gave no download URL for ${file.name}`);
            const response = await fetch(file.url, { headers: { Authorization: `Bearer ${config.botToken}` } });
            if (!response.ok) throw new Error(`Slack file download failed: ${response.status} ${file.name}`);
            // Without files:read, Slack answers 200 with its sign-in page.
            const type = response.headers.get("content-type") ?? "";
            if (!type.startsWith("image/")) throw new Error(`Slack returned ${type} instead of ${file.name}`);
            return new Uint8Array(await response.arrayBuffer());
        },

        async uploadFiles({ channel, threadTs, files }) {
            await app.client.files.uploadV2({
                channel_id: channel,
                thread_ts: threadTs,
                file_uploads: files.map((file) => ({ file: Buffer.from(file.bytes), filename: file.filename })),
            });
        },
    };

    // app_mention events carry no channel_type.
    const channelType = async (channel: string): Promise<string> => {
        try {
            const { channel: info } = await app.client.conversations.info({ channel });
            if (info?.is_im) return "im";
            if (info?.is_mpim) return "mpim";
            return info?.is_private ? "group" : "channel";
        } catch (error) {
            // Only 1:1 DM ids are recognizable: a group DM can't be told from a channel.
            log("warn", "conversations.info failed, guessing the channel type from its id", { error, channel });
            return channel.startsWith("D") ? "im" : "unknown";
        }
    };

    return {
        port,
        botUserId: auth.user_id,
        workspaceTeamId: auth.team_id,
        async alertAdmin(text) {
            log("error", "admin alert", { text });
            if (!config.adminChannel) return;
            await app.client.chat.postMessage({ channel: config.adminChannel, text });
        },
        async start(onMention) {
            const dispatch = (mention: Mention) => {
                // Answering takes minutes: don't hold the event listener.
                void onMention(mention).catch((error) =>
                    log("error", "mention handler crashed", { error, eventId: mention.eventId }),
                );
            };
            const eventIdOf = (body: object, fallback: string) =>
                "event_id" in body && typeof body.event_id === "string" ? body.event_id : fallback;

            app.event("app_mention", async ({ event, body }) => {
                if ("bot_id" in event && event.bot_id) return;
                if ("edited" in event && event.edited) return;
                if (!event.user) return;
                dispatch({
                    eventId: eventIdOf(body, event.event_ts),
                    channel: event.channel,
                    channelType: await channelType(event.channel),
                    ts: event.ts,
                    threadTs: event.thread_ts,
                    userId: event.user,
                    text: event.text,
                    files: toSlackFiles("files" in event ? event.files : undefined),
                });
            });

            // Every message in a 1:1 DM with the bot, mentioning it or not.
            app.event("message", async ({ event, body }) => {
                if (event.channel_type !== "im") return;
                // Edits, deletions and other system messages carry a subtype. Kept: image
                // uploads, and thread replies also sent to the conversation.
                const { subtype } = event;
                if (subtype !== undefined && subtype !== "file_share" && subtype !== "thread_broadcast") return;
                if ("bot_id" in event && event.bot_id) return;
                if (!event.user || event.user === auth.user_id) return;
                dispatch({
                    eventId: eventIdOf(body, event.event_ts),
                    channel: event.channel,
                    channelType: "im",
                    ts: event.ts,
                    threadTs: event.thread_ts,
                    userId: event.user,
                    text: event.text ?? "",
                    files: toSlackFiles("files" in event ? event.files : undefined),
                });
            });
            await app.start();
            log("info", "connected to Slack", { botUserId: auth.user_id, team: auth.team_id });
        },
        async stop() {
            await app.stop();
        },
    };
}

function slackErrorCode(error: unknown): string | undefined {
    const data = (error as { data?: { error?: unknown } } | null)?.data;
    return typeof data?.error === "string" ? data.error : undefined;
}

interface RawSlackFile {
    id?: string;
    name?: string | null;
    mimetype?: string;
    size?: number;
    url_private_download?: string;
}

function toSlackFiles(files: RawSlackFile[] | undefined): SlackFile[] {
    return (files ?? []).flatMap((file) =>
        file.id
            ? [
                  {
                      id: file.id,
                      name: file.name ?? file.id,
                      mimeType: file.mimetype ?? "application/octet-stream",
                      size: file.size ?? 0,
                      url: file.url_private_download,
                  },
              ]
            : [],
    );
}
