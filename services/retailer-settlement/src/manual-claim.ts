import type { ConversionWrite, WalletEntryStatus } from "@wanthat/contracts";
import { splitCommission } from "@wanthat/domain";

/**
 * Assemble the ledger write for a manually-attributed (admin-claimed) order. Referrer-only —
 * `consumer: null` / `consumer: "none"` — because an unattributed order has no known buyer (that is
 * what made it unattributed). This is the single source of the manual money math, used by both the
 * claim-settlement sweep (initial `pending` credit) and the confirmed scan (promotion to
 * `confirmed`). The reward stays in the settlement currency; the split uses the recommendation's
 * SNAPSHOTTED cashback rates.
 */
export function manualClaimWrite(args: {
  orderId: string;
  recommendationId: string;
  referrerSub: string;
  cashback: { referrerBps: number; consumerBps: number };
  gross: bigint;
  currency: string;
  status: WalletEntryStatus;
  occurredAt: string;
}): ConversionWrite {
  const split = splitCommission(args.gross, args.cashback.referrerBps, args.cashback.consumerBps);
  return {
    resolved: {
      orderId: args.orderId,
      recommendationId: args.recommendationId,
      referrer: {
        sub: args.referrerSub,
        reward: { amountMinor: split.referrerMinor, currency: args.currency },
      },
      consumer: null,
      status: args.status,
      occurredAt: args.occurredAt,
    },
    gross: { amountMinor: args.gross, currency: args.currency },
    consumer: "none",
  };
}
