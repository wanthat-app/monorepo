import {
  type ConfigKey,
  ConfigKey as ConfigKeySchema,
  isPublicConfigKey,
  PUBLIC_CONFIG_MAX_KEYS,
  PublicConfigResponse,
} from "@wanthat/contracts";
import { Hono } from "hono";
import type { Bindings } from "../claims";
import { getContext } from "../context";

/**
 * The PUBLIC runtime-config projection (replaces the retired `GET /auth/config`, generically):
 * `GET /config?keys=k1,k2,…` answers only keys allow-listed in `CONFIG_PUBLIC`
 * (`@wanthat/contracts`) — the SPA reads these before any sign-in (e.g. which OTP channels the
 * register screen offers). Wired at the gateway WITHOUT the JWT authorizer, like `/healthz`
 * (infra/lib/api-stack.ts).
 *
 * Strict by design: 1..20 keys, and ANY unknown or non-public key fails the whole request with
 * a 400 — no partial answers, so a typo (or a probe for a private key) is loud, and the private
 * set (`auth.otpSink`, `whatsapp.phoneNumberId`, …) is unreachable here regardless of what the
 * config table holds. `cache-control: no-store` because these are live kill switches.
 */
export function publicConfigRouter(): Hono<{ Bindings: Bindings }> {
  const config = new Hono<{ Bindings: Bindings }>();

  config.get("/", async (c) => {
    const raw = c.req.query("keys");
    if (!raw) return c.json({ error: "invalid_request" }, 400);
    const requested = raw.split(",");
    if (requested.length < 1 || requested.length > PUBLIC_CONFIG_MAX_KEYS) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const keys: ConfigKey[] = [];
    for (const candidate of requested) {
      const parsed = ConfigKeySchema.safeParse(candidate.trim());
      if (!parsed.success || !isPublicConfigKey(parsed.data)) {
        return c.json({ error: "invalid_request" }, 400);
      }
      keys.push(parsed.data);
    }
    const values = await getContext().config.getMany(keys);
    return c.json(PublicConfigResponse.parse({ values }), 200, {
      "cache-control": "no-store",
    });
  });

  return config;
}
