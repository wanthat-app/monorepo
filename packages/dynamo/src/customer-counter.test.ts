import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CUSTOMER_COUNTER_KEY, CustomerCounterRepo } from "./customer-counter";

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

const denied = () => new ConditionalCheckFailedException({ message: "denied", $metadata: {} });

// The floor-skip path warns loudly (the drift signal); keep test output clean and assertable.
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe("CustomerCounterRepo.get", () => {
  it("reads the sentinel counter item", async () => {
    const { doc, calls } = stub(() => ({
      Item: { configKey: CUSTOMER_COUNTER_KEY, total: 41, disabled: 3 },
    }));
    expect(await new CustomerCounterRepo(doc, "config").get()).toEqual({ total: 41, disabled: 3 });
    expect(calls[0]?.name).toBe("GetCommand");
    expect(calls[0]?.input.Key).toEqual({ configKey: CUSTOMER_COUNTER_KEY });
  });

  it("reads a missing item as zeros (both pools start empty - no seed write)", async () => {
    const { doc } = stub(() => ({}));
    expect(await new CustomerCounterRepo(doc, "config").get()).toEqual({ total: 0, disabled: 0 });
  });

  it("reads a missing disabled attribute as 0 (only increments have happened)", async () => {
    const { doc } = stub(() => ({ Item: { configKey: CUSTOMER_COUNTER_KEY, total: 7 } }));
    expect(await new CustomerCounterRepo(doc, "config").get()).toEqual({ total: 7, disabled: 0 });
  });
});

describe("CustomerCounterRepo.incrementTotal", () => {
  it("adds 1 to total on the sentinel key, unconditionally", async () => {
    const { doc, calls } = stub(() => ({}));
    await new CustomerCounterRepo(doc, "config").incrementTotal();
    expect(calls[0]?.name).toBe("UpdateCommand");
    expect(calls[0]?.input).toMatchObject({
      Key: { configKey: CUSTOMER_COUNTER_KEY },
      UpdateExpression: "ADD #total :one",
      ExpressionAttributeNames: { "#total": "total" },
      ExpressionAttributeValues: { ":one": 1 },
    });
    expect(calls[0]?.input.ConditionExpression).toBeUndefined();
  });
});

describe("CustomerCounterRepo.decrementTotal", () => {
  it("decrements only total for an enabled user, floor-guarded at 0", async () => {
    const { doc, calls } = stub(() => ({}));
    expect(await new CustomerCounterRepo(doc, "config").decrementTotal(false)).toBe(true);
    expect(calls[0]?.input).toMatchObject({
      Key: { configKey: CUSTOMER_COUNTER_KEY },
      UpdateExpression: "ADD #total :minusOne",
      ConditionExpression: "#total >= :one",
      ExpressionAttributeNames: { "#total": "total" },
      ExpressionAttributeValues: { ":minusOne": -1, ":one": 1 },
    });
  });

  it("decrements total AND disabled for a suspended user, both floor-guarded", async () => {
    const { doc, calls } = stub(() => ({}));
    expect(await new CustomerCounterRepo(doc, "config").decrementTotal(true)).toBe(true);
    expect(calls[0]?.input).toMatchObject({
      UpdateExpression: "ADD #total :minusOne, #disabled :minusOne",
      ConditionExpression: "#total >= :one AND #disabled >= :one",
      ExpressionAttributeNames: { "#total": "total", "#disabled": "disabled" },
    });
  });

  it("skips (returns false, warns, never throws) when the floor guard fails", async () => {
    const { doc } = stub(() => {
      throw denied();
    });
    expect(await new CustomerCounterRepo(doc, "config").decrementTotal(true)).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      JSON.stringify({
        warn: "customer_counter_floor_skip",
        op: "decrementTotal",
        table: "config",
      }),
    );
  });

  it("rethrows a failure that is NOT the conditional guard", async () => {
    const { doc } = stub(() => {
      throw new Error("dynamo down");
    });
    await expect(new CustomerCounterRepo(doc, "config").decrementTotal(false)).rejects.toThrow(
      "dynamo down",
    );
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("CustomerCounterRepo.markDisabled", () => {
  it("adds 1 to disabled, guarded so disabled never exceeds total (missing disabled = 0)", async () => {
    const { doc, calls } = stub(() => ({}));
    expect(await new CustomerCounterRepo(doc, "config").markDisabled()).toBe(true);
    expect(calls[0]?.input).toMatchObject({
      Key: { configKey: CUSTOMER_COUNTER_KEY },
      UpdateExpression: "ADD #disabled :one",
      ConditionExpression:
        "#total >= :one AND (attribute_not_exists(#disabled) OR #disabled < #total)",
      ExpressionAttributeNames: { "#total": "total", "#disabled": "disabled" },
      ExpressionAttributeValues: { ":one": 1 },
    });
  });

  it("skips when the ceiling guard fails (counter already inconsistent)", async () => {
    const { doc } = stub(() => {
      throw denied();
    });
    expect(await new CustomerCounterRepo(doc, "config").markDisabled()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      JSON.stringify({ warn: "customer_counter_floor_skip", op: "markDisabled", table: "config" }),
    );
  });
});

describe("CustomerCounterRepo.markEnabled", () => {
  it("subtracts 1 from disabled, floor-guarded at 0", async () => {
    const { doc, calls } = stub(() => ({}));
    expect(await new CustomerCounterRepo(doc, "config").markEnabled()).toBe(true);
    expect(calls[0]?.input).toMatchObject({
      Key: { configKey: CUSTOMER_COUNTER_KEY },
      UpdateExpression: "ADD #disabled :minusOne",
      ConditionExpression: "#disabled >= :one",
      ExpressionAttributeNames: { "#disabled": "disabled" },
      ExpressionAttributeValues: { ":minusOne": -1, ":one": 1 },
    });
  });

  it("skips when disabled is already 0 (floor guard)", async () => {
    const { doc } = stub(() => {
      throw denied();
    });
    expect(await new CustomerCounterRepo(doc, "config").markEnabled()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      JSON.stringify({ warn: "customer_counter_floor_skip", op: "markEnabled", table: "config" }),
    );
  });
});
