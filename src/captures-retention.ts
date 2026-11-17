import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * Deletes each entry of `dir` (usually one folder per question) whose newest file is older than `maxAgeMs`.
 * Once posted to Slack, a capture is no longer needed on disk. An entry that can't be deleted (e.g. owned
 * by another user) is reported in `failed` and doesn't stop the others.
 */
export async function purgeOldCaptures(
    dir: string,
    maxAgeMs: number,
): Promise<{ deleted: string[]; failed: string[] }> {
    const deleted: string[] = [];
    const failed: string[] = [];
    for (const name of await readdir(dir)) {
        const path = join(dir, name);
        try {
            if (Date.now() - (await newestMtimeMs(path)) < maxAgeMs) continue;
            await rm(path, { recursive: true, force: true });
            deleted.push(name);
        } catch {
            failed.push(name);
        }
    }
    return { deleted, failed };
}

/** Most recent modification time of a file, or of anything inside a folder (symbolic links are not followed). */
async function newestMtimeMs(path: string): Promise<number> {
    const stats = await lstat(path);
    if (!stats.isDirectory()) return stats.mtimeMs;
    let newest = stats.mtimeMs;
    for (const name of await readdir(path)) newest = Math.max(newest, await newestMtimeMs(join(path, name)));
    return newest;
}
