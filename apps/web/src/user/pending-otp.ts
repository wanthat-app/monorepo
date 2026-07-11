/**
 * Reload-survival for the OTP validation phase. The core use case: the member switches apps
 * to copy the code from Messages/WhatsApp and the mobile browser evicts + reloads the tab on
 * return — without persistence that lands them back on the phone screen mid-validation.
 *
 * The pending challenge lives in sessionStorage (per-tab; survives the eviction reload, gone
 * when the tab closes) and is restored only while the code is still valid server-side:
 * - login: Cognito's SMS_OTP `Session` string is the whole challenge state and works across
 *   reloads, but dies server-side after ~3 minutes (the pool-default session validity) — the
 *   TTL mirrors that so we never restore a dead screen.
 * - sign-up: `ConfirmSignUp` is stateless (phone + code, code valid for hours); the TTL is a
 *   pragmatic freshness bound for the switch-away-and-return case.
 */

const KEY = "wanthat.pendingOtp";
const LOGIN_TTL_MS = 3 * 60_000;
const SIGNUP_TTL_MS = 15 * 60_000;

export type PendingOtp =
  | { kind: "login"; phone: string; session: string; username: string; expiresAt: number }
  | { kind: "signup"; phone: string; expiresAt: number };

// sessionStorage can throw (Safari private mode, storage disabled) — the feature degrades
// to the old reload-loses-state behavior, never to a broken flow.
function write(pending: PendingOtp): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(pending));
  } catch {
    // best-effort
  }
}

export function savePendingLoginOtp(phone: string, session: string, username: string): void {
  write({ kind: "login", phone, session, username, expiresAt: Date.now() + LOGIN_TTL_MS });
}

export function savePendingSignupOtp(phone: string): void {
  write({ kind: "signup", phone, expiresAt: Date.now() + SIGNUP_TTL_MS });
}

/** The persisted challenge, or null if none/expired/unreadable (expired entries are removed). */
export function loadPendingOtp(): PendingOtp | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const pending = JSON.parse(raw) as PendingOtp;
    if (typeof pending?.expiresAt !== "number" || pending.expiresAt <= Date.now()) {
      clearPendingOtp();
      return null;
    }
    return pending;
  } catch {
    return null;
  }
}

export function hasPendingOtp(): boolean {
  return loadPendingOtp() !== null;
}

export function clearPendingOtp(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // best-effort
  }
}
