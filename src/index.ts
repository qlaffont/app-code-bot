import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { loadConfig } from "./config";
import { createDatabase } from "./db/database";
import { log } from "./log";
import { createMediaReader } from "./media-reader";
import { createMentionHandler } from "./mention-handler";
import { connectSlack } from "./slack-bolt";
import { createT3McpClient } from "./t3-mcp";
import { issueFullAccessToken } from "./t3-oauth";
import { createThreadStore } from "./thread-store";
import { createTokenManager } from "./token-manager";

const POLL_INTERVAL_MS = 15_000;
const TOKEN_CHECK_INTERVAL_MS = 6 * 60 * 60_000;

const config = loadConfig();
mkdirSync(dirname(config.dbPath), { recursive: true });

const systemPrompt = (await Bun.file(config.systemPromptPath).text())
    .replaceAll("{{CAPTURES_DIR}}", config.capturesDir)
    .trim();
const db = createDatabase(config.dbPath);
const slack = await connectSlack({
    botToken: config.slackBotToken,
    appToken: config.slackAppToken,
    adminChannel: config.slackAdminChannel,
});
const tokens = createTokenManager({
    db,
    issue: () => issueFullAccessToken({ url: config.t3Url, rootToken: config.t3RootToken }),
    alertAdmin: (text) => slack.alertAdmin(text),
});
const t3 = createT3McpClient({
    url: config.t3Url,
    tokens,
    project: config.t3Project,
    providerInstanceId: config.t3ProviderInstanceId,
    model: config.t3Model,
    effort: config.t3Effort,
});

// Renew early and report a broken root token even when nobody asks anything.
// A failure is already alerted once; the bot keeps running to answer "error".
const checkToken = () => tokens.getToken().catch(() => undefined);
await checkToken();
setInterval(checkToken, TOKEN_CHECK_INTERVAL_MS);

// A wrong T3_PROJECT_ID makes every question fail with a vague T3 error: stop now and say why.
const projectId = await t3.resolveProjectId().catch((error: unknown) => {
    log("error", "invalid T3_PROJECT_ID", { error });
    process.exit(1);
});

await slack.start(
    createMentionHandler({
        slack: slack.port,
        t3,
        store: createThreadStore(db),
        // T3's attachments folder also holds everyone's uploads: only its recordings (videos) may be published.
        media: createMediaReader([
            { dir: join(config.t3UserdataDir, "browser-artifacts"), kinds: ["image", "video"] },
            { dir: join(config.t3UserdataDir, "attachments"), kinds: ["video"] },
            { dir: config.capturesDir, kinds: ["image", "video"] },
        ]),
        systemPrompt,
        botUserId: slack.botUserId,
        workspaceTeamId: slack.workspaceTeamId,
        answerTimeoutMs: config.answerTimeoutMs,
        pollIntervalMs: POLL_INTERVAL_MS,
    }),
);
log("info", "app-code-bot ready", { project: config.t3Project, projectId, model: config.t3Model });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
        log("info", "shutting down", { signal });
        await slack.stop().catch(() => undefined);
        process.exit(0);
    });
}
