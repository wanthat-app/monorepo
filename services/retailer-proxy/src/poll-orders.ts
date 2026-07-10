/**
 * The scheduled conversion poll (ADR-0009): heartbeat-gated window sweep over
 * aliexpress.affiliate.order.listbyindex → attribution → the in-VPC writer.
 *
 * The EventBridge heartbeat fires every 15 minutes; THIS op decides whether a run is due by
 * comparing `poller_state.lastRunAt` against the admin-tunable CONFIG `poller.intervalMinutes`
 * (the ADR's CONFIG-driven cadence without any scheduler mutation — an in-VPC admin-api cannot
 * call the Scheduler API in our endpoint-free VPC). Windows are `[watermark − overlap, now]`
 * clamped to `[now − lookbackHours, now]`, in the platform's GMT+8 clock; overlapping re-reads
 * are safe because the ledger's `(order_id, kind, status)` unique index makes appends no-op.
 * The watermark advances ONLY after a fully successful run.
 *
 * Retailer calls run sequentially with the ADR-0021 interim throttle (one ~1.2s retry on
 * ApiCallLimit). Dry mode (no writer configured): resolved conversions are logged, not written.
 */
import type { Logger } from "@aws-lambda-powertools/logger";
import type { AliExpressClient, AliExpressOrder } from "@wanthat/aliexpress";
import { AliExpressApiError } from "@wanthat/aliexpress";
import {
  type ConversionWrite,
  type PollOrdersResponse,
  UntrackedOrderEvent,
  type WriteConversionsRequest,
  type WriteConversionsResponse,
} from "@wanthat/contracts";
import type {
  PollerStateRepo,
  RuntimeConfigBatchReader,
  UnattributedOrderRepo,
} from "@wanthat/dynamo";
import { type AttributionDeps, parseGmt8, resolveOrder } from "./attribution";

const bigintReplacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

export const POLLER_STATE_KEY = "aliexpress#orders";
/** Re-read overlap behind the watermark — absorbs late-arriving orders + clock skew. */
const OVERLAP_MS = 60 * 60 * 1000;
/**
 * One sweep per status filter, sequentially. The platform's documented request enum is EXACTLY
 * these two (probed live 2026-07-10: "Completed" answers resp_code 407 param-pattern-invalid,
 * "Invalid" 405 empty — both silently sweep nothing). Clawback therefore has NO request-side
 * source on this endpoint yet; the response-side mapStatus keeps its clawback branch for
 * whatever statuses fetched orders later carry.
 */
export const POLL_STATUSES = ["Payment Completed", "Buyer Confirmed Receipt"] as const;
const PAGE_SIZE = 50;
const API_LIMIT_RETRY_MS = 1200;
/** Writer invoke batch bound — keeps one invoke payload small and one failure blast-radius low. */
const WRITE_BATCH = 25;

export interface PollOrdersDeps {
  client: () => Promise<AliExpressClient | null>;
  state: PollerStateRepo;
  config: RuntimeConfigBatchReader;
  attribution: AttributionDeps;
  /** The admin claim queue: every same-env untracked order is projected here (best-effort). */
  unattributed: Pick<UnattributedOrderRepo, "recordSighting">;
  /** Null = dry mode (CONVERSION_WRITER_FUNCTION unset): log resolved conversions, write nothing. */
  invokeWriter: ((req: WriteConversionsRequest) => Promise<WriteConversionsResponse>) | null;
  now: () => Date;
  sleep?: (ms: number) => Promise<void>;
  logger: Logger;
}

/** "2026-07-10T10:00:00.000Z" → "2026-07-10 18:00:00" (the platform's GMT+8 request clock). */
export function toGmt8(date: Date): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
}

