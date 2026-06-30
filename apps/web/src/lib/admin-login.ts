import { isAdminToken } from "./jwt";

/**
 * Admin (employee) login via the **employee** Cognito pool's Managed Login (ADR-0020 §two-pool):
 * email + password + mandatory TOTP, OAuth authorization-code + PKCE completed in the browser,
 * callback at `/admin/callback`. This mirrors the consumer `managed-login.ts` passkey flow but points
 * at a different pool/client, so an admin session is structurally separate from a customer session —
 * the admin-api authorizer only trusts the employee pool.
 *
 * The resulting tokens are kept in sessionStorage (cleared on tab close); the access token is sent as
 * a Bearer to admin-api, the id token's `cognito:groups` gates the console UI (server re-enforces it).
 */
const MANAGED_LOGIN_URL: string = import.meta.env.VITE_ADMIN_MANAGED_LOGIN_URL ?? "";
const CLIENT_ID: string = import.meta.env.VITE_ADMIN_POOL_CLIENT_ID ?? "";
const VERIFIER_KEY = "wanthat.admin.pkceVerifier";
const STATE_KEY = "wanthat.admin.oauthState";
const TOKENS_KEY = "wanthat.admin.tokens";

export interface AdminTokens {
  accessToken: string;
  idToken: string;
  refreshToken: string;
  expiresIn: number;
}

// Computed lazily (not at module load) so the module is importable in a DOM-less context.
const redirectUri = () => `${window.location.origin}/admin/callback`;

function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sha256(input: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
}

/**
 * Redirect to the employee hosted UI to begin an admin login. Stores the PKCE verifier and a random
 * `state` (CSRF) in sessionStorage; `state` is echoed back on the callback and verified before the
 * code is exchanged.
 */
export async function beginAdminLogin(): Promise<void> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);
  const challenge = base64url(await sha256(verifier));
  const url = new URL(`${MANAGED_LOGIN_URL}/oauth2/authorize`);
  url.search = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    scope: "openid email profile",
    redirect_uri: redirectUri(),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  }).toString();
  window.location.assign(url.toString());
}

/**
 * Verify the `state` returned on the OAuth callback against the value stashed by `beginAdminLogin`
 * (CSRF defence). The stored value is single-use: it is cleared whether or not it matched. Returns
 * false when nothing was stored or the values differ.
 */
export function verifyAdminOauthState(received: string | null): boolean {
  const expected = sessionStorage.getItem(STATE_KEY);
  sessionStorage.removeItem(STATE_KEY);
  return !!expected && !!received && received === expected;
}

/**
 * Complete the callback: exchange the authorization code (with the stored PKCE verifier) for tokens at
 * the hosted token endpoint, persist them to sessionStorage, and return them.
 */
export async function completeAdminLogin(code: string): Promise<AdminTokens> {
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  if (!verifier) throw new Error("missing PKCE verifier");

  const res = await fetch(`${MANAGED_LOGIN_URL}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      redirect_uri: redirectUri(),
      code_verifier: verifier,
    }).toString(),
  });
  if (!res.ok) throw new Error("token exchange failed");
  const t = (await res.json()) as {
    access_token: string;
    id_token: string;
    refresh_token: string;
    expires_in: number;
  };
  const tokens: AdminTokens = {
    accessToken: t.access_token,
    idToken: t.id_token,
    refreshToken: t.refresh_token,
    expiresIn: t.expires_in,
  };
  sessionStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
  return tokens;
}

/** Load the stored admin tokens (e.g. on an /admin reload within the tab), or null if none. */
export function loadAdminTokens(): AdminTokens | null {
  const raw = sessionStorage.getItem(TOKENS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AdminTokens;
  } catch {
    return null;
  }
}

/** Clear the stored admin tokens (sign-out). */
export function clearAdminTokens(): void {
  sessionStorage.removeItem(TOKENS_KEY);
}

/** Whether the stored tokens carry the Cognito `admin` group (UI gating only; server re-enforces). */
export function isAdminSession(tokens: AdminTokens | null): boolean {
  return isAdminToken(tokens?.idToken);
}
