import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

/**
 * PK of the exact customer counter: `{ counterKey: "customerCounter", total: N, disabled: M }`
 * in the dedicated `OpsCounters` table (PK attribute `counterKey`; env `OPS_COUNTERS_TABLE`).
 * A dedicated table so counter writers (post-confirmation, admin-credentials) carry no write
 * grant on the runtime `config` table — admin-api stays its single writer. A missing item reads
 * as `{ total: 0, disabled: 0 }` — both pools started empty, so no seed write is needed.
 */
export const CUSTOMER_COUNTER_KEY = "customerCounter";

/** `total` = confirmed customers, `disabled` = the suspended subset. Active = total - disabled. */
export interface CustomerCounts {
  total: number;
  disabled: number;
}

/**
 * The exact confirmed-customer counter (same sentinel-counter pattern as the product /
 * recommendation `#counter` items: atomic ADD, conditional floor guards). Semantics: `total`
 * counts CONFIRMED signups only — the Post-Confirmation trigger is the sole increment — so it is
 * deliberately narrower than the users page's approximate whole-pool estimate, which includes
 * UNCONFIRMED users (`DescribeUserPool.EstimatedNumberOfUsers`).
 *
 * Writers: post-confirmation increments `total`; admin-credentials decrements it on
 * cognito-delete and moves `disabled` on suspend / lift. Self-service account deletion (Cognito
 * `DeleteUser`) does NOT exist in the SPA yet (verified 2026-07-09 — no caller anywhere); when it
 * arrives it MUST call `decrementTotal` too, or the counter drifts.
 *
 * The guarded ops return `false` (log-and-skip, never throw) when a floor guard cancels the
 * write — a skipped write means the counter was already inconsistent with the pool, so
 * decrementing further would only deepen the drift. Reconcile hint: recount confirmed users via
 * paginated `ListUsers` and overwrite the item.
 */
export class CustomerCounterRepo {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  /** Current counts; a missing item (or attribute) reads as zero. */
  async get(): Promise<CustomerCounts> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { counterKey: CUSTOMER_COUNTER_KEY } }),
    );
    return { total: Number(res.Item?.total ?? 0), disabled: Number(res.Item?.disabled ?? 0) };
  }

  /** One confirmed signup: `total += 1`. Unconditional — an increment cannot go negative. */
  // `total` is a DynamoDB reserved word (and `disabled` rides the same aliasing for symmetry),
  // so every expression addresses the attributes through ExpressionAttributeNames. Each command
  // declares exactly the aliases its expressions use — DynamoDB rejects unused entries.
  async incrementTotal(): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { counterKey: CUSTOMER_COUNTER_KEY },
        UpdateExpression: "ADD #total :one",
        ExpressionAttributeNames: { "#total": "total" },
        ExpressionAttributeValues: { ":one": 1 },
      }),
    );
  }

  /**
   * One deleted account: `total -= 1`, and `disabled -= 1` too when the account was suspended at
   * deletion time (`wasDisabled`). Floor-guarded so neither count goes negative; a guard failure
   * skips the WHOLE write (returns false).
   */
  async decrementTotal(wasDisabled: boolean): Promise<boolean> {
    return this.guarded("decrementTotal", {
      UpdateExpression: wasDisabled
        ? "ADD #total :minusOne, #disabled :minusOne"
        : "ADD #total :minusOne",
      ConditionExpression: wasDisabled ? "#total >= :one AND #disabled >= :one" : "#total >= :one",
      ExpressionAttributeNames: wasDisabled
        ? { "#total": "total", "#disabled": "disabled" }
        : { "#total": "total" },
      ExpressionAttributeValues: { ":minusOne": -1, ":one": 1 },
    });
  }

  /**
   * One suspension of a previously-ENABLED user (the caller checks the prior state — repeats must
   * not double-count): `disabled += 1`, guarded so `disabled` never exceeds `total` (a missing
   * `disabled` attribute counts as 0).
   */
  async markDisabled(): Promise<boolean> {
    return this.guarded("markDisabled", {
      UpdateExpression: "ADD #disabled :one",
      ConditionExpression:
        "#total >= :one AND (attribute_not_exists(#disabled) OR #disabled < #total)",
      ExpressionAttributeNames: { "#total": "total", "#disabled": "disabled" },
      ExpressionAttributeValues: { ":one": 1 },
    });
  }

  /** One lifted suspension of a previously-DISABLED user: `disabled -= 1`, floor-guarded at 0. */
  async markEnabled(): Promise<boolean> {
    return this.guarded("markEnabled", {
      UpdateExpression: "ADD #disabled :minusOne",
      ConditionExpression: "#disabled >= :one",
      ExpressionAttributeNames: { "#disabled": "disabled" },
      ExpressionAttributeValues: { ":minusOne": -1, ":one": 1 },
    });
  }

  /** Run one guarded ADD; a ConditionalCheckFailed is logged and skipped (false), never thrown. */
  private async guarded(
    op: string,
    input: {
      UpdateExpression: string;
      ConditionExpression: string;
      ExpressionAttributeNames: Record<string, string>;
      ExpressionAttributeValues: Record<string, number>;
    },
  ): Promise<boolean> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { counterKey: CUSTOMER_COUNTER_KEY },
          ...input,
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        // Floor guard fired: the counter already disagrees with the pool. Skip rather than go
        // negative, and say so loudly — this line is the drift signal operators grep for.
        console.warn(
          JSON.stringify({ warn: "customer_counter_floor_skip", op, table: this.tableName }),
        );
        return false;
      }
      throw err;
    }
  }
}
