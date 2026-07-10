import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { type UnattributedOrderItem, UnattributedOrderRepo } from "./unattributed-order";

const NOW = "2026-07-10T15:00:00.000Z";
const ITEM: UnattributedOrderItem = {
  orderId: "1121635427126421",
  reason: "no_ref",
  orderStatus: "Payment Completed",
  commissionMinor: "37",
  currency: "USD",
  occurredAt: "2026-07-09T05:17:21.000Z",
  firstSeenAt: NOW,
  lastSeenAt: NOW,
  state: "open",
  claim: null,
  settledAt: null,
};

function stub(respond: (name: string, input: Record<string, unknown>) => unknown) {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const doc = {
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      calls.push({ name: cmd.constructor.name, input: cmd.input });
      return respond(cmd.constructor.name, cmd.input);
    },
  } as unknown as DynamoDBDocumentClient;
  return { doc, calls };
}

describe("UnattributedOrderRepo.recordSighting", () => {
  it("upserts volatile fields, sets firstSeenAt/state only once", async () => {
    const { doc, calls } = stub(() => ({}));
    await new UnattributedOrderRepo(doc, "unattributed").recordSighting(
      {
        orderId: ITEM.orderId,
        reason: "no_ref",
        orderStatus: "Payment Completed",
        commissionMinor: "37",
        currency: "USD",
        occurredAt: ITEM.occurredAt,
      },
      NOW,
    );
    expect(calls[0]?.name).toBe("UpdateCommand");
    const expr = String(calls[0]?.input.UpdateExpression);
    expect(expr).toContain("lastSeenAt = :now");
    expect(expr).toContain("firstSeenAt = if_not_exists(firstSeenAt, :now)");
    expect(expr).toContain("#st = if_not_exists(#st, :open)");
    expect(calls[0]?.input.ExpressionAttributeNames).toEqual({ "#st": "state" });
  });
});

describe("UnattributedOrderRepo.listByState", () => {
  it("queries the byState GSI newest-first and passes the cursor through", async () => {
    const { doc, calls } = stub(() => ({
      Items: [ITEM],
      LastEvaluatedKey: { orderId: ITEM.orderId },
    }));
    const page = await new UnattributedOrderRepo(doc, "unattributed").listByState("open", 50, {
      orderId: "prev",
    });
    expect(page.items).toEqual([ITEM]);
    expect(page.lastKey).toEqual({ orderId: ITEM.orderId });
    expect(calls[0]?.input).toMatchObject({
      IndexName: "byState",
      KeyConditionExpression: "#st = :state",
      ExpressionAttributeValues: { ":state": "open" },
      ScanIndexForward: false,
      Limit: 50,
      ExclusiveStartKey: { orderId: "prev" },
    });
  });

  it("parses a pre-claim item to defaults (claim/settledAt absent)", async () => {
    const { claim: _c, settledAt: _s, ...bare } = ITEM;
    const { doc } = stub(() => ({ Items: [bare] }));
    const page = await new UnattributedOrderRepo(doc, "unattributed").listByState("open", 10);
    expect(page.items[0]?.claim).toBeNull();
    expect(page.items[0]?.settledAt).toBeNull();
  });
});

describe("UnattributedOrderRepo transitions", () => {
  const CLAIMED: UnattributedOrderItem = {
    ...ITEM,
    state: "claimed",
    claim: { recommendationId: "abc123DEF45", claimedBy: "dennis@wanthat.app", claimedAt: NOW },
  };

  it("claim: open|claimed only, requires a commission (string-typed), returns the new item", async () => {
    const { doc, calls } = stub(() => ({ Attributes: CLAIMED }));
    const res = await new UnattributedOrderRepo(doc, "unattributed").claim(
      ITEM.orderId,
      { recommendationId: "abc123DEF45", claimedBy: "dennis@wanthat.app" },
      NOW,
    );
    expect(res?.state).toBe("claimed");
    const cond = String(calls[0]?.input.ConditionExpression);
    expect(cond).toContain("#st IN (:from0, :from1)");
    expect(cond).toContain("attribute_type(commissionMinor, :sType)");
    expect(calls[0]?.input.ExpressionAttributeValues).toMatchObject({
      ":from0": "open",
      ":from1": "claimed",
      ":sType": "S",
      ":claim": {
        recommendationId: "abc123DEF45",
        claimedBy: "dennis@wanthat.app",
        claimedAt: NOW,
      },
    });
  });

  it("claim answers undefined on a conditional failure (settled/dismissed/missing/no commission)", async () => {
    const { doc } = stub(() => {
      throw new ConditionalCheckFailedException({ message: "denied", $metadata: {} });
    });
    const repo = new UnattributedOrderRepo(doc, "unattributed");
    await expect(
      repo.claim(ITEM.orderId, { recommendationId: "r", claimedBy: "x" }, NOW),
    ).resolves.toBeUndefined();
  });

  it("settle: claimed only, stamps settledAt", async () => {
    const settled = { ...CLAIMED, state: "settled" as const, settledAt: NOW };
    const { doc, calls } = stub(() => ({ Attributes: settled }));
    const res = await new UnattributedOrderRepo(doc, "unattributed").settle(ITEM.orderId, NOW);
    expect(res?.state).toBe("settled");
    expect(String(calls[0]?.input.ConditionExpression)).toContain("#st IN (:from0)");
    expect(calls[0]?.input.ExpressionAttributeValues).toMatchObject({ ":from0": "claimed" });
  });

  it("dismiss: open|claimed, clears any claim", async () => {
    const dismissed = { ...ITEM, state: "dismissed" as const };
    const { doc, calls } = stub(() => ({ Attributes: dismissed }));
    const res = await new UnattributedOrderRepo(doc, "unattributed").dismiss(ITEM.orderId);
    expect(res?.state).toBe("dismissed");
    expect(String(calls[0]?.input.UpdateExpression)).toContain("claim = :null");
  });

  it("rethrows a non-conditional failure", async () => {
    const { doc } = stub(() => {
      throw new Error("dynamo down");
    });
    await expect(
      new UnattributedOrderRepo(doc, "unattributed").settle(ITEM.orderId, NOW),
    ).rejects.toThrow("dynamo down");
  });
});
