import { profileFromIdToken, type UserProfile } from "./claims";
import { type AuthResultWire, CognitoError, refreshTokens } from "./cognito";

/**
 * The landing app's session state — the same tiny framework-free external store as the member
 * app's (apps/web/src/user/store.ts), trimmed to what `/p/*` needs: rehydrate a stored session,
 * complete a passkey sign-in, read the remembered phone. Cookieless (ADR-0007): access/id
 * tokens live only in memory; ONLY the refresh token is persisted — and the storage KEYS are
 * shared with the member app (same origin, deliberately): a member signed in on the app is
 * signed in on the landing page and vice versa.
 */
const REFRESH_KEY = "wanthat.refreshToken";
/**
 * The remembered phone — written on every successful sign-in, kept across sign-out. It is
 * what makes native passkey login possible on a returning device (ADR-0006: Cognito's
 * WEB_AUTHN challenge is username-gated; userless login is waived).
 */
const PHONE_KEY = "wanthat.phone";

export type SessionStatus = "loading" | "signedOut" | "signedIn";

export interface SessionTokens {
  accessToken: string;
  idToken: string;
  refreshToken: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
}

export interface SessionSnapshot {
  status: SessionStatus;
  tokens: SessionTokens | null;
  profile: UserProfile | null;
}

let state: SessionSnapshot = { status: "loading", tokens: null, profile: null };
const listeners = new Set<() => void>();

function setState(next: SessionSnapshot): void {
  state = next;
  for (const fn of listeners) fn();
}

export function getSnapshot(): SessionSnapshot {
  return state;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// localStorage guards: private mode / tests must degrade, never crash.
function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage disabled — the session simply isn't remembered across reloads.
  }
}
function storageRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

/**
 * Whether a session is persisted on this device (a stored refresh token), read synchronously.
 * A heuristic for "returning member — don't prompt" gates; the actual refresh confirms it.
 */
export function hasStoredSession(): boolean {
  return !!storageGet(REFRESH_KEY);
}

/** The phone of the last member who signed in on this device (E.164), if any. */
export function rememberedPhone(): string | null {
  return storageGet(PHONE_KEY);
}

/**
 * Establish the session from a Cognito `AuthenticationResult`: decode the profile from the
 * ID-token claims, persist the refresh token, and remember the phone for future passkey
 * logins. `RefreshToken` is absent on REFRESH_TOKEN_AUTH responses — the stored one stays.
 */
export function completeSignIn(result: AuthResultWire): void {
  const refreshToken = result.RefreshToken ?? state.tokens?.refreshToken ?? storageGet(REFRESH_KEY);
  if (!refreshToken) throw new CognitoError("MissingRefreshToken", "no refresh token", 0);
  const profile = profileFromIdToken(result.IdToken);
  storageSet(REFRESH_KEY, refreshToken);
  if (profile.phone) storageSet(PHONE_KEY, profile.phone);
  setState({
    status: "signedIn",
    tokens: {
      accessToken: result.AccessToken,
      idToken: result.IdToken,
      refreshToken,
      expiresAt: Date.now() + result.ExpiresIn * 1000,
    },
    profile,
  });
}

/**
 * Drop the session. The refresh token is removed; the remembered phone is KEPT deliberately —
 * it is the passkey-login gate for the next visit.
 */
export function clearSession(): void {
  storageRemove(REFRESH_KEY);
  setState({ status: "signedOut", tokens: null, profile: null });
}

/** The current access token, or null — the Bearer for the attributed resolve call. */
export function currentAccessToken(): string | null {
  return state.tokens?.accessToken ?? null;
}

let rehydrated = false;

/**
 * Re-establish the session from the stored refresh token on first load. Discards the stored
 * token ONLY when Cognito actually rejects it (revoked/expired/disabled → NotAuthorized);
 * a network failure must NOT log a member out — they stay "signedOut" for this page view
 * but the token survives for the next load.
 */
export async function rehydrate(): Promise<void> {
  if (rehydrated) return;
  rehydrated = true;
  const stored = storageGet(REFRESH_KEY);
  if (!stored) {
    setState({ status: "signedOut", tokens: null, profile: null });
    return;
  }
  try {
    const res = await refreshTokens(stored);
    if (!res.AuthenticationResult) throw new CognitoError("UnknownError", "no tokens", 0);
    completeSignIn(res.AuthenticationResult);
  } catch (err) {
    if (err instanceof CognitoError && err.name === "NotAuthorizedException") {
      clearSession();
    } else {
      setState({ status: "signedOut", tokens: null, profile: null });
    }
  }
}
