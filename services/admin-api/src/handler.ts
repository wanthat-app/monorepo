/**
 * Admin API (ADR-0002, ADR-0006) — a separate in-VPC Lambda with its own role/exposure, behind its
 * own HTTP API + JWT authorizer (every route gated; no public probe). HTTP routing via Hono.
 *
 * Owns the runtime-config panel (the sole CONFIG writer), operational stats, and the activity
 * feed. The whole users surface — list/search + ban tooling + account removal — is Cognito-backed
 * (ADR-0006) and served by the non-VPC admin-credentials function; Aurora is money-only since T7
 * (ADR-0006 decision 4), so this function reads it (as `app_ro`) for the audit-log feed and,
 * later, wallet stats — money tables stay immutable. Its one Aurora write is the audit trail of
 * its own config edits, via the narrow SECURITY DEFINER wrapper admin_audit_config_change
 * (0007; app_ro holds no raw audit_append). Admin-group membership is re-checked in-handler
 * (defence in depth).
 */
import {
  Bps,
  CatalogStats,
  CONFIG_DEFAULTS,
  CONFIG_KEYS,
  type ConfigItem,
  ConfigKey,
  GetConfigResponse,
  ListActivityQuery,
  ListActivityResponse,
  ListConfigResponse,
  MoneyStats,
  PutConfigBody,
  PutConfigResponse,
  UsersStats,
} from "@wanthat/contracts";
import { appendConfigChangeAudit, listAuditLog, listRewardRows } from "@wanthat/db";
import { convertMinor, deriveMoneyStats } from "@wanthat/domain";
import { jerusalemDate, lastNDates } from "@wanthat/dynamo";
import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import { auditEntryToItem, mergeByAtDesc, otpSinkToItems, outboxToItems } from "./activity";
import { getContext } from "./context";
import { moneyJson } from "./http";
import { actorFrom, type Bindings, requireAdmin } from "./guard";
import { unattributedRouter } from "./unattributed";
import { userDetailRouter } from "./user-detail";

const SERVICE = "admin-api";
const EPOCH0 = new Date(0).toISOString(); // shown as "never set" for keys still on their default

const app = new Hono<{ Bindings: Bindings }>();

// Unauthenticated liveness probe for the deploy smoke test (no data, no auth).
app.get("/healthz", (c) => c.json({ ok: true, service: SERVICE }));

// Everything under /admin requires a valid token AND the admin group.
app.use("/admin/*", requireAdmin);

// The unattributed-order claim queue (Phase 2) — list / claim / dismiss.
app.route("/admin/orders/unattributed", unattributedRouter());

// The user detail sub-resources (recommendations + wallet). The identity route
// (GET /admin/users/{sub}) is served by the non-VPC admin-credentials function.
app.route("/admin/users", userDetailRouter());

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

// PUT /admin/config/:key — set one entry (value validated against its schema by RuntimeConfigRepo),
// then chain a config_changed event into the audit log (admin_audit_config_change, 0007 — the
// narrow SECURITY DEFINER append app_ro holds instead of raw audit_append).
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
  // NOTE: when poller.intervalMinutes changes, the EventBridge schedule retune lands with the
  // conversion-poller slice (ADR-0009) — its schedule is still DISABLED, so there is nothing to
  // retune yet; the poller reads this value when it goes live.

  // Audited AFTER the write (the event records what actually happened). A failed append fails
  // the request loudly — the change IS applied by then, but a silently broken audit trail is
  // worse than a retried idempotent save.
  try {
    await appendConfigChangeAudit(ctx.db, {
      key,
      value: item.value,
      previous,
      actor: actorFrom(c),
    });
  } catch {
    return c.json({ error: "audit_failed" }, 500);
  }
  return c.json(PutConfigResponse.parse({ item }));
});

// NOTE: /admin/retailer/* (the write-only credential drop) is served by the separate NON-VPC
// admin-credentials function on this same HTTP API — Secrets Manager is unreachable from the
// endpoint-free VPC this function runs in (ADR-0004).

// GET /admin/stats/overview — `usersCount` is EXACT again: the `customerCounter` item in the
// OpsCounters table (a DynamoDB read, so this in-VPC function can serve it without
// cognito-idp — ADR-0004). The counter counts CONFIRMED customers (only the Post-Confirmation
// trigger increments); the users page's approximate whole-pool total keeps its wider scope. The
// wallet figures (totalCashbackMinor, conversions30d) become real Aurora reads with the
// conversion slice.
app.get("/admin/stats/overview", async (c) => {
  const { total } = await getContext().customerCounter.get();
  return c.json({
    usersCount: total,
    pendingApprovals: null,
    totalCashbackMinor: null,
    conversions30d: null,
  });
});

// GET /admin/stats/users — population + activity metrics, all DynamoDB (ADR-0004: no
// cognito-idp in the endpoint-free VPC). Counters per the 2026-07-12 dashboard spec:
// exact customerCounter totals, signupsDaily/activeDaily 30-day series (dense, zero-filled,
// Asia/Jerusalem), and DISTINCT active-in-window counts from the presence stamps (which daily
// counters cannot express - repeat visitors would double-count).
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

