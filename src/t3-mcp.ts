import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { TokenManager } from "./token-manager";

import { log } from "./log";
import { RUN_OUTCOMES, T3ThreadGoneError, type RunOutcome, type T3Port } from "./t3-port";

export interface T3McpConfig {
    /** e.g. http://127.0.0.1:3773 */
    url: string;
    /** Hands out the full-access token and renews it when T3 rejects it. */
    tokens: TokenManager;
    projectId: string;
    providerInstanceId: string;
    model: string;
    effort: string;
}

/** A tool call T3 answered with `isError`, carrying its OrchestratorMcpFailure code. */
export class T3ToolError extends Error {
    constructor(
        readonly tool: string,
        readonly code: string | undefined,
        message: string,
    ) {
        super(`${tool}: ${message}`);
        this.name = "T3ToolError";
    }
}

// The agent may run the app in its own worktrees; safety comes from isolation (see docs/SPEC.md).
const RUNTIME_MODE = "full-access";
const INTERACTION_MODE = "default";
const isRunOutcome = (status: string): status is RunOutcome => (RUN_OUTCOMES as readonly string[]).includes(status);
const GONE_CODES = new Set(["thread_not_found", "thread_not_sendable"]);

interface TimelineItem {
    itemId: string;
    runId: string | null;
    type: string;
    text: string | null;
    textTruncated: boolean;
    nextTextOffset?: number | null;
}

interface ThreadReadResult {
    thread: { pendingRequestCount: number };
    items: TimelineItem[];
    nextPosition: number | null;
    hasMore: boolean;
}

