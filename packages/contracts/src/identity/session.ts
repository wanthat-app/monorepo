import { z } from "zod";
import { AuthSession } from "./auth";
import { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON } from "./passkey";
import { AuthTokens } from "./tokens";

// POST /auth/passkey/login/options — userless (discoverable) FaceID login challenge.
export const PasskeyLoginOptionsBody = z.object({});
export type PasskeyLoginOptionsBody = z.infer<typeof PasskeyLoginOptionsBody>;

export const PasskeyLoginOptionsResponse = z.object({
  options: PublicKeyCredentialRequestOptionsJSON,
});
export type PasskeyLoginOptionsResponse = z.infer<typeof PasskeyLoginOptionsResponse>;

// POST /auth/passkey/login/verify — assertion → signed-in session.
export const PasskeyLoginVerifyBody = z.object({ credential: AuthenticationResponseJSON });
export type PasskeyLoginVerifyBody = z.infer<typeof PasskeyLoginVerifyBody>;

export const PasskeyLoginVerifyResponse = AuthSession;
export type PasskeyLoginVerifyResponse = AuthSession;

// POST /auth/refresh — exchange a refresh token for fresh tokens (refreshToken may be unchanged).
export const AuthRefreshBody = z.object({ refreshToken: z.string() });
export type AuthRefreshBody = z.infer<typeof AuthRefreshBody>;

export const AuthRefreshResponse = z.object({ tokens: AuthTokens });
export type AuthRefreshResponse = z.infer<typeof AuthRefreshResponse>;

// POST /auth/signout — revoke the current session (authenticated). Client also drops its tokens.
export const AuthSignoutBody = z.object({ refreshToken: z.string().optional() });
export type AuthSignoutBody = z.infer<typeof AuthSignoutBody>;

export const AuthSignoutResponse = z.object({ ok: z.literal(true) });
export type AuthSignoutResponse = z.infer<typeof AuthSignoutResponse>;
