import { type DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

/**
 * Repository over the `phone_velocity` table (ADR-0006 kill-switch layer 1) — a per-phone SMS-send
 * counter in a fixed time window. The key is a **hash** of the phone (not the E.164), so the table
 * stays non-PII (ADR-0003). The window is implemented with TTL: the first hit stamps `ttl =
 * now + windowSeconds` and the item is dropped when it expires, resetting the count.
 */
export class PhoneVelocityRepo {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  /**
   * Atomically increment the counter for `phoneHash` and return the new `count` plus the window's
   * `ttl` (Unix seconds), so the caller can derive a retry-after when over the cap. `nowEpoch` is
   * Unix seconds (passed in for testability); the TTL is set only on first write within the window.
   */
  async hit(
    phoneHash: string,
    windowSeconds: number,
    nowEpoch: number,
  ): Promise<{ count: number; ttl: number }> {
    const res = await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { phoneHash },
        UpdateExpression: "ADD #count :one SET #ttl = if_not_exists(#ttl, :ttl)",
        ExpressionAttributeNames: { "#count": "count", "#ttl": "ttl" },
        ExpressionAttributeValues: { ":one": 1, ":ttl": nowEpoch + windowSeconds },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    return {
      count: Number(res.Attributes?.count ?? 0),
      ttl: Number(res.Attributes?.ttl ?? nowEpoch + windowSeconds),
    };
  }
}
