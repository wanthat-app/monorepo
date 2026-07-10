import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";

/**
 * The `unattributed_order` projection (Phase 2 of the unattributed-cashback plan, 2026-07-10):
 * one item per same-env order the poller could not attribute, PK `orderId`. Lifecycle `state`:
 * `open` (poller sighting) → `claimed` (admin binds it to a recommendation) → `settled` (the
 * retailer-proxy heartbeat pushed the claim through the conversion writer), or `open|claimed` →
 * `dismissed` (reviewed house revenue). Writers: the poller upserts sightings, admin-api sets
 * claims/dismissals, the proxy settles — all field-scoped updates, so the three never clobber
 * each other. The GSI `byState` (`state`, `firstSeenAt`) serves the admin list and the proxy's
 * claimed-queue sweep. `STATE` is a DynamoDB reserved word — expressions alias it as `#st`.
 */
export const UnattributedOrderItem = z.object({
  orderId: z.string().min(1),
  reason: z.string(),
  orderStatus: z.string(),
  commissionMinor: z.string().regex(/^\d+$/).nullable(),
  currency: z.string().nullable(),
  occurredAt: z.string().nullable(),
  // Product + payment context for the admin's portal cross-reference. Defaults keep rows
  // written before these fields parsing; a later re-sighting fills them in.
  productId: z.string().nullable().default(null),
  productTitle: z.string().nullable().default(null),
  productImageUrl: z.string().nullable().default(null),
  productDetailUrl: z.string().nullable().default(null),
  productCount: z.number().int().nullable().default(null),
  paidAmountMinor: z.string().nullable().default(null),
  commissionRate: z.string().nullable().default(null),
  subOrderId: z.string().nullable().default(null),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  state: z.enum(["open", "claimed", "settled", "dismissed"]),
  claim: z
    .object({
      recommendationId: z.string(),
      claimedBy: z.string(),
      claimedAt: z.string(),
    })
    .nullable()
    .default(null),
  settledAt: z.string().nullable().default(null),
});
export type UnattributedOrderItem = z.infer<typeof UnattributedOrderItem>;

export interface UnattributedOrderSighting {
  orderId: string;
  reason: string;
  orderStatus: string;
  commissionMinor: string | null;
  currency: string | null;
  occurredAt: string | null;
  productId: string | null;
  productTitle: string | null;
  productImageUrl: string | null;
  productDetailUrl: string | null;
  productCount: number | null;
  paidAmountMinor: string | null;
  commissionRate: string | null;
  subOrderId: string | null;
}

export interface UnattributedOrderPage {
  items: UnattributedOrderItem[];
  /** Raw DynamoDB LastEvaluatedKey — the caller encodes it into an opaque cursor. */
  lastKey: Record<string, unknown> | undefined;
}

