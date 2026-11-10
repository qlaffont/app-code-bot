import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeVideo } from "../src/video";

/** Encodes a short, busy test clip so the bitrate isn't trivially low. */
function sampleClip(dir: string): Uint8Array {
    const path = join(dir, "sample.webm");
    const result = Bun.spawnSync([
        "ffmpeg",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=640x360:rate=15:duration=3",
        "-c:v",
        "libvpx-vp9",
        "-b:v",
        "500k",
        path,
    ]);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return new Uint8Array(readFileSync(path));
}

/** Reads the video stream line ffmpeg prints for a file. */
function describeVideo(dir: string, bytes: Uint8Array): string {
    const path = join(dir, "probe.mp4");
    writeFileSync(path, bytes);
    const result = Bun.spawnSync(["ffmpeg", "-hide_banner", "-i", path, "-f", "null", "-"]);
    return (
        result.stderr
            .toString()
            .split("\n")
            .find((line) => line.includes("Video:")) ?? ""
    );
}

describe("normalizeVideo", () => {
    test("re-encodes a capture to H.264 1920x1080 at 30 fps with a high bitrate", async () => {
        const dir = mkdtempSync(join(tmpdir(), "video-"));
        try {
            const video = await normalizeVideo({ filename: "parcours.webm", kind: "video", bytes: sampleClip(dir) });

            expect(video.filename).toBe("parcours.mp4");
            const stream = describeVideo(dir, video.bytes);
            expect(stream).toContain("h264");
            expect(stream).toContain("1920x1080");
            expect(stream).toMatch(/\b30 fps\b/);
            const kbps = Number(/(\d+) kb\/s/.exec(stream)?.[1]);
            expect(kbps).toBeGreaterThan(4000);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 60_000);
});
