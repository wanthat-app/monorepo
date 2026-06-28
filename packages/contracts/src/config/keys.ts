import { z } from "zod";
import { Bps } from "../common";

/**
 * Admin-tunable **runtime** configuration as a generic key-value store — distinct from the
 * boot-time `Env` contract in `@wanthat/config` (env vars, validated fail-fast at startup). These
 * values change at runtime via the admin config panel without a redeploy, so they are operational,
 * non-PII state in a DynamoDB `config` table (ADR-0003): written by `admin-api`, read where needed
 * (e.g. the public redirect path reads `landing.countdownSeconds`).
 *
 * The store is key-value so new parameters are added without new endpoints — but every value is
 * still validated against its key's schema (schema-first, ADR-0001). Adding a parameter is one
 * entry in `CONFIG_SCHEMAS` + `CONFIG_DEFAULTS`.
 */

/** A stored config value. Primitive for now (DynamoDB-native); widen here as needs grow. */
export const ConfigValue = z.union([z.string(), z.number(), z.boolean()]);
export type ConfigValue = z.infer<typeof ConfigValue>;

// ---- Per-key value schemas (reused at the boundaries that read each key) ----

/** Branded-landing countdown before the auto-redirect fires, in whole seconds (ADR-0007). */
export const LandingCountdownSeconds = z.number().int().min(0).max(30);

/**
 * The current cashback split policy — our share of the retailer commission paid to each side, in
 * basis points. These are the admin-tunable **defaults**; a Recommendation snapshots them at
 * creation (`CashbackSplit`), so changing them here affects only new links (UC5 #4).
 */
export const CashbackReferrerBps = Bps;
export const CashbackConsumerBps = Bps;

/**
 * Conversion commission withheld when the held settlement-currency balance (e.g. USD) is shown and
 * paid out in the member's currency (e.g. ILS), in basis points — so the displayed ILS reflects the
 * real, all-in rate the member would receive at withdrawal (UC5 #1). Admin-tunable.
 */
export const FxConversionCommissionBps = Bps;

/** Known config keys. Dotted namespaces group related settings. */
export const CONFIG_KEYS = [
  "landing.countdownSeconds",
  "cashback.referrerBps",
  "cashback.consumerBps",
  "fx.conversionCommissionBps",
] as const;

export const ConfigKey = z.enum(CONFIG_KEYS);
export type ConfigKey = z.infer<typeof ConfigKey>;

/** key → the schema its value must satisfy. The single source of truth for value validation. */
export const CONFIG_SCHEMAS: Record<ConfigKey, z.ZodType<ConfigValue>> = {
  "landing.countdownSeconds": LandingCountdownSeconds,
  "cashback.referrerBps": CashbackReferrerBps,
  "cashback.consumerBps": CashbackConsumerBps,
  "fx.conversionCommissionBps": FxConversionCommissionBps,
};

/**
 * key → the value used when the key has never been set in the store. The cashback figures are
 * business placeholders (referrer 50% of commission, consumer 0% — two-sided reward is Phase 2);
 * confirm before launch.
 */
export const CONFIG_DEFAULTS: Record<ConfigKey, ConfigValue> = {
  "landing.countdownSeconds": 3,
  "cashback.referrerBps": 5000,
  "cashback.consumerBps": 0,
  "fx.conversionCommissionBps": 200,
};

/** Validate a value against its key's schema — use in the config API handler before persisting. */
export function parseConfigValue(key: ConfigKey, value: unknown): ConfigValue {
  return CONFIG_SCHEMAS[key].parse(value);
}
