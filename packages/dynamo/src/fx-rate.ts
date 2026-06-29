import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { type Currency, ExchangeRate } from "@wanthat/contracts";

/** The `fx_rate` table's partition key: an ordered pair, e.g. `USD#ILS` (quote-per-base). */
export const fxPairKey = (base: Currency, quote: Currency): string => `${base}#${quote}`;

/**
 * Repository over the `fx_rate` cache table (ADR-0003, ADR-0017). One item per ordered `(base, quote)`
 * pair: the stored item adds a `pair` partition-key attribute around an `ExchangeRate`
 * (`@wanthat/contracts`); reads validate back through `ExchangeRate`, which drops the extra `pair`.
 *
 * Written by the scheduled `fx-rates` updater and read by display/withdrawal conversion
 * (`convertMinor`, `@wanthat/domain`). `put` is a full-item upsert, so a refresh is idempotent and a
 * failed provider fetch can simply skip the write to leave the last-known-good rate in place.
 */
export class FxRateRepo {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  /** The cached rate for `(base, quote)`, or undefined if never cached. */
  async get(base: Currency, quote: Currency): Promise<ExchangeRate | undefined> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { pair: fxPairKey(base, quote) } }),
    );
    return res.Item ? ExchangeRate.parse(res.Item) : undefined;
  }

  /** Every cached rate (for the admin console / `ListFxRatesResponse`). Invalid rows are skipped. */
  async getAll(): Promise<ExchangeRate[]> {
    const res = await this.doc.send(new ScanCommand({ TableName: this.tableName }));
    const rates: ExchangeRate[] = [];
    for (const row of res.Items ?? []) {
      const parsed = ExchangeRate.safeParse(row);
      if (parsed.success) rates.push(parsed.data);
    }
    return rates;
  }

  /** Upsert a rate; the `pair` key is derived from `base`/`quote`. Validates before writing. */
  async put(rate: ExchangeRate): Promise<ExchangeRate> {
    const r = ExchangeRate.parse(rate);
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { pair: fxPairKey(r.base, r.quote), ...r },
      }),
    );
    return r;
  }
}
