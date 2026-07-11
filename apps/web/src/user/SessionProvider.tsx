import i18n from "i18next";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import type { UserProfile } from "./claims";
import { currentAccessToken, getSnapshot, rehydrate, type SessionStatus, subscribe } from "./store";

/**
 * React face of the session store (ADR-0006). The provider's only job is kicking off the
 * one-time rehydrate (stored refresh token → `InitiateAuth(REFRESH_TOKEN_AUTH)`, Cognito
 * only — no backend); state lives in the framework-free store so the module's actions can
 * mutate it from anywhere.
 */
export interface Session {
  status: SessionStatus;
  /** True while a stored session is being re-established on load. */
  loading: boolean;
  /** The signed-in member's profile, decoded from ID-token claims — null when signed out. */
  profile: UserProfile | null;
  /** Current Cognito access token — the Bearer for app-api calls (wallet/links). */
  accessToken: () => string | null;
}

const SessionContext = createContext<boolean>(false);

export function SessionProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    void rehydrate();
  }, []);
  useProfileLocaleSync();
  return <SessionContext.Provider value={true}>{children}</SessionContext.Provider>;
}

/**
 * The signed-in member's saved locale is the source of truth for the app language: applied on
 * sign-in/rehydrate (a fresh device honours the preference instead of the Hebrew default) and
 * after a profile edit (`refreshProfile` updates the store — no page calls changeLanguage
 * itself). Signed out, the per-device choice (i18n's own localStorage memory) stays in charge;
 * a sign-out deliberately keeps the last language rather than snapping back.
 */
function useProfileLocaleSync() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const locale = snapshot.profile?.locale;
  useEffect(() => {
    if (!locale) return;
    const lang = locale.startsWith("he") ? "he" : "en";
    if (i18n.language !== lang) void i18n.changeLanguage(lang);
  }, [locale]);
}

export function useSession(): Session {
  const inProvider = useContext(SessionContext);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (!inProvider) throw new Error("useSession must be used within SessionProvider");
  return useMemo<Session>(
    () => ({
      status: snapshot.status,
      loading: snapshot.status === "loading",
      profile: snapshot.profile,
      accessToken: currentAccessToken,
    }),
    [snapshot],
  );
}
