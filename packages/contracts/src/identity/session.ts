import { z } from "zod";
import { AuthTokens } from "./tokens";

// POST /auth/refresh — exchange a refresh token for fresh tokens (refreshToken may be unchanged).
// ADR-0006: the SPA refreshes via InitiateAuth(REFRESH_TOKEN_AUTH) against Cognito directly.
/** @deprecated removed by ADR-0006, deleted in T8 */
export const AuthRefreshBody = z.object({ refreshToken: z.string() });
/** @deprecated removed by ADR-0006, deleted in T8 */
export type AuthRefreshBody = z.infer<typeof AuthRefreshBody>;

/** @deprecated removed by ADR-0006, deleted in T8 */
export const AuthRefreshResponse = z.object({ tokens: AuthTokens });
/** @deprecated removed by ADR-0006, deleted in T8 */
export type AuthRefreshResponse = z.infer<typeof AuthRefreshResponse>;

// POST /auth/signout — revoke the current session (authenticated). Client also drops its tokens.
// ADR-0006: the SPA calls Cognito RevokeToken directly.
/** @deprecated removed by ADR-0006, deleted in T8 */
export const AuthSignoutBody = z.object({ refreshToken: z.string().optional() });
/** @deprecated removed by ADR-0006, deleted in T8 */
export type AuthSignoutBody = z.infer<typeof AuthSignoutBody>;

/** @deprecated removed by ADR-0006, deleted in T8 */
export const AuthSignoutResponse = z.object({ ok: z.literal(true) });
/** @deprecated removed by ADR-0006, deleted in T8 */
export type AuthSignoutResponse = z.infer<typeof AuthSignoutResponse>;
