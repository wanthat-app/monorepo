import { randomUUID } from "node:crypto";
import {
  AuthRefreshBody,
  AuthRegisterBody,
  AuthResendBody,
  AuthSession,
  AuthSignoutBody,
  AuthStartBody,
  AuthStartResponse,
  AuthVerifyBody,
  AuthVerifyResponse,
} from "@wanthat/contracts";
import { findByCognitoSub, insertCustomer } from "@wanthat/db";
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

/** Map a CloudFront viewer country to a default BCP-47 locale (Israeli-first app). */
function countryToLocale(country: string | undefined): string {
  return country === "IL" || !country ? "he-IL" : "en-US";
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

  // POST /auth/verify — verify the OTP; branch on whether a customer row exists for the sub.
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
    const customer = await findByCognitoSub(ctx.db, challenge.sub);

    if (customer) {
      return c.json(AuthVerifyResponse.parse({ status: "authenticated", tokens, customer }));
    }

    // Not registered yet: park the tokens server-side, hand back only a signed ticket id.
    const ticketId = randomUUID();
    await ctx.challenges.putTicket({
      ticketId,
      sub: challenge.sub,
      phone: challenge.phone,
      accessToken: tokens.accessToken,
      idToken: tokens.idToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      ttl: nowEpoch() + TICKET_TTL_SEC,
    });
    const registrationTicket = await ctx.tickets.sign(ticketId);
    return c.json(
      AuthVerifyResponse.parse({ status: "registration_required", registrationTicket }),
    );
  });

  // POST /auth/register — complete the profile for a new user; provisions the customer row (ADR-0020).
  auth.post("/register", async (c) => {
    const body = await parseBody(c, AuthRegisterBody);
    if (!body) return c.json({ error: "invalid_request" }, 400);
    const ctx = getContext();

    const ticketId = await ctx.tickets.verify(body.registrationTicket);
    if (!ticketId) return c.json({ error: "invalid_ticket" }, 401);
    const ticket = await ctx.challenges.getTicket(ticketId);
    if (!ticket) return c.json({ error: "ticket_expired" }, 401);

    const locale = body.locale ?? countryToLocale(c.req.header("CloudFront-Viewer-Country"));
    const customer = await insertCustomer(ctx.db, {
      cognitoSub: ticket.sub,
      phone: ticket.phone,
      firstName: body.firstName,
      lastName: body.lastName,
      email: body.email ?? null,
      locale,
    });
    await ctx.challenges.deleteTicket(ticketId);

    return c.json(
      AuthSession.parse({
        tokens: {
          accessToken: ticket.accessToken,
          idToken: ticket.idToken,
          refreshToken: ticket.refreshToken,
          tokenType: "Bearer",
          expiresIn: ticket.expiresIn,
        },
        customer,
      }),
    );
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

  return auth;
}
