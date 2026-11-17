// Chrome binary and flags used for rendering.
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function t3HeadlessShell() {
    const root = join(homedir(), ".t3/tools/chrome-headless-shell/linux64");
    const versions = readdirSync(root).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return join(root, versions.at(-1), "chrome-headless-shell");
}

export const CHROME_BIN = process.env.VIDEO_RENDER_CHROME ?? t3HeadlessShell();