/** Repository over the `unattributed_order` table. */
export class UnattributedOrderRepo {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  /**
   * Poller upsert, re-sighting-safe: the volatile fields (status/commission/lastSeenAt) always
   * refresh — an order's later lifecycle stages update the row — while `firstSeenAt` and `state`
   * set only once, so an admin's claim/dismissal is never clobbered by the next poll overlap.
   */
  async recordSighting(sighting: UnattributedOrderSighting, nowIso: string): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { orderId: sighting.orderId },
        UpdateExpression:
          "SET reason = :reason, orderStatus = :orderStatus, commissionMinor = :commissionMinor, " +
          "currency = :currency, occurredAt = :occurredAt, productId = :productId, " +
          "productTitle = :productTitle, productImageUrl = :productImageUrl, " +
          "productDetailUrl = :productDetailUrl, productCount = :productCount, " +
          "paidAmountMinor = :paidAmountMinor, commissionRate = :commissionRate, " +
          "subOrderId = :subOrderId, lastSeenAt = :now, " +
          "firstSeenAt = if_not_exists(firstSeenAt, :now), #st = if_not_exists(#st, :open)",
        ExpressionAttributeNames: { "#st": "state" },
        ExpressionAttributeValues: {
          ":reason": sighting.reason,
          ":orderStatus": sighting.orderStatus,
          ":commissionMinor": sighting.commissionMinor,
          ":currency": sighting.currency,
          ":occurredAt": sighting.occurredAt,
          ":productId": sighting.productId,
          ":productTitle": sighting.productTitle,
          ":productImageUrl": sighting.productImageUrl,
          ":productDetailUrl": sighting.productDetailUrl,
          ":productCount": sighting.productCount,
          ":paidAmountMinor": sighting.paidAmountMinor,
          ":commissionRate": sighting.commissionRate,
          ":subOrderId": sighting.subOrderId,
          ":now": nowIso,
          ":open": "open",
        },
      }),
    );
  }

  /** One order for the admin detail page. */
  async get(orderId: string): Promise<UnattributedOrderItem | undefined> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { orderId } }),
    );
    return res.Item ? UnattributedOrderItem.parse(res.Item) : undefined;
  }

  /** The admin list + the proxy's claimed-queue sweep: `byState`, newest first. */
  async listByState(
    state: UnattributedOrderItem["state"],
    limit: number,
    startKey?: Record<string, unknown>,
  ): Promise<UnattributedOrderPage> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "byState",
        KeyConditionExpression: "#st = :state",
        ExpressionAttributeNames: { "#st": "state" },
        ExpressionAttributeValues: { ":state": state },
        ScanIndexForward: false,
        Limit: limit,
        ExclusiveStartKey: startKey,
      }),
    );
    return {
      items: (res.Items ?? []).map((item) => UnattributedOrderItem.parse(item)),
      lastKey: res.LastEvaluatedKey,
    };
  }

  /**
   * Admin claim: bind the order to a recommendation. Allowed from `open` (first claim) and
   * `claimed` (correcting a typo before settlement); a settled/dismissed/missing order — or one
   * with no commission to split (the extra type condition: null is not an S) — answers
   * `undefined`: the admin gets a conflict, never a silent overwrite of paid money.
   */
  async claim(
    orderId: string,
    claim: { recommendationId: string; claimedBy: string },
    nowIso: string,
  ): Promise<UnattributedOrderItem | undefined> {
    return this.transition(orderId, ["open", "claimed"], {
      UpdateExpression: "SET #st = :claimed, claim = :claim",
      extraCondition: "attribute_type(commissionMinor, :sType)",
      values: {
        ":claimed": "claimed",
        ":claim": { ...claim, claimedAt: nowIso },
        ":sType": "S",
      },
    });
  }

  /** Admin dismissal: reviewed house revenue. Allowed from `open` and `claimed`. */
  async dismiss(orderId: string): Promise<UnattributedOrderItem | undefined> {
    return this.transition(orderId, ["open", "claimed"], {
      UpdateExpression: "SET #st = :dismissed, claim = :null",
      values: { ":dismissed": "dismissed", ":null": null },
    });
  }

  /** Proxy settlement: the claim landed in the ledger. Only a `claimed` order settles. */
  async settle(orderId: string, nowIso: string): Promise<UnattributedOrderItem | undefined> {
    return this.transition(orderId, ["claimed"], {
      UpdateExpression: "SET #st = :settled, settledAt = :now",
      values: { ":settled": "settled", ":now": nowIso },
    });
  }

  /** State-conditional update; `undefined` when the order is missing or in a different state. */
  private async transition(
    orderId: string,
    fromStates: string[],
    update: { UpdateExpression: string; values: Record<string, unknown>; extraCondition?: string },
  ): Promise<UnattributedOrderItem | undefined> {
    const stateCondition = `attribute_exists(orderId) AND #st IN (${fromStates
      .map((_, i) => `:from${i}`)
      .join(", ")})`;
    try {
      const res = await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { orderId },
          UpdateExpression: update.UpdateExpression,
          ConditionExpression: update.extraCondition
            ? `${stateCondition} AND ${update.extraCondition}`
            : stateCondition,
          ExpressionAttributeNames: { "#st": "state" },
          ExpressionAttributeValues: {
            ...update.values,
            ...Object.fromEntries(fromStates.map((s, i) => [`:from${i}`, s])),
          },
          ReturnValues: "ALL_NEW",
        }),
      );
      return UnattributedOrderItem.parse(res.Attributes);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return undefined;
      throw err;
    }
  }
}
