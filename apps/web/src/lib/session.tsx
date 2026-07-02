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
import { authApi, meApi } from "./api";
import { rememberDevicePhone } from "./device";
import { isAdminToken } from "./jwt";

/**
 * Session state (ADR-0007, cookieless). Access/id tokens live only in memory; the refresh token is
 * persisted to localStorage so a reload can silently re-establish the session via `/auth/refresh` +
 * `/me`. No token is ever written to a cookie.
 */
const REFRESH_KEY = "wanthat.refreshToken";

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
    rememberDevicePhone(session.customer.phone); // ADR-0022 Flow B: enable next-visit Face ID login
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
        const { profile } = await meApi.get(fresh.accessToken);
        setTokens(fresh);
        setCustomer(profile);
        localStorage.setItem(REFRESH_KEY, fresh.refreshToken);
        // Backfill the remembered phone for sessions that predate Flow B (ADR-0022): any device
        // with a live session gets its passkey-login hint on next load, no re-OTP required.
        rememberDevicePhone(profile.phone);
      } catch {
        localStorage.removeItem(REFRESH_KEY);
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
