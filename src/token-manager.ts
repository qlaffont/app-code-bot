import { eq } from "drizzle-orm";

import type { Db } from "./db/database";
import type { IssuedToken } from "./t3-oauth";

import { t3Credentials } from "./db/schema";
import { log } from "./log";

export interface TokenManager {
    /** A valid full-access token, issuing a new one when needed. */
    getToken(): Promise<string>;
    /** T3 rejected `token`: the next getToken() issues a new one. */
    invalidate(token: string): void;
}

const ROW_ID = "mcp";
// T3 tokens last 30 days: start renewing 5 days before, so a broken root token
// is reported while the current token still works.
const RENEW_BEFORE_EXPIRY_MS = 5 * 24 * 60 * 60_000;

export function createTokenManager(deps: {
    db: Db;
    issue: () => Promise<IssuedToken>;
    alertAdmin: (text: string) => Promise<void>;
    now?: () => number;
}): TokenManager {
    const now = deps.now ?? Date.now;
    let renewal: Promise<string> | undefined;
    // One alert per failure streak, not one per question.
    let alerted = false;

    const readStoredToken = () => deps.db.select().from(t3Credentials).where(eq(t3Credentials.id, ROW_ID)).get();

    const renew = async (): Promise<string> => {
        try {
            const { token, expiresAt } = await deps.issue();
            const values = { token, expiresAt: expiresAt.toISOString() };
            deps.db
                .insert(t3Credentials)
                .values({ id: ROW_ID, ...values })
                .onConflictDoUpdate({ target: t3Credentials.id, set: values })
                .run();
            log("info", "issued a new T3 token", { expiresAt: values.expiresAt });
            alerted = false;
            return token;
        } catch (error) {
            log("error", "could not issue a T3 token", { error });
            if (!alerted) {
                alerted = true;
                await deps
                    .alertAdmin(
                        `⚠️ AppCode n'arrive pas à renouveler son jeton T3 (${String(error)}). Vérifie T3_ROOT_TOKEN et que T3 tourne.`,
                    )
                    .catch((alertError) => log("error", "admin alert failed", { error: alertError }));
            }
            throw error;
        }
    };

    return {
        async getToken() {
            const current = readStoredToken();
            const remainingMs = current ? Date.parse(current.expiresAt) - now() : 0;
            if (current && remainingMs > RENEW_BEFORE_EXPIRY_MS) return current.token;
            renewal ??= renew().finally(() => {
                renewal = undefined;
            });
            try {
                return await renewal;
            } catch (error) {
                // An early renewal failed: the current token still works until it expires.
                if (current && remainingMs > 0) return current.token;
                throw error;
            }
        },
        invalidate(token) {
            if (readStoredToken()?.token === token) {
                deps.db.delete(t3Credentials).where(eq(t3Credentials.id, ROW_ID)).run();
            }
        },
    };
}