export async function pollOrders(deps: PollOrdersDeps): Promise<PollOrdersResponse> {
  const now = deps.now();
  const [intervalMinutes, lookbackHours] = await Promise.all([
    deps.config.get("poller.intervalMinutes").then(Number),
    deps.config.get("poller.lookbackHours").then(Number),
  ]);

  const state = await deps.state.get(POLLER_STATE_KEY);
  if (state && now.getTime() - Date.parse(state.lastRunAt) < intervalMinutes * 60_000) {
    return {
      status: "ok",
      ran: false,
      window: null,
      fetched: 0,
      resolved: 0,
      untracked: 0,
      written: null,
    };
  }

  let client: AliExpressClient | null;
  try {
    client = await deps.client();
  } catch (err) {
    deps.logger.error("client setup failed (secret/config read)", { error: String(err) });
    return { status: "error", code: "upstream_error", message: "client setup failed" };
  }
  if (!client) return { status: "error", code: "retailer_not_configured" };

  const floor = now.getTime() - lookbackHours * 60 * 60 * 1000;
  const start = new Date(
    Math.max(floor, state ? Date.parse(state.watermarkEndTime) - OVERLAP_MS : floor),
  );
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
    // Sequential sweep (ADR-0021: never parallel retailer calls), one cursor loop per status.
    const orders: AliExpressOrder[] = [];
    for (const status of POLL_STATUSES) {
      let cursor: string | undefined;
      do {
        const page = await withThrottleRetry(() =>
          client.listOrdersByIndex({
            startTime: window.startTime,
            endTime: window.endTime,
            status,
            startQueryIndexId: cursor,
            pageSize: PAGE_SIZE,
          }),
        );
        orders.push(...page.orders);
        cursor = page.nextQueryIndexId ?? undefined;
      } while (cursor);
    }

    const writes: ConversionWrite[] = [];
    let untracked = 0;
    for (const order of orders) {
      const outcome = await resolveOrder(order, deps.attribution);
      if (outcome.outcome === "resolved") {
        writes.push(outcome.write);
      } else {
        untracked += 1;
        if (outcome.reason === "foreign_env") {
          // Another env's conversion on the shared retailer account — its poller credits it;
          // not this env's analytics.
          deps.logger.info("order_untracked", { orderId: order.orderId, reason: outcome.reason });
        } else {
          // Unattributed revenue: a typed funnel event (this log group's subscription ships it
          // to Firehose → S3/Athena). Dedupe downstream on (orderId, status) — overlap re-reads.
          console.log(
            JSON.stringify(
              UntrackedOrderEvent.parse({
                type: "order_untracked",
                orderId: order.orderId,
                reason: outcome.reason,
                orderStatus: order.status,
                amount: order.commissionMinor
                  ? {
                      amountMinor: BigInt(order.commissionMinor),
                      currency: order.commissionCurrency ?? "USD",
                    }
                  : null,
                at: now.toISOString(),
              }),
              bigintReplacer,
            ),
          );
          // The admin claim queue — best-effort: a projection miss never fails the poll.
          try {
            await deps.unattributed.recordSighting(
              {
                orderId: order.orderId,
                reason: outcome.reason,
                orderStatus: order.status,
                commissionMinor: order.commissionMinor,
                currency: order.commissionMinor ? (order.commissionCurrency ?? "USD") : null,
                occurredAt: parseGmt8(order.orderTimeGmt8),
                productId: order.productId,
                productTitle: order.productTitle,
                productImageUrl: order.productImageUrl,
                productDetailUrl: order.productDetailUrl,
                productCount: order.productCount,
                paidAmountMinor: order.paidAmountMinor,
                commissionRate: order.commissionRate,
                subOrderId: order.subOrderId,
              },
              now.toISOString(),
            );
          } catch (err) {
            deps.logger.error("unattributed sighting failed", {
              orderId: order.orderId,
              error: String(err),
            });
          }
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
        deps.logger.info("dry_resolved", {
          orderId: write.resolved.orderId,
          recommendationId: write.resolved.recommendationId,
          status: write.resolved.status,
          consumer: write.consumer,
          referrerSub: write.resolved.referrer.sub,
          referrerRewardMinor: write.resolved.referrer.reward.amountMinor.toString(),
          consumerRewardMinor: write.resolved.consumer?.reward.amountMinor.toString() ?? null,
          grossMinor: write.gross.amountMinor.toString(),
        });
      }
    }

    // A fully successful run — advance the gate + watermark (single writer: this op).
    await deps.state.put({
      stateKey: POLLER_STATE_KEY,
      lastRunAt: now.toISOString(),
      watermarkEndTime: now.toISOString(),
    });

    return {
      status: "ok",
      ran: true,
      window,
      fetched: orders.length,
      resolved: writes.length,
      untracked,
      written,
    };
  } catch (err) {
    // Watermark untouched: the next due run re-reads the same window; appends are idempotent.
    deps.logger.error("poll run failed", { error: String(err) });
    return { status: "error", code: "upstream_error", message: String(err) };
  }
}
