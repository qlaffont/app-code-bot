#!/usr/bin/env node
// Renders a motion-design scenario to an MP4 at a constant frame rate, frame
// by frame, with Chrome drawing on the GPU. See README.md.
import { spawn } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { CHROME_BIN } from "./chrome.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RENDER_NODE = "/dev/dri/renderD128";
const DEFAULT_MOTION = resolve(homedir(), ".claude/projects/-home/memory/video-motion-design.js");
const FFMPEG_IMAGE = "jrottenberg/ffmpeg:7.1-ubuntu";
// Colour swaps applied to the motion-design script (written in teal).
const THEMES = {
    teal: []
};
const GPU_FLAGS = ["--use-gl=angle", "--use-angle=gl-egl", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"];

const { values: opt } = parseArgs({
    options: {
        url: { type: "string" },
        setup: { type: "string" },
        scenario: { type: "string" },
        out: { type: "string" },
        motion: { type: "string", default: DEFAULT_MOTION },
        theme: { type: "string", default: "teal" },
        fps: { type: "string", default: "60" },
        width: { type: "string", default: "1920" },
        height: { type: "string", default: "1080" },
        crf: { type: "string", default: "16" },
        tail: { type: "string", default: "300" },
        "max-seconds": { type: "string", default: "180" },
        "allow-cpu": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
    },
});

if (opt.help || !opt.scenario || !opt.out || (!opt.url && !opt.setup)) {
    console.log(`Usage: node render.mjs --scenario steps.js --out video.mp4 (--url URL | --setup setup.mjs)
  --setup      module whose default export async ({ page, context }) logs in / opens the page (real time)
  --url        page to open when there is no --setup
  --scenario   body of an async function run in the page under virtual time (window.__md is available)
  --motion     motion-design script injected before the scenario (default: ${DEFAULT_MOTION})
  --theme      ${Object.keys(THEMES).join(" | ")} (default teal)
  --fps 60  --width 1920  --height 1080  --crf 16  --tail 300 (ms kept after the scenario ends)
  --allow-cpu  render even if Chrome falls back to SwiftShader (CPU)`);
    process.exit(opt.help ? 0 : 2);
}

// Being added to the "render" group only reaches new login sessions: re-run
// under `sg render` when this process cannot open the GPU yet.
if (!canOpen(RENDER_NODE) && !process.env.VIDEO_RENDER_SG) {
    const command = [process.execPath, ...process.argv.slice(1)].map(shellQuote).join(" ");
    const child = spawn("sg", ["render", "-c", command], { stdio: "inherit", env: { ...process.env, VIDEO_RENDER_SG: "1" } });
    child.on("exit", (code) => process.exit(code ?? 1));
} else {
    await main();
}

async function main() {
    const fps = Number(opt.fps);
    const width = Number(opt.width);
    const height = Number(opt.height);
    const frameMs = 1000 / fps;
    const maxFrames = Math.ceil(Number(opt["max-seconds"]) * fps);
    const tailFrames = Math.ceil(Number(opt.tail) / frameMs);
    const out = resolve(opt.out);
    const scenario = readFileSync(resolve(opt.scenario), "utf8");
    const clock = readFileSync(resolve(HERE, "virtual-clock.js"), "utf8");
    const motion = opt.motion ? applyTheme(readFileSync(resolve(opt.motion), "utf8"), opt.theme) : null;

    const browser = await chromium.launch({
        executablePath: CHROME_BIN,
        args: GPU_FLAGS,
        ignoreDefaultArgs: ["--enable-unsafe-swiftshader"],
    });
    let encoder;
    try {
        const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
        const page = await context.newPage();
        page.on("console", (msg) => { if (msg.type() === "error") console.error(`[page] ${msg.text()}`); });

        const renderer = await page.evaluate(() => {
            const gl = document.createElement("canvas").getContext("webgl2");
            const ext = gl?.getExtension("WEBGL_debug_renderer_info");
            return gl ? gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) : "none";
        });
        console.log(`GPU: ${renderer}`);
        if (/swiftshader|llvmpipe|none/i.test(renderer) && !opt["allow-cpu"]) {
            throw new Error("Chrome is not using the GPU (pass --allow-cpu to render anyway)");
        }

        if (opt.setup) {
            const { default: setup } = await import(pathToFileURL(resolve(opt.setup)).href);
            await setup({ page, context, url: opt.url });
        } else {
            await page.goto(opt.url, { waitUntil: "networkidle" });
        }
        await page.evaluate(() => document.fonts.ready);

        // Motion script first (real time), then freeze time and start the scenario.
        if (motion) await page.evaluate(motion);
        await page.evaluate(clock);
        await page.evaluate((source) => window.__vr.run(source), scenario);

        const cdp = await context.newCDPSession(page);
        encoder = startEncoder({ out, fps, crf: opt.crf });
        const started = Date.now();
        let frame = 0;
        let endFrame = null;
        for (; frame < maxFrames && (endFrame === null || frame < endFrame); frame++) {
            const status = await page.evaluate((t) => window.__vr.advanceTo(t), frame * frameMs);
            if (status.error) throw new Error(`scenario failed: ${status.error}`);
            if (status.done && endFrame === null) endFrame = frame + tailFrames;
            const { data } = await cdp.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true });
            await encoder.write(Buffer.from(data, "base64"));
            if (frame % fps === 0) process.stdout.write(`\r${(frame / fps).toFixed(0)} s rendered`);
        }
        if (endFrame === null) console.warn(`\nscenario still running after ${opt["max-seconds"]} s, video cut`);
        await encoder.finish();
        const seconds = ((Date.now() - started) / 1000).toFixed(0);
        console.log(`\r${frame} frames (${(frame / fps).toFixed(2)} s at ${fps} fps) in ${seconds} s -> ${out}`);
    } catch (error) {
        encoder?.abort();
        throw error;
    } finally {
        await browser.close();
    }
}

function startEncoder({ out, fps, crf }) {
    const ffmpeg = spawn("docker", [
        "run", "--rm", "-i", "-u", `${process.getuid()}:${process.getgid()}`, "-v", `${dirname(out)}:/out`,
        "--entrypoint", "ffmpeg", FFMPEG_IMAGE, "-loglevel", "error", "-y",
        "-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "-",
        "-c:v", "libx264", "-preset", "slow", "-crf", String(crf), "-pix_fmt", "yuv420p",
        "-r", String(fps), "-movflags", "+faststart", `/out/${basename(out)}`,
    ], { stdio: ["pipe", "inherit", "inherit"] });
    const exited = new Promise((ok, fail) => {
        ffmpeg.on("error", fail);
        ffmpeg.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg exited with ${code}`))));
    });
    return {
        write: (buffer) => (ffmpeg.stdin.write(buffer) ? Promise.resolve() : new Promise((ok) => ffmpeg.stdin.once("drain", ok))),
        finish: () => { ffmpeg.stdin.end(); return exited; },
        abort: () => ffmpeg.kill("SIGKILL"),
    };
}

function applyTheme(script, theme) {
    const swaps = THEMES[theme];
    if (!swaps) throw new Error(`unknown --theme ${theme} (${Object.keys(THEMES).join(", ")})`);
    for (const [from, to] of swaps) {
        if (!script.includes(from)) throw new Error(`--theme ${theme}: colour ${from} not found in the motion script`);
        script = script.replaceAll(from, to);
    }
    return script;
}

function canOpen(path) {
    try { accessSync(path, constants.R_OK | constants.W_OK); return true; } catch { return false; }
}

function shellQuote(arg) {
    return `'${String(arg).replaceAll("'", `'\\''`)}'`;
}
