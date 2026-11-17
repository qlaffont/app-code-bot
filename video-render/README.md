# video-render

Renders the motion-design demo videos (Manager) **outside T3**, frame by frame:
1920x1080, **constant 60 fps**, Chrome drawing on the Intel GPU.

## Why not the T3 recorder

T3's `preview_recording_*` captures a 4K screencast (device scale factor 2) from a
`chrome-headless-shell` launched with SwiftShader (CPU rendering). It delivers
10–20 frames/s at irregular intervals; padding that to 30 fps makes zooms jerky.

## How it works

1. Launches T3's `chrome-headless-shell` with ANGLE on EGL (`--use-gl=angle --use-angle=gl-egl`),
   **without** `--enable-unsafe-swiftshader`, and refuses to render if WebGL reports SwiftShader.
2. `--setup` logs in / opens the page in real time (e.g. `examples/manager-login.mjs`).
3. Injects the motion-design script (`~/.claude/projects/-home/memory/video-motion-design.js`),
   then `virtual-clock.js`: page timers, `requestAnimationFrame`, `performance.now`/`Date.now`
   and every CSS/Web animation are frozen and only advance by exactly 1/60 s per frame.
4. For each frame: advance the clock, `Page.captureScreenshot` (PNG), pipe into ffmpeg
   (`jrottenberg/ffmpeg:7.1-ubuntu`, libx264 CRF 16, yuv420p, faststart).

Rendering takes ~2.5–3× the video length; the result is perfectly regular whatever the machine load.
Network calls (fetch) still run in real time: load the data before the scenario starts.

## Usage

```sh
cd ~/video-render
MANAGER_WAIT_TEXT="Une video d'exemple" node render.mjs \
  --setup examples/manager-login.mjs \
  --url http://localhost:4000/users/5b528169-8e5e-453c-b1b6-62d45424ae64 \
  --scenario examples/test-apres.js \
  --out /path/to/clip.mp4
```

- `--scenario`: body of an async function run in the page; `window.__md` (motion design) is available.
  No initial blank to cut: the video starts at the scenario's first frame.
- `--fps 60 --width 1920 --height 1080 --crf 16 --tail 300` (ms kept after the end).
- `--theme teal` (default, app):
  swaps the colours of the motion-design script when it is injected.
- Before/after: render two clips with the same settings, then
  `ffmpeg -f concat -safe 0 -i list.txt -c copy out.mp4`.
- `node gpu-probe.mjs [--flags]` prints the WebGL renderer Chrome gets.

## GPU access

Chrome needs `/dev/dri/renderD128` (group `render`).
Sessions opened before that don't have the group yet: `render.mjs` re-runs itself through
`sg render` when it cannot open the device.
