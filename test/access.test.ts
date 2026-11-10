import { describe, expect, test } from "bun:test";

import { checkAccess, type SlackUser } from "../src/access";

const member: SlackUser = {
    id: "U1",
    name: "Alice",
    teamId: "T1",
    isBot: false,
    isRestricted: false,
    isUltraRestricted: false,
    isStranger: false,
};

describe("checkAccess", () => {
    test("allows an internal member", () => {
        expect(checkAccess({ user: member, workspaceTeamId: "T1" })).toEqual({ allowed: true });
    });

    test.each([
        ["multi-channel guest", { isRestricted: true }],
        ["single-channel guest", { isUltraRestricted: true }],
    ])("refuses a %s", (_label, overrides) => {
        expect(checkAccess({ user: { ...member, ...overrides }, workspaceTeamId: "T1" })).toEqual({
            allowed: false,
            reason: "guest",
        });
    });

    test.each([
        ["Slack Connect stranger", { isStranger: true }],
        ["member of another workspace", { teamId: "T2" }],
    ])("refuses a %s", (_label, overrides) => {
        expect(checkAccess({ user: { ...member, ...overrides }, workspaceTeamId: "T1" })).toEqual({
            allowed: false,
            reason: "external",
        });
    });

    test("refuses bots", () => {
        expect(checkAccess({ user: { ...member, isBot: true }, workspaceTeamId: "T1" })).toEqual({
            allowed: false,
            reason: "bot",
        });
    });
});
