import { z } from "zod";
import { IsoDateTime } from "../common";
import { ConfigKey, ConfigValue } from "./keys";

/**
 * One config entry as stored in the DynamoDB `config` table and returned by the config API.
 * Keyed by `key`; `value` is validated against that key's schema (see `parseConfigValue`).
 */
export const ConfigItem = z.object({
  key: ConfigKey,
  value: ConfigValue,
  updatedAt: IsoDateTime,
});
export type ConfigItem = z.infer<typeof ConfigItem>;
