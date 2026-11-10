import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

import type { MediaFile } from "./media-reader";

// Published videos are always 1920x1080, 30 fps, H.264 at ~8 Mbit/s (12 max):
// sharp enough for UI text, and playable inline in Slack.
const FFMPEG_ARGS = [
    "-vf",
    "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=white,fps=30",
    "-r",
    "30",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-b:v",
    "8M",
    "-maxrate",
    "12M",
    "-bufsize",
    "16M",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-an",
];

/** Re-encodes an agent's recording (T3 records ~3 Mbit/s, Playwright less) to the published format. */
export async function normalizeVideo(video: MediaFile): Promise<MediaFile> {
    const dir = await mkdtemp(join(tmpdir(), "app-code-bot-video-"));
    try {
        const input = join(dir, `input${extname(video.filename) || ".webm"}`);
        const output = join(dir, "output.mp4");
        await writeFile(input, video.bytes);
        const ffmpeg = Bun.spawn(["ffmpeg", "-loglevel", "error", "-y", "-i", input, ...FFMPEG_ARGS, output], {
            stderr: "pipe",
        });
        if ((await ffmpeg.exited) !== 0) {
            throw new Error(`ffmpeg failed on ${video.filename}: ${await new Response(ffmpeg.stderr).text()}`);
        }
        const name = video.filename.replace(/\.[^.]+$/, "");
        return { filename: `${name}.mp4`, kind: "video", bytes: new Uint8Array(await readFile(output)) };
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}
