/**
 * Claimed-order settlement (unattributed-cashback Phase 2, 2026-07-10). The in-VPC admin-api
 * cannot invoke the writer (the VPC is endpoint-free, ADR-0004), so claiming is a two-step
 * dance: admin-api writes the claim INTENT to the `unattributed_order` item, and THIS op —
 * running on every retailer-proxy heartbeat, retailer API untouched — sweeps the claimed queue
 * and pushes each claim through the conversion writer, the one door money enters (ADR-0002).
 *
 * A claim binds the order to a recommendation: its owner is the credited referrer and its
 * SNAPSHOTTED split prices the reward (consumer: none — the click identity is gone; that is
 * what made the order unattributed). The ledger status maps from the order's latest raw
 * platform status (unknown → `pending`: provisional, never over-promoted). Settlement marks the
 * item `settled` only after the writer answered without failure; the `(order_id, kind, status)`
 * unique index makes a crash-and-retry append a no-op, so the two-step commit is safe.
 */
import type { Logger } from "@aws-lambda-powertools/logger";
import type {
  ConversionWrite,
  WriteConversionsRequest,
  WriteConversionsResponse,
} from "@wanthat/contracts";
import { splitCommission } from "@wanthat/domain";
import type { RecommendationRepo, UnattributedOrderRepo } from "@wanthat/dynamo";
import { mapStatus } from "./attribution";

/** One heartbeat settles at most one page of claims — the queue is admin-paced, tiny by nature. */
const CLAIM_PAGE = 25;

export interface SettleClaimsDeps {
  unattributed: Pick<UnattributedOrderRepo, "listByState" | "settle">;
  recommendations: Pick<RecommendationRepo, "get">;
  /** Null = dry mode: claims stay queued until a writer is configured. */
  invokeWriter: ((req: WriteConversionsRequest) => Promise<WriteConversionsResponse>) | null;
  now: () => Date;
  logger: Logger;
}

export interface SettleClaimsSummary {
  processed: number;
  settled: number;
  failed: number;
}

export async function settleClaims(deps: SettleClaimsDeps): Promise<SettleClaimsSummary> {
  const summary: SettleClaimsSummary = { processed: 0, settled: 0, failed: 0 };
  if (!deps.invokeWriter) return summary;

  const page = await deps.unattributed.listByState("claimed", CLAIM_PAGE);
  for (const item of page.items) {
    summary.processed += 1;
    // Every skip below leaves the item `claimed` and logs why: the queue stays visible to the
    // admin (nothing silently vanishes), and the next heartbeat retries transient failures.
    if (!item.claim) {
      summary.failed += 1;
      deps.logger.error("claim missing on claimed item", { orderId: item.orderId });
      continue;
    }
    if (!item.commissionMinor) {
      summary.failed += 1;
      deps.logger.error("claimed order has no commission to split", { orderId: item.orderId });
      continue;
    }
    const rec = await deps.recommendations.get(item.claim.recommendationId);
    if (!rec) {
      summary.failed += 1;
      deps.logger.error("claimed recommendation not found", {
        orderId: item.orderId,
        recommendationId: item.claim.recommendationId,
      });
      continue;
    }

    const gross = BigInt(item.commissionMinor);
    const currency = item.currency ?? "USD";
    const split = splitCommission(gross, rec.cashback.referrerBps, rec.cashback.consumerBps);
    const write: ConversionWrite = {
      resolved: {
        orderId: item.orderId,
        recommendationId: rec.recommendationId,
        referrer: { sub: rec.ownerId, reward: { amountMinor: split.referrerMinor, currency } },
        consumer: null,
        status: mapStatus(item.orderStatus) ?? "pending",
        occurredAt: item.occurredAt ?? deps.now().toISOString(),
      },
      gross: { amountMinor: gross, currency },
      consumer: "none",
    };

    try {
      const res = await deps.invokeWriter({ conversions: [write] });
      if (res.failed.length > 0) {
        summary.failed += 1;
        deps.logger.error("claim write failed", {
          orderId: item.orderId,
          error: res.failed[0]?.error ?? "unknown",
        });
        continue;
      }
      // Appended OR already in the ledger (idempotent retry after a crash) — either way settled.
      await deps.unattributed.settle(item.orderId, deps.now().toISOString());
      summary.settled += 1;
    } catch (err) {
      summary.failed += 1;
      deps.logger.error("claim settlement failed", {
        orderId: item.orderId,
        error: String(err),
      });
    }
  }
  return summary;
}
