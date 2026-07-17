/**
 * Admin ledger view (refactor PR-5) — the in-VPC half of the admin surface, and ONLY the Aurora
 * reads: money stats over the wallet_entry ledger, the audit-log activity feed, and the user
 * detail page's wallet tab. Behind the shared admin HTTP API + JWT authorizer (admin-group
 * re-checked in-handler); HTTP routing via Hono.
 *
 * Reaches Aurora as `ledger_reader` — SELECT on wallet_entry + audit_log, nothing else (0008) —
 * so this function structurally cannot write anywhere. Every admin ACTION (config, moderation,
 * credentials, claims) and every Dynamo-backed view (stats counters, OTP sink, unattributed
 * queue, recommendations) lives on the non-VPC admin-console; the public /healthz probe lives
 * there too (one public probe total — the cheap non-VPC one). This function keeps only the
 * authenticated GET /admin/health.
 */
import {
  Bps,
  ListActivityQuery,
  ListActivityResponse,
  MoneyStats,
  moneyJson,
} from "@wanthat/contracts";
import { listAuditLog, listRewardRows } from "@wanthat/db";
import {
  DISPLAY_CURRENCY,
  deriveMoneyStats,
  ilsDisplayEstimate,
  SETTLEMENT_CURRENCY,
} from "@wanthat/domain";
import { jerusalemDate, lastNDates } from "@wanthat/dynamo";
import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import { auditEntryToItem } from "./activity";
import { getContext } from "./context";
import { type Bindings, requireAdmin } from "./guard";
import { userDetailRouter } from "./user-detail";

const SERVICE = "admin-ledger-view";

const app = new Hono<{ Bindings: Bindings }>();

// Everything under /admin requires a valid token AND the admin group.
app.use("/admin/*", requireAdmin);

// The user detail wallet tab (GET /admin/users/{sub}/wallet). The identity route and the
// recommendations tab are admin-console routes (Cognito + DynamoDB, non-VPC).
app.route("/admin/users", userDetailRouter());

// GET /admin/stats/money — the dashboard money KPIs, derived per request from the wallet_entry
// ledger (spec 2026-07-13, approach A: money is derived, never stored). Aurora read as
// ledger_reader; the SPA fetches this separately so a scale-to-zero resume delays only the
// money cards. Rewards settle in USD (ADR-0017); the ILS figures are display-only estimates off
// the cached rate minus the conversion commission - the member wallet's exact semantics. The
// per-active-member KPI is computed CLIENT-side (refactor PR-5): this route carries the
// confirmed-in-window ₪ numerator; active30d comes from admin-console's /admin/stats/users.
app.get("/admin/stats/money", async () => {
  const ctx = getContext();
  const dates = lastNDates(30);
  const [rows, rate, commissionBps] = await Promise.all([
    listRewardRows(ctx.db),
    ctx.fx.get(SETTLEMENT_CURRENCY, DISPLAY_CURRENCY),
    ctx.config.get("fx.conversionCommissionBps"),
  ]);
  const stats = deriveMoneyStats(
    // The explicit pick (not a spread) is the domain boundary: `createdAt` stays out of the
    // timezone-free module; only its pre-stamped Jerusalem bucket crosses.
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

  // The member wallet's exact ≈₪ semantics — one shared rule (`ilsDisplayEstimate`): hard
  // zeros when no USD is held, null when USD is held but no rate is cached.
  const usd = stats.totals.find((t) => t.currency === SETTLEMENT_CURRENCY);
  const est = ilsDisplayEstimate(
    Boolean(usd),
    {
      confirmed: usd?.confirmedMinor ?? 0n,
      pending: usd?.pendingMinor ?? 0n,
      confirmedInWindow: usd?.confirmedInWindowMinor ?? 0n,
    },
    rate?.rate ?? null,
    Bps.parse(commissionBps),
  );

  return moneyJson(
    MoneyStats.parse({
      totals: stats.totals.map((t) => ({
        currency: t.currency,
        confirmed: { amountMinor: t.confirmedMinor, currency: t.currency },
        pending: { amountMinor: t.pendingMinor, currency: t.currency },
      })),
      ilsEstimate: est && {
        confirmed: est.confirmed,
        pending: est.pending,
        confirmedInWindow: est.confirmedInWindow,
      },
      conversions30d: stats.conversionsInWindow,
      dailyConversions: stats.dailyConversions,
    }),
  );
});

// GET /admin/activity — one paged feed over the audit log (money events, signups, config edits,
// moderation moves — every audited action), newest first. Audit rows ONLY since refactor PR-5:
// the parked OTP codes are their own admin-console route (GET /admin/otp-sink) and the SPA
// fetches both in parallel, so page boundaries here are exact. Member signups arrive as
// user_registered audit rows (post-confirmation -> audit-writer); moderation and config events
// arrive via admin-console's synchronous audit-writer invokes.
app.get("/admin/activity", async (c) => {
  const query = ListActivityQuery.safeParse({
    page: c.req.query("page"),
    pageSize: c.req.query("pageSize"),
  });
  if (!query.success) return c.json({ error: "invalid_request" }, 400);
  const { page, pageSize } = query.data;
  const { entries, total } = await listAuditLog(getContext().db, { page, pageSize });
  return c.json(
    ListActivityResponse.parse({ items: entries.map(auditEntryToItem), total, page, pageSize }),
  );
});

app.get("/admin/health", (c) => c.json({ ok: true }));

app.all("*", (c) => c.json({ error: "not_implemented", service: SERVICE, path: c.req.path }, 501));

export const handler = handle(app);
export { app };
