import { z } from "zod";
import { ConfigValue } from "./keys";

/**
 * GET /config?keys=k1,k2,… — the PUBLIC, unauthenticated runtime-config projection (served by
 * app-links, no JWT authorizer). Only keys marked public in `CONFIG_PUBLIC` may be requested;
 * an unknown or non-public key — or more than `PUBLIC_CONFIG_MAX_KEYS` — is a 400, never a
 * partial answer. Values resolve exactly like the authenticated reads (stored, else default).
 */
export const PUBLIC_CONFIG_MAX_KEYS = 20;

export const PublicConfigResponse = z.object({
  /** Requested key → its effective value. Keys are `ConfigKey`s; the record stays loose on the wire. */
  values: z.record(z.string(), ConfigValue),
});
export type PublicConfigResponse = z.infer<typeof PublicConfigResponse>;
