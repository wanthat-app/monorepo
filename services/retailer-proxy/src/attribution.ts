/**
 * Conversion attribution (ADR-0008/0009): one raw retailer order → who gets paid what. Resolved
 * HERE, in the non-VPC proxy (ADR-0003 assigns the conversion-time guest_attribution read to
 * it), from the `custom_parameters` our resolve endpoint appended at click-through:
 *   ref → recommendation → referrer sub + the SNAPSHOTTED split (locked at creation, never live
 *         config); missing/foreign ref → untracked (also the natural cross-env isolation on the
 *         shared retailer account — another env's ref does not exist in this env's table);
 *   c   → member consumer sub; g → guest_attribution lookup (mapped → sub; unmapped → no party
 *         to credit YET, but the click was still a guest's — the event kind says so).
 * Money math is exact bigint via splitCommission; rewards stay in the settlement currency.
 */
import type { AliExpressOrder } from "@wanthat/aliexpress";
import {
  type ConsumerKind,
  type ConversionWrite,
  Uuid,
  type WalletEntryStatus,
} from "@wanthat/contracts";
import { splitCommission } from "@wanthat/domain";
import type { GuestAttributionRepo, RecommendationRepo } from "@wanthat/dynamo";

export interface AttributionDeps {
  recommendations: Pick<RecommendationRepo, "get">;
  guests: Pick<GuestAttributionRepo, "get">;
  now: () => Date;
}

export type AttributionOutcome =
  | { outcome: "resolved"; write: ConversionWrite }
  | { outcome: "untracked"; reason: "no_ref" | "unknown_ref" | "no_commission" | "unknown_status" };

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
function mapStatus(raw: string): WalletEntryStatus | null {
  const s = raw.toLowerCase();
  if (s.includes("payment completed")) return "pending";
  if (s.includes("invalid") || s.includes("reject")) return "clawback";
  if (s.includes("completed") || s.includes("finished") || s.includes("buyer confirmed")) {
    return "confirmed";
  }
  return null;
}

/** The click's custom_parameters, tolerantly decoded; every field optional and untrusted. */
function parseCustomParams(raw: string | null): { ref?: string; c?: string; g?: string } {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const rec = parsed as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
    return { ref: str(rec.ref), c: str(rec.c), g: str(rec.g) };
  } catch {
    return {};
  }
}

export async function resolveOrder(
  order: AliExpressOrder,
  deps: AttributionDeps,
): Promise<AttributionOutcome> {
  const params = parseCustomParams(order.customParameters);
  if (!params.ref) return { outcome: "untracked", reason: "no_ref" };

  const rec = await deps.recommendations.get(params.ref);
  if (!rec) return { outcome: "untracked", reason: "unknown_ref" };

  if (!order.commissionMinor) return { outcome: "untracked", reason: "no_commission" };
  const status = mapStatus(order.status);
  if (!status) return { outcome: "untracked", reason: "unknown_status" };

  // Consumer identity: a member sub beats a guest key; a malformed sub is treated as absent
  // (params are attacker-influencable query strings — validate, never trust).
  const memberSub = params.c && Uuid.safeParse(params.c).success ? params.c : undefined;
  let consumerSub: string | undefined = memberSub;
  let consumerKind: ConsumerKind = memberSub ? "member" : "none";
  if (!memberSub && params.g) {
    consumerKind = "guest";
    consumerSub = (await deps.guests.get(params.g))?.sub;
  }

  const gross = BigInt(order.commissionMinor);
  const currency = order.commissionCurrency ?? "USD";
  const split = splitCommission(gross, rec.cashback.referrerBps, rec.cashback.consumerBps);

  return {
    outcome: "resolved",
    write: {
      resolved: {
        orderId: order.orderId,
        recommendationId: rec.recommendationId,
        referrer: {
          sub: rec.ownerId,
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
