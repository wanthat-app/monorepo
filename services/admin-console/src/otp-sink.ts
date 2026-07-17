import { ActivityItem } from "@wanthat/contracts";
import type { OtpSinkItem } from "@wanthat/dynamo";

/**
 * Sink items -> `otp_sent` items for GET /admin/otp-sink (refactor PR-5: the codes are their own
 * console route; the audit feed on admin-ledger-view no longer merges them). Items past their
 * TTL are dropped here because DynamoDB TTL deletion is best-effort (can lag hours); `ttl` is
 * epoch seconds. Newest first, so the SPA renders them in feed order.
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
    )
    .sort((x, y) => y.at.localeCompare(x.at));
}
