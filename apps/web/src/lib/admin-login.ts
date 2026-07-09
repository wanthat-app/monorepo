import { getConfig } from "./config";
import { isAdminToken } from "./jwt";

/**
 * Admin (employee) login via the **employee** Cognito pool's Managed Login (ADR-0006 §two-pool):
 * email + password + mandatory TOTP, OAuth authorization-code + PKCE completed in the browser,
 * callback at `/admin/callback`. This mirrors the consumer `managed-login.ts` passkey flow but points
 * at a different pool/client, so an admin session is structurally separate from a customer session —
 * the admin-api authorizer only trusts the employee pool.
 *
 * The resulting tokens are kept in sessionStorage (cleared on tab close); the **id token** is sent as
 * the Bearer to admin-api — the JWT authorizer verifies it like the access token (aud = client id),
 * and its email claim lets audited actions record a readable actor. Its `cognito:groups` also gates
 * the console UI (server re-enforces it).
 */
const VERIFIER_KEY = "wanthat.admin.pkceVerifier";
const STATE_KEY = "wanthat.admin.oauthState";
const TOKENS_KEY = "wanthat.admin.tokens";
const RETURN_TO_KEY = "wanthat.admin.returnTo";

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
  // Remember which admin view started the login, so the callback can land back on the deep link.
  sessionStorage.setItem(RETURN_TO_KEY, window.location.pathname);
  const challenge = base64url(await sha256(verifier));
  const { adminManagedLoginUrl, adminPoolClientId } = getConfig();
  const url = new URL(`${adminManagedLoginUrl}/oauth2/authorize`);
  url.search = new URLSearchParams({
    client_id: adminPoolClientId,
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
 * The admin path stashed by `beginAdminLogin`, single-use, restricted to admin views — anything
 * else (nothing stored, the callback itself, a non-admin path) falls back to the dashboard.
 */
export function consumeAdminReturnPath(): string {
  const stored = sessionStorage.getItem(RETURN_TO_KEY);
  sessionStorage.removeItem(RETURN_TO_KEY);
  return stored?.startsWith("/admin") && stored !== "/admin/callback" ? stored : "/admin";
}

/**
 * Complete the callback: exchange the authorization code (with the stored PKCE verifier) for tokens at
 * the hosted token endpoint, persist them to sessionStorage, and return them.
 */
export async function completeAdminLogin(code: string): Promise<AdminTokens> {
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  if (!verifier) throw new Error("missing PKCE verifier");

  const { adminManagedLoginUrl, adminPoolClientId } = getConfig();
  const res = await fetch(`${adminManagedLoginUrl}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: adminPoolClientId,
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

/**
 * Read the `exp` claim (seconds since epoch) from the access token, or null when undecodable.
 * Unverified, like the other client-side JWT reads: it only schedules a refresh — the authorizer
 * enforces real expiry server-side.
 */
function accessTokenExpSec(accessToken: string): number | null {
  try {
    const payload = accessToken.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as {
      exp?: unknown;
    };
    return typeof json.exp === "number" ? json.exp : null;
  } catch {
    return null;
  }
}

// Refresh early so a token that expires mid-request doesn't slip through as a 401.
const EXPIRY_SKEW_SEC = 60;

// Concurrent callers (parallel API calls all hitting 401) share one refresh round-trip.
let inflightRefresh: Promise<AdminTokens | null> | null = null;

/**
 * Exchange the stored refresh token for a new access/id token pair at the hosted token endpoint and
 * persist it. Cognito's refresh grant returns no new refresh token (no rotation configured), so the
 * stored one is kept. Returns null — without clearing the session — when there is nothing to refresh
 * or the endpoint rejects/errors; callers decide whether that means sign-in.
 */
export function refreshAdminTokens(): Promise<AdminTokens | null> {
  inflightRefresh ??= doRefresh().finally(() => {
    inflightRefresh = null;
  });
  return inflightRefresh;
}

async function doRefresh(): Promise<AdminTokens | null> {
  const stored = loadAdminTokens();
  if (!stored?.refreshToken) return null;
  const { adminManagedLoginUrl, adminPoolClientId } = getConfig();
  try {
    const res = await fetch(`${adminManagedLoginUrl}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: adminPoolClientId,
        refresh_token: stored.refreshToken,
      }).toString(),
    });
    if (!res.ok) return null;
    const t = (await res.json()) as { access_token: string; id_token: string; expires_in: number };
    const tokens: AdminTokens = {
      accessToken: t.access_token,
      idToken: t.id_token,
      refreshToken: stored.refreshToken,
      expiresIn: t.expires_in,
    };
    sessionStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
    return tokens;
  } catch {
    return null;
  }
}

/**
 * The session entry point for /admin: stored tokens if still fresh, a refreshed pair if the access
 * token is expired (or undecodable), or null — with the session cleared — when neither works and
 * the caller should restart the hosted-UI login.
 */
export async function ensureFreshAdminTokens(): Promise<AdminTokens | null> {
  const stored = loadAdminTokens();
  if (!stored) return null;
  const exp = accessTokenExpSec(stored.accessToken);
  if (exp !== null && exp - EXPIRY_SKEW_SEC > Date.now() / 1000) return stored;
  const refreshed = await refreshAdminTokens();
  if (!refreshed) clearAdminTokens();
  return refreshed;
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
