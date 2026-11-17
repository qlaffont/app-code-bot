// --setup for the local Manager (http://localhost:4000): logs in with the
// seeded support account, opens --url and waits for MANAGER_WAIT_TEXT if set.
// The password is the seed one, read from ~/manager/.env.development.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.env.MANAGER_URL ?? "http://localhost:4000";
const EMAIL = process.env.MANAGER_EMAIL ?? "support@test.monapp.co";

function seedPassword() {
    if (process.env.MANAGER_PASSWORD) return process.env.MANAGER_PASSWORD;
    const env = readFileSync(join(homedir(), "manager/.env.development"), "utf8");
    const match = env.match(/^VITE_JOHN_DOE_PASSWORD=(.*)$/m);
    if (!match) throw new Error("VITE_JOHN_DOE_PASSWORD not found in ~/manager/.env.development");
    return match[1].trim().replace(/^["']|["']$/g, "");
}

export default async function setup({ page, url }) {
    // Vite dev keeps a socket open, so wait for the form rather than for network idle.
    await page.goto(`${BASE}/login`, { timeout: 120_000 });
    await page.locator('input[type="email"]').waitFor({ timeout: 120_000 });
    // Clicking before React hydrates would submit the form natively (GET /login?password=…).
    await page.waitForFunction(
        () => {
            const form = document.querySelector("form");
            return form && Object.keys(form).some((key) => key.startsWith("__react"));
        },
        null,
        { timeout: 120_000 },
    );
    await page.locator('input[type="email"]').fill(EMAIL);
    await page.locator('input[type="password"]').fill(seedPassword());
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });
    if (url) await page.goto(url, { timeout: 120_000 });
    if (process.env.MANAGER_WAIT_TEXT)
        await page.getByText(process.env.MANAGER_WAIT_TEXT).first().waitFor({ timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await page.addStyleTag({
        content: 'button[aria-label="Open TanStack Devtools"],[class*="tsqd-open-btn"]{display:none!important}',
    });
}
