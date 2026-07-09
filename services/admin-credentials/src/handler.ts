/**
 * Admin credentials service — the non-VPC half of the admin surface, split out of admin-api
 * because it must run **outside** the VPC: Secrets Manager and cognito-idp are only reachable
 * over their public endpoints, and the VPC is deliberately endpoint-free (ADR-0004). Same admin
 * HTTP API, same JWT authorizer, same in-handler admin-group re-check as admin-api.
 *
 * Owns two things: the write-only retailer-credential drop (PutSecretValue + DescribeSecret
 * only — the credential can be written but never read back; retailer-proxy stays the sole
 * reader), and the customer USER MANAGEMENT surface (ADR-0006: Cognito is the customer store) —
 * list/search via ListUsers, ban tooling via the Admin lifecycle calls, account erasure via
 * AdminDeleteUser + recommendation cleanup.
 */
import {
  CognitoDeleteUserBody,
  CognitoDeleteUserResponse,
  DisableUserBody,
  EnableUserBody,
  GlobalSignOutUserBody,
  ListUsersQuery,
  ListUsersResponse,
  PutRetailerCredentialsBody,
  RetailerCredentialsStatus,
} from "@wanthat/contracts";
import { type Context, Hono } from "hono";
import { handle } from "hono/aws-lambda";
import { getContext } from "./context";
import { type Bindings, requireAdmin } from "./guard";

const SERVICE = "admin-credentials";

const app = new Hono<{ Bindings: Bindings }>();

app.use("/admin/*", requireAdmin);

/**
 * Audit actor — the ID-token email, the same convention as admin-api's delete route (the admin
 * SPA deliberately sends the ID token so actors are readable emails; falls back to
 * username/sub for tokens without one).
 */
function actorFrom(c: Context<{ Bindings: Bindings }>): string {
  // biome-ignore lint/suspicious/noExplicitAny: authorizer claim shape varies by event type
  const claims = (c.env?.event as any)?.requestContext?.authorizer?.jwt?.claims ?? {};
  return (
    (typeof claims.email === "string" && claims.email) ||
    (typeof claims.username === "string" && claims.username) ||
    String(claims.sub ?? "unknown")
  );
}

/**
 * Moderation audit line. Aurora's hash-chained audit log is unreachable from this non-VPC
 * function (the database is in-VPC and the VPC is endpoint-free, ADR-0004), so moderation
 * actions are audited as structured CloudWatch log lines carrying the same fields the audit_log
 * payloads use (type/phone/actor). Folding these into the /admin/activity feed remains an OPEN
 * follow-up — T7 recorded it on the feed route (admin-api) without implementing it (a CloudWatch
 * Logs read or an off-band ingest into audit_log).
 */
function audit(type: string, phone: string, actor: string): void {
  console.log(JSON.stringify({ audit: type, phone, actor, at: new Date().toISOString() }));
}

/**
 * Customer-counter write riding a moderation route. It runs AFTER the Cognito call succeeded and
 * is best-effort: the moderation action already happened, so a counter failure must not fail the
 * route (and a retry would then double-count) - it is logged LOUDLY as customer_counter_drift
 * instead. Reconcile hint: recount confirmed users via paginated ListUsers. The repo's own floor
 * guards handle the never-go-negative side (log-and-skip, no throw).
 */
async function counterWrite(
  op: string,
  phone: string,
  write: () => Promise<unknown>,
): Promise<void> {
  try {
    await write();
  } catch (err) {
    console.error(
      JSON.stringify({
        error: "customer_counter_drift",
        op,
        phone,
        message: err instanceof Error ? err.message : String(err),
        at: new Date().toISOString(),
      }),
    );
  }
}

// GET /admin/retailer/aliexpress/credentials — write-only credential status: whether the secret
// has been written and when. Never returns (or can return) the credential values themselves.
app.get("/admin/retailer/aliexpress/credentials", async (c) =>
  c.json(RetailerCredentialsStatus.parse(await getContext().retailerSecret.status())),
);

// PUT /admin/retailer/aliexpress/credentials — replace the AliExpress AppKey/AppSecret pair in the
// retailer secret (both fields together; PutSecretValue replaces the whole value). The body is
// never logged and never echoed back — errors name the failing field, not its content.
app.put("/admin/retailer/aliexpress/credentials", async (c) => {
  const body = PutRetailerCredentialsBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) {
    const fields = [...new Set(body.error.issues.map((i) => i.path.join(".") || "body"))];
    return c.json({ error: "invalid_request", fields }, 400);
  }
  await getContext().retailerSecret.put(body.data);
  // Re-describe rather than fabricating a timestamp, so PUT and GET report the same clock.
  return c.json(RetailerCredentialsStatus.parse(await getContext().retailerSecret.status()));
});

