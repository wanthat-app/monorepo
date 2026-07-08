/**
 * Admin API (ADR-0002, ADR-0006) — a separate in-VPC Lambda with its own role/exposure, behind its
 * own HTTP API + JWT authorizer (every route gated; no public probe). HTTP routing via Hono.
 *
 * Owns the runtime-config panel (the sole CONFIG writer), operational stats, the activity feed,
 * and the users page's Aurora-side hard delete (removed in T7 with the `customer` table). The
 * rest of the users surface — list/search + ban tooling — is Cognito-backed (ADR-0006) and served
 * by the non-VPC admin-credentials function. Reaches Aurora as `admin_api` (0004): app_ro's read
 * surface plus DELETE on customer only — money tables stay immutable. Admin-group membership is
 * re-checked in-handler (defence in depth).
 */
import {
  CatalogStats,
  CONFIG_DEFAULTS,
  CONFIG_KEYS,
  type ConfigItem,
  ConfigKey,
  DeleteUserResponse,
  GetConfigResponse,
  ListActivityQuery,
  ListActivityResponse,
  ListConfigResponse,
  PutConfigBody,
  PutConfigResponse,
  Uuid,
} from "@wanthat/contracts";
import { adminDeleteCustomer, listAuditLog } from "@wanthat/db";
import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import { auditEntryToItem, mergeByAtDesc, otpSinkToItems } from "./activity";
import { getContext } from "./context";
import { type Bindings, requireAdmin } from "./guard";
import { loadUsersStats } from "./users-stats";

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

// GET /admin/stats/overview — the live users count is real (Aurora COUNT); the rest are placeholders
// until their slices land. NOTE (T7): still counts the Aurora `customer` table; the contract has no
// approximate flag and this in-VPC function cannot call DescribeUserPool (no cognito-idp path,
// ADR-0004), so the switch to EstimatedNumberOfUsers lands with the T7 customer-table drop.
app.get("/admin/stats/overview", async (c) => {
  const row = await getContext()
    .db.selectFrom("customer")
    .select((eb) => eb.fn.countAll<string>().as("count"))
    .executeTakeFirst();
  return c.json({
    usersCount: Number(row?.count ?? 0),
    pendingApprovals: null,
    totalCashbackMinor: null,
    conversions30d: null,
  });
});

// GET /admin/stats/users — real customer metrics (total, status split, recent-signup windows, and a
// 30-day daily-signup trend), all from the Aurora `customer` table (read-only). NOTE (T7): the
// UsersStats contract has no `approximate` field and cognito-idp is unreachable from this VPC, so
// the Cognito-based replacement (DescribeUserPool / ListUsers-derived) lands with T7's
// customer-table drop rather than here.
app.get("/admin/stats/users", async (c) =>
  c.json(await loadUsersStats(getContext().db, Date.now())),
);

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

// GET /admin/activity — one paged feed over the audit log (registrations, deletions, any future
// audited admin action), newest first. In dev the first page also merges the parked OTP codes
// from the dev sink (DEV_OTP_SINK_TABLE is only set where the table exists — never prod), so
// codes are grabbed from this panel instead of the AWS CLI. `total` counts audit rows plus the
// live sink items; page boundaries can drift by the sink size on page 1 — accepted, dev only.
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

// DELETE /admin/users/:id — hard delete via the admin_delete_customer SECURITY DEFINER function
// (0004): the wallet-history guard and the delete run atomically in the database, so the
// append-only ledger is never orphaned (the FK enforces the same independently). Returns the phone
// so the SPA can run the Cognito cleanup step (admin-credentials, non-VPC — this in-VPC function
// cannot reach cognito-idp; ADR-0004). Removed in T7: this Aurora customer-row delete goes away
// with the `customer` table; the Cognito delete + recommendation erasure then stand alone.
app.delete("/admin/users/:id", async (c) => {
  const id = Uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "invalid_request" }, 400);
  // biome-ignore lint/suspicious/noExplicitAny: authorizer claim shape varies by event type
  const claims = (c.env?.event as any)?.requestContext?.authorizer?.jwt?.claims ?? {};
  const actor =
    (typeof claims.email === "string" && claims.email) ||
    (typeof claims.username === "string" && claims.username) ||
    String(claims.sub ?? "unknown");
  const result = await adminDeleteCustomer(getContext().db, id.data, actor);
  if (result.outcome === "has_wallet_history") return c.json({ error: "has_wallet_history" }, 409);
  if (result.outcome === "not_found") return c.json({ error: "not_found" }, 404);
  return c.json(DeleteUserResponse.parse({ deleted: true, id: id.data, phone: result.phone }));
});

app.get("/admin/health", (c) => c.json({ ok: true }));

app.all("*", (c) => c.json({ error: "not_implemented", service: SERVICE, path: c.req.path }, 501));

export const handler = handle(app);
export { app };
