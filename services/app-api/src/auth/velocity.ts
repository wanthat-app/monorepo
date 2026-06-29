import { createHash } from "node:crypto";
import type { PhoneVelocityRepo } from "@wanthat/dynamo";

/** Per-phone SMS velocity (ADR-0006 layer 1): at most this many sends per rolling window. */
export const VELOCITY_LIMIT = 5;
export const VELOCITY_WINDOW_SECONDS = 60 * 60; // 1 hour

/** Hash the phone so the velocity table holds no PII (ADR-0003). */
export function hashPhone(phone: string): string {
  return createHash("sha256").update(phone).digest("hex");
}

/**
 * Record an SMS-send attempt for `phone` and report whether it is within the limit. Over the limit →
 * `false` (the caller returns 429 without sending). `nowEpoch` is Unix seconds.
 */
export async function withinVelocity(
  repo: PhoneVelocityRepo,
  phone: string,
  nowEpoch: number,
): Promise<boolean> {
  const count = await repo.hit(hashPhone(phone), VELOCITY_WINDOW_SECONDS, nowEpoch);
  return count <= VELOCITY_LIMIT;
}
