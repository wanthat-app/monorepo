import { randomUUID } from "node:crypto";
import {
  AuthRefreshBody,
  AuthResendBody,
  AuthSignoutBody,
  AuthStartBody,
  AuthStartResponse,
  AuthVerifyBody,
  AuthVerifyResponse,
  PasskeyRegisterOptionsBody,
  PasskeyRegisterVerifyBody,
  PasskeyRegisterVerifyResponse,
} from "@wanthat/contracts";
import { Hono } from "hono";
import { getContext } from "../context";
import { OTP_REJECTION_ERRORS, toAuthTokens } from "./cognito";
import { smsEnabled } from "./killswitch";
import { withinVelocity } from "./velocity";

const RESEND_COOLDOWN_SEC = 30;
const OTP_EXPIRES_SEC = 180; // Cognito SMS OTP lifetime (~3 min)
const CHALLENGE_TTL_SEC = 600;
const TICKET_TTL_SEC = 600;
const MAX_OTP_ATTEMPTS = 5;

const nowEpoch = (): number => Math.floor(Date.now() / 1000);

/** Extract the Bearer access token from the Authorization header, or null. */
function bearerToken(c: { req: { header: (n: string) => string | undefined } }): string | null {
  const h = c.req.header("Authorization");
  return h?.startsWith("Bearer ") ? h.slice(7) : null;
}

/** Parse a JSON body against a Zod schema; returns the value or null (the caller 400s on null). */
async function parseBody<T>(
  c: { req: { json: () => Promise<unknown> } },
  schema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
): Promise<T | null> {
  try {
    const raw = await c.req.json();
    const r = schema.safeParse(raw);
    return r.success ? (r.data as T) : null;
  } catch {
    return null;
  }
}

/**
 * The `app-auth` router (ADR-0021): the Cognito + DynamoDB endpoints of the auth flow, served from
 * the non-VPC edge. It never touches Aurora — the customer row (and the login-or-register decision)
 * lives behind `/auth/register` on `app-core`, so `/auth/verify` here always hands off a signed,
 * self-contained ticket rather than resolving customer existence itself.
 */
