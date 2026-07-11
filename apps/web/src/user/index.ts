/**
 * The self-contained user module (ADR-0006 T4) — ALL authentication + profile functionality
 * for the SPA. The rest of the app consumes ONLY this index:
 *
 * - `SessionProvider` / `useSession()` — session state (status, profile-from-claims, access
 *   token for app-api Bearer calls).
 * - Actions — `signUpWithOtp`, `loginWithOtp`, `loginWithPasskey`, `updateProfile`,
 *   `signOut`, plus the passkey/profile auxiliaries the pages need.
 * - `UserChip` — the module's UI face (avatar + menu: profile, passkeys, sign out).
 *
 * Internals (`cognito.ts`, `store.ts`, `claims.ts`, `webauthn.ts`) talk directly to the
 * Cognito public API — no backend participates in authentication (ADR-0006).
 */
export {
  enrollPasskey,
  listPasskeys,
  loginWithDiscoveredPasskey,
  loginWithOtp,
  loginWithPasskey,
  type OtpLoginFlow,
  type PasskeySummary,
  type ProfilePatch,
  passkeyLoginAvailable,
  type ResumedOtp,
  refreshProfile,
  removePasskey,
  resumePendingOtp,
  resumeSignUp,
  type SignUpFlow,
  type SignUpInput,
  signOut,
  signUpWithOtp,
  updateProfile,
  verifyEmail,
} from "./actions";
export type { UserProfile } from "./claims";
export { CognitoError } from "./cognito";
export { ProfileEditor } from "./ProfileEditor";
export { clearPendingOtp, hasPendingOtp } from "./pending-otp";
export { type Session, SessionProvider, useSession } from "./SessionProvider";
export { hasStoredSession, rememberedPhone } from "./store";
export { UserChip } from "./UserChip";
export { biometricLabelKey, passkeysSupported } from "./webauthn";
