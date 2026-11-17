import { sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Which T3 thread answers which Slack thread (`<channel>:<thread_ts>`). */
export const threads = sqliteTable("threads", {
    slackThreadKey: text("slack_thread_key").primaryKey(),
    t3ThreadId: text("t3_thread_id").notNull(),
    updatedAt: text("updated_at")
        .notNull()
        .default(sql`(datetime('now'))`),
});

/** The full-access T3 MCP token the bot issued itself (single row, id "mcp"). */
export const t3Credentials = sqliteTable("t3_credentials", {
    id: text("id").primaryKey(),
    token: text("token").notNull(),
    expiresAt: text("expires_at").notNull(),
});
