import type { BatchGetCommandOutput, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { BatchGetCommand, GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
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
/** Max keys per {@link RuntimeConfigRepo.getMany} call — one BatchGetItem page. */
export const CONFIG_GET_MANY_MAX = 20;

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

  /**
   * Current values for several keys in ONE BatchGetItem round trip — the public config
   * endpoint's read. Same per-key resolution as {@link get}: an unset key falls back to its
   * `CONFIG_DEFAULTS` entry and every value is schema-validated. Capped at
   * {@link CONFIG_GET_MANY_MAX} (one BatchGetItem page); callers exposing this over HTTP map
   * the throw to a 400. Duplicate keys are deduplicated (DynamoDB rejects them in a batch).
   */
  async getMany<K extends ConfigKey>(keys: readonly K[]): Promise<Record<K, ConfigValue>> {
    const unique = [...new Set(keys)];
    if (unique.length > CONFIG_GET_MANY_MAX) {
      throw new Error(`getMany: at most ${CONFIG_GET_MANY_MAX} keys per call`);
    }
    const stored = new Map<string, unknown>();
    if (unique.length > 0) {
      let keysToFetch: Record<string, unknown>[] | undefined = unique.map((key) => ({
        configKey: key,
      }));
      // BatchGet may leave keys unprocessed under throttling; drain with a bounded retry.
      for (let attempt = 0; keysToFetch && attempt < 3; attempt++) {
        const res: BatchGetCommandOutput = await this.doc.send(
          new BatchGetCommand({ RequestItems: { [this.tableName]: { Keys: keysToFetch } } }),
        );
        for (const row of res.Responses?.[this.tableName] ?? []) {
          stored.set(String(row.configKey), row.value);
        }
        const leftover = res.UnprocessedKeys?.[this.tableName]?.Keys;
        keysToFetch = leftover?.length ? leftover : undefined;
      }
      if (keysToFetch) throw new Error("getMany: unprocessed keys after retries");
    }
    const values = {} as Record<K, ConfigValue>;
    for (const key of unique) {
      const raw = stored.get(key);
      values[key] = raw === undefined ? CONFIG_DEFAULTS[key] : parseConfigValue(key, raw);
    }
    return values;
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
 * Read-only view of the runtime config. admin-api holds the sole write grant on the config
 * table; every other config consumer depends on this type, so a stray `put` from a non-admin
 * service does not even compile. IAM is the enforcement; this is documentation that cannot drift.
 */
export type RuntimeConfigReader = Pick<RuntimeConfigRepo, "get">;

/** Reader that also serves batched reads — the public config endpoint's dependency. */
export type RuntimeConfigBatchReader = Pick<RuntimeConfigRepo, "get" | "getMany">;

/** Narrow an arbitrary stored partition-key value to a known `ConfigKey`, or undefined. */
function ConfigKeyOf(value: unknown): ConfigKey | undefined {
  return typeof value === "string" && value in CONFIG_DEFAULTS ? (value as ConfigKey) : undefined;
}
