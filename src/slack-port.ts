import type { SlackUser } from "./access";
import type { MediaFile } from "./media-reader";

/** A file attached to a Slack message. */
export interface SlackFile {
    id: string;
    name: string;
    mimeType: string;
    size: number;
    /** `url_private_download`, readable with the bot token; missing for some external files. */
    url?: string;
}

export interface ThreadMessage {
    userId: string;
    text: string;
    ts: string;
    files: SlackFile[];
}

/** Slack has no details for this user, e.g. someone from another organization. */
export class SlackUserNotFoundError extends Error {
    constructor(readonly userId: string) {
        super(`Slack has no details for user ${userId}`);
        this.name = "SlackUserNotFoundError";
    }
}

/** What the bot needs from Slack. The Bolt adapter implements it; tests use a fake. */
export interface SlackPort {
    /** Throws SlackUserNotFoundError when Slack can't describe the user. */
    getUser(userId: string): Promise<SlackUser>;
    postMessage(input: { channel: string; threadTs: string; text: string }): Promise<{ ts: string }>;
    deleteMessage(input: { channel: string; ts: string }): Promise<void>;
    /** Messages of a thread, oldest first. */
    getThreadHistory(input: { channel: string; threadTs: string; limit: number }): Promise<ThreadMessage[]>;
    downloadFile(file: SlackFile): Promise<Uint8Array>;
    uploadFiles(input: { channel: string; threadTs: string; files: MediaFile[] }): Promise<void>;
}
