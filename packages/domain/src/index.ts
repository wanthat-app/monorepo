/**
 * Commission split (ADR-0003, ADR-0008/0009). A gross commission (integer **minor units**,
 * `bigint`, in the retailer's settlement currency) is split into the referrer cashback, the
 * consumer reward, and Wanthat's margin, using the rates **snapshotted on the recommendation** at
 * link creation. Both rewards are carved from the gross (never added on top), so
 * `margin = gross − referrer − consumer` stays >= 0 as long as `referrerBps + consumerBps <= 100%`.
 *
 * If an admin misconfigures the policy so the sum exceeds 100%, the rates are **normalized**
 * proportionally to 100% (margin floored at 0) and a warning is logged — we never fail a
 * conversion over a config mistake. The admin panel will also guard the sum at input.
 *
 * The API string `Money` (`@wanthat/contracts`) is converted to/from these minor units at the
 * boundary; the real wiring lands with the conversion poller-writer.
 */
const BPS_DENOMINATOR = 10_000n;

export interface CommissionSplit {
  referrerMinor: bigint;
  consumerRewardMinor: bigint;
  marginMinor: bigint;
}

export function splitCommission(
  grossMinor: bigint,
  referrerBps: number,
  consumerBps: number,
): CommissionSplit {
  let referrer = referrerBps;
  let consumer = consumerBps;
  const total = referrer + consumer;

  if (total > 10_000) {
    // Normalize to 100%, preserving the referrer/consumer ratio; consumer absorbs the rounding
    // so the two always sum to exactly 100% and the margin is floored at 0.
    referrer = Math.round((referrerBps * 10_000) / total);
    consumer = 10_000 - referrer;
    console.warn(
      JSON.stringify({
        level: "warn",
        msg: "cashback split exceeds 100%; normalized to protect margin",
        referrerBps,
        consumerBps,
        normalizedReferrerBps: referrer,
        normalizedConsumerBps: consumer,
      }),
    );
  }

  const referrerMinor = (grossMinor * BigInt(referrer)) / BPS_DENOMINATOR;
  const consumerRewardMinor = (grossMinor * BigInt(consumer)) / BPS_DENOMINATOR;
  const marginMinor = grossMinor - referrerMinor - consumerRewardMinor;
  return { referrerMinor, consumerRewardMinor, marginMinor };
}