// GET /admin/users — the users page, backed by Cognito ListUsers (ADR-0006: Cognito is the
// customer store; the Aurora read this replaces dies with the customer table in T7). Token
// pagination, optional E.164 phone-PREFIX search; the `total` is the approximate pool size.
app.get("/admin/users", async (c) => {
  const query = ListUsersQuery.safeParse({
    search: c.req.query("search"),
    pageSize: c.req.query("pageSize"),
    nextToken: c.req.query("nextToken"),
  });
  if (!query.success) return c.json({ error: "invalid_request" }, 400);
  const { search, pageSize, nextToken } = query.data;
  const page = await getContext().cognitoUsers.list({
    phonePrefix: search,
    limit: pageSize,
    nextToken,
  });
  return c.json(ListUsersResponse.parse(page));
});

// POST /admin/users/disable | enable | global-signout — ban tooling (ADR-0006 decision 8):
// suspend = AdminDisableUser (reversible), lift = AdminEnableUser, kick = AdminUserGlobalSignOut.
// Phone-keyed (the pool username); unknown phone = 404 not_found; repeating an action is
// idempotent success per the contract. Each action is audited with the ID-token actor.
// Suspend / lift also move the customer counter's `disabled` count — but ONLY when the Cognito
// state actually changed (AdminGetUser inside disable/enable reports the prior state), so the
// idempotent repeat of an action never double-counts.
const moderation = [
  {
    path: "/admin/users/disable",
    body: DisableUserBody,
    auditType: "user_disabled",
    run: async (phone: string) => {
      const { found, wasEnabled } = await getContext().cognitoUsers.disable(phone);
      if (found && wasEnabled) {
        await counterWrite("markDisabled", phone, () =>
          getContext().customerCounter.markDisabled(),
        );
      }
      return found;
    },
  },
  {
    path: "/admin/users/enable",
    body: EnableUserBody,
    auditType: "user_enabled",
    run: async (phone: string) => {
      const { found, wasDisabled } = await getContext().cognitoUsers.enable(phone);
      if (found && wasDisabled) {
        await counterWrite("markEnabled", phone, () => getContext().customerCounter.markEnabled());
      }
      return found;
    },
  },
  {
    path: "/admin/users/global-signout",
    body: GlobalSignOutUserBody,
    auditType: "user_signed_out",
    run: (phone: string) => getContext().cognitoUsers.globalSignOut(phone),
  },
] as const;
for (const route of moderation) {
  app.post(route.path, async (c) => {
    const body = route.body.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_request" }, 400);
    const found = await route.run(body.data.phone);
    if (!found) return c.json({ error: "not_found" }, 404);
    audit(route.auditType, body.data.phone, actorFrom(c));
    return c.json({ ok: true as const });
  });
}

// POST /admin/users/cognito-delete — remove a customer's Cognito account AND their DynamoDB
// recommendations (ADR-0006 decision 8): the sub is resolved via AdminGetUser before the delete,
// then deleteByOwner(sub) erases the recs with exact counter decrements. Idempotent: an
// already-gone account is `existed: false`, not an error, so the SPA can retry safely. (The
// Aurora customer-row delete stays on admin-api until T7 drops the table.)
app.post("/admin/users/cognito-delete", async (c) => {
  const body = CognitoDeleteUserBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request" }, 400);
  const { existed, sub, wasDisabled } = await getContext().cognitoUsers.remove(body.data.phone);
  const recommendationsDeleted = sub
    ? await getContext().recommendations.deleteByOwner(sub)
    : undefined;
  // Exact customer counter: one erased account = total - 1 (and disabled - 1 when it was
  // suspended). Only when the account existed — the idempotent retry must not double-decrement.
  // NOTE: SELF-service account deletion (Cognito DeleteUser) does not exist in the SPA yet
  // (verified 2026-07-09 — no caller anywhere); when that flow arrives it MUST decrement too.
  if (existed) {
    await counterWrite("decrementTotal", body.data.phone, () =>
      getContext().customerCounter.decrementTotal(wasDisabled),
    );
    audit("user_deleted", body.data.phone, actorFrom(c));
  }
  return c.json(
    CognitoDeleteUserResponse.parse({
      ok: true,
      existed,
      ...(recommendationsDeleted !== undefined ? { recommendationsDeleted } : {}),
    }),
  );
});

app.all("*", (c) => c.json({ error: "not_implemented", service: SERVICE, path: c.req.path }, 501));

export const handler = handle(app);
export { app };
