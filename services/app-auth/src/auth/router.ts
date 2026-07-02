import { randomUUID } from "node:crypto";
import { Logger } from "@aws-lambda-powertools/logger";
import {
  AuthConfigResponse,
  AuthRefreshBody,
  AuthResendBody,
  AuthResendResponse,
  AuthSignoutBody,
  AuthStartBody,
  AuthStartResponse,
  AuthVerifyBody,
  AuthVerifyResponse,
  normalizePhone,
  PasskeyLoginOptionsBody,
  PasskeyLoginOptionsResponse,
  PasskeyLoginVerifyBody,
  PasskeyRegisterOptionsBody,
  PasskeyRegisterVerifyBody,
  PasskeyRegisterVerifyResponse,
} from "@wanthat/contracts";
import { Hono } from "hono";
import { getContext } from "../context";
import { OTP_REJECTION_ERRORS, toAuthTokens } from "./cognito";
import { otpChannelAvailability } from "./killswitch";
import { withinVelocity } from "./velocity";

const RESEND_COOLDOWN_SEC = 30;
const OTP_EXPIRES_SEC = 180; // Cognito SMS OTP lifetime (~3 min)
const CHALLENGE_TTL_SEC = 600;
const TICKET_TTL_SEC = 600;
const MAX_OTP_ATTEMPTS = 5;

const nowEpoch = (): number => Math.floor(Date.now() / 1000);

// OTP chain logging (no PII, never the code): `sub` correlates with message-sender's
// otp_delivered/otp_delivery_failed lines; `challengeId` with the client session. One
// Logs Insights query across the app-auth + message-sender groups follows a send end to end.
const logger = new Logger({ serviceName: "app-auth" });

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
 * Cognito surfaces a custom-sender (message-sender) throw on AdminInitiateAuth as these error
 * names. app-auth maps them to `send_failed` so the UI can offer the other channel (spec rev 2).
 */
const SENDER_FAILURE_ERRORS = new Set([
  "UnexpectedLambdaException",
  "UserLambdaValidationException",
]);
const isSenderFailure = (err: unknown): boolean =>
  err instanceof Error && SENDER_FAILURE_ERRORS.has(err.name);

/**
 * The `app-auth` router (ADR-0021): the Cognito + DynamoDB endpoints of the auth flow, served from
 * the non-VPC edge. It never touches Aurora — the customer row (and the login-or-register decision)
 * lives behind `/auth/register` on `app-core`, so `/auth/verify` here always hands off a signed,
 * self-contained ticket rather than resolving customer existence itself.
 */
