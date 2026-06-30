import { createHash } from "node:crypto";
import type { PhoneVelocityRepo, RuntimeConfigRepo } from "@wanthat/dynamo";

/** Hash the phone so the velocity table holds no PII (ADR-0003). */
export function hashPhone(phone: string): string {
  return createHash("sha256").update(phone).digest("hex");
}

/**
 * Record an SMS-send attempt for `phone` and report whether it is within the admin-tunable cap. The
 * window (`auth.smsLockoutMinutes`) and cap (`auth.smsMaxPerWindow`) are read from runtime config so
 * the gate can be tightened during an SMS-pumping spike without a redeploy (ADR-0006). Over the cap →
 * `allowed: false` with `retryAfterSec` until the counter's TTL expires; within → `allowed: true`,
 * `retryAfterSec: 0`. `nowEpoch` is Unix seconds.
 */
export async function withinVelocity(
  config: RuntimeConfigRepo,
  repo: PhoneVelocityRepo,
  phone: string,
  nowEpoch: number,
): Promise<{ allowed: boolean; retryAfterSec: number }> {
  const limit = (await config.get("auth.smsMaxPerWindow")) as number;
  const windowSeconds = ((await config.get("auth.smsLockoutMinutes")) as number) * 60;
  const { count, ttl } = await repo.hit(hashPhone(phone), windowSeconds, nowEpoch);
  if (count <= limit) return { allowed: true, retryAfterSec: 0 };
  return { allowed: false, retryAfterSec: Math.max(0, ttl - nowEpoch) };
}
