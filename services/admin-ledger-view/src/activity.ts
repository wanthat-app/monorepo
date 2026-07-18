import { ActivityItem } from "@wanthat/contracts";
import type { AuditLogEntry } from "@wanthat/db";

/**
 * Pure mapping for the activity feed (I/O-free, like users-stats' buildUsersStats). Audit
 * payloads are free-form jsonb written by audit_append callers (0005); mapping is tolerant —
 * unknown types and malformed payloads still yield a renderable item, never a throw.
 * The parked-OTP mapping (`otpSinkToItems`) lives on admin-console since refactor PR-5: the
 * codes are their own GET /admin/otp-sink route, no longer merged into this feed.
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
    // The member the event is about: wallet_entry payloads name it `cognitoSub`; user events
    // (user_registered / moderation) carry `sub`. Either way the SPA resolves + links it.
    ...(str(p.cognitoSub) ?? str(p.sub)
      ? { cognitoSub: str(p.cognitoSub) ?? str(p.sub) }
      : {}),
    ...(str(p.orderId) ? { orderId: str(p.orderId) } : {}),
    ...(str(p.kind) ? { kind: str(p.kind) } : {}),
    ...(str(p.status) ? { status: str(p.status) } : {}),
    ...(str(p.amountMinor) ? { amountMinor: str(p.amountMinor) } : {}),
    ...(str(p.currency) ? { currency: str(p.currency) } : {}),
  });
}
