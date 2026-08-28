/**
 * The wide confirmed-order scan (spec 2026-08-26). `listbyindex` filters by PAID time (probed
 * 2026-08-26), so the narrow watermark poll never re-surfaces an order once it flips to "Buyer
 * Confirmed Receipt" weeks after payment — the pending→confirmed promotion was silently dead for
 * EVERY order. This step fixes it: on a slow cadence it sweeps a WIDE fixed window
 * `[now − confirmScanDays, now]` (decoupled from the watermark; under the ~90-day listbyindex span
 * cap) for `"Buyer Confirmed Receipt"`, and appends the `confirmed` row through the one money door.
 *
 * Tracked orders resolve from `custom_parameters` via `resolveOrder`; manually-attributed orders
 * (no `custom_parameters` → `no_ref`) resolve from OUR stored `unattributed_order.claim` via
 * `manualClaimWrite` — the same money path, so manual and tracked confirmations promote identically.
 * Every append is idempotent on the ledger's `(order_id, kind, status)` unique index, so re-reading
 * the whole window each run never double-credits.
 */
import type { Logger } from "@aws-lambda-powertools/logger";
import type { AliExpressClient, AliExpressOrder } from "@wanthat/aliexpress";
import { AliExpressApiError } from "@wanthat/aliexpress";
import type {
  ConversionWrite,
  WriteConversionsRequest,
  WriteConversionsResponse,
} from "@wanthat/contracts";
import type {
  PollerStateRepo,
  RuntimeConfigBatchReader,
  UnattributedOrderRepo,
} from "@wanthat/dynamo";
import {
  type AttributionDeps,
  mapStatus,
  orderSighting,
  parseGmt8,
  resolveOrder,
} from "./attribution";
import { manualClaimWrite } from "./manual-claim";
import { toGmt8 } from "./poll-orders";

/** Own state row (separate from the narrow poll's `aliexpress#orders`) — cadence gate only. */
export const CONFIRMED_STATE_KEY = "aliexpress#confirmed";
/** The single status this scan sweeps (mapStatus → `confirmed`). */
export const CONFIRMED_STATUS = "Buyer Confirmed Receipt";
const PAGE_SIZE = 50;
const API_LIMIT_RETRY_MS = 1200;
const WRITE_BATCH = 25;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ScanConfirmedDeps {
  client: () => Promise<AliExpressClient | null>;
  state: PollerStateRepo;
  config: RuntimeConfigBatchReader;
  attribution: AttributionDeps;
  unattributed: Pick<UnattributedOrderRepo, "get" | "recordSighting">;
  /** Null = dry mode (LEDGER_WRITER_FUNCTION unset): resolved conversions are logged, not written. */
  invokeWriter: ((req: WriteConversionsRequest) => Promise<WriteConversionsResponse>) | null;
  now: () => Date;
  sleep?: (ms: number) => Promise<void>;
  logger: Logger;
}

export interface ConfirmedScanSummary {
  ran: boolean;
  window: { startTime: string; endTime: string } | null;
  fetched: number;
  /** Tracked confirmations resolved from custom_parameters. */
  resolved: number;
  /** Manual confirmations resolved from a stored claim. */
  injected: number;
  /** Unclaimed no_ref orders re-sighted (kept claimable). */
  sighted: number;
  written: { appended: number; failed: number } | null;
}

const idle = (): ConfirmedScanSummary => ({
  ran: false,
  window: null,
  fetched: 0,
  resolved: 0,
  injected: 0,
  sighted: 0,
  written: null,
});

