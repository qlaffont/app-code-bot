export interface SlackUser {
    id: string;
    /** Display name, used to title T3 threads. */
    name: string;
    teamId: string;
    isBot: boolean;
    /** Multi-channel guest. */
    isRestricted: boolean;
    /** Single-channel guest. */
    isUltraRestricted: boolean;
    /** Slack Connect user from an organization we don't share a workspace with. */
    isStranger: boolean;
}

export type AccessDecision = { allowed: true } | { allowed: false; reason: "guest" | "external" | "bot" };

/** Only internal members may ask questions. */
export function checkAccess(input: { user: SlackUser; workspaceTeamId: string }): AccessDecision {
    const { user, workspaceTeamId } = input;
    if (user.isBot) return { allowed: false, reason: "bot" };
    if (user.isStranger || user.teamId !== workspaceTeamId) return { allowed: false, reason: "external" };
    if (user.isRestricted || user.isUltraRestricted) return { allowed: false, reason: "guest" };
    return { allowed: true };
}
