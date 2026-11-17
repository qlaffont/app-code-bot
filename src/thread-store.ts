import { eq, sql } from "drizzle-orm";

import type { Db } from "./db/database";

import { threads } from "./db/schema";

/** Remembers which T3 thread answers which Slack thread, so follow-ups reuse it. */
export interface ThreadStore {
    get(slackThreadKey: string): string | undefined;
    set(slackThreadKey: string, t3ThreadId: string): void;
}

export function createThreadStore(db: Db): ThreadStore {
    return {
        get: (key) =>
            db.select({ t3ThreadId: threads.t3ThreadId }).from(threads).where(eq(threads.slackThreadKey, key)).get()
                ?.t3ThreadId,
        set: (key, t3ThreadId) => {
            db.insert(threads)
                .values({ slackThreadKey: key, t3ThreadId })
                .onConflictDoUpdate({
                    target: threads.slackThreadKey,
                    set: { t3ThreadId, updatedAt: sql`(datetime('now'))` },
                })
                .run();
        },
    };
}
