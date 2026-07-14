import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { BatchGetCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

/**
 * Dashboard metrics in the OpsCounters table (same sentinel-counter pattern as
 * `customerCounter` — PK attribute `counterKey`, atomic ADD, a missing item reads as zero):
 *
 *   `signupsDaily#<YYYY-MM-DD>`  { count }        confirmed signups that local day
 *   `recsDaily#<YYYY-MM-DD>`     { count }        recommendations created that local day
 *   `activeDaily#<YYYY-MM-DD>`   { count }        DISTINCT members seen that local day
 *   `presence#<sub>`             { lastSeenDate } the member's last active local day
 *
 * "Active" means USED THE APP (any authenticated member-API call), not "signed in" — the SPA
 * keeps sessions alive via refresh tokens, so fresh Cognito sign-ins would undercount badly.
 * The presence item is the first-touch-of-day detector AND the source for distinct
 * active-in-window counts (which canNOT be summed from daily counters — repeat visitors would
 * double-count). All days are Asia/Jerusalem calendar dates, matching how the dashboard reads.
 */
export type DailyMetric = "signupsDaily" | "recsDaily" | "activeDaily";

export const PRESENCE_PREFIX = "presence#";

// Hoisted: constructing a DateTimeFormat is ~40x the cost of format(), and admin money
// stats calls jerusalemDate once per ledger row. format() itself is stateless.
const JERUSALEM_DATE_FORMAT = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" });

/** The Asia/Jerusalem calendar date of an instant, as YYYY-MM-DD (en-CA gives ISO order). */
export function jerusalemDate(now: Date = new Date()): string {
  return JERUSALEM_DATE_FORMAT.format(now);
}

/**
 * Dense ascending list of the last `n` Jerusalem calendar dates, ending today. Arithmetic runs
 * on a noon-UTC anchor of today's LOCAL date so DST transitions can't skip or repeat a day.
 */
export function lastNDates(n: number, now: Date = new Date()): string[] {
  const anchor = new Date(`${jerusalemDate(now)}T12:00:00Z`);
  const dates: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    dates.push(new Date(anchor.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  }
  return dates;
}

const dailyKey = (metric: DailyMetric, date: string) => `${metric}#${date}`;

export class OpsMetricsRepo {
  /** sub → the date this container already stamped (skips repeat DynamoDB calls same-day). */
  private readonly stamped = new Map<string, string>();

  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  /** ADD 1 to a daily metric counter (atomic; the item materialises on first ADD). */
  // `count` is aliased through ExpressionAttributeNames — it is a DynamoDB reserved word.
  async incrementDaily(metric: DailyMetric, date: string): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { counterKey: dailyKey(metric, date) },
        UpdateExpression: "ADD #count :one",
        ExpressionAttributeNames: { "#count": "count" },
        ExpressionAttributeValues: { ":one": 1 },
      }),
    );
  }

  /**
   * First-touch-of-day: advance the member's presence stamp to `date`; when this call won the
   * advance (condition passed), also bump that day's distinct-actives counter. Returns whether
   * THIS call was the first touch. The `<` condition (ISO dates compare lexicographically)
   * also refuses to move a stamp backwards if a laggard container carries yesterday's date.
   */
  async markActive(sub: string, date: string): Promise<boolean> {
    if (this.stamped.get(sub) === date) return false;
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { counterKey: `${PRESENCE_PREFIX}${sub}` },
          UpdateExpression: "SET lastSeenDate = :date",
          ConditionExpression: "attribute_not_exists(lastSeenDate) OR lastSeenDate < :date",
          ExpressionAttributeValues: { ":date": date },
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        // Another container (or an earlier cold start) already counted this member today.
        this.stamped.set(sub, date);
        return false;
      }
      throw err;
    }
    this.stamped.set(sub, date);
    await this.incrementDaily("activeDaily", date);
    return true;
  }

  /** Fire-and-forget presence stamp for request paths: never delays or fails the member call. */
  touch(sub: string, date: string): void {
    void this.markActive(sub, date).catch((err) => {
      console.error(
        JSON.stringify({
          error: "presence_stamp_failed",
          sub,
          detail: err instanceof Error ? err.message : String(err),
        }),
      );
    });
  }

  /** Dense daily counts for the given dates — missing items (quiet days) read as zero. */
  async getDailyCounts(metric: DailyMetric, dates: string[]): Promise<Map<string, number>> {
    const counts = new Map(dates.map((d) => [d, 0]));
    // 30 dates fit one BatchGet page (cap 100), but honor UnprocessedKeys regardless.
    let keys: Record<string, unknown>[] = dates.map((date) => ({
      counterKey: dailyKey(metric, date),
    }));
    while (keys.length > 0) {
      const res = await this.doc.send(
        new BatchGetCommand({ RequestItems: { [this.tableName]: { Keys: keys } } }),
      );
      for (const item of res.Responses?.[this.tableName] ?? []) {
        counts.set(String(item.counterKey).slice(metric.length + 1), Number(item.count ?? 0));
      }
      keys = res.UnprocessedKeys?.[this.tableName]?.Keys ?? [];
    }
    return counts;
  }

  /**
   * DISTINCT members seen on/after `cutoffDate` (inclusive): a COUNT scan over the presence
   * items — one tiny item per member ever seen, fine at MVP scale (the spec's accepted
   * exception to O(1) counter reads; swap the implementation if scale ever demands).
   */
  async countActiveSince(cutoffDate: string): Promise<number> {
    let count = 0;
    let startKey: Record<string, unknown> | undefined;
    do {
      const res = await this.doc.send(
        new ScanCommand({
          TableName: this.tableName,
          Select: "COUNT",
          FilterExpression: "begins_with(counterKey, :prefix) AND lastSeenDate >= :cutoff",
          ExpressionAttributeValues: { ":prefix": PRESENCE_PREFIX, ":cutoff": cutoffDate },
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }),
      );
      count += res.Count ?? 0;
      startKey = res.LastEvaluatedKey;
    } while (startKey);
    return count;
  }
}
