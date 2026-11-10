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
    test("allows an internal member in a channel", () => {
        expect(checkAccess({ user: member, channelType: "channel", workspaceTeamId: "T1" })).toEqual({ allowed: true });
    });

    test("allows an internal member in a private channel", () => {
        expect(checkAccess({ user: member, channelType: "group", workspaceTeamId: "T1" })).toEqual({ allowed: true });
    });

    test.each([
        ["multi-channel guest", { isRestricted: true }],
        ["single-channel guest", { isUltraRestricted: true }],
    ])("refuses a %s", (_label, overrides) => {
        expect(
            checkAccess({ user: { ...member, ...overrides }, channelType: "channel", workspaceTeamId: "T1" }),
        ).toEqual({
            allowed: false,
            reason: "guest",
        });
    });

    test.each([
        ["Slack Connect stranger", { isStranger: true }],
        ["member of another workspace", { teamId: "T2" }],
    ])("refuses a %s", (_label, overrides) => {
        expect(
            checkAccess({ user: { ...member, ...overrides }, channelType: "channel", workspaceTeamId: "T1" }),
        ).toEqual({
            allowed: false,
            reason: "external",
        });
    });

    test("refuses bots", () => {
        expect(
            checkAccess({ user: { ...member, isBot: true }, channelType: "channel", workspaceTeamId: "T1" }),
        ).toEqual({
            allowed: false,
            reason: "bot",
        });
    });

    test.each(["im", "mpim"])("refuses direct messages (%s)", (channelType) => {
        expect(checkAccess({ user: member, channelType, workspaceTeamId: "T1" })).toEqual({
            allowed: false,
            reason: "direct_message",
        });
    });
});
