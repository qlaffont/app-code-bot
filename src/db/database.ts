import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

export type Db = BunSQLiteDatabase;

const MIGRATIONS_FOLDER = new URL("../../drizzle", import.meta.url).pathname;

/** Opens (and migrates) the SQLite database at `path`; ":memory:" for tests. */
export function createDatabase(path: string): Db {
    const db = drizzle(new Database(path, { create: true }));
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    return db;
}
