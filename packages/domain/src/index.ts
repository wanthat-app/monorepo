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
import type { CashbackEstimate, CashbackSplit } from "@wanthat/contracts";

export { deriveBalances, type LedgerRow } from "./wallet";

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

/**
 * Derived per-side estimate (display only, never stored): price × network commission × split,
 * exact bigint math in the retailer's settlement currency. Null when the price is unknown.
 * Shared by the create flow (app-links) and the landing render (ADR-0007) so both show the
 * same figures for the same snapshot.
 */
export function buildEstimate(
  price: { amountMinor: string; currency: string } | null,
  commissionBps: number,
  split: CashbackSplit,
): CashbackEstimate {
  if (!price) {
    return {
      referrer: { rateBps: split.referrerBps, estimated: null },
      consumer: { rateBps: split.consumerBps, estimated: null },
    };
  }
  const gross = (BigInt(price.amountMinor) * BigInt(commissionBps)) / 10_000n;
  const parts = splitCommission(gross, split.referrerBps, split.consumerBps);
  return {
    referrer: {
      rateBps: split.referrerBps,
      estimated: { amountMinor: parts.referrerMinor, currency: price.currency },
    },
    consumer: {
      rateBps: split.consumerBps,
      estimated: { amountMinor: parts.consumerRewardMinor, currency: price.currency },
    },
  };
}

/**
 * Convert a minor-unit amount from one currency to another (ADR-0003; UC8 FX rates) using a
 * decimal FX `rate` (quote units per **1** base unit, e.g. `"3.7215"`, from the `fx_rate` cache)
 * and withholding a conversion commission in basis points (CONFIG `fx.conversionCommissionBps`).
 * Exact integer math — the rate is parsed to a scaled bigint, never a float. Used for the ILS
 * display figure and committed at withdrawal.
 *
 * ASSUMES `base` and `quote` share the same minor-unit exponent (true for USD↔ILS, both 2 places);
 * a fully general version would rescale by the exponent difference (JPY=0, KWD=3).
 */
export function convertMinor(amountMinor: bigint, rate: string, commissionBps: number): bigint {
  const [whole, frac = ""] = rate.split(".");
  const scale = 10n ** BigInt(frac.length);
  const scaledRate = BigInt(whole + frac); // rate × scale, exact
  const gross = (amountMinor * scaledRate) / scale;
  return (gross * BigInt(10_000 - commissionBps)) / BPS_DENOMINATOR;
}

/** Who a click resolves to (ADR-0008): a member's Cognito sub or a guest's opaque localStorage id. */
export type ResolvedConsumer = { kind: "member"; sub: string } | { kind: "guest"; guestId: string };

/**
 * The click→report wire keys. AliExpress round-trips ONLY its fixed tracking keys (`af`, `cn`,
 * `cv`, `dp` — portals help: the names cannot be changed); anything else is silently dropped
 * (proven on dev 2026-07-10: `ref`/`c`/`g` clicks came back as `custom_parameters: "{}"`). So
 * our logical keys ride the platform's names: `af` = ref (recommendationId), `cn` = member sub,
 * `cv` = guest id. Encode (withAttribution) and decode (decodeAttribution) MUST stay symmetric —
 * both live here so the wire format has one home.
 */
const CLICK_KEYS = { ref: "af", member: "cn", guest: "cv" } as const;

/**
 * Attribution at click-through (ADR-0008): append the click's `custom_parameters` onto the
 * PRODUCT-level affiliate URL — the ref always, plus the consumer key (member sub / guest id),
 * under the platform's fixed tracking keys (CLICK_KEYS). Opaque ids only — nothing internal
 * leaks. The input URL comes ONLY from the stored recommendation projection (open-redirect
 * safety, ADR-0007); `new URL` throws on malformed storage rather than emitting a broken
 * redirect.
 */
export function withAttribution(
  affiliateUrl: string,
  recommendationId: string,
  consumer: ResolvedConsumer,
): string {
  const url = new URL(affiliateUrl);
  url.searchParams.set(CLICK_KEYS.ref, recommendationId);
  if (consumer.kind === "member") url.searchParams.set(CLICK_KEYS.member, consumer.sub);
  else url.searchParams.set(CLICK_KEYS.guest, consumer.guestId);
  return url.toString();
}

/**
 * The report side of CLICK_KEYS: an order's raw `custom_parameters` JSON → our logical keys.
 * Tolerant by design — the field is platform-echoed, attacker-influencable click input: bad
 * JSON or shapes decode to {}. Values may echo back as JSON numbers (the platform's own doc
 * example is `{"af":0,"dp":1111}`), so finite numbers are stringified; our ids are never
 * leading-zero numerics, so the round-trip is lossless.
 */
export function decodeAttribution(raw: string | null): { ref?: string; c?: string; g?: string } {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const rec = parsed as Record<string, unknown>;
    const str = (v: unknown) => {
      if (typeof v === "string" && v.length > 0) return v;
      if (typeof v === "number" && Number.isFinite(v)) return String(v);
      return undefined;
    };
    return {
      ref: str(rec[CLICK_KEYS.ref]),
      c: str(rec[CLICK_KEYS.member]),
      g: str(rec[CLICK_KEYS.guest]),
    };
  } catch {
    return {};
  }
}
