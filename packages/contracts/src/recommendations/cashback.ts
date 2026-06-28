import { z } from "zod";
import { Bps, Money } from "../common";

/**
 * Our split of the retailer commission paid to each side, in basis points — the platform policy
 * **snapshotted** onto a Recommendation at creation (from the admin CONFIG keys
 * `cashback.referrerBps` / `cashback.consumerBps`). The snapshot LOCKS a link's economics: later
 * admin changes affect only new links, and both the displayed estimate and the eventual payout use
 * these rates (UC5 #4). Currency-neutral — a percentage, applied at conversion to the retailer's
 * reported commission in its settlement currency.
 */
export const CashbackSplit = z.object({
  referrerBps: Bps,
  consumerBps: Bps,
});
export type CashbackSplit = z.infer<typeof CashbackSplit>;

/** One side of the derived cashback estimate (display only, never stored). */
export const CashbackShare = z.object({
  rateBps: Bps, // the split rate applied to this side
  estimated: Money.nullable(), // estimate in the retailer's settlement (origin) currency, if price known
});
export type CashbackShare = z.infer<typeof CashbackShare>;

/**
 * Per-side cashback **estimate** shown to users — derived (not stored) from the product price × the
 * network commission rate × the split. Amounts are in the retailer's **settlement (origin)
 * currency**, which is the currency the wallet is held in (ADR-0003); the SPA converts to the
 * member's currency for display convenience, and the real conversion happens only at withdrawal.
 */
export const CashbackEstimate = z.object({
  referrer: CashbackShare,
  consumer: CashbackShare,
});
export type CashbackEstimate = z.infer<typeof CashbackEstimate>;
