/**
 * PROBE (diagnostic, read-only): what time field does aliexpress.affiliate.order.listbyindex's
 * [start_time, end_time] window filter on — the order's PAID time, or a STATUS-change/modified time?
 *
 * This decides the manual-attribution completion design (spec in progress):
 *   - If the window filters by STATUS/MODIFIED time, an order re-surfaces when it flips to
 *     "Buyer Confirmed Receipt", so the poll re-reads it → the SIMPLE pull-driven loop self-heals.
 *   - If it filters by PAID time, a confirmation weeks after payment never re-appears in the recent
 *     window → the pull loop can't complete it → a by-id refresh (order.get) is required.
 *
 * The tell: `orderTimeGmt8` exposed by the client is the order's `paid_time`. So if a
 * "Buyer Confirmed Receipt" order with an OLD paid_time shows up in a RECENT window, the filter is
 * NOT paid-time. Read-only: only calls listbyindex (no writes, no ledger, no mutation).
 *
 * Run (root):
 *   # with the retailer secret in Secrets Manager (needs AWS creds + secretsmanager:GetSecretValue):
 *   RETAILER_SECRET_ARN=arn:aws:secretsmanager:il-central-1:...:secret:... \
 *   TRACKING_ID=<portal tracking id> pnpm tsx scripts/probe-listbyindex.ts
 *
 *   # or with credentials passed directly (no AWS needed):
 *   APP_KEY=... APP_SECRET=... TRACKING_ID=... pnpm tsx scripts/probe-listbyindex.ts
 */
import { AliExpressClient, RetailerCredentialsReader } from "@wanthat/aliexpress";

const STATUSES = ["Payment Completed", "Buyer Confirmed Receipt"] as const;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const PAGE_SIZE = 50;

/** "yyyy-MM-dd HH:mm:ss" in the platform's GMT+8 request clock. */
function toGmt8(date: Date): string {
  return new Date(date.getTime() + 8 * HOUR).toISOString().slice(0, 19).replace("T", " ");
}

async function resolveCreds(): Promise<{ appKey: string; appSecret: string }> {
  if (process.env.APP_KEY && process.env.APP_SECRET) {
    return { appKey: process.env.APP_KEY, appSecret: process.env.APP_SECRET };
  }
  const arn = process.env.RETAILER_SECRET_ARN;
  if (!arn) {
    throw new Error(
      "provide APP_KEY + APP_SECRET, or RETAILER_SECRET_ARN (with AWS creds) to read the secret",
    );
  }
  const creds = await new RetailerCredentialsReader(arn).get();
  if (!creds) throw new Error(`retailer secret at ${arn} is empty/unset`);
  return creds;
}

async function main() {
  const now = new Date();
  const { appKey, appSecret } = await resolveCreds();
  const trackingId = process.env.TRACKING_ID ?? "default";
  const client = new AliExpressClient({ appKey, appSecret, trackingId });

  // Windows chosen to separate the two hypotheses. An order paid weeks ago that appears in
  // "recent-3h" or "lookback-72h" proves the filter is NOT paid-time.
  const windows = [
    { label: "recent-3h", start: new Date(now.getTime() - 3 * HOUR), end: now },
    { label: "lookback-72h", start: new Date(now.getTime() - 72 * HOUR), end: now },
    {
      label: "hist-90to3d",
      start: new Date(now.getTime() - 90 * DAY),
      end: new Date(now.getTime() - 3 * DAY),
    },
    { label: "broad-365d", start: new Date(now.getTime() - 365 * DAY), end: now },
  ];

  // orderId -> { status, paidTime, seenIn: window labels }
  const seen = new Map<string, { status: string; paidTime: string | null; seenIn: Set<string> }>();

  for (const status of STATUSES) {
    for (const w of windows) {
      let cursor: string | undefined;
      let count = 0;
      try {
        do {
          const page = await client.listOrdersByIndex({
            startTime: toGmt8(w.start),
            endTime: toGmt8(w.end),
            status,
            startQueryIndexId: cursor,
            pageSize: PAGE_SIZE,
          });
          for (const o of page.orders) {
            count += 1;
            const row = seen.get(o.orderId) ?? {
              status: o.status,
              paidTime: o.orderTimeGmt8,
              seenIn: new Set<string>(),
            };
            row.seenIn.add(`${status}@${w.label}`);
            seen.set(o.orderId, row);
          }
          cursor = page.nextQueryIndexId ?? undefined;
        } while (cursor);
        console.log(
          `  [${status}] ${w.label} (${toGmt8(w.start)} .. ${toGmt8(w.end)}): ${count} orders`,
        );
      } catch (err) {
        console.log(
          `  [${status}] ${w.label}: ERROR ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  console.log(`\n=== orders seen (paidTime = orderTimeGmt8) ===`);
  const paidMs = (t: string | null) =>
    t ? Date.parse(t.replace(" ", "T") + "+08:00") : Number.NaN;
  let anyOldInRecent = false;
  for (const [orderId, row] of seen) {
    const ageDays = Number.isNaN(paidMs(row.paidTime))
      ? "?"
      : ((now.getTime() - paidMs(row.paidTime)) / DAY).toFixed(1);
    const inRecent = [...row.seenIn].some(
      (s) => s.endsWith("recent-3h") || s.endsWith("lookback-72h"),
    );
    const oldPaid =
      Number.isFinite(paidMs(row.paidTime)) && now.getTime() - paidMs(row.paidTime) > 72 * HOUR;
    if (oldPaid && inRecent) anyOldInRecent = true;
    console.log(
      `  ${orderId}  status="${row.status}"  paidTime=${row.paidTime ?? "?"} (${ageDays}d ago)  in: ${[...row.seenIn].join(", ")}`,
    );
  }

  console.log(`\n=== VERDICT ===`);
  if (seen.size === 0) {
    console.log(
      "No orders returned by ANY window/status. Cannot discriminate — check creds/tracking id, or there are simply no orders on this account.",
    );
  } else if (anyOldInRecent) {
    console.log(
      "[A1] TRUE (status/modified-time filter): an order paid >72h ago appeared in a RECENT window.",
    );
    console.log(
      "=> A confirmation re-surfaces the order in the poll. The SIMPLE pull-driven loop self-heals. by-id NOT required.",
    );
  } else {
    console.log(
      "No old-paid order appeared in a recent window. Consistent with PAID-TIME filtering ([A1] FALSE).",
    );
    console.log(
      "=> A late confirmation would NOT re-surface in the poll. A by-id (order.get) refresh IS required for self-heal.",
    );
    console.log(
      "   (Caveat: if there were no 'Buyer Confirmed Receipt' orders at all, this is inferred from Payment-Completed windows — confirm once a real order matures.)",
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
