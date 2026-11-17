/** Terminal states of a T3 run. */
export const RUN_OUTCOMES = ["completed", "failed", "interrupted", "cancelled", "rolled_back"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/** The T3 thread no longer exists or can't receive messages (deleted, archived…). */
export class T3ThreadGoneError extends Error {
    constructor(readonly threadId: string) {
        super(`T3 thread ${threadId} is gone`);
        this.name = "T3ThreadGoneError";
    }
}

/** A file uploaded to T3, ready to attach to a message. */
export interface T3Attachment {
    type: "image";
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
}

/** What the bot needs from T3. The MCP adapter implements it; tests use a fake. */
export interface T3Port {
    uploadImage(input: { name: string; mimeType: string; bytes: Uint8Array }): Promise<T3Attachment>;
    launchThread(input: {
        title: string;
        message: string;
        attachments: T3Attachment[];
    }): Promise<{ threadId: string; runId: string }>;
    /** Throws T3ThreadGoneError when the thread can't be reused. */
    sendMessage(input: { threadId: string; message: string; attachments?: T3Attachment[] }): Promise<{ runId: string }>;
    /** Waits up to `timeoutMs` for the run to end; "running" when it hasn't yet. */
    waitForRun(input: { threadId: string; runId: string; timeoutMs: number }): Promise<RunOutcome | "running">;
    /** Approvals or questions the agent is blocked on. */
    getPendingRequestCount(threadId: string): Promise<number>;
    /** Final assistant message of the run. */
    readAnswer(input: { threadId: string; runId: string }): Promise<string | null>;
    interrupt(input: { threadId: string; runId: string }): Promise<void>;
    settle(threadId: string): Promise<void>;
}
