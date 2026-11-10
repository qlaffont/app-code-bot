import type { SlackUser } from "../src/access";
import type { MediaFile, MediaReader } from "../src/media-reader";

import { MediaNotAllowedError } from "../src/media-reader";
import { SlackUserNotFoundError, type SlackFile, type SlackPort, type ThreadMessage } from "../src/slack-port";
import { T3ThreadGoneError, type RunOutcome, type T3Attachment, type T3Port } from "../src/t3-port";

export const slackFile = (name: string, mimeType: string, size = 1000): SlackFile => ({
    id: `F-${name}`,
    name,
    mimeType,
    size,
    url: `https://files.slack.com/${name}`,
});

export const internalMember = (id = "UASKER", name = "Alice"): SlackUser => ({
    id,
    name,
    teamId: "TAPP",
    isBot: false,
    isRestricted: false,
    isUltraRestricted: false,
    isStranger: false,
});

interface PostedMessage {
    channel: string;
    threadTs: string;
    text: string;
    ts: string;
}

export class FakeSlack implements SlackPort {
    users = new Map<string, SlackUser>([["UASKER", internalMember()]]);
    history: ThreadMessage[] = [];
    posted: PostedMessage[] = [];
    deleted: string[] = [];
    uploaded: { channel: string; threadTs: string; filenames: string[] }[] = [];
    failGetUser = false;
    private nextTs = 1;

    async getUser(userId: string): Promise<SlackUser> {
        if (this.failGetUser) throw new Error("Slack rate limited");
        const user = this.users.get(userId);
        if (!user) throw new SlackUserNotFoundError(userId);
        return user;
    }

    async postMessage(input: { channel: string; threadTs: string; text: string }): Promise<{ ts: string }> {
        const ts = `9000.${this.nextTs++}`;
        this.posted.push({ ...input, ts });
        return { ts };
    }

    async deleteMessage(input: { channel: string; ts: string }): Promise<void> {
        this.deleted.push(input.ts);
    }

    async getThreadHistory(): Promise<ThreadMessage[]> {
        return this.history;
    }

    async downloadFile(file: SlackFile): Promise<Uint8Array> {
        return new TextEncoder().encode(`bytes of ${file.name}`);
    }

    async uploadFiles(input: { channel: string; threadTs: string; files: MediaFile[] }): Promise<void> {
        this.uploaded.push({
            channel: input.channel,
            threadTs: input.threadTs,
            filenames: input.files.map((file) => file.filename),
        });
    }

    /** Messages still visible in Slack, oldest first. */
    visibleTexts(): string[] {
        return this.posted.filter((message) => !this.deleted.includes(message.ts)).map((message) => message.text);
    }
}

type ScriptedRun = { outcome: RunOutcome; answer?: string } | { pending: true } | { running: true };

/**
 * A scripted T3: each run created (by launch or send) consumes the next scripted
 * behaviour. `{ pending: true }` makes the run sit waiting for an approval,
 * `{ running: true }` makes it never finish. Waiting advances `elapsedMs`.
 */
export class FakeT3 implements T3Port {
    launched: { title: string; message: string; attachments: T3Attachment[] }[] = [];
    sent: { threadId: string; message: string; attachments?: T3Attachment[] }[] = [];
    uploadedImages: string[] = [];
    failingUploads = new Set<string>();
    interrupted: string[] = [];
    settled: string[] = [];
    goneThreads = new Set<string>();
    script: ScriptedRun[] = [];
    elapsedMs = 0;
    failLaunch = false;
    failInterrupt = false;
    private runs = new Map<string, ScriptedRun>();
    private nextId = 1;

    async uploadImage(input: { name: string; mimeType: string; bytes: Uint8Array }): Promise<T3Attachment> {
        if (this.failingUploads.has(input.name)) throw new Error("T3 upload failed");
        this.uploadedImages.push(input.name);
        return {
            type: "image",
            id: `att-${input.name}`,
            name: input.name,
            mimeType: input.mimeType,
            sizeBytes: input.bytes.length,
        };
    }

    async launchThread(input: {
        title: string;
        message: string;
        attachments: T3Attachment[];
    }): Promise<{ threadId: string; runId: string }> {
        if (this.failLaunch) throw new Error("T3 unreachable");
        this.launched.push(input);
        const threadId = `thread-${this.nextId++}`;
        return { threadId, runId: this.startRun() };
    }

    async sendMessage(input: {
        threadId: string;
        message: string;
        attachments?: T3Attachment[];
    }): Promise<{ runId: string }> {
        if (this.goneThreads.has(input.threadId)) throw new T3ThreadGoneError(input.threadId);
        this.sent.push(input);
        return { runId: this.startRun() };
    }

    async waitForRun(input: { threadId: string; runId: string; timeoutMs: number }): Promise<RunOutcome | "running"> {
        const run = this.runs.get(input.runId);
        if (!run || !("outcome" in run)) {
            this.elapsedMs += input.timeoutMs;
            return "running";
        }
        return run.outcome;
    }

    async getPendingRequestCount(): Promise<number> {
        return [...this.runs.entries()].some(([runId, run]) => "pending" in run && !this.interrupted.includes(runId))
            ? 1
            : 0;
    }

    async readAnswer(input: { threadId: string; runId: string }): Promise<string | null> {
        const run = this.runs.get(input.runId);
        return run && "outcome" in run ? (run.answer ?? null) : null;
    }

    async interrupt(input: { threadId: string; runId: string }): Promise<void> {
        if (this.failInterrupt) throw new Error("T3 unreachable");
        this.interrupted.push(input.runId);
    }

    async settle(threadId: string): Promise<void> {
        this.settled.push(threadId);
    }

    private startRun(): string {
        const runId = `run-${this.nextId++}`;
        const next = this.script.shift() ?? { outcome: "completed", answer: "Réponse par défaut." };
        this.runs.set(runId, next);
        return runId;
    }
}

/** Serves captures from an in-memory folder; anything else is "outside the roots". */
export class FakeMediaReader implements MediaReader {
    files = new Map<string, string>();

    async read(path: string): Promise<MediaFile> {
        const content = this.files.get(path);
        if (content === undefined) throw new MediaNotAllowedError(path, "outside the capture folders");
        const filename = path.split("/").at(-1) ?? path;
        const kind = /\.(mp4|webm|mov)$/.test(filename) ? "video" : "image";
        return { filename, kind, bytes: new TextEncoder().encode(content) };
    }
}
