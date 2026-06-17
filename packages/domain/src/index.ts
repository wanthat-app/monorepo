import type { MoneyMinor } from "@wanthat/contracts";

/**
 * Commission split (ADR-0003, SDD §10.1, D9). Referrer cashback is always credited;
 * the consumer reward is carved from Wanthat's margin (never added on top), at a rate
 * snapshotted on the conversion. Margin must stay >= 0.
 *
 * Stub — the real implementation lands with the conversion poller.
 */
export interface CommissionSplit {
  referrerMinor: bigint;
  consumerRewardMinor: bigint;
  marginMinor: bigint;
}

export function splitCommission(
  _grossIls: MoneyMinor,
  _consumerRewardBps: number,
): CommissionSplit {
  throw new Error("not implemented");
}
