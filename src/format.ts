/**
 * Turns the agent's Markdown answer into Slack-ready message chunks:
 * code blocks are dropped (the bot never shares code), Markdown becomes mrkdwn,
 * and long answers are split to stay under Slack's message size.
 */
export function formatAnswer(markdown: string, { maxChunkLength = 3500 } = {}): string[] {
    const withoutCode = markdown.replace(/(```|~~~)[\s\S]*?(\1|$)/g, "");
    const text = toMrkdwn(withoutCode)
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    return splitIntoChunks(text, maxChunkLength);
}

function splitIntoChunks(text: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let current = "";
    for (const paragraph of text.split("\n\n")) {
        const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
        if (candidate.length <= maxLength) {
            current = candidate;
            continue;
        }
        if (current) chunks.push(current);
        current = paragraph;
        while (current.length > maxLength) {
            chunks.push(current.slice(0, maxLength));
            current = current.slice(maxLength);
        }
    }
    if (current) chunks.push(current);
    return chunks;
}

// Bold is marked with a placeholder while italics are converted, so Slack's
// single-asterisk bold isn't mistaken for Markdown italics.
const BOLD = "\u0000";

function toMrkdwn(markdown: string): string {
    return markdown
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/^([ \t]*)[-*+] /gm, "$1• ")
        .replace(
            /^#{1,6}[ \t]+(.+?)[ \t]*#*$/gm,
            (_match, title: string) => `${BOLD}${title.replace(/\*\*/g, "")}${BOLD}`,
        )
        .replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${BOLD}`)
        .replace(/(?<![\w*])\*(?![\s*])([^*\n]+?)(?<!\s)\*(?![\w*])/g, "_$1_")
        .replaceAll(BOLD, "*")
        .replace(/~~(.+?)~~/g, "~$1~")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>");
}
