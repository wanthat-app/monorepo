/**
 * Admin console (refactor PR-5) — the non-VPC half of the admin surface: ALL admin actions +
 * ALL Dynamo-backed views. Absorbs the former admin-credentials function whole (Cognito user
 * management + the write-only retailer-credential drop) and takes the actions/Dynamo routes off
 * the former admin-api (runtime config — this function is the config table's SOLE writer —
 * Dynamo stats, the unattributed-order claim queue, the user recommendations tab), plus the
 * OTP-sink view and the on-demand FX refresh. Runs OUTSIDE the VPC on purpose: Secrets Manager,
 * cognito-idp and the Lambda Invoke API are only reachable over their public endpoints, and the
 * VPC is deliberately endpoint-free (ADR-0004). Aurora reads live on the in-VPC
 * admin-ledger-view; same admin HTTP API, same JWT authorizer, same in-handler admin-group
 * re-check on every /admin route.
 *
 * AUDIT-OR-FAIL: config writes and the moderation moves (disable / enable / global-signout /
 * cognito-delete) SYNCHRONOUSLY invoke the in-VPC audit-writer with a typed AuditWriteRequest.
 * A failed append fails the request loudly (500 audit_failed) — the action IS applied by then,
 * but a silently broken audit trail is worse than a retried idempotent action. This closes the
 * old "NOT IMPLEMENTED (moderation audit)" gap: moderation events now chain into the same
 * hash-chained audit_log the activity feed reads, instead of loose CloudWatch log lines.
 */
import {
  CatalogStats,
  CONFIG_DEFAULTS,
  CONFIG_KEYS,
  CognitoDeleteUserBody,
  CognitoDeleteUserResponse,
  type ConfigItem,
  ConfigKey,
  DisableUserBody,
  EnableUserBody,
  GetAdminUserResponse,
  GetConfigResponse,
  GlobalSignOutUserBody,
  ListConfigResponse,
  ListOtpSinkResponse,
  ListUsersQuery,
  ListUsersResponse,
  PutConfigBody,
  PutConfigResponse,
  PutRetailerCredentialsBody,
  RefreshFxRatesResponse,
  RetailerCredentialsStatus,
  UsersStats,
  Uuid,
} from "@wanthat/contracts";
import { lastNDates } from "@wanthat/dynamo";
import { type Context, Hono } from "hono";
import { handle } from "hono/aws-lambda";
import { getContext } from "./context";
import { actorFrom, type Bindings, requireAdmin } from "./guard";
import { otpSinkToItems } from "./otp-sink";
import { unattributedRouter } from "./unattributed";
import { userRecommendationsRouter } from "./user-recommendations";

const SERVICE = "admin-console";
const EPOCH0 = new Date(0).toISOString(); // shown as "never set" for keys still on their default

const app = new Hono<{ Bindings: Bindings }>();

// Unauthenticated liveness probe for the deploy smoke test (no data, no auth) — the ONE public
// probe of the admin surface (this is the cheap non-VPC function; admin-ledger-view keeps only
// the authenticated /admin/health).
app.get("/healthz", (c) => c.json({ ok: true, service: SERVICE }));

// Everything under /admin requires a valid token AND the admin group.
app.use("/admin/*", requireAdmin);

// The unattributed-order claim queue (Phase 2) — list / claim / dismiss.
app.route("/admin/orders/unattributed", unattributedRouter());

// The user detail recommendations tab. The wallet tab (GET /admin/users/{sub}/wallet) is the
// in-VPC admin-ledger-view's route (Aurora); the identity route is below (Cognito).
app.route("/admin/users", userRecommendationsRouter());

/**
 * Audit-or-fail wrapper: append via the audit-writer (SYNC invoke) and report whether it landed.
 * The caller turns `false` into a 500 `audit_failed` — loud, because the primary action already
 * happened and the trail must not break silently.
 */
