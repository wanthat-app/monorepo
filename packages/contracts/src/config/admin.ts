import { z } from "zod";
import { ConfigItem } from "./item";
import { ConfigKey, ConfigValue } from "./keys";

// GET /admin/config — list every config entry for the admin config panel.
export const ListConfigResponse = z.object({ items: z.array(ConfigItem) });
export type ListConfigResponse = z.infer<typeof ListConfigResponse>;

// GET /admin/config/{key} — read one entry.
export const GetConfigParams = z.object({ key: ConfigKey });
export type GetConfigParams = z.infer<typeof GetConfigParams>;

export const GetConfigResponse = z.object({ item: ConfigItem });
export type GetConfigResponse = z.infer<typeof GetConfigResponse>;

// PUT /admin/config/{key} — set one entry (audited admin write). The handler validates `value`
// against the key's schema via `parseConfigValue` — the generic body can't do it statically.
export const PutConfigParams = z.object({ key: ConfigKey });
export type PutConfigParams = z.infer<typeof PutConfigParams>;

export const PutConfigBody = z.object({ value: ConfigValue });
export type PutConfigBody = z.infer<typeof PutConfigBody>;

export const PutConfigResponse = z.object({ item: ConfigItem });
export type PutConfigResponse = z.infer<typeof PutConfigResponse>;
