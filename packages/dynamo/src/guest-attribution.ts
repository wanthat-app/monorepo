import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { type DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

export interface GuestAttribution {
  guestId: string;
  /** The member's canonical id — the Cognito sub (ADR-0025). */
  sub: string;
  claimedAt: string;
}

/**
 * Repository over the `guest_attribution` table (ADR-0008) — maps an anonymous `guestId` to the
 * member who later registered (by canonical `sub`, ADR-0025), so a conversion attributed to the
 * guest can be resolved to a member. Best-effort and **first-claim-wins**: a guestId already
 * mapped is not overwritten.
 */
export class GuestAttributionRepo {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  /** Map `guestId → sub` if unclaimed. Returns true if this call created the mapping. */
  async claim(guestId: string, sub: string, claimedAt: string): Promise<boolean> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { guestId, sub, claimedAt },
          ConditionExpression: "attribute_not_exists(guestId)",
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false; // already claimed — fine
      throw err;
    }
  }

  async get(guestId: string): Promise<GuestAttribution | undefined> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { guestId } }),
    );
    return res.Item ? (res.Item as GuestAttribution) : undefined;
  }
}
