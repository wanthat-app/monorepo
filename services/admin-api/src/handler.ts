/**
 * Admin API (ADR-0002, ADR-0020) — a separate in-VPC Lambda with its own role/exposure, behind its
 * own HTTP API + JWT authorizer (every route gated; no public probe). HTTP routing via Hono.
 *
 * Owns the runtime-config panel (the sole CONFIG writer) and read-only operational stats. Reads
 * Aurora as `app_ro`. Admin-group membership is re-checked in-handler (defence in depth).
 */
import {
  CONFIG_DEFAULTS,
  CONFIG_KEYS,
  type ConfigItem,
  ConfigKey,
  GetConfigResponse,
  ListConfigResponse,
  PutConfigBody,
  PutConfigResponse,
  PutRetailerCredentialsBody,
  RetailerCredentialsStatus,
} from "@wanthat/contracts";
import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
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

// GET /admin/stats/overview — the live users count is real (Aurora COUNT); the rest are placeholders
// until their slices land.
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
// 30-day daily-signup trend), all from the Aurora `customer` table (read-only).
app.get("/admin/stats/users", async (c) =>
  c.json(await loadUsersStats(getContext().db, Date.now())),
);

app.get("/admin/health", (c) => c.json({ ok: true }));

app.all("*", (c) => c.json({ error: "not_implemented", service: SERVICE, path: c.req.path }, 501));

export const handler = handle(app);
export { app };
