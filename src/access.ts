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

export type AccessDecision =
    | { allowed: true }
    | { allowed: false; reason: "guest" | "external" | "bot" | "direct_message" };

/** Only internal members may ask questions, and only in channels (never in DMs). */
export function checkAccess(input: { user: SlackUser; channelType: string; workspaceTeamId: string }): AccessDecision {
    const { user, channelType, workspaceTeamId } = input;
    if (channelType === "im" || channelType === "mpim") return { allowed: false, reason: "direct_message" };
    if (user.isBot) return { allowed: false, reason: "bot" };
    if (user.isStranger || user.teamId !== workspaceTeamId) return { allowed: false, reason: "external" };
    if (user.isRestricted || user.isUltraRestricted) return { allowed: false, reason: "guest" };
    return { allowed: true };
}
