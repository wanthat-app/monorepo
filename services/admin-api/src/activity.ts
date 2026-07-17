import { ActivityItem } from "@wanthat/contracts";
import type { AuditLogEntry } from "@wanthat/db";
import type { OtpSinkItem } from "@wanthat/dynamo";

/**
 * Pure mapping for the activity feed (I/O-free, like users-stats' buildUsersStats). Audit
 * payloads are free-form jsonb written by audit_append callers (0005); mapping is tolerant —
 * unknown types and malformed payloads still yield a renderable item, never a throw.
 */

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** audit_log row -> feed item. Known payload keys are lifted; anything else just keeps `type`. */
export function auditEntryToItem(entry: AuditLogEntry): ActivityItem {
  const p = (entry.payload && typeof entry.payload === "object" ? entry.payload : {}) as Record<
    string,
    unknown
  >;
  const first = str(p.firstName);
  const last = str(p.lastName);
  const name = first || last ? [first, last].filter(Boolean).join(" ") : undefined;
  return ActivityItem.parse({
    id: `audit_${entry.id}`,
    type: str(p.type) ?? "unknown",
    at: entry.createdAt.toISOString(),
    ...(str(p.phone) ? { phone: str(p.phone) } : {}),
    ...(name ? { name } : {}),
    ...(str(p.email) ? { email: str(p.email) } : {}),
    ...(str(p.actor) ? { actor: str(p.actor) } : {}),
    // config_changed (0007): the key plus the value transition (values are free JSON — the
    // admin SPA stringifies them for display).
    ...(str(p.key) ? { key: str(p.key) } : {}),
    ...(p.value !== undefined ? { value: p.value } : {}),
    ...(p.previous !== undefined ? { previous: p.previous } : {}),
    // wallet_entry (the conversion writer's chained rows): the member + order + money details.
    ...(str(p.cognitoSub) ? { cognitoSub: str(p.cognitoSub) } : {}),
    ...(str(p.orderId) ? { orderId: str(p.orderId) } : {}),
    ...(str(p.kind) ? { kind: str(p.kind) } : {}),
    ...(str(p.status) ? { status: str(p.status) } : {}),
    ...(str(p.amountMinor) ? { amountMinor: str(p.amountMinor) } : {}),
    ...(str(p.currency) ? { currency: str(p.currency) } : {}),
  });
}

/**
 * Dev sink items -> otp_sent feed items. Items past their TTL are dropped here because DynamoDB
 * TTL deletion is best-effort (can lag hours); `ttl` is epoch seconds.
 */
export function otpSinkToItems(items: OtpSinkItem[], nowMs: number): ActivityItem[] {
  return items
    .filter((i) => i.ttl * 1000 > nowMs)
    .map((i) =>
      ActivityItem.parse({
        id: `otp_${i.phone}`,
        type: "otp_sent",
        at: i.createdAt,
        phone: i.phone,
        channel: i.channel,
        code: i.code,
        expiresAt: new Date(i.ttl * 1000).toISOString(),
      }),
    );
}

/** Merge two newest-first lists into one, newest first (stable for equal timestamps). */
export function mergeByAtDesc(a: ActivityItem[], b: ActivityItem[]): ActivityItem[] {
  return [...a, ...b].sort((x, y) => y.at.localeCompare(x.at));
}
