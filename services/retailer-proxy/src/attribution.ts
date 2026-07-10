/**
 * Conversion attribution (ADR-0008/0009): one raw retailer order → who gets paid what. Resolved
 * HERE, in the non-VPC proxy (ADR-0003 assigns the conversion-time guest_attribution read to
 * it), from the `custom_parameters` our resolve endpoint bound at click-through (the env-prefixed
 * af/dp wire format — see @wanthat/domain):
 *   af → env gate first (the shared retailer account serves every env; another env's click is
 *        untracked here), then the recommendation → the SNAPSHOTTED split (locked at creation,
 *        never live config). A recommendation deleted by conversion time falls back to the af
 *        referrer sub, rewarded at the CURRENT config split — the click's credit survives the
 *        deletion, its economics degrade to policy-of-the-day.
 *   dp → member consumer sub, or guest → guest_attribution lookup (mapped → sub; unmapped → no
 *        party to credit YET, but the click was still a guest's — the event kind says so). A
 *        foreign-env or malformed consumer half is dropped alone, never the whole order.
 * Money math is exact bigint via splitCommission; rewards stay in the settlement currency.
 */
import type { AliExpressOrder } from "@wanthat/aliexpress";
import {
  type ConsumerKind,
  type ConversionWrite,
  Uuid,
  type WalletEntryStatus,
} from "@wanthat/contracts";
import { decodeAttribution, splitCommission } from "@wanthat/domain";
import type { GuestAttributionRepo, RecommendationRepo } from "@wanthat/dynamo";

export interface AttributionDeps {
  recommendations: Pick<RecommendationRepo, "get">;
  guests: Pick<GuestAttributionRepo, "get">;
  /** This deployment's env name (WANTHAT_ENV) — only same-env clicks are ours to credit. */
  env: string;
  /** The CURRENT config split — the fallback economics when the recommendation is gone. */
  fallbackSplit: () => Promise<{ referrerBps: number; consumerBps: number }>;
  now: () => Date;
}

export type AttributionOutcome =
  | { outcome: "resolved"; write: ConversionWrite }
  | {
      outcome: "untracked";
      reason: "no_ref" | "foreign_env" | "unknown_ref" | "no_commission" | "unknown_status";
    };

/** "2026-07-10 18:00:00" (the platform's GMT+8 clock) → ISO UTC; null when unparseable. */
export function parseGmt8(raw: string | null): string | null {
  if (!raw) return null;
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const date = new Date(`${m[1]}T${m[2]}+08:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Raw platform status → ledger status (ADR-0009 mapping). The full enum is integration-pending:
 * anything unrecognized is null → the order is untracked and logged, never guessed at.
 * "payment completed" must be tested BEFORE the generic "completed".
 */
export function mapStatus(raw: string): WalletEntryStatus | null {
  const s = raw.toLowerCase();
  if (s.includes("payment completed")) return "pending";
  if (s.includes("invalid") || s.includes("reject")) return "clawback";
  if (s.includes("completed") || s.includes("finished") || s.includes("buyer confirmed")) {
    return "confirmed";
  }
  return null;
}

export async function resolveOrder(
  order: AliExpressOrder,
  deps: AttributionDeps,
): Promise<AttributionOutcome> {
  // Decoded by the domain's wire format — the exact mirror of withAttribution's encode.
  const params = decodeAttribution(order.customParameters);
  const referrer = params.referrer;
  if (!referrer) return { outcome: "untracked", reason: "no_ref" };
  if (referrer.env !== deps.env) return { outcome: "untracked", reason: "foreign_env" };

  // Primary: the recommendation (its owner + LOCKED split). Fallback: the af referrer sub at
  // the current config split — but only a well-formed sub; params are attacker-influencable.
  const rec = await deps.recommendations.get(referrer.recommendationId);
  let referrerSub: string;
  let cashback: { referrerBps: number; consumerBps: number };
  if (rec) {
    referrerSub = rec.ownerId;
    cashback = rec.cashback;
  } else {
    if (!Uuid.safeParse(referrer.sub).success) {
      return { outcome: "untracked", reason: "unknown_ref" };
    }
    referrerSub = referrer.sub;
    cashback = await deps.fallbackSplit();
  }

  if (!order.commissionMinor) return { outcome: "untracked", reason: "no_commission" };
  const status = mapStatus(order.status);
  if (!status) return { outcome: "untracked", reason: "unknown_status" };

  // Consumer identity, independently validated: foreign-env or malformed → treated as absent
  // (the referrer's credit never rides on the consumer half surviving).
  const c = params.consumer;
  let consumerSub: string | undefined;
  let consumerKind: ConsumerKind = "none";
  if (c && c.env === deps.env) {
    if (c.kind === "member" && Uuid.safeParse(c.id).success) {
      consumerKind = "member";
      consumerSub = c.id;
    } else if (c.kind === "guest") {
      consumerKind = "guest";
      consumerSub = (await deps.guests.get(c.id))?.sub;
    }
  }

  const gross = BigInt(order.commissionMinor);
  const currency = order.commissionCurrency ?? "USD";
  const split = splitCommission(gross, cashback.referrerBps, cashback.consumerBps);

  return {
    outcome: "resolved",
    write: {
      resolved: {
        orderId: order.orderId,
        recommendationId: referrer.recommendationId,
        referrer: {
          sub: referrerSub,
          reward: { amountMinor: split.referrerMinor, currency },
        },
        consumer:
          consumerSub && split.consumerRewardMinor > 0n
            ? { sub: consumerSub, reward: { amountMinor: split.consumerRewardMinor, currency } }
            : null,
        status,
        occurredAt: parseGmt8(order.orderTimeGmt8) ?? deps.now().toISOString(),
      },
      gross: { amountMinor: gross, currency },
      consumer: consumerKind,
    },
  };
}
