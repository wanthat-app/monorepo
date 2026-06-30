import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { PhoneVelocityRepo } from "./phone-velocity";

function stub(respond: (name: string) => unknown) {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const doc = {
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      calls.push({ name: cmd.constructor.name, input: cmd.input });
      return respond(cmd.constructor.name);
    },
  } as unknown as DynamoDBDocumentClient;
  return { doc, calls };
}

describe("PhoneVelocityRepo.hit", () => {
  it("atomically increments and returns the new count and ttl", async () => {
    const { doc, calls } = stub(() => ({ Attributes: { count: 3, ttl: 4600 } }));
    const repo = new PhoneVelocityRepo(doc, "phone_velocity");
    expect(await repo.hit("abc", 3600, 1000)).toEqual({ count: 3, ttl: 4600 });
    expect(calls[0]?.name).toBe("UpdateCommand");
    expect(calls[0]?.input.Key).toEqual({ phoneHash: "abc" });
    expect(calls[0]?.input.ExpressionAttributeValues).toMatchObject({ ":one": 1, ":ttl": 4600 });
  });

  it("falls back to the window-derived ttl when Dynamo returns none", async () => {
    const { doc } = stub(() => ({ Attributes: { count: 1 } }));
    const repo = new PhoneVelocityRepo(doc, "phone_velocity");
    expect(await repo.hit("abc", 3600, 1000)).toEqual({ count: 1, ttl: 4600 });
  });
});
