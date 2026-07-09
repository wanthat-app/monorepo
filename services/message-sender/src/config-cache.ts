import type { ConfigKey, ConfigValue } from "@wanthat/contracts";
import type { RuntimeConfigReader } from "@wanthat/dynamo";

/**
 * Per-container read-through cache over the runtime-config table. The sender resolves the OTP
 * channel on EVERY Cognito trigger (four config keys), so a warm container would otherwise hit
 * DynamoDB four times per OTP; a short TTL keeps kill-switch flips near-immediate (a flipped
 * switch takes effect within `ttlMs` per warm container) while collapsing the steady-state reads.
 * Failed reads are never cached — the next call retries the table.
 */
export function cachedConfigReader(inner: RuntimeConfigReader, ttlMs: number): RuntimeConfigReader {
  const cache = new Map<ConfigKey, { value: ConfigValue; expiresAt: number }>();
  return {
    async get(key: ConfigKey): Promise<ConfigValue> {
      const hit = cache.get(key);
      if (hit && hit.expiresAt > Date.now()) return hit.value;
      const value = await inner.get(key);
      cache.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    },
  };
}
