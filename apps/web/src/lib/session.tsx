import type { AuthSession, AuthTokens, CustomerProfile } from "@wanthat/contracts";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { ApiError, authApi, meApi } from "./api";
import { isAdminToken } from "./jwt";

/**
 * Session state (ADR-0007, cookieless). Access/id tokens live only in memory; the refresh token is
 * persisted to localStorage so a reload can silently re-establish the session via `/auth/refresh` +
 * `/me`. No token is ever written to a cookie.
 */
const REFRESH_KEY = "wanthat.refreshToken";

/**
 * Whether a session is persisted on this device (a stored refresh token), read synchronously. A page
 * can use this before rehydration completes to decide "this is a returning member — don't ask them to
 * log in again". It is a heuristic (the token may be expired/revoked); the actual refresh confirms it.
 */
export function hasStoredSession(): boolean {
  try {
    return !!localStorage.getItem(REFRESH_KEY);
  } catch {
    return false;
  }
}

/**
 * Persist a session from its refresh token alone — the Aurora-free landing path (ADR-0007): the /p/
 * page verifies a passkey, stores the rotated refresh token, and redirects to the store without ever
 * resolving the profile. The next app-proper page load rehydrates normally.
 */
export function persistRefreshToken(refreshToken: string): void {
  try {
    localStorage.setItem(REFRESH_KEY, refreshToken);
  } catch {
    // storage disabled (private mode) — the redirect still happens, the session just isn't remembered.
  }
}

interface SessionState {
  customer: CustomerProfile | null;
  tokens: AuthTokens | null;
  loading: boolean;
  /** Whether the id token carries the Cognito `admin` group (UI gating only). */
  isAdmin: boolean;
  signIn: (session: AuthSession) => void;
  signOut: () => Promise<void>;
  accessToken: () => string | null;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [customer, setCustomer] = useState<CustomerProfile | null>(null);
  const [tokens, setTokens] = useState<AuthTokens | null>(null);
  const [loading, setLoading] = useState(true);

  const signIn = useCallback((session: AuthSession) => {
    setTokens(session.tokens);
    setCustomer(session.customer);
    localStorage.setItem(REFRESH_KEY, session.tokens.refreshToken);
  }, []);

  const signOut = useCallback(async () => {
    const rt = localStorage.getItem(REFRESH_KEY);
    localStorage.removeItem(REFRESH_KEY);
    setTokens(null);
    setCustomer(null);
    if (rt) await authApi.signout(rt).catch(() => undefined);
  }, []);

  // Rehydrate from the stored refresh token on first load.
  useEffect(() => {
    const rt = localStorage.getItem(REFRESH_KEY);
    if (!rt) {
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const { tokens: fresh } = await authApi.refresh(rt);
        // The refresh token is valid — establish the session immediately and persist the rotated token.
        localStorage.setItem(REFRESH_KEY, fresh.refreshToken);
        setTokens(fresh);
        // The referral landing (/p/*) is Aurora-free by design (ADR-0007): a valid refresh alone
        // proves the member there (the page gates on `tokens`), so the profile fetch — /me, which
        // reads Aurora — is skipped entirely; it loads on the next app-proper page (e.g. /home).
        if (window.location.pathname.startsWith("/p/")) return;
        try {
          const { profile } = await meApi.get(fresh.accessToken);
          setCustomer(profile);
        } catch {
          // Profile fetch hiccup (e.g. a cold-Aurora /me blip) — keep the valid session; the profile
          // loads on a later navigation. Do NOT log the member out over a transient /me failure.
        }
      } catch (err) {
        // Discard the stored session ONLY when the refresh token is actually rejected (expired/revoked,
        // 401). A network error or a 5xx must NOT log a member out — they stay signed in and retry.
        if (err instanceof ApiError && err.status === 401) {
          localStorage.removeItem(REFRESH_KEY);
          setTokens(null);
          setCustomer(null);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const value = useMemo<SessionState>(
    () => ({
      customer,
      tokens,
      loading,
      isAdmin: isAdminToken(tokens?.idToken),
      signIn,
      signOut,
      accessToken: () => tokens?.accessToken ?? null,
    }),
    [customer, tokens, loading, signIn, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within SessionProvider");
  return ctx;
}
