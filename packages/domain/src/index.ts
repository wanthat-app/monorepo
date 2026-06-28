/**
 * Commission split (ADR-0003, SDD §10.1, D9). Referrer cashback is always credited;
 * the consumer reward is carved from Wanthat's margin (never added on top), at a rate
 * snapshotted on the conversion. Margin must stay >= 0.
 *
 * The domain computes in integer **minor units** (`bigint`); the API string `Money`
 * (`@wanthat/contracts`) is converted at the boundary.
 *
 * Stub — the real implementation lands with the conversion poller.
 */
export interface CommissionSplit {
  referrerMinor: bigint;
  consumerRewardMinor: bigint;
  marginMinor: bigint;
}

export function splitCommission(_grossMinor: bigint, _consumerRewardBps: number): CommissionSplit {
  throw new Error("not implemented");
}
