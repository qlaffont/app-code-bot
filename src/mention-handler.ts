import type { MediaFile, MediaReader } from "./media-reader";
import type { ThreadStore } from "./thread-store";

import { checkAccess, type AccessDecision, type SlackUser } from "./access";
import { formatAnswer } from "./format";
import { log } from "./log";
import { SlackUserNotFoundError, type SlackFile, type SlackPort } from "./slack-port";
import { T3ThreadGoneError, type T3Attachment, type T3Port } from "./t3-port";

/** An `app_mention` event, reduced to what the bot uses. */
export interface Mention {
    eventId: string;
    channel: string;
    channelType: string;
    /** Timestamp of the mentioning message. */
    ts: string;
    /** Set when the mention was posted inside an existing Slack thread. */
    threadTs?: string;
    userId: string;
    text: string;
    files: SlackFile[];
}

export interface MentionHandlerDeps {
    slack: SlackPort;
    t3: T3Port;
    store: ThreadStore;
    /** Reads the captures the agent asks to publish. */
    media: MediaReader;
    systemPrompt: string;
    botUserId: string;
    workspaceTeamId: string;
    answerTimeoutMs: number;
    pollIntervalMs: number;
    now?: () => number;
}

interface StartedRun {
    threadId: string;
    runId: string;
}

type Outcome = { kind: "answered"; answer: string } | { kind: "timeout" | "blocked" | "error" };

const LOADING_TEXT = "🔎 Je fouille le code…";
const REFUSAL_TEXT = "Désolé, je ne réponds qu'aux membres internes de l'équipe.";
/** What to tell someone who may not ask; bots get no answer at all. */
const REFUSAL_TEXTS: Record<Exclude<AccessDecision, { allowed: true }>["reason"], string | undefined> = {
    guest: REFUSAL_TEXT,
    external: REFUSAL_TEXT,
    direct_message: "Je ne réponds que dans les canaux : mentionne-moi dans un canal 🙂",
    bot: undefined,
};
const EMPTY_QUESTION_TEXT = "Pose-moi ta question juste après la mention 🙂";
const CODE_ONLY_TEXT = "Ma réponse ne contenait que du code, que je ne peux pas partager. Reformule ta question.";
const OUTCOME_TEXT = {
    timeout: "❌ Je n'ai pas réussi à répondre à temps, reformule ou précise ta question.",
    blocked: "❌ Je suis resté bloqué en attendant une réponse. Reformule ou précise ta question.",
    error: "❌ Une erreur est survenue, réessaie dans un moment.",
} as const;
const CARRY_ON_REMINDER =
    "Ici, personne ne peut te répondre : n'attends ni réponse ni validation, continue seul et donne ta réponse finale.";
const CLEANUP_REQUEST =
    "Stop : le temps est écoulé et la personne a déjà été prévenue. Ne réponds pas à la question : nettoie seulement tout ce que tu as lancé (processus, conteneurs Docker, onglets de prévisualisation) et supprime tes worktrees, puis arrête-toi.";
const CAPTURES_ONLY_TEXT = "Voici ce que j'ai trouvé 👇";
// Captures cost minutes (the app is started locally), so the agent only makes
// them when it sees fit; the asker can still ask for them in a follow-up.
const CAPTURE_OFFER =
    "_Si tu souhaites une vidéo ou des captures d'écran du parcours, indique-le-moi en me mentionnant dans ce fil._";
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
// T3's limits: 10 MB per image, 8 attachments per message.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS = 8;
const MAX_EARLIER_IMAGES = 5;
// As the prompt asks: 3 screenshots and 1 video.
const MAX_PUBLISHED = { image: 3, video: 1 } as const;
const MEDIA_MARKER = /^[ \t]*\[\[media:\s*(.+?)\s*\]\][ \t]*$/gm;
const HISTORY_LIMIT = 20;
const SEEN_EVENTS_LIMIT = 1000;