// GET /admin/stats/money — the dashboard money KPIs, derived per request from the wallet_entry
// ledger (spec 2026-07-13, approach A: money is derived, never stored). Aurora read as app_ro;
// the SPA fetches this separately so a scale-to-zero resume delays only the money cards.
// Rewards settle in USD (ADR-0017); the ILS figures are display-only estimates off the cached
// rate minus the conversion commission - the member wallet's exact semantics.
app.get("/admin/stats/money", async (c) => {
  const ctx = getContext();
  const dates = lastNDates(30);
  const [rows, active30d, rate, commissionBps] = await Promise.all([
    listRewardRows(ctx.db),
    ctx.opsMetrics.countActiveSince(dates[0] as string),
    ctx.fx.get("USD", "ILS"),
    ctx.config.get("fx.conversionCommissionBps"),
  ]);
  const stats = deriveMoneyStats(
    rows.map((r) => ({
      kind: r.kind,
      amountMinor: r.amountMinor,
      currency: r.currency,
      orderId: r.orderId,
      status: r.status,
      date: jerusalemDate(r.createdAt),
    })),
    dates,
  );

  const bps = Bps.parse(commissionBps);
  const ils = (amountMinor: bigint) =>
    rate ? { amountMinor: convertMinor(amountMinor, rate.rate, bps), currency: "ILS" } : null;
  const ZERO_ILS = { amountMinor: 0n, currency: "ILS" };
  const usd = stats.totals.find((t) => t.currency === "USD");

  // Wallet-contract fallbacks: no USD held anywhere = hard zeros (nothing converts to nothing
  // at any rate); USD held but no cached rate = null (genuinely unknowable).
  const ilsEstimate = !usd
    ? { confirmed: ZERO_ILS, pending: ZERO_ILS }
    : rate
      ? { confirmed: ils(usd.confirmedMinor), pending: ils(usd.pendingMinor) }
      : null;
  const windowIls = !usd ? ZERO_ILS : ils(usd.confirmedInWindowMinor);
  const cashbackPerActive30d =
    windowIls === null || active30d === 0
      ? null
      : { amountMinor: windowIls.amountMinor / BigInt(active30d), currency: "ILS" };

  return moneyJson(
    c,
    MoneyStats.parse({
      totals: stats.totals.map((t) => ({
        currency: t.currency,
        confirmed: { amountMinor: t.confirmedMinor, currency: t.currency },
        pending: { amountMinor: t.pendingMinor, currency: t.currency },
      })),
      ilsEstimate,
      conversions30d: stats.conversionsInWindow,
      dailyConversions: stats.dailyConversions,
      cashbackPerActive30d,
    }),
  );
});

// NOTE: GET /admin/users (list/search) and the ban tooling (disable / enable / global-signout)
// are served by the NON-VPC admin-credentials function on this same HTTP API — Cognito is the
// customer store (ADR-0006) and cognito-idp is unreachable from the endpoint-free VPC this
// function runs in (ADR-0004). Route wiring lives in infra/lib/admin-stack.ts.

// GET /admin/activity — one paged feed over the audit log (money events and any future audited
// admin action), newest first. In dev the first page also merges the parked OTP codes from the
// dev sink (OTP_SINK_TABLE is only set where the table exists — never prod), so codes are
// grabbed from this panel instead of the AWS CLI. `total` counts audit rows plus the live sink
// items; page boundaries can drift by the sink size on page 1 — accepted, dev only.
// NOT IMPLEMENTED (moderation audit): user moderation (disable / enable / global-signout /
// cognito-delete) runs on the non-VPC admin-credentials function, which cannot reach Aurora's
// audit_log (endpoint-free VPC, ADR-0004) — those actions are audited as structured CloudWatch
// log lines carrying the same payload fields (type/phone/actor). Folding those lines into this
// feed (a CloudWatch Logs read or an off-band ingest into audit_log) is an open follow-up.
app.get("/admin/activity", async (c) => {
  const query = ListActivityQuery.safeParse({
    page: c.req.query("page"),
    pageSize: c.req.query("pageSize"),
  });
  if (!query.success) return c.json({ error: "invalid_request" }, 400);
  const { page, pageSize } = query.data;
  const { entries, total } = await listAuditLog(getContext().db, { page, pageSize });
  let items = entries.map(auditEntryToItem);
  let grandTotal = total;
  const sink = getContext().otpSink;
  if (sink && page === 1) {
    const otp = otpSinkToItems(await sink.scanAll(), Date.now());
    items = mergeByAtDesc(items, otp);
    grandTotal += otp.length;
  }
  // Member signups ride the optin_welcome outbox (one item per confirmed signup, ~30-day
  // TTL) — nothing else emits user_registered (the audit log is unreachable from the
  // non-VPC post-confirmation trigger).
  const outbox = getContext().outbox;
  if (outbox && page === 1) {
    const signups = outboxToItems(await outbox.scanAll(), Date.now());
    items = mergeByAtDesc(items, signups);
    grandTotal += signups.length;
  }
  return c.json(ListActivityResponse.parse({ items, total: grandTotal, page, pageSize }));
});

// DELETE /admin/users/:id — 410 Gone since T7: the Aurora-side hard delete died with the
// `customer` table (ADR-0006 decision 4; migration 0006 also dropped admin_delete_customer).
// Account removal is now POST /admin/users/cognito-delete alone (admin-credentials, non-VPC):
// AdminDeleteUser + the DynamoDB recommendation erasure; a deleted account's ledger rows remain,
// keyed by the orphaned sub (pseudonymous history — the wallet-history guard is moot). Kept as an
// explicit 410 (not a silent 404/501) because the current SPA delete flow still calls this route
// FIRST and aborts on error — it must fail loudly, not read as "user not found". Remove the route
// once the SPA calls cognito-delete alone (SPA rework, not owned by T7).
app.delete("/admin/users/:id", (c) => c.json({ error: "gone" }, 410));

app.get("/admin/health", (c) => c.json({ ok: true }));

app.all("*", (c) => c.json({ error: "not_implemented", service: SERVICE, path: c.req.path }, 501));

export const handler = handle(app);
export { app };
