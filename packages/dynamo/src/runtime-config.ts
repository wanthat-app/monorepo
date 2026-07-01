import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import {
  CONFIG_DEFAULTS,
  type ConfigItem,
  type ConfigKey,
  type ConfigValue,
  parseConfigValue,
} from "@wanthat/contracts";

/**
 * Repository over the runtime `config` table (ADR-0003) — the admin-tunable key-value store
 * (`@wanthat/contracts` `ConfigKey`/`CONFIG_*`). The table's partition key attribute is `configKey`;
 * the `ConfigItem` contract exposes it as `key`, so this maps between the two.
 *
 * Reads always resolve to a value: an unset key falls back to its `CONFIG_DEFAULTS` entry, and every
 * value — stored or default — is validated against the key's schema (`parseConfigValue`), so a
 * caller never has to special-case "never written yet".
 */
export class RuntimeConfigRepo {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  /** Current value for `key`, falling back to its default when unset. Validated against the key's schema. */
  async get<K extends ConfigKey>(key: K): Promise<ConfigValue> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { configKey: key } }),
    );
    const raw = res.Item?.value;
    if (raw === undefined) return CONFIG_DEFAULTS[key];
    return parseConfigValue(key, raw);
  }

  /** All explicitly-set items (defaults are not materialised). Invalid stored rows are skipped, not thrown. */
  async getAll(): Promise<ConfigItem[]> {
    const res = await this.doc.send(new ScanCommand({ TableName: this.tableName }));
    const items: ConfigItem[] = [];
    for (const row of res.Items ?? []) {
      const key = ConfigKeyOf(row.configKey);
      if (!key) continue; // unknown/legacy key — ignore rather than fail the whole read
      try {
        items.push({
          key,
          value: parseConfigValue(key, row.value),
          updatedAt: String(row.updatedAt),
        });
      } catch {
        // a stored value that no longer satisfies its schema: skip (surfaced via the admin panel later)
      }
    }
    return items;
  }

  /** Validate `value` against the key's schema and upsert it; returns the stored item. */
  async put(key: ConfigKey, value: unknown, updatedAt: string): Promise<ConfigItem> {
    const validated = parseConfigValue(key, value);
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { configKey: key, value: validated, updatedAt },
      }),
    );
    return { key, value: validated, updatedAt };
  }
}

/**
 * Read-only view of the runtime config. The table is single-writer (admin-api holds the sole IAM
 * write grant); every other service depends on this type, so a stray `put` from a non-admin
 * service does not even compile. IAM is the enforcement; this is documentation that cannot drift.
 */
export type RuntimeConfigReader = Pick<RuntimeConfigRepo, "get">;

/** Narrow an arbitrary stored partition-key value to a known `ConfigKey`, or undefined. */
function ConfigKeyOf(value: unknown): ConfigKey | undefined {
  return typeof value === "string" && value in CONFIG_DEFAULTS ? (value as ConfigKey) : undefined;
}
