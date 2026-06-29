import type { AuthSession } from "@wanthat/contracts";
import { meApi } from "./api";

/**
 * Discoverable (userless) passkey login via Cognito Managed Login (ADR-0020). The raw Cognito API
 * can't do username-less WebAuthn, so we redirect to the hosted UI and complete the OAuth
 * authorization-code + PKCE exchange **in the browser** (the in-VPC API can't reach the hosted token
 * endpoint). The resulting tokens are then used as a normal Bearer session.
 */
const MANAGED_LOGIN_URL: string = import.meta.env.VITE_MANAGED_LOGIN_URL ?? "";
const CLIENT_ID: string = import.meta.env.VITE_USER_POOL_CLIENT_ID ?? "";
const REDIRECT_URI = `${window.location.origin}/auth/callback`;
const VERIFIER_KEY = "wanthat.pkceVerifier";

function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sha256(input: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
}

/** Redirect to the hosted UI to begin a discoverable passkey login (stores the PKCE verifier). */
export async function beginPasskeyLogin(): Promise<void> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  const challenge = base64url(await sha256(verifier));
  const url = new URL(`${MANAGED_LOGIN_URL}/oauth2/authorize`);
  url.search = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    scope: "openid phone profile",
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  window.location.assign(url.toString());
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

  const res = await fetch(`${MANAGED_LOGIN_URL}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
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