export function authRouter(): Hono {
  const auth = new Hono();

  // GET /auth/config — public projection of the channel availability (ADR-0023). Advisory only:
  // start/resend re-check the same predicate. no-store so no intermediary caches a stale list.
  auth.get("/config", async (c) => {
    const avail = await otpChannelAvailability(getContext().config);
    c.header("cache-control", "no-store");
    return c.json(AuthConfigResponse.parse(avail));
  });

  // POST /auth/start — phone entry (login-or-register), uniform for new and existing numbers.
  auth.post("/start", async (c) => {
    const body = await parseBody(c, AuthStartBody);
    if (!body) return c.json({ error: "invalid_request" }, 400);
    const ctx = getContext();

    // Re-normalize + validate at the boundary (the SPA can be bypassed, and the E.164 regex alone still
    // accepts a doubled country code Cognito would reject) so every downstream call sees one form.
    const phone = normalizePhone(body.phone);
    if (!phone) return c.json({ error: "invalid_request" }, 400);

    // Per-channel gate (ADR-0023): the requested channel must be available. Explicit 503 — the UI
    // decides what to offer instead; the server never silently switches.
    const avail = await otpChannelAvailability(ctx.config);
    if (!avail.channels.includes(body.channel))
      return c.json({ error: "channel_disabled", channel: body.channel }, 503);

    const gate = await withinVelocity(ctx.config, ctx.velocity, phone, nowEpoch());
    if (!gate.allowed)
      return c.json({ error: "rate_limited", retryAfterSec: gate.retryAfterSec }, 429);

    const existing = await ctx.cognito.getUserByPhone(phone);
    const user = existing ?? (await ctx.cognito.createUser(phone));

    // Channel (+ template language) ride user attributes: Cognito forwards NO ClientMetadata from
    // AdminInitiateAuth to custom sender triggers, so this write IS the request's channel.
    await ctx.cognito.updateAttributes(user.username, [
      { Name: "custom:otpChannel", Value: body.channel },
      ...(body.locale ? [{ Name: "locale", Value: body.locale }] : []),
    ]);

    let session: string;
    try {
      ({ session } = await ctx.cognito.startSmsOtp(user.username));
    } catch (err) {
      if (isSenderFailure(err)) {
        logger.warn("otp_send_failed", {
          channel: body.channel,
          sub: user.sub,
          error: err instanceof Error ? err.name : "unknown",
        });
        return c.json({ error: "send_failed", channel: body.channel }, 502);
      }
      throw err;
    }

    const challengeId = randomUUID();
    const now = nowEpoch();
    await ctx.challenges.putChallenge({
      challengeId,
      username: user.username,
      sub: user.sub,
      phone,
      cognitoSession: session,
      isNewUser: existing === null,
      requestedChannel: body.channel,
      resendAfterEpoch: now + RESEND_COOLDOWN_SEC,
      attempts: 0,
      ttl: now + CHALLENGE_TTL_SEC,
    });

    logger.info("otp_start", { challengeId, channel: body.channel, sub: user.sub });
    return c.json(
      AuthStartResponse.parse({
        challengeId,
        resendAfterSec: RESEND_COOLDOWN_SEC,
        expiresInSec: OTP_EXPIRES_SEC,
        channel: body.channel,
      }),
    );
  });

  // POST /auth/resend — re-issue the OTP under a server-enforced cooldown. `channel` is required
  // and may switch (the UI's "didn't get it on WhatsApp? send via SMS" — an explicit user
  // decision, not a server fallback).
  auth.post("/resend", async (c) => {
    const body = await parseBody(c, AuthResendBody);
    if (!body) return c.json({ error: "invalid_request" }, 400);
    const ctx = getContext();

    const challenge = await ctx.challenges.getChallenge(body.challengeId);
    if (!challenge) return c.json({ error: "challenge_not_found" }, 404);

    const now = nowEpoch();
    if (now < challenge.resendAfterEpoch) return c.json({ error: "rate_limited" }, 429);

    const avail = await otpChannelAvailability(ctx.config);
    if (!avail.channels.includes(body.channel))
      return c.json({ error: "channel_disabled", channel: body.channel }, 503);

    // The 30s cooldown caps burst; the velocity gate caps total sends per phone (ADR-0006).
    const gate = await withinVelocity(ctx.config, ctx.velocity, challenge.phone, now);
    if (!gate.allowed)
      return c.json({ error: "rate_limited", retryAfterSec: gate.retryAfterSec }, 429);

    await ctx.cognito.updateAttributes(challenge.username, [
      { Name: "custom:otpChannel", Value: body.channel },
    ]);

    let session: string;
    try {
      ({ session } = await ctx.cognito.startSmsOtp(challenge.username));
    } catch (err) {
      if (isSenderFailure(err)) {
        logger.warn("otp_send_failed", {
          channel: body.channel,
          sub: challenge.sub,
          error: err instanceof Error ? err.name : "unknown",
        });
        return c.json({ error: "send_failed", channel: body.channel }, 502);
      }
      throw err;
    }

    await ctx.challenges.putChallenge({
      ...challenge,
      cognitoSession: session,
      requestedChannel: body.channel,
      resendAfterEpoch: now + RESEND_COOLDOWN_SEC,
      ttl: now + CHALLENGE_TTL_SEC,
    });
    logger.info("otp_resend", {
      challengeId: challenge.challengeId,
      channel: body.channel,
      sub: challenge.sub,
    });
    return c.json(
      AuthResendResponse.parse({
        resendAfterSec: RESEND_COOLDOWN_SEC,
        expiresInSec: OTP_EXPIRES_SEC,
        channel: body.channel,
      }),
    );
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
  // Passkey *login* (below, ADR-0022 Flow B) is username-hinted, not discoverable: Cognito's raw
  // API requires a username for the WEB_AUTHN challenge. The phone (Cognito username) is remembered
  // client-side after any sign-in and replayed silently, so a returning device still gets
  // "visit -> biometric -> in" with no phone prompt. True discoverable (userless) login would go
  // through Managed Login (Flow C) — currently non-functional (its origin can't consume a passkey
  // bound to this site's RP-ID); see the plan's closing note.

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

  // POST /auth/passkey/login/options — begin username-hinted passkey login (ADR-0022 Flow B).
  // Public (the assertion is the credential). The phone is the device-remembered Cognito username,
  // never prompted on a known device. "no user" and "no passkey" collapse to one error (no oracle).
  auth.post("/passkey/login/options", async (c) => {
    const body = await parseBody(c, PasskeyLoginOptionsBody);
    if (!body) return c.json({ error: "invalid_request" }, 400);
    const ctx = getContext();
    const phone = normalizePhone(body.phone);
    if (!phone) return c.json({ error: "invalid_request" }, 400);

    const user = await ctx.cognito.getUserByPhone(phone);
    if (!user) return c.json({ error: "passkey_unavailable" }, 409);

    let session: string;
    let options: unknown;
    try {
      ({ session, options } = await ctx.cognito.startPasskeyAuth(user.username));
    } catch {
      return c.json({ error: "passkey_unavailable" }, 409);
    }

    const challengeId = randomUUID();
    const now = nowEpoch();
    await ctx.challenges.putChallenge({
      challengeId,
      username: user.username,
      sub: user.sub,
      phone,
      cognitoSession: session,
      isNewUser: false,
      resendAfterEpoch: now + RESEND_COOLDOWN_SEC,
      attempts: 0,
      ttl: now + CHALLENGE_TTL_SEC,
    });
    logger.info("passkey_login_start", { challengeId, sub: user.sub });
    return c.json(PasskeyLoginOptionsResponse.parse({ challengeId, options }));
  });

  // POST /auth/passkey/login/verify — finish; hand off the SAME signed ticket as /auth/verify so
  // /auth/session (app-core) resolves the member. The passkey holder is always already registered.
  auth.post("/passkey/login/verify", async (c) => {
    const body = await parseBody(c, PasskeyLoginVerifyBody);
    if (!body) return c.json({ error: "invalid_request" }, 400);
    const ctx = getContext();

    const challenge = await ctx.challenges.getChallenge(body.challengeId);
    if (!challenge) return c.json({ error: "challenge_not_found" }, 404);

    let result: Awaited<ReturnType<typeof ctx.cognito.respondPasskeyAuth>>;
    try {
      result = await ctx.cognito.respondPasskeyAuth(
        challenge.username,
        challenge.cognitoSession,
        body.credential,
      );
    } catch (err) {
      if (err instanceof Error && OTP_REJECTION_ERRORS.has(err.name)) {
        await ctx.challenges.deleteChallenge(challenge.challengeId);
        return c.json({ error: "invalid_passkey" }, 401);
      }
      throw err;
    }

    await ctx.challenges.deleteChallenge(challenge.challengeId);
    const tokens = toAuthTokens(result);
    const registrationTicket = await ctx.tickets.sign({
      sub: challenge.sub,
      phone: challenge.phone,
      accessToken: tokens.accessToken,
      idToken: tokens.idToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      exp: nowEpoch() + TICKET_TTL_SEC,
    });
    logger.info("passkey_login_ok", { sub: challenge.sub });
    return c.json(AuthVerifyResponse.parse({ registrationTicket }));
  });

  return auth;
}
