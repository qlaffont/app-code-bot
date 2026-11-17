import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, sep } from "node:path";

export type MediaKind = "image" | "video";

export interface MediaFile {
    filename: string;
    kind: MediaKind;
    bytes: Uint8Array;
}

/** A folder the agent's captures may come from, and which kinds of files it may provide. */
export interface MediaRoot {
    dir: string;
    kinds: MediaKind[];
}

/** Reads the agent's captures from the host folders mounted into the container. */
export interface MediaReader {
    /** Throws MediaNotAllowedError for anything that isn't a capture in an allowed folder. */
    read(path: string): Promise<MediaFile>;
}

export class MediaNotAllowedError extends Error {
    constructor(
        readonly path: string,
        reason: string,
    ) {
        super(`Media not allowed (${reason}): ${path}`);
        this.name = "MediaNotAllowedError";
    }
}

const KIND_BY_EXTENSION: Record<string, MediaKind> = {
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
    ".gif": "image",
    ".webp": "image",
    ".mp4": "video",
    ".webm": "video",
    ".mov": "video",
};
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

/**
 * The agent names the files to publish, so only images and videos really
 * inside an allowed folder (after resolving `..` and symlinks) may leave the
 * machine. T3's attachments folder also holds every user's uploads, which is
 * why each folder lists the kinds it may provide.
 */
export function createMediaReader(roots: MediaRoot[]): MediaReader {
    return {
        async read(path) {
            const resolved = await realpath(path).catch(() => {
                throw new MediaNotAllowedError(path, "missing");
            });
            const kind = KIND_BY_EXTENSION[extname(resolved).toLowerCase()];
            if (!kind) throw new MediaNotAllowedError(path, "not an image or a video");
            // Resolved on every read: a folder may appear after the bot started.
            const allowed = await Promise.all(
                roots.map(async (root) => {
                    const dir = await realpath(root.dir).catch(() => undefined);
                    return dir !== undefined && resolved.startsWith(dir + sep) && root.kinds.includes(kind);
                }),
            );
            if (!allowed.includes(true)) throw new MediaNotAllowedError(path, "outside the capture folders");
            if ((await stat(resolved)).size > MAX_MEDIA_BYTES) throw new MediaNotAllowedError(path, "too large");
            return { filename: basename(resolved), kind, bytes: new Uint8Array(await readFile(resolved)) };
        },
    };
}
