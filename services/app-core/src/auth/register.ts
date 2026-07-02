import { randomUUID } from "node:crypto";
import { Logger } from "@aws-lambda-powertools/logger";
import {
  AuthRegisterBody,
  AuthSession,
  AuthSessionBody,
  AuthSessionResponse,
} from "@wanthat/contracts";
import { findByCognitoSub, insertCustomer } from "@wanthat/db";
import { Hono } from "hono";
import { getContext } from "../context";

// Notification chain logging (no PII): `outboxId` is the field the whatsapp-dispatcher's
// notification_* lines share, so one Logs Insights query follows a welcome message end to end.
const logger = new Logger({ serviceName: "app-core" });

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
    const r = schema.safeParse(await c.req.json());
    return r.success ? (r.data as T) : null;
  } catch {
    return null;
  }
}

/** Tokens carried inside a verify ticket, reshaped as the session's `AuthTokens`. */
function ticketTokens(ticket: {
  accessToken: string;
  idToken: string;
  refreshToken: string;
  expiresIn: number;
}) {
  return {
    accessToken: ticket.accessToken,
    idToken: ticket.idToken,
    refreshToken: ticket.refreshToken,
    tokenType: "Bearer" as const,
    expiresIn: ticket.expiresIn,
  };
}

/**
 * The Aurora seam of onboarding (ADR-0021), served in-VPC by `app-core`. Both routes validate the
 * self-contained HMAC ticket minted by `app-auth`'s `/auth/verify` independently (no inter-Lambda
 * invoke, no shared session store) and call NO Cognito control-plane API.
 *
 * - `POST /auth/session` — resolve the ticket: an existing customer for the ticket's `sub` logs in
 *   (`authenticated`); otherwise `registration_required` (the caller completes `/auth/register`). This
 *   is the login-vs-register decision that used to live in `/auth/verify`, moved here because it needs
 *   an Aurora read the non-VPC edge cannot do.
 * - `POST /auth/register` — provision the `customer` row from the ticket identity + submitted profile.
 *   Idempotent: an already-provisioned customer is returned as-is rather than failing.
 */
export function authRouter(): Hono {
  const auth = new Hono();

  auth.post("/session", async (c) => {
    const body = await parseBody(c, AuthSessionBody);
    if (!body) return c.json({ error: "invalid_request" }, 400);
    const ctx = getContext();

    const ticket = await ctx.tickets.verify(body.registrationTicket);
    if (!ticket) return c.json({ error: "invalid_ticket" }, 401);

    const existing = await findByCognitoSub(ctx.db, ticket.sub);
    if (existing) {
      return c.json(
        AuthSessionResponse.parse({
          status: "authenticated",
          tokens: ticketTokens(ticket),
          customer: existing,
        }),
      );
    }
    return c.json(
      AuthSessionResponse.parse({
        status: "registration_required",
        registrationTicket: body.registrationTicket,
      }),
    );
  });

  auth.post("/register", async (c) => {
    const body = await parseBody(c, AuthRegisterBody);
    if (!body) return c.json({ error: "invalid_request" }, 400);
    const ctx = getContext();

    const ticket = await ctx.tickets.verify(body.registrationTicket);
    if (!ticket) return c.json({ error: "invalid_ticket" }, 401);

    const tokens = ticketTokens(ticket);

    // Idempotent: an already-provisioned customer is returned as-is; a new one is inserted from the
    // ticket identity + submitted profile. (Normal flow resolves login vs register via /auth/session.)
    const existing = await findByCognitoSub(ctx.db, ticket.sub);
    if (existing) return c.json(AuthSession.parse({ tokens, customer: existing }));

    const locale = body.locale ?? countryToLocale(c.req.header("CloudFront-Viewer-Country"));
    const customer = await insertCustomer(ctx.db, {
      cognitoSub: ticket.sub,
      phone: ticket.phone,
      firstName: body.firstName,
      lastName: body.lastName,
      email: body.email ?? null,
      locale,
    });

    // ADR-0023: queue the optin_welcome WhatsApp message through the transactional outbox (a
    // DynamoDB write over the gateway endpoint; the NON-VPC dispatcher does the egress). The
    // producer owns WHAT to send and in which language; best-effort — a failed enqueue is logged,
    // never fails registration. No Cognito call here (in-VPC, ADR-0021).
    const outboxId = randomUUID();
    try {
      await ctx.outbox.put({
        outboxId,
        customerId: ticket.sub,
        phone: ticket.phone,
        messageType: "optin_welcome",
        language: locale.startsWith("he") ? "he" : "en",
        variables: { firstName: body.firstName, appUrl: ctx.appUrl },
        status: "pending",
        createdAt: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
      });
      // Chain log: outboxId correlates with the dispatcher's notification_sent/skipped/failed lines.
      logger.info("optin_welcome_enqueued", { outboxId, customerId: ticket.sub });
    } catch (err) {
      logger.error("optin_welcome_enqueue_failed", {
        customerId: ticket.sub,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return c.json(AuthSession.parse({ tokens, customer }));
  });

  return auth;
}
