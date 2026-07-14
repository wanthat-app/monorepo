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

export {
  type DerivedCurrencyTotals,
  type DerivedMoneyStats,
  deriveMoneyStats,
  type MoneyStatsRow,
} from "./money-stats";
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

/** Rewards settle in USD (ADR-0017); ILS is the Israeli MVP's display currency. */
export const SETTLEMENT_CURRENCY = "USD";
export const DISPLAY_CURRENCY = "ILS";

/**
 * The `≈₪` display-estimate rule (ADR-0017), shared by the member wallet and the admin money
 * stats so the two can never disagree on the same ledger. Converts a record of USD minor-unit
 * amounts to ILS `Money`s per `convertMinor` (cached rate minus the conversion commission).
 * No USD held (`usdHeld` false; the empty ledger included) estimates to hard zeros — nothing
 * converts to nothing at any rate — so the UI always has a number to render. Null ONLY when
 * USD is held but no rate is cached yet: the amount is genuinely unknowable.
 */
export function ilsDisplayEstimate<K extends string>(
  usdHeld: boolean,
  usdMinor: Record<K, bigint>,
  rate: string | null,
  commissionBps: number,
): Record<K, { amountMinor: bigint; currency: string }> | null {
  if (usdHeld && rate === null) return null;
  const toIls = (amountMinor: bigint) => ({
    amountMinor: usdHeld && rate !== null ? convertMinor(amountMinor, rate, commissionBps) : 0n,
    currency: DISPLAY_CURRENCY,
  });
  const out = {} as Record<K, { amountMinor: bigint; currency: string }>;
  for (const key of Object.keys(usdMinor) as K[]) out[key] = toIls(usdMinor[key]);
  return out;
}

/** Who a click resolves to (ADR-0008): a member's Cognito sub or a guest's opaque localStorage id. */
export type ResolvedConsumer = { kind: "member"; sub: string } | { kind: "guest"; guestId: string };

/**
 * The click→report wire format (agreed 2026-07-10). AliExpress round-trips ONLY its fixed
 * tracking keys (`af`, `cn`, `cv`, `dp` — portals help: the names cannot be changed); anything
 * else is silently dropped (proven on dev: `ref`/`c`/`g` clicks came back as
 * `custom_parameters: "{}"`). Two of those keys carry colon-delimited, env-prefixed values:
 *
 *   af = `<env>:user:<referrerSub>:rec:<recommendationId>`   (the affiliator — never a guest)
 *   dp = `<env>:user:<sub>` | `<env>:guest:<guestId>`        (the consumer)
 *
 * The rec id is the PRIMARY attribution datum (locked split snapshot, ADR-0008); the referrer
 * sub rides along as the fallback credit target should the recommendation be deleted by
 * conversion time. The env prefix isolates the shared retailer account across environments.
 * Encode (withAttribution) and decode (decodeAttribution) MUST stay symmetric — both live here
 * so the wire format has one home.
 */
const KEY_REFERRER = "af";
const KEY_CONSUMER = "dp";

/** Everything a click knows, bound into the affiliate URL at redirect time. */
export interface ClickAttribution {
  /** The deploy environment of the link ("dev" / "prod") — cross-env isolation marker. */
  env: string;
  /** The recommendation's owner (a member's Cognito sub — an affiliator is never a guest). */
  referrerSub: string;
  recommendationId: string;
  consumer: ResolvedConsumer;
}

/**
 * Attribution at click-through (ADR-0008): bind the click's identity into `custom_parameters`
 * on the PRODUCT-level affiliate URL, under the platform's fixed tracking keys (format above).
 * Opaque ids only — nothing internal leaks. The input URL comes ONLY from the stored
 * recommendation projection (open-redirect safety, ADR-0007); `new URL` throws on malformed
 * storage rather than emitting a broken redirect.
 */
export function withAttribution(affiliateUrl: string, attr: ClickAttribution): string {
  const url = new URL(affiliateUrl);
  url.searchParams.set(
    KEY_REFERRER,
    `${attr.env}:user:${attr.referrerSub}:rec:${attr.recommendationId}`,
  );
  const c = attr.consumer;
  url.searchParams.set(
    KEY_CONSUMER,
    c.kind === "member" ? `${attr.env}:user:${c.sub}` : `${attr.env}:guest:${c.guestId}`,
  );
  return url.toString();
}

/** The two halves decode independently — a mangled consumer must not cost referrer credit. */
export interface DecodedAttribution {
  referrer?: { env: string; sub: string; recommendationId: string };
  consumer?: { env: string; kind: "member" | "guest"; id: string };
}

const REFERRER_RE = /^([^:]+):user:([^:]+):rec:(.+)$/;
const CONSUMER_RE = /^([^:]+):(user|guest):(.+)$/;

/**
 * The report side of the wire format: an order's raw `custom_parameters` JSON → the click's
 * identity. Tolerant by design — the field is platform-echoed, attacker-influencable click
 * input: bad JSON, wrong shapes or unparseable values decode to absent halves, never a throw.
 * Values may echo back as JSON numbers (the platform's own doc example is `{"af":0,"dp":1111}`),
 * so finite numbers are stringified before matching.
 */
export function decodeAttribution(raw: string | null): DecodedAttribution {
  if (!raw) return {};
  let rec: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    rec = parsed as Record<string, unknown>;
  } catch {
    return {};
  }
  const str = (v: unknown) => {
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    return undefined;
  };

  const out: DecodedAttribution = {};
  const af = str(rec[KEY_REFERRER])?.match(REFERRER_RE);
  if (af?.[1] && af[2] && af[3]) {
    out.referrer = { env: af[1], sub: af[2], recommendationId: af[3] };
  }
  const dp = str(rec[KEY_CONSUMER])?.match(CONSUMER_RE);
  if (dp?.[1] && dp[3]) {
    out.consumer = { env: dp[1], kind: dp[2] === "user" ? "member" : "guest", id: dp[3] };
  }
  return out;
}
