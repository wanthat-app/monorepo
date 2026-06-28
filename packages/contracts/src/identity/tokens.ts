import { z } from "zod";

/**
 * Cognito JWTs returned to the cookieless SPA (ADR-0007): held in memory, sent as a
 * Bearer header on `/api/*`. Never set as a cookie.
 */
export const AuthTokens = z.object({
  accessToken: z.string(),
  idToken: z.string(),
  refreshToken: z.string(),
  tokenType: z.literal("Bearer"),
  expiresIn: z.number().int().positive(), // access-token lifetime, seconds
});
export type AuthTokens = z.infer<typeof AuthTokens>;