async function audited(write: () => Promise<void>): Promise<boolean> {
  try {
    await write();
    return true;
  } catch (err) {
    console.error(
      JSON.stringify({
        error: "audit_append_failed",
        message: err instanceof Error ? err.message : String(err),
        at: new Date().toISOString(),
      }),
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Runtime config (this function is the config table's SOLE writer)
// ---------------------------------------------------------------------------

// GET /admin/config — every key with its effective value (stored, or its default).
app.get("/admin/config", async (c) => {
  const stored = await getContext().config.getAll();
  const byKey = new Map(stored.map((i) => [i.key, i]));
  const items: ConfigItem[] = CONFIG_KEYS.map(
    (k) => byKey.get(k) ?? { key: k, value: CONFIG_DEFAULTS[k], updatedAt: EPOCH0 },
  );
  return c.json(ListConfigResponse.parse({ items }));
});

// GET /admin/config/:key — one entry (default if never set).
app.get("/admin/config/:key", async (c) => {
  const parsed = ConfigKey.safeParse(c.req.param("key"));
  if (!parsed.success) return c.json({ error: "unknown_key" }, 404);
  const key = parsed.data;
  const stored = (await getContext().config.getAll()).find((i) => i.key === key);
  const item = stored ?? { key, value: CONFIG_DEFAULTS[key], updatedAt: EPOCH0 };
  return c.json(GetConfigResponse.parse({ item }));
});

// PUT /admin/config/:key — set one entry (value validated against its schema by
// RuntimeConfigRepo), then chain a config_changed event into the audit log via the audit-writer
// (SYNC invoke, audit-or-fail — this replaced the app_ro SECURITY DEFINER wrapper of 0007).
app.put("/admin/config/:key", async (c) => {
  const parsedKey = ConfigKey.safeParse(c.req.param("key"));
  if (!parsedKey.success) return c.json({ error: "unknown_key" }, 404);
  const body = PutConfigBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request" }, 400);
  const key = parsedKey.data;

  const ctx = getContext();
  // The effective value BEFORE the write (stored, or the key's default) — audited alongside
  // the new value so the feed can show the transition, not just the end state.
  const stored = (await ctx.config.getAll()).find((i) => i.key === key);
  const previous = stored ? stored.value : CONFIG_DEFAULTS[key];

  const item = await ctx.config.put(key, body.data.value, new Date().toISOString());
  // NOTE: when poller.intervalMinutes changes, the conversion-poller reads the value on its
  // next heartbeat (ADR-0009) — no schedule mutation happens here.

  // Audited AFTER the write (the event records what actually happened).
  const ok = await audited(() =>
    ctx.audit.write({
      event: "config_changed",
      key,
      value: item.value,
      previous,
      actor: actorFrom(c),
    }),
  );
  if (!ok) return c.json({ error: "audit_failed" }, 500);
  return c.json(PutConfigResponse.parse({ item }));
});

// ---------------------------------------------------------------------------
// Retailer credentials (write-only drop — the credential can never be read back)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Users (Cognito is the customer store, ADR-0006)
// ---------------------------------------------------------------------------

// GET /admin/users — the users page, backed by Cognito ListUsers. Token pagination, optional
// E.164 phone-PREFIX search; the `total` is the approximate pool size.
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

// GET /admin/users/:sub — one member by canonical id, for the admin user detail page. The
// detail page's wallet tab is an admin-ledger-view route; recommendations are mounted above.
// An unknown or malformed sub is a plain 404.
app.get("/admin/users/:sub", async (c) => {
  const sub = Uuid.safeParse(c.req.param("sub"));
  if (!sub.success) return c.json({ error: "not_found" }, 404);
  const user = await getContext().cognitoUsers.getBySub(sub.data);
  if (!user) return c.json({ error: "not_found" }, 404);
  return c.json(GetAdminUserResponse.parse({ user }));
});

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

/** Moderation audit, audit-or-fail: the member's sub + the acting admin, via audit-writer. */
async function auditModeration(
  c: Context<{ Bindings: Bindings }>,
  event: "user_deleted" | "user_disabled" | "user_enabled" | "user_signed_out",
  sub: string | undefined,
): Promise<boolean> {
  return audited(async () => {
    // A Cognito account without a sub attribute cannot happen; treated as an append failure
    // (loud) rather than a silent skip, per audit-or-fail.
    const parsed = Uuid.parse(sub);
    await getContext().audit.write({ event, sub: parsed, actor: actorFrom(c) });
  });
}

// POST /admin/users/disable | enable | global-signout — ban tooling (ADR-0006 decision 8):
// suspend = AdminDisableUser (reversible), lift = AdminEnableUser, kick = AdminUserGlobalSignOut.
// Phone-keyed (the pool username); unknown phone = 404 not_found; repeating an action is
// idempotent success per the contract. Each action chains an audit event (audit-or-fail).
// Suspend / lift also move the customer counter's `disabled` count — but ONLY when the Cognito
// state actually changed (AdminGetUser inside disable/enable reports the prior state), so the
// idempotent repeat of an action never double-counts.
const moderation = [
  {
    path: "/admin/users/disable",
    body: DisableUserBody,
    event: "user_disabled" as const,
    run: async (phone: string) => {
      const { found, wasEnabled, sub } = await getContext().cognitoUsers.disable(phone);
      if (found && wasEnabled) {
        await counterWrite("markDisabled", phone, () =>
          getContext().customerCounter.markDisabled(),
        );
      }
      return { found, sub };
    },
  },
  {
    path: "/admin/users/enable",
    body: EnableUserBody,
    event: "user_enabled" as const,
    run: async (phone: string) => {
      const { found, wasDisabled, sub } = await getContext().cognitoUsers.enable(phone);
      if (found && wasDisabled) {
        await counterWrite("markEnabled", phone, () => getContext().customerCounter.markEnabled());
      }
      return { found, sub };
    },
  },
  {
    path: "/admin/users/global-signout",
    body: GlobalSignOutUserBody,
    event: "user_signed_out" as const,
    run: (phone: string) => getContext().cognitoUsers.globalSignOut(phone),
  },
] as const;
for (const route of moderation) {
  app.post(route.path, async (c) => {
    const body = route.body.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_request" }, 400);
    const { found, sub } = await route.run(body.data.phone);
    if (!found) return c.json({ error: "not_found" }, 404);
    if (!(await auditModeration(c, route.event, sub))) {
      return c.json({ error: "audit_failed" }, 500);
    }
    return c.json({ ok: true as const });
  });
}

// POST /admin/users/cognito-delete — remove a customer's Cognito account ONLY (ADR-0006
// decision 8, amended 2026-07-18): recommendations and wallet history are retained (non-PII,
// keyed by sub) so the deleted-user admin page stays inspectable. Idempotent: an already-gone
// account is `existed: false`, not an error, so the SPA can retry safely — and the retry
// writes no second audit event or counter decrement.
app.post("/admin/users/cognito-delete", async (c) => {
  const body = CognitoDeleteUserBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request" }, 400);
  const { existed, sub, wasDisabled } = await getContext().cognitoUsers.remove(body.data.phone);
  // Exact customer counter: one erased account = total - 1 (and disabled - 1 when it was
  // suspended). Only when the account existed — the idempotent retry must not double-decrement.
  // NOTE: SELF-service account deletion (Cognito DeleteUser) does not exist in the SPA yet
  // (verified 2026-07-09 — no caller anywhere); when that flow arrives it MUST decrement too.
  if (existed) {
    await counterWrite("decrementTotal", body.data.phone, () =>
      getContext().customerCounter.decrementTotal(wasDisabled),
    );
    if (!(await auditModeration(c, "user_deleted", sub))) {
      return c.json({ error: "audit_failed" }, 500);
    }
  }
  return c.json(CognitoDeleteUserResponse.parse({ ok: true, existed }));
});

// DELETE /admin/users/:id — 410 Gone since T7: the Aurora-side hard delete died with the
// `customer` table (ADR-0006 decision 4). Account removal is POST /admin/users/cognito-delete
// alone. Kept as an explicit 410 (not a silent 404/501) because the current SPA delete flow
// still calls this route FIRST and aborts on error — it must fail loudly, not read as "user
// not found". Remove the route once the SPA calls cognito-delete alone.
app.delete("/admin/users/:id", (c) => c.json({ error: "gone" }, 410));

// ---------------------------------------------------------------------------
// Stats (DynamoDB counters — the money KPIs live on admin-ledger-view)
// ---------------------------------------------------------------------------

// GET /admin/stats/overview — `usersCount` is EXACT: the `customerCounter` item in the
// OpsCounters table. The counter counts CONFIRMED customers (only the Post-Confirmation
// trigger increments); the users page's approximate whole-pool total keeps its wider scope.
// Money figures live on /admin/stats/money (admin-ledger-view: Aurora cold-resume isolation).
app.get("/admin/stats/overview", async (c) => {
  const { total } = await getContext().customerCounter.get();
  return c.json({ usersCount: total });
});

// GET /admin/stats/users — population + activity metrics, all DynamoDB. Counters per the
// 2026-07-12 dashboard spec: exact customerCounter totals, signupsDaily/activeDaily 30-day
// series (dense, zero-filled, Asia/Jerusalem), and DISTINCT active-in-window counts from the
// presence stamps (which daily counters cannot express - repeat visitors would double-count).
// `active30d` is ALSO the denominator of the dashboard's per-active-member money KPI, which
// the SPA computes client-side against /admin/stats/money's in-window ₪ numerator (PR-5).
app.get("/admin/stats/users", async (c) => {
  const ctx = getContext();
  const dates = lastNDates(30);
  const [counter, signups, active, active7d, active30d] = await Promise.all([
    ctx.customerCounter.get(),
    ctx.opsMetrics.getDailyCounts("signupsDaily", dates),
    ctx.opsMetrics.getDailyCounts("activeDaily", dates),
    ctx.opsMetrics.countActiveSince(dates[dates.length - 7] as string),
    ctx.opsMetrics.countActiveSince(dates[0] as string),
  ]);
  const series = (m: Map<string, number>) =>
    dates.map((date) => ({ date, count: m.get(date) ?? 0 }));
  const sumLast = (m: Map<string, number>, n: number) =>
    dates.slice(-n).reduce((acc, d) => acc + (m.get(d) ?? 0), 0);
  return c.json(
    UsersStats.parse({
      usersCount: counter.total,
      suspendedUsersCount: counter.disabled,
      newToday: sumLast(signups, 1),
      new7d: sumLast(signups, 7),
      new30d: sumLast(signups, 30),
      active7d,
      active30d,
      dailySignups: series(signups),
      dailyActive: series(active),
    }),
  );
});

// GET /admin/stats/catalog — exact product + recommendation totals from the transactional
// counters (incremented atomically with each conditional create; sentinel items in the tables),
// plus the 30-day recommendations-created trend (recsDaily items, dense/zero-filled).
app.get("/admin/stats/catalog", async (c) => {
  const ctx = getContext();
  const dates = lastNDates(30);
  const [products, recommendations, created] = await Promise.all([
    ctx.products.count("aliexpress"),
    ctx.recommendations.count(),
    ctx.opsMetrics.getDailyCounts("recsDaily", dates),
  ]);
  return c.json(
    CatalogStats.parse({
      products,
      recommendations,
      dailyCreated: dates.map((date) => ({ date, count: created.get(date) ?? 0 })),
    }),
  );
});

// ---------------------------------------------------------------------------
// OTP sink + on-demand FX refresh
// ---------------------------------------------------------------------------

// GET /admin/otp-sink — every currently-parked OTP code (docs/otp-sink.md; 5-minute TTL, at
// most one item per phone — a tiny unpaginated list). Its own route since PR-5: the activity
// feed (admin-ledger-view) reads audit rows only, and the SPA fetches both in parallel.
app.get("/admin/otp-sink", async (c) => {
  const items = otpSinkToItems(await getContext().otpSink.scanAll(), Date.now());
  return c.json(ListOtpSinkResponse.parse({ items }));
});

// POST /admin/fx-rates/refresh — SYNCHRONOUS on-demand run of the fx-rates updater (UC8), e.g.
// before a known FX move. Invokes the fx-rates Lambda by deterministic name and answers with
// the freshly cached rates; a failed invoke (or a malformed result) is a loud 502.
app.post("/admin/fx-rates/refresh", async (c) => {
  let result: unknown;
  try {
    result = await getContext().fxRates.refresh();
  } catch (err) {
    console.error(
      JSON.stringify({
        error: "fx_refresh_invoke_failed",
        message: err instanceof Error ? err.message : String(err),
        at: new Date().toISOString(),
      }),
    );
    return c.json({ error: "fx_refresh_failed" }, 502);
  }
  // The updater returns { status, provider, updated, failed, rates }; the contract lifts `rates`.
  const parsed = RefreshFxRatesResponse.safeParse(result);
  if (!parsed.success) return c.json({ error: "fx_refresh_failed" }, 502);
  return c.json(parsed.data);
});

app.all("*", (c) => c.json({ error: "not_implemented", service: SERVICE, path: c.req.path }, 501));

export const handler = handle(app);
export { app };
