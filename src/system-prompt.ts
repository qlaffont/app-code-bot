export interface SystemPromptValues {
    capturesDir: string;
    buildCacheDir: string;
    branchMap: Record<string, string>;
}

/** Fills the `{{…}}` placeholders of prompts/system.md; a leftover placeholder is a typo in the prompt. */
export function renderSystemPrompt(template: string, values: SystemPromptValues): string {
    const branchMap = Object.entries(values.branchMap)
        .map(([env, branch]) => `  - \`${env}\` → \`${branch}\``)
        .join("\n");
    const prompt = template
        .replaceAll("{{CAPTURES_DIR}}", values.capturesDir)
        .replaceAll("{{BUILD_CACHE_DIR}}", values.buildCacheDir)
        .replaceAll("{{BRANCH_MAP}}", branchMap)
        .trim();
    const leftover = prompt.match(/\{\{[^{}]*\}\}/);
    if (leftover) throw new Error(`Unknown placeholder ${leftover[0]} in the system prompt`);
    return prompt;
}