export async function scanConfirmedOrders(deps: ScanConfirmedDeps): Promise<ConfirmedScanSummary> {
  const now = deps.now();
  const [confirmScanDays, intervalMinutes] = await Promise.all([
    deps.config.get("poller.confirmScanDays").then(Number),
    deps.config.get("poller.confirmScanIntervalMinutes").then(Number),
  ]);

  const state = await deps.state.get(CONFIRMED_STATE_KEY);
  if (state && now.getTime() - Date.parse(state.lastRunAt) < intervalMinutes * 60_000) {
    return idle();
  }

  let client: AliExpressClient | null;
  try {
    client = await deps.client();
  } catch (err) {
    deps.logger.error("confirmed scan client setup failed", { error: String(err) });
    return idle();
  }
  if (!client) return idle();

  const start = new Date(now.getTime() - confirmScanDays * DAY_MS);
  const window = { startTime: toGmt8(start), endTime: toGmt8(now) };

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const withThrottleRetry = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (err) {
      if (!(err instanceof AliExpressApiError) || err.code !== "ApiCallLimit") throw err;
      await sleep(API_LIMIT_RETRY_MS);
      return await call();
    }
  };

  try {
    const orders: AliExpressOrder[] = [];
    let cursor: string | undefined;
    do {
      const page = await withThrottleRetry(() =>
        client.listOrdersByIndex({
          startTime: window.startTime,
          endTime: window.endTime,
          status: CONFIRMED_STATUS,
          startQueryIndexId: cursor,
          pageSize: PAGE_SIZE,
        }),
      );
      orders.push(...page.orders);
      cursor = page.nextQueryIndexId ?? undefined;
    } while (cursor);

    const writes: ConversionWrite[] = [];
    let injected = 0;
    let sighted = 0;
    for (const order of orders) {
      const outcome = await resolveOrder(order, deps.attribution);
      if (outcome.outcome === "resolved") {
        writes.push(outcome.write);
        continue;
      }
      if (outcome.reason !== "no_ref") {
        deps.logger.info("confirmed_untracked", { orderId: order.orderId, reason: outcome.reason });
        continue;
      }
      // no_ref: a manually-attributed order carries its attribution in OUR store, not on AliExpress.
      const item = await deps.unattributed.get(order.orderId);
      if (item?.claim) {
        const status = mapStatus(order.status);
        if (!order.commissionMinor || !status) {
          deps.logger.error("confirmed manual order unwritable", {
            orderId: order.orderId,
            hasCommission: Boolean(order.commissionMinor),
            rawStatus: order.status,
          });
          continue;
        }
        const rec = await deps.attribution.recommendations.get(item.claim.recommendationId);
        if (!rec) {
          deps.logger.error("confirmed manual recommendation not found", {
            orderId: order.orderId,
            recommendationId: item.claim.recommendationId,
          });
          continue;
        }
        writes.push(
          manualClaimWrite({
            orderId: order.orderId,
            recommendationId: rec.recommendationId,
            referrerSub: rec.ownerId,
            cashback: rec.cashback,
            gross: BigInt(order.commissionMinor),
            currency: order.commissionCurrency ?? "USD",
            status,
            occurredAt: parseGmt8(order.orderTimeGmt8) ?? now.toISOString(),
          }),
        );
        injected += 1;
      } else {
        // Unclaimed: keep it visible/claimable in the admin queue. Best-effort — never fail the scan.
        try {
          await deps.unattributed.recordSighting(
            orderSighting(order, outcome.reason),
            now.toISOString(),
          );
          sighted += 1;
        } catch (err) {
          deps.logger.error("confirmed sighting failed", {
            orderId: order.orderId,
            error: String(err),
          });
        }
      }
    }

    let written: { appended: number; failed: number } | null = null;
    if (deps.invokeWriter && writes.length > 0) {
      written = { appended: 0, failed: 0 };
      for (let i = 0; i < writes.length; i += WRITE_BATCH) {
        const res = await deps.invokeWriter({ conversions: writes.slice(i, i + WRITE_BATCH) });
        written.appended += res.appended.length;
        written.failed += res.failed.length;
      }
    } else if (!deps.invokeWriter) {
      for (const write of writes) {
        deps.logger.info("dry_confirmed", {
          orderId: write.resolved.orderId,
          recommendationId: write.resolved.recommendationId,
          status: write.resolved.status,
        });
      }
    }

    // Advance the cadence gate only after a fully successful run.
    await deps.state.put({
      stateKey: CONFIRMED_STATE_KEY,
      lastRunAt: now.toISOString(),
      watermarkEndTime: now.toISOString(),
    });

    return {
      ran: true,
      window,
      fetched: orders.length,
      resolved: writes.length - injected,
      injected,
      sighted,
      written,
    };
  } catch (err) {
    // Gate untouched: the next due beat re-reads the same window; appends are idempotent.
    deps.logger.error("confirmed scan failed", { error: String(err) });
    return idle();
  }
}
