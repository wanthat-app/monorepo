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
/** How often the FX rates-updater refreshes the fx_rate cache, in minutes (UC8). */
export const FxUpdateIntervalMinutes = z.number().int().min(1).max(1440);
/**
 * Which FX rate source is live (ADR-0017). Both are implemented behind the `fx-rates` adapter; the
 * active one is admin-selected here. `boi` = Bank of Israel representative rate (official, but its
 * commercial-use licensing needs written consent — see the Product/Legal tracking issue); `ecb` =
 * ECB reference rate (freely reusable, the commercial-safe default).
 */
export const FxProvider = z.enum(["boi", "ecb"]);
export type FxProvider = z.infer<typeof FxProvider>;

/** How often the conversion poller runs, in minutes — admin-api applies it to the EventBridge schedule. */
export const PollerIntervalMinutes = z.number().int().min(1).max(1440);
/** How far back each poll re-scans to catch status maturation, in hours — read by the poller at run time. */
export const PollerLookbackHours = z.number().int().min(1).max(2160);

/**
 * SMS-OTP kill switch (ADR-0006, ADR-0020). When `false`, `app-api` short-circuits any Cognito SMS
 * send before it is attempted — the layered defence against an SMS-pumping abuse spike, flippable at
 * runtime (admin panel or an automated alarm action) without a redeploy. Lives here (DynamoDB
 * `config`) rather than SSM so the in-VPC Lambdalith reads it over the existing DynamoDB gateway
 * endpoint, with no extra interface endpoint. `@wanthat/config` `OTP_SMS_ENABLED` remains the
 * boot-time default applied before this key has ever been written.
 */
export const AuthSmsEnabled = z.boolean();

/**
 * Per-phone SMS-OTP send cap within the lockout window (ADR-0006 velocity layer): the most sends
 * one phone may trigger before further `/auth/start` + `/auth/resend` requests are refused (HTTP
 * 429). Admin-tunable so the gate can be tightened during an SMS-pumping spike without a redeploy;
 * paired with `auth.smsLockoutMinutes`, which sets the window length.
 */
export const AuthSmsMaxPerWindow = z.number().int().min(1).max(20);
/**
 * How long the per-phone SMS velocity counter is held before it resets, in minutes — i.e. the
 * lockout duration once a phone trips `auth.smsMaxPerWindow`. Admin-tunable (ADR-0006).
 */
export const AuthSmsLockoutMinutes = z.number().int().min(1).max(1440);

/** Known config keys. Dotted namespaces group related settings. */
export const CONFIG_KEYS = [
  "landing.countdownSeconds",
  "cashback.referrerBps",
  "cashback.consumerBps",
  "fx.conversionCommissionBps",
  "fx.updateIntervalMinutes",
  "fx.provider",
  "poller.intervalMinutes",
  "poller.lookbackHours",
  "auth.smsEnabled",
  "auth.smsMaxPerWindow",
  "auth.smsLockoutMinutes",
] as const;

export const ConfigKey = z.enum(CONFIG_KEYS);
export type ConfigKey = z.infer<typeof ConfigKey>;

/** key → the schema its value must satisfy. The single source of truth for value validation. */
export const CONFIG_SCHEMAS: Record<ConfigKey, z.ZodType<ConfigValue>> = {
  "landing.countdownSeconds": LandingCountdownSeconds,
  "cashback.referrerBps": CashbackReferrerBps,
  "cashback.consumerBps": CashbackConsumerBps,
  "fx.conversionCommissionBps": FxConversionCommissionBps,
  "fx.updateIntervalMinutes": FxUpdateIntervalMinutes,
  "fx.provider": FxProvider,
  "poller.intervalMinutes": PollerIntervalMinutes,
  "poller.lookbackHours": PollerLookbackHours,
  "auth.smsEnabled": AuthSmsEnabled,
  "auth.smsMaxPerWindow": AuthSmsMaxPerWindow,
  "auth.smsLockoutMinutes": AuthSmsLockoutMinutes,
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
  "fx.updateIntervalMinutes": 720, // twice daily; the conversion commission absorbs intraday drift
  "fx.provider": "ecb", // commercial-safe default until BoI consent is obtained (ADR-0017)
  "poller.intervalMinutes": 60,
  // Lookback must cover an order's full maturation; 72h is a placeholder — tune at integration
  // to AliExpress's confirm/return latency (see ADR-0009).
  "poller.lookbackHours": 72,
  // SMS OTP on by default; the kill switch flips this to false to stop sends during an abuse spike.
  "auth.smsEnabled": true,
  // At most 5 OTP sends per phone per lockout window; tighten during an SMS-pumping spike.
  "auth.smsMaxPerWindow": 5,
  "auth.smsLockoutMinutes": 180, // 3h lockout once a phone trips the per-window cap
};

/** Validate a value against its key's schema — use in the config API handler before persisting. */
export function parseConfigValue(key: ConfigKey, value: unknown): ConfigValue {
  return CONFIG_SCHEMAS[key].parse(value);
}
