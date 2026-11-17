import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMediaReader, MediaNotAllowedError } from "../src/media-reader";

let base: string;
let artifacts: string;
let attachments: string;
let secrets: string;

beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "media-reader-"));
    artifacts = join(base, "browser-artifacts");
    attachments = join(base, "attachments");
    secrets = join(base, "secrets");
    mkdirSync(artifacts);
    mkdirSync(attachments);
    mkdirSync(secrets);
    writeFileSync(join(artifacts, "screen.png"), "png-bytes");
    writeFileSync(join(artifacts, "notes.txt"), "not a capture");
    writeFileSync(join(attachments, "user-upload.png"), "someone else's image");
    writeFileSync(join(attachments, "recording.mp4"), "mp4-bytes");
    writeFileSync(join(secrets, "key.bin"), "secret");
    symlinkSync(join(secrets, "key.bin"), join(artifacts, "innocent.png"));
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

const reader = () =>
    createMediaReader([
        { dir: artifacts, kinds: ["image", "video"] },
        { dir: attachments, kinds: ["video"] },
        { dir: join(base, "created-later"), kinds: ["image"] },
    ]);

describe("the media reader", () => {
    test("reads a capture inside an allowed folder", async () => {
        const media = await reader().read(join(artifacts, "screen.png"));

        expect(media).toMatchObject({ filename: "screen.png", kind: "image" });
        expect(new TextDecoder().decode(media.bytes)).toBe("png-bytes");
    });

    test("refuses a path outside the allowed folders", async () => {
        await expect(reader().read(join(secrets, "key.bin"))).rejects.toBeInstanceOf(MediaNotAllowedError);
    });

    test("refuses a path that climbs out with ..", async () => {
        await expect(reader().read(join(artifacts, "..", "secrets", "key.bin"))).rejects.toBeInstanceOf(
            MediaNotAllowedError,
        );
    });

    test("refuses a symlink pointing outside the allowed folders", async () => {
        await expect(reader().read(join(artifacts, "innocent.png"))).rejects.toBeInstanceOf(MediaNotAllowedError);
    });

    test("refuses files that are neither images nor videos", async () => {
        await expect(reader().read(join(artifacts, "notes.txt"))).rejects.toBeInstanceOf(MediaNotAllowedError);
    });

    test("only takes videos from the T3 attachments folder, never other people's uploads", async () => {
        expect((await reader().read(join(attachments, "recording.mp4"))).kind).toBe("video");
        await expect(reader().read(join(attachments, "user-upload.png"))).rejects.toBeInstanceOf(MediaNotAllowedError);
    });

    test("accepts a folder created after the bot started", async () => {
        const media = reader();
        mkdirSync(join(base, "created-later"));
        writeFileSync(join(base, "created-later", "late.png"), "png");

        expect((await media.read(join(base, "created-later", "late.png"))).filename).toBe("late.png");
    });
});
