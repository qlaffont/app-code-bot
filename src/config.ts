export interface Config {
    slackBotToken: string;
    slackAppToken: string;
    slackAdminChannel?: string;
    t3Url: string;
    t3RootToken: string;
    /** T3 project id or title. */
    t3Project: string;
    t3ProviderInstanceId: string;
    t3Model: string;
    t3Effort: string;
    answerTimeoutMs: number;
    dbPath: string;
    systemPromptPath: string;
    /** T3's data folder on the host; its attachments/ and browser-artifacts/ hold captures. */
    t3UserdataDir: string;
    /** Folder the agent writes its own captures to (Playwright fallback). */
    capturesDir: string;
    /** Folder holding the agent's builds, one per repository and commit. */
    buildCacheDir: string;
    /** Environment named in a question → branch to read (e.g. staging → staging). */
    branchMap: Record<string, string>;
}

const DEFAULT_BRANCH_MAP = "prod:main,demo:main,staging:staging,dev:dev";

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
    const missing: string[] = [];
    const required = (name: string): string => {
        const value = env[name]?.trim();
        if (!value) missing.push(name);
        return value ?? "";
    };
    const optional = (name: string, fallback: string): string => env[name]?.trim() || fallback;

    const config: Config = {
        slackBotToken: required("SLACK_BOT_TOKEN"),
        slackAppToken: required("SLACK_APP_TOKEN"),
        slackAdminChannel: env.SLACK_ADMIN_CHANNEL?.trim() || undefined,
        t3Url: optional("T3_URL", "http://127.0.0.1:3773"),
        t3RootToken: required("T3_ROOT_TOKEN"),
        t3Project: required("T3_PROJECT_ID"),
        t3ProviderInstanceId: optional("T3_PROVIDER_INSTANCE", "claudeAgent"),
        t3Model: optional("T3_MODEL", "claude-sonnet-5-5"),
        t3Effort: optional("T3_EFFORT", "high"),
        answerTimeoutMs: Number(optional("ANSWER_TIMEOUT_MS", String(8 * 60_000))),
        dbPath: optional("DB_PATH", "./data/app-code-bot.sqlite"),
        systemPromptPath: optional("SYSTEM_PROMPT_PATH", "./prompts/system.md"),
        t3UserdataDir: required("T3_USERDATA_DIR"),
        capturesDir: required("CAPTURES_DIR"),
        buildCacheDir: required("BUILD_CACHE_DIR"),
        branchMap: {},
    };
    if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}`);
    config.branchMap = parseBranchMap(optional("BRANCH_MAP", DEFAULT_BRANCH_MAP));
    if (!Number.isFinite(config.answerTimeoutMs) || config.answerTimeoutMs <= 0) {
        throw new Error("ANSWER_TIMEOUT_MS must be a positive number of milliseconds");
    }
    return config;
}

/** Parses `env:branch,env:branch` (e.g. `prod:main,staging:staging`). */
function parseBranchMap(value: string): Record<string, string> {
    const map: Record<string, string> = {};
    for (const pair of value.split(",")) {
        const [env, branch, ...rest] = pair.split(":").map((part) => part.trim());
        if (!env || !branch || rest.length) {
            throw new Error(`BRANCH_MAP must look like "prod:main,staging:staging", got "${value}"`);
        }
        map[env] = branch;
    }
    return map;
}