export function createMentionHandler(deps: MentionHandlerDeps): (mention: Mention) => Promise<void> {
    const { slack, t3 } = deps;
    const now = deps.now ?? Date.now;
    const seenEventIds = new Set<string>();
    const busySlackThreads = new Map<string, Promise<unknown>>();

    /** Runs `task` after every earlier task queued under the same key. */
    const oneAtATime = <T>(key: string, task: () => Promise<T>): Promise<T> => {
        const previous = busySlackThreads.get(key) ?? Promise.resolve();
        const current = previous.then(task, task);
        busySlackThreads.set(key, current);
        void current.finally(() => {
            if (busySlackThreads.get(key) === current) busySlackThreads.delete(key);
        });
        return current;
    };

    return async (mention) => {
        // Slack retries deliveries it thinks were lost.
        if (seenEventIds.has(mention.eventId)) return;
        seenEventIds.add(mention.eventId);
        if (seenEventIds.size > SEEN_EVENTS_LIMIT) {
            const [oldest] = seenEventIds;
            if (oldest) seenEventIds.delete(oldest);
        }

        const replyTs = mention.threadTs ?? mention.ts;
        const reply = (text: string) =>
            slack.postMessage({ channel: mention.channel, threadTs: replyTs, text: `<@${mention.userId}> ${text}` });

        let user: SlackUser;
        try {
            user = await slack.getUser(mention.userId);
        } catch (error) {
            if (error instanceof SlackUserNotFoundError) {
                await reply(REFUSAL_TEXT);
            } else {
                log("error", "could not look up the asker", { error, eventId: mention.eventId });
                await reply(OUTCOME_TEXT.error);
            }
            return;
        }
        const access = checkAccess({ user, channelType: mention.channelType, workspaceTeamId: deps.workspaceTeamId });
        if (!access.allowed) {
            const refusal = REFUSAL_TEXTS[access.reason];
            if (refusal) await reply(refusal);
            return;
        }

        const question = stripMention(mention.text, deps.botUserId);
        if (!question) {
            await reply(EMPTY_QUESTION_TEXT);
            return;
        }

        const loading = await slack.postMessage({ channel: mention.channel, threadTs: replyTs, text: LOADING_TEXT });

        const slackThreadKey = `${mention.channel}:${replyTs}`;
        const asker = `<@${mention.userId}> (${user.name})`;
        const readableImages = mention.files.filter(isReadableImage);
        const askedImages = readableImages.slice(0, MAX_ATTACHMENTS);
        // Reported to the asker; attachImages adds the images T3 couldn't take.
        const skippedFiles = [
            ...mention.files.filter((file) => !isReadableImage(file)),
            ...readableImages.slice(MAX_ATTACHMENTS),
        ].map((file) => file.name);
        // Uploaded once, even if the question falls back from a gone thread to a new one.
        let askedAttachments: Promise<T3Attachment[]> | undefined;
        const attachAskedImages = () => (askedAttachments ??= attachImages(askedImages, skippedFiles));

        const startNewThread = async (): Promise<StartedRun> => {
            const history = mention.threadTs
                ? await slack.getThreadHistory({ channel: mention.channel, threadTs: replyTs, limit: HISTORY_LIMIT })
                : [];
            const earlier = history.filter((message) => Number(message.ts) < Number(mention.ts));
            const context = earlier.map((message) => `<@${message.userId}> : ${message.text}`);
            const earlierImages = earlier
                .flatMap((message) => message.files)
                .filter(isReadableImage)
                .slice(-MAX_EARLIER_IMAGES);
            const contextBlock = context.length
                ? `Messages précédents du fil Slack, du plus ancien au plus récent :\n${context.join("\n")}\n\n`
                : "";
            const asked = await attachAskedImages();
            const fromThread = await attachImages(earlierImages.slice(0, MAX_ATTACHMENTS - asked.length));
            const launched = await t3.launchThread({
                title: `Slack · ${user.name} · ${question.slice(0, 60)}`,
                message: `${deps.systemPrompt}\n\n---\n\n${contextBlock}Question de ${asker} :\n${question}`,
                attachments: [...asked, ...fromThread],
            });
            deps.store.set(slackThreadKey, launched.threadId);
            return launched;
        };

        const continueThread = async (threadId: string): Promise<StartedRun> => {
            try {
                const { runId } = await t3.sendMessage({
                    threadId,
                    message: `Nouvelle question de ${asker} :\n${question}`,
                    attachments: await attachAskedImages(),
                });
                return { threadId, runId };
            } catch (error) {
                if (error instanceof T3ThreadGoneError) return startNewThread();
                throw error;
            }
        };

        // One question at a time per Slack thread: they share a T3 thread, and a
        // run must not be settled while the next one is queued behind it.
        // A run cut short may have left a stack running: the agent is asked to
        // tear it down, and the thread stays open (unsettled) for inspection.
        const { threadId, outcome } = await oneAtATime(slackThreadKey, async () => {
            let threadId: string | undefined;
            let outcome: Outcome;
            try {
                const existingThreadId = deps.store.get(slackThreadKey);
                const started = existingThreadId ? await continueThread(existingThreadId) : await startNewThread();
                threadId = started.threadId;
                outcome = await awaitAnswer(started);
            } catch (error) {
                log("error", "question failed", { error, eventId: mention.eventId, threadId });
                outcome = { kind: "error" };
            }
            if (threadId && (outcome.kind === "timeout" || outcome.kind === "blocked")) {
                await t3
                    .sendMessage({ threadId, message: CLEANUP_REQUEST })
                    .catch((error) => log("warn", "cleanup request failed", { error, threadId }));
            } else if (threadId) {
                await t3.settle(threadId).catch((error) => log("warn", "settle failed", { error, threadId }));
            }
            return { threadId, outcome };
        });

        await slack
            .deleteMessage({ channel: mention.channel, ts: loading.ts })
            .catch((error) => log("warn", "loading message not deleted", { error }));

        let chunks: string[] = [OUTCOME_TEXT.error];
        let mediaPaths: string[] = [];
        let offerCaptures = false;
        if (outcome.kind === "answered") {
            const extracted = extractMedia(outcome.answer);
            mediaPaths = extracted.mediaPaths;
            chunks = formatAnswer(extracted.text);
            offerCaptures = chunks.length > 0 && mediaPaths.length === 0;
            if (chunks.length === 0) chunks.push(mediaPaths.length ? CAPTURES_ONLY_TEXT : CODE_ONLY_TEXT);
        } else {
            chunks = [OUTCOME_TEXT[outcome.kind]];
        }
        if (skippedFiles.length) {
            const limitMb = MAX_IMAGE_BYTES / 1024 / 1024;
            const note = `_Je n'ai pas pu regarder : ${skippedFiles.join(", ")} (je ne lis que les images de moins de ${limitMb} Mo, ${MAX_ATTACHMENTS} au maximum)._`;
            chunks.push(`${chunks.pop()}\n\n${note}`);
        }
        if (offerCaptures) chunks.push(`${chunks.pop()}\n\n${CAPTURE_OFFER}`);
        const [first = "", ...rest] = chunks;
        await reply(first);
        for (const chunk of rest) {
            await slack.postMessage({ channel: mention.channel, threadTs: replyTs, text: chunk });
        }
        await publishMedia(mediaPaths, { channel: mention.channel, threadTs: replyTs });
        log("info", "question handled", { eventId: mention.eventId, threadId, outcome: outcome.kind });
    };

    /**
     * Copies Slack images to T3. An image that fails is left out rather than
     * failing the question, and its name goes to `failed` when given.
     */
    async function attachImages(files: SlackFile[], failed?: string[]): Promise<T3Attachment[]> {
        const attachments: T3Attachment[] = [];
        for (const file of files) {
            try {
                const bytes = await slack.downloadFile(file);
                attachments.push(await t3.uploadImage({ name: file.name, mimeType: file.mimeType, bytes }));
            } catch (error) {
                log("warn", "image not attached", { error, file: file.name });
                failed?.push(file.name);
            }
        }
        return attachments;
    }

    async function publishMedia(paths: string[], target: { channel: string; threadTs: string }): Promise<void> {
        const files: MediaFile[] = [];
        for (const path of paths) {
            try {
                const file = await deps.media.read(path);
                const sameKind = files.filter((published) => published.kind === file.kind).length;
                if (sameKind < MAX_PUBLISHED[file.kind]) files.push(file);
            } catch (error) {
                log("warn", "capture not published", { error, path });
            }
        }
        if (!files.length) return;
        await slack
            .uploadFiles({ ...target, files })
            .catch((error) => log("error", "captures upload failed", { error, count: files.length }));
    }

    /**
     * Polls the run until it ends, the deadline passes, or the agent gets stuck
     * waiting for a person (a question or an approval). Nobody can answer it
     * over MCP, so a stuck run is interrupted and the agent is told, once, to
     * carry on alone.
     */
    async function awaitAnswer({ threadId, runId }: StartedRun): Promise<Outcome> {
        const deadline = now() + deps.answerTimeoutMs;
        let currentRunId = runId;
        let reminded = false;
        for (;;) {
            const remainingMs = deadline - now();
            if (remainingMs <= 0) {
                await t3
                    .interrupt({ threadId, runId: currentRunId })
                    .catch((error) => log("warn", "interrupt failed", { error, threadId }));
                return { kind: "timeout" };
            }
            const status = await t3.waitForRun({
                threadId,
                runId: currentRunId,
                timeoutMs: Math.min(deps.pollIntervalMs, remainingMs),
            });
            if (status === "completed") {
                const answer = await t3.readAnswer({ threadId, runId: currentRunId });
                return answer ? { kind: "answered", answer } : { kind: "error" };
            }
            if (status !== "running") return { kind: "error" };
            if ((await t3.getPendingRequestCount(threadId)) === 0) continue;

            await t3.interrupt({ threadId, runId: currentRunId });
            if (reminded) return { kind: "blocked" };
            reminded = true;
            currentRunId = (await t3.sendMessage({ threadId, message: CARRY_ON_REMINDER })).runId;
        }
    }
}

function isReadableImage(file: SlackFile): boolean {
    return Boolean(file.url) && IMAGE_TYPES.has(file.mimeType) && file.size <= MAX_IMAGE_BYTES;
}

/** Pulls the agent's `[[media: /path]]` lines out of its answer. */
function extractMedia(answer: string): { text: string; mediaPaths: string[] } {
    const mediaPaths: string[] = [];
    const text = answer.replace(MEDIA_MARKER, (_line, path: string) => {
        mediaPaths.push(path);
        return "";
    });
    return { text, mediaPaths };
}

function stripMention(text: string, botUserId: string): string {
    return text.replaceAll(`<@${botUserId}>`, "").trim();
}