export function authRouter(): Hono {
  const auth = new Hono();

  // POST /auth/start — phone entry (login-or-register), uniform for new and existing numbers.
  auth.post("/start", async (c) => {
    const body = await parseBody(c, AuthStartBody);
    if (!body) return c.json({ error: "invalid_request" }, 400);
    const ctx = getContext();

    if (!(await smsEnabled(ctx.config))) return c.json({ error: "sms_disabled" }, 503);
    const gate = await withinVelocity(ctx.config, ctx.velocity, body.phone, nowEpoch());
    if (!gate.allowed)
      return c.json({ error: "rate_limited", retryAfterSec: gate.retryAfterSec }, 429);

    const existing = await ctx.cognito.getUserByPhone(body.phone);
    const user = existing ?? (await ctx.cognito.createUser(body.phone));
    const { session } = await ctx.cognito.startSmsOtp(user.username);

    const challengeId = randomUUID();
    const now = nowEpoch();
    await ctx.challenges.putChallenge({
      challengeId,
      username: user.username,
      sub: user.sub,
      phone: body.phone,
      cognitoSession: session,
      isNewUser: existing === null,
      resendAfterEpoch: now + RESEND_COOLDOWN_SEC,
      attempts: 0,
      ttl: now + CHALLENGE_TTL_SEC,
    });

    return c.json(
      AuthStartResponse.parse({
        challengeId,
        resendAfterSec: RESEND_COOLDOWN_SEC,
        expiresInSec: OTP_EXPIRES_SEC,
      }),
    );
  });

  // POST /auth/resend — re-issue the OTP under a server-enforced cooldown.
  auth.post("/resend", async (c) => {
    const body = await parseBody(c, AuthResendBody);
    if (!body) return c.json({ error: "invalid_request" }, 400);
    const ctx = getContext();

    const challenge = await ctx.challenges.getChallenge(body.challengeId);
    if (!challenge) return c.json({ error: "challenge_not_found" }, 404);

    const now = nowEpoch();
    if (now < challenge.resendAfterEpoch) return c.json({ error: "rate_limited" }, 429);
    if (!(await smsEnabled(ctx.config))) return c.json({ error: "sms_disabled" }, 503);
    // The 30s cooldown caps burst; the velocity gate caps total sends per phone (ADR-0006).
    const gate = await withinVelocity(ctx.config, ctx.velocity, challenge.phone, now);
    if (!gate.allowed)
      return c.json({ error: "rate_limited", retryAfterSec: gate.retryAfterSec }, 429);

    const { session } = await ctx.cognito.startSmsOtp(challenge.username);
    await ctx.challenges.putChallenge({
      ...challenge,
      cognitoSession: session,
      resendAfterEpoch: now + RESEND_COOLDOWN_SEC,
      ttl: now + CHALLENGE_TTL_SEC,
    });
    return c.json({ resendAfterSec: RESEND_COOLDOWN_SEC, expiresInSec: OTP_EXPIRES_SEC });
  });

  // POST /auth/verify — verify the OTP, then hand off a signed self-contained ticket. Being
  // Cognito-only (no Aurora, ADR-0021), this edge cannot resolve whether a customer row exists, so it
  // just returns the ticket; the client calls `app-core`'s `/auth/session` to resolve login vs
  // register. The ticket carries the freshly minted tokens, so nothing is parked.
  auth.post("/verify", async (c) => {
    const body = await parseBody(c, AuthVerifyBody);
    if (!body) return c.json({ error: "invalid_request" }, 400);
    const ctx = getContext();

    const challenge = await ctx.challenges.getChallenge(body.challengeId);
    if (!challenge) return c.json({ error: "challenge_not_found" }, 404);

    let result: Awaited<ReturnType<typeof ctx.cognito.respondSmsOtp>>;
    try {
      result = await ctx.cognito.respondSmsOtp(
        challenge.username,
        challenge.cognitoSession,
        body.code,
      );
    } catch (err) {
      if (err instanceof Error && OTP_REJECTION_ERRORS.has(err.name)) {
        const attempts = challenge.attempts + 1;
        if (attempts >= MAX_OTP_ATTEMPTS)
          await ctx.challenges.deleteChallenge(challenge.challengeId);
        else await ctx.challenges.putChallenge({ ...challenge, attempts });
        return c.json({ error: "invalid_code" }, 401);
      }
      throw err;
    }

    // Wrong code, but Cognito re-issued the challenge: persist the NEW session under the SAME
    // challengeId so the next attempt works without a /resend, and count the failed try.
    if (result.kind === "retry") {
      await ctx.challenges.putChallenge({
        ...challenge,
        cognitoSession: result.session,
        attempts: challenge.attempts + 1,
      });
      return c.json({ error: "invalid_code" }, 401);
    }

    await ctx.challenges.deleteChallenge(challenge.challengeId);
    const tokens = toAuthTokens(result.result);

    // Sign a self-contained ticket carrying the tokens + identity; `/auth/register` (app-core)
    // verifies it independently and either logs the member in or provisions the customer row.
    const registrationTicket = await ctx.tickets.sign({
      sub: challenge.sub,
      phone: challenge.phone,
      accessToken: tokens.accessToken,
      idToken: tokens.idToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      exp: nowEpoch() + TICKET_TTL_SEC,
    });
    return c.json(AuthVerifyResponse.parse({ registrationTicket }));
  });

  // POST /auth/refresh — exchange a refresh token for fresh tokens.
  auth.post("/refresh", async (c) => {
    const body = await parseBody(c, AuthRefreshBody);
    if (!body) return c.json({ error: "invalid_request" }, 400);
    const ctx = getContext();
    try {
      const result = await ctx.cognito.refresh(body.refreshToken);
      return c.json({ tokens: toAuthTokens(result, body.refreshToken) });
    } catch (err) {
      if (err instanceof Error && OTP_REJECTION_ERRORS.has(err.name))
        return c.json({ error: "invalid_token" }, 401);
      throw err;
    }
  });

  // POST /auth/signout — revoke the refresh token (best-effort); the client also drops its tokens.
  auth.post("/signout", async (c) => {
    const body = await parseBody(c, AuthSignoutBody);
    if (!body) return c.json({ error: "invalid_request" }, 400);
    const ctx = getContext();
    if (body.refreshToken) await ctx.cognito.revoke(body.refreshToken);
    return c.json({ ok: true } as const);
  });

  // --- Passkeys (ADR-0006/0020) ---
  // Enrolment is API-driven and authorised by the caller's access token (Cognito's WebAuthn
  // registration is access-token-scoped), so these sit under /auth but read the Bearer directly.
  //
  // Discoverable (userless) passkey *login* is NOT served here: Cognito's raw API requires a username
  // for the WEB_AUTHN challenge, so true discoverable login goes through Managed Login (provisioned
  // in IdentityStack). The SPA opens the hosted UI and completes the OAuth code+PKCE exchange in the
  // browser, then carries the resulting Bearer token like any other session (PR4 spike resolution).

  auth.post("/passkey/register/options", async (c) => {
    const token = bearerToken(c);
    if (!token) return c.json({ error: "unauthorized" }, 401);
    if (!(await parseBody(c, PasskeyRegisterOptionsBody)))
      return c.json({ error: "invalid_request" }, 400);
    const ctx = getContext();
    // `options` is server-generated and passed straight to the browser; the contract types it loosely.
    const options = await ctx.cognito.startWebAuthnRegistration(token);
    return c.json({ options });
  });

  auth.post("/passkey/register/verify", async (c) => {
    const token = bearerToken(c);
    if (!token) return c.json({ error: "unauthorized" }, 401);
    const body = await parseBody(c, PasskeyRegisterVerifyBody);
    if (!body) return c.json({ error: "invalid_request" }, 400);
    const ctx = getContext();
    await ctx.cognito.completeWebAuthnRegistration(token, body.credential);
    return c.json(
      PasskeyRegisterVerifyResponse.parse({
        passkey: { credentialId: body.credential.id, createdAt: new Date().toISOString() },
      }),
    );
  });

  return auth;
}
