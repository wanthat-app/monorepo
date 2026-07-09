import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { PollerStateRepo } from "./poller-state";

const STATE = {
  stateKey: "aliexpress#orders",
  lastRunAt: "2026-07-10T10:00:00.000Z",
  watermarkEndTime: "2026-07-10T09:00:00.000Z",
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

describe("PollerStateRepo", () => {
  it("gets and parses the state item, undefined when never written", async () => {
    const { doc, calls } = stub(() => ({ Item: STATE }));
    const repo = new PollerStateRepo(doc, "poller_state");
    expect(await repo.get("aliexpress#orders")).toEqual(STATE);
    expect(calls[0]?.input.Key).toEqual({ stateKey: "aliexpress#orders" });

    const empty = stub(() => ({}));
    expect(
      await new PollerStateRepo(empty.doc, "poller_state").get("aliexpress#orders"),
    ).toBeUndefined();
  });

  it("puts a validated full item", async () => {
    const { doc, calls } = stub(() => ({}));
    await new PollerStateRepo(doc, "poller_state").put(STATE);
    expect(calls[0]?.name).toBe("PutCommand");
    expect(calls[0]?.input.Item).toEqual(STATE);
    await expect(
      new PollerStateRepo(doc, "poller_state").put({ ...STATE, lastRunAt: 5 } as never),
    ).rejects.toThrow();
  });
});
