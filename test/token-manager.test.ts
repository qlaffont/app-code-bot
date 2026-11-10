import { beforeEach, describe, expect, test } from "bun:test";

import { createDatabase } from "../src/db/database";
import { createTokenManager, type TokenManager } from "../src/token-manager";

const DAY = 24 * 60 * 60_000;

let now: number;
let issued: number;
let failIssue: boolean;
let alerts: string[];
let manager: TokenManager;

beforeEach(() => {
    now = Date.parse("2026-11-10T00:00:00Z");
    issued = 0;
    failIssue = false;
    alerts = [];
    manager = createTokenManager({
        db: createDatabase(":memory:"),
        now: () => now,
        issue: async () => {
            if (failIssue) throw new Error("T3 refused the root token");
            issued++;
            return { token: `token-${issued}`, expiresAt: new Date(now + 30 * DAY) };
        },
        alertAdmin: async (text) => {
            alerts.push(text);
        },
    });
});

describe("the T3 token manager", () => {
    test("issues a token on first use, then reuses it", async () => {
        expect(await manager.getToken()).toBe("token-1");
        now += 10 * DAY;
        expect(await manager.getToken()).toBe("token-1");
        expect(issued).toBe(1);
    });

    test("renews the token 5 days before it expires", async () => {
        await manager.getToken();
        now += 24 * DAY;
        expect(await manager.getToken()).toBe("token-1");
        now += 2 * DAY;
        expect(await manager.getToken()).toBe("token-2");
    });

    test("renews immediately once T3 has rejected the token", async () => {
        await manager.getToken();
        manager.invalidate("token-1");
        expect(await manager.getToken()).toBe("token-2");
    });

    test("ignores a rejection of a token that was already replaced", async () => {
        await manager.getToken();
        manager.invalidate("token-1");
        await manager.getToken();
        manager.invalidate("token-1");
        expect(await manager.getToken()).toBe("token-2");
    });

    test("issues once when several questions need a token at the same time", async () => {
        const tokens = await Promise.all([manager.getToken(), manager.getToken(), manager.getToken()]);
        expect(tokens).toEqual(["token-1", "token-1", "token-1"]);
        expect(issued).toBe(1);
    });

    test("alerts the admins and fails when there is no usable token", async () => {
        failIssue = true;
        await expect(manager.getToken()).rejects.toThrow("T3 refused the root token");
        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toContain("T3_ROOT_TOKEN");
    });

    test("keeps using the current token while an early renewal fails, alerting once", async () => {
        await manager.getToken();
        now += 26 * DAY;
        failIssue = true;

        expect(await manager.getToken()).toBe("token-1");
        expect(await manager.getToken()).toBe("token-1");
        expect(alerts).toHaveLength(1);
    });

    test("alerts again once a renewal has succeeded in between", async () => {
        failIssue = true;
        await manager.getToken().catch(() => undefined);
        failIssue = false;
        await manager.getToken();
        manager.invalidate("token-1");
        failIssue = true;
        await manager.getToken().catch(() => undefined);

        expect(alerts).toHaveLength(2);
    });
});
