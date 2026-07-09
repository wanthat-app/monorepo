/**
 * Admin API (ADR-0002, ADR-0006) — a separate in-VPC Lambda with its own role/exposure, behind its
 * own HTTP API + JWT authorizer (every route gated; no public probe). HTTP routing via Hono.
 *
 * Owns the runtime-config panel (the sole CONFIG writer), operational stats, and the activity
 * feed. The whole users surface — list/search + ban tooling + account removal — is Cognito-backed
 * (ADR-0006) and served by the non-VPC admin-credentials function; Aurora is money-only since T7
 * (ADR-0006 decision 4), so this function reads it (as `app_ro`) solely for the audit-log feed
 * and, later, wallet stats — money tables stay immutable. Admin-group membership is re-checked
 * in-handler (defence in depth).
 */
import {
  CatalogStats,
  CONFIG_DEFAULTS,
  CONFIG_KEYS,
  type ConfigItem,
  ConfigKey,
  GetConfigResponse,
  ListActivityQuery,
  ListActivityResponse,
  ListConfigResponse,
  PutConfigBody,
  PutConfigResponse,
  UsersStats,
} from "@wanthat/contracts";
import { listAuditLog } from "@wanthat/db";
import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import { auditEntryToItem, mergeByAtDesc, otpSinkToItems } from "./activity";
import { getContext } from "./context";
import { type Bindings, requireAdmin } from "./guard";

const SERVICE = "admin-api";
const EPOCH0 = new Date(0).toISOString(); // shown as "never set" for keys still on their default

const app = new Hono<{ Bindings: Bindings }>();

// Unauthenticated liveness probe for the deploy smoke test (no data, no auth).
app.get("/healthz", (c) => c.json({ ok: true, service: SERVICE }));

// Everything under /admin requires a valid token AND the admin group.
app.use("/admin/*", requireAdmin);

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

// PUT /admin/config/:key — set one entry (value validated against its schema by RuntimeConfigRepo).
app.put("/admin/config/:key", async (c) => {
  const parsedKey = ConfigKey.safeParse(c.req.param("key"));
  if (!parsedKey.success) return c.json({ error: "unknown_key" }, 404);
  const body = PutConfigBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request" }, 400);

  const item = await getContext().config.put(
    parsedKey.data,
    body.data.value,
    new Date().toISOString(),
  );
  // NOTE: when poller.intervalMinutes changes, the EventBridge schedule retune lands with the
  // conversion-poller slice (ADR-0009) — its schedule is still DISABLED, so there is nothing to
  // retune yet; the poller reads this value when it goes live.
  return c.json(PutConfigResponse.parse({ item }));
});

// NOTE: /admin/retailer/* (the write-only credential drop) is served by the separate NON-VPC
// admin-credentials function on this same HTTP API — Secrets Manager is unreachable from the
// endpoint-free VPC this function runs in (ADR-0004).

// GET /admin/stats/overview — `usersCount` is EXACT again: the `#customerCounter` sentinel item
// in the runtime config table (a DynamoDB read, so this in-VPC function can serve it without
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

// GET /admin/stats/users — the exact counter figures (`usersCount` / `suspendedUsersCount`; the
// contract documents the confirmed-only semantics). The Aurora-era population metrics (status
// split, signup trend) stayed unavailable since T7 — a ListUsers-derived aggregation remains
// deliberately deferred (see the contract's doc).
app.get("/admin/stats/users", async (c) => {
  const { total, disabled } = await getContext().customerCounter.get();
  return c.json(UsersStats.parse({ usersCount: total, suspendedUsersCount: disabled }));
});

// GET /admin/stats/catalog — exact product + recommendation totals from the transactional
// counters (incremented atomically with each conditional create; sentinel items in the tables).
app.get("/admin/stats/catalog", async (c) => {
  const ctx = getContext();
  const [products, recommendations] = await Promise.all([
    ctx.products.count("aliexpress"),
    ctx.recommendations.count(),
  ]);
  return c.json(CatalogStats.parse({ products, recommendations }));
});

// NOTE: GET /admin/users (list/search) and the ban tooling (disable / enable / global-signout)
// are served by the NON-VPC admin-credentials function on this same HTTP API — Cognito is the
// customer store (ADR-0006) and cognito-idp is unreachable from the endpoint-free VPC this
// function runs in (ADR-0004). Route wiring lives in infra/lib/admin-stack.ts.

// GET /admin/activity — one paged feed over the audit log (money events and any future audited
// admin action), newest first. In dev the first page also merges the parked OTP codes from the
// dev sink (DEV_OTP_SINK_TABLE is only set where the table exists — never prod), so codes are
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
  const sink = getContext().devOtpSink;
  if (sink && page === 1) {
    const otp = otpSinkToItems(await sink.scanAll(), Date.now());
    items = mergeByAtDesc(items, otp);
    grandTotal += otp.length;
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
