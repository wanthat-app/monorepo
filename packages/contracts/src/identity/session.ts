import { z } from "zod";
import { AuthTokens } from "./tokens";

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
