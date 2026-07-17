/**
 * The landing app's self-contained user module — the RETURNING-MEMBER subset of the member
 * app's (apps/web/src/user): session rehydrate + native passkey login, nothing else. Sign-up,
 * OTP login and profile management live in the member app; the `/p/*` page links there.
 * The page consumes ONLY this index.
 */
export { loginWithPasskey, passkeyLoginAvailable } from "./actions";
export { BiometricGlyph } from "./BiometricGlyph";
export type { UserProfile } from "./claims";
export { CognitoError } from "./cognito";
export { type Session, SessionProvider, useSession } from "./SessionProvider";
export { hasStoredSession, rememberedPhone } from "./store";
export { biometricLabelKey, passkeysSupported } from "./webauthn";
