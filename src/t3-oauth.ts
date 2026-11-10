/**
 * Obtains a full-access T3 MCP token without a human: T3 only grants
 * full-access through its OAuth flow, and that flow can be approved with a
 * pairing code, which a long-lived "root" session (scope `access:write`) can
 * mint itself. Tokens from this flow last 30 days and can't be refreshed, so
 * the bot simply runs the flow again (see token-manager.ts).
 */

export interface IssuedToken {
    token: string;
    expiresAt: Date;
}

// Scopes T3 requires for a full-access MCP client; the root token must hold them all.
const FULL_ACCESS_SCOPES = ["orchestration:read", "orchestration:operate", "settings:write", "source-control:write"];
// Loopback redirect: nothing listens there, the code is read from the redirect URL.
const REDIRECT_URI = "http://127.0.0.1/app-code-bot/callback";
const CLIENT_NAME = "app-code-bot";

export async function issueFullAccessToken(input: { url: string; rootToken: string }): Promise<IssuedToken> {
    const endpoint = (path: string) => new URL(path, input.url).toString();

    const pairing = await postJson<{ credential: string }>(
        endpoint("/api/auth/pairing-token"),
        { label: `${CLIENT_NAME} renewal`, scopes: FULL_ACCESS_SCOPES },
        { Authorization: `Bearer ${input.rootToken}` },
    );

    const client = await postJson<{ client_id: string }>(endpoint("/oauth/mcp/register"), {
        client_name: CLIENT_NAME,
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: "none",
    });

    const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = base64Url(
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
    );
    const resource = endpoint("/mcp");
    const approval = await postJson<{ redirectTo: string }>(endpoint("/oauth/mcp/decision"), {
        authorization: {
            response_type: "code",
            client_id: client.client_id,
            redirect_uri: REDIRECT_URI,
            code_challenge: challenge,
            code_challenge_method: "S256",
            resource,
        },
        decision: { _tag: "pairing-code", access: "full-access", code: pairing.credential },
    });
    const code = new URL(approval.redirectTo).searchParams.get("code");
    if (!code) throw new Error(`T3 OAuth approval returned no code: ${new URL(approval.redirectTo).search}`);

    const response = await fetch(endpoint("/oauth/mcp/token"), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: REDIRECT_URI,
            client_id: client.client_id,
            code_verifier: verifier,
            resource,
        }),
    });
    if (!response.ok) throw new Error(`T3 OAuth token exchange failed: ${response.status} ${await response.text()}`);
    const token = (await response.json()) as { access_token: string; expires_in: number };
    return { token: token.access_token, expiresAt: new Date(Date.now() + token.expires_in * 1000) };
}

async function postJson<T>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        throw new Error(`T3 ${new URL(url).pathname} failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as T;
}

function base64Url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64url");
}