/** T3Port over the T3 server's `/mcp` endpoint (MCP Streamable HTTP). */
export function createT3McpClient(config: T3McpConfig): T3Port {
    interface Session {
        client: Client;
        token: string;
    }
    let session: Promise<Session> | undefined;

    const connect = async (token: string): Promise<Session> => {
        const transport = new StreamableHTTPClientTransport(new URL("/mcp", config.url), {
            requestInit: {
                headers: {
                    Authorization: `Bearer ${token}`,
                    "T3-Mode-Limit": `${RUNTIME_MODE}/${INTERACTION_MODE}`,
                },
            },
        });
        const client = new Client({ name: "app-code-bot", version: "0.1.0" });
        await client.connect(transport);
        return { client, token };
    };

    const drop = async (stale: Promise<Session>) => {
        // Only drop the session this call used: a parallel call may already have reconnected.
        if (session === stale) session = undefined;
        await stale.then(({ client }) => client.close()).catch(() => undefined);
    };

    /**
     * Calls a T3 tool. The session follows the token manager (so an early
     * renewal takes effect at the next call), and a lost session is reopened
     * once, unless the call isn't safe to repeat.
     */
    const call = async <T>(
        tool: string,
        args: Record<string, unknown>,
        { timeoutMs = 60_000, retry = true } = {},
    ): Promise<T> => {
        for (let attempt = 0; ; attempt++) {
            const token = await config.tokens.getToken();
            if (session && (await session.then((s) => s.token !== token).catch(() => true))) await drop(session);
            const current = (session ??= connect(token));
            try {
                const result = await (
                    await current
                ).client.callTool({ name: tool, arguments: args }, undefined, { timeout: timeoutMs });
                if (result.isError) throw toolError(tool, result.content);
                return result.structuredContent as T;
            } catch (error) {
                if (error instanceof T3ToolError) throw error;
                if (/\b401\b|invalid_mcp_credential/i.test(String(error))) {
                    log("warn", "T3 rejected the token, issuing a new one", { tool });
                    config.tokens.invalidate(token);
                }
                await drop(current);
                if (attempt > 0 || !retry) throw error;
                log("warn", "T3 MCP call failed, reconnecting", { tool, error });
            }
        }
    };

    return {
        async uploadImage({ name, mimeType, bytes }) {
            const prepared = await call<{ attachmentId: string; relativeUrl: string }>("t3_attachment_prepare_upload", {
                upload: { type: "image", name, mimeType, sizeBytes: bytes.length },
            });
            // The signed URL is the credential: no bearer token here.
            const response = await fetch(new URL(prepared.relativeUrl, config.url), {
                method: "POST",
                headers: { "Content-Length": String(bytes.length) },
                body: bytes,
            });
            if (!response.ok) throw new Error(`T3 attachment upload failed: ${response.status}`);
            return { type: "image", id: prepared.attachmentId, name, mimeType, sizeBytes: bytes.length };
        },

        async launchThread({ title, message, attachments }) {
            const result = await call<{ threadId: string; runId: string | null }>("t3_thread_launch", {
                projectId: config.projectId,
                title,
                message,
                modelSelection: {
                    instanceId: config.providerInstanceId,
                    model: config.model,
                    options: [{ id: "effort", value: config.effort }],
                },
                runtimeMode: RUNTIME_MODE,
                interactionMode: INTERACTION_MODE,
                ...(attachments.length ? { attachments } : {}),
                clientRequestId: crypto.randomUUID(),
            });
            if (!result.runId) throw new Error(`T3 created thread ${result.threadId} without starting a run`);
            return { threadId: result.threadId, runId: result.runId };
        },

        async sendMessage({ threadId, message, attachments = [] }) {
            try {
                // t3_thread_send_attachments has no retry key: never send it twice.
                const result = attachments.length
                    ? await call<{ runId: string }>(
                          "t3_thread_send_attachments",
                          { threadId, message, attachments },
                          { retry: false },
                      )
                    : await call<{ runId: string }>("t3_thread_send", {
                          threadId,
                          message,
                          mode: "queue",
                          clientRequestId: crypto.randomUUID(),
                      });
                return { runId: result.runId };
            } catch (error) {
                if (error instanceof T3ToolError && error.code && GONE_CODES.has(error.code)) {
                    throw new T3ThreadGoneError(threadId);
                }
                throw error;
            }
        },

        async waitForRun({ threadId, runId, timeoutMs }) {
            const result = await call<{ status: string; timedOut: boolean }>(
                "t3_thread_wait",
                { threadId, runId, timeoutMs },
                { timeoutMs: timeoutMs + 30_000 },
            );
            return !result.timedOut && isRunOutcome(result.status) ? result.status : "running";
        },

        async getPendingRequestCount(threadId) {
            const read = await call<ThreadReadResult>("t3_thread_read", { threadId, limit: 1, maxCharsPerItem: 1 });
            return read.thread.pendingRequestCount;
        },

        async readAnswer({ threadId, runId }) {
            let reply: TimelineItem | undefined;
            let afterPosition: number | undefined;
            for (;;) {
                const read = await call<ThreadReadResult>("t3_thread_read", {
                    threadId,
                    view: "messages",
                    limit: 100,
                    maxCharsPerItem: 50_000,
                    ...(afterPosition === undefined ? {} : { afterPosition }),
                });
                reply =
                    read.items.findLast((item) => item.type === "assistant_message" && item.runId === runId) ?? reply;
                if (!read.hasMore || read.nextPosition === null) break;
                afterPosition = read.nextPosition;
            }
            if (!reply) return null;

            let text = reply.text ?? "";
            let textOffset = reply.textTruncated ? (reply.nextTextOffset ?? null) : null;
            while (textOffset !== null) {
                const read = await call<ThreadReadResult>("t3_thread_read", {
                    threadId,
                    itemId: reply.itemId,
                    textOffset,
                    maxCharsPerItem: 50_000,
                });
                const part = read.items[0];
                if (!part) break;
                text += part.text ?? "";
                textOffset = part.textTruncated ? (part.nextTextOffset ?? null) : null;
            }
            return text;
        },

        async interrupt({ threadId, runId }) {
            await call("t3_thread_interrupt", {
                threadId,
                runId,
                reason: "AppCode: no answer in time or blocked",
                clientRequestId: crypto.randomUUID(),
            });
        },

        async settle(threadId) {
            await call("t3_thread_organize", { threadId, action: "settle" });
        },
    };
}

function toolError(tool: string, content: unknown): T3ToolError {
    const text = Array.isArray(content) ? (content.find((part) => typeof part?.text === "string")?.text ?? "") : "";
    try {
        const failure = JSON.parse(text) as { code?: string; message?: string };
        return new T3ToolError(tool, failure.code, failure.message ?? text);
    } catch {
        return new T3ToolError(tool, undefined, text || "tool call failed");
    }
}
