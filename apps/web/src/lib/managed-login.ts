import type { AuthSession } from "@wanthat/contracts";
import { meApi } from "./api";
import { getConfig } from "./config";

/**
 * Discoverable (userless) passkey login via Cognito Managed Login (ADR-0006). The raw Cognito API
 * can't do username-less WebAuthn, so we redirect to the hosted UI and complete the OAuth
 * authorization-code + PKCE exchange **in the browser** (the in-VPC API can't reach the hosted token
 * endpoint). The resulting tokens are then used as a normal Bearer session.
 */
const VERIFIER_KEY = "wanthat.pkceVerifier";
const STATE_KEY = "wanthat.oauthState";

// Computed lazily (not at module load) so the module is importable in a DOM-less context.
const redirectUri = () => `${window.location.origin}/auth/callback`;

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
 * Redirect to the hosted UI to begin a discoverable passkey login. Stores the PKCE verifier and a
 * random `state` (CSRF) in sessionStorage; `state` is echoed back on the callback and verified
 * before the code is exchanged.
 */
export async function beginPasskeyLogin(): Promise<void> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);
  const challenge = base64url(await sha256(verifier));
  const { managedLoginUrl, userPoolClientId } = getConfig();
  const url = new URL(`${managedLoginUrl}/oauth2/authorize`);
  url.search = new URLSearchParams({
    client_id: userPoolClientId,
    response_type: "code",
    scope: "openid phone profile",
    redirect_uri: redirectUri(),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  }).toString();
  window.location.assign(url.toString());
}

/**
 * Verify the `state` returned on the OAuth callback against the value stashed by `beginPasskeyLogin`
 * (CSRF defence). The stored value is single-use: it is cleared whether or not it matched. Returns
 * false when nothing was stored or the values differ.
 */
export function verifyOauthState(received: string | null): boolean {
  const expected = sessionStorage.getItem(STATE_KEY);
  sessionStorage.removeItem(STATE_KEY);
  return !!expected && !!received && received === expected;
}

/**
 * Complete the callback: exchange the authorization code (with the stored PKCE verifier) for tokens
 * at the hosted token endpoint, then load the profile. Returns null if the user has tokens but no
 * customer row yet (the caller routes them to onboarding).
 */
export async function completePasskeyLogin(code: string): Promise<AuthSession | null> {
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  if (!verifier) throw new Error("missing PKCE verifier");

  const { managedLoginUrl, userPoolClientId } = getConfig();
  const res = await fetch(`${managedLoginUrl}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: userPoolClientId,
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
  const tokens = {
    accessToken: t.access_token,
    idToken: t.id_token,
    refreshToken: t.refresh_token,
    tokenType: "Bearer" as const,
    expiresIn: t.expires_in,
  };
  try {
    const { profile } = await meApi.get(tokens.accessToken);
    return { tokens, customer: profile };
  } catch {
    return null; // authenticated but unregistered — caller sends to onboarding
  }
}
