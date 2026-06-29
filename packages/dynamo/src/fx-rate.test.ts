import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { FxRateRepo } from "./fx-rate";

const ISO = "2026-06-27T00:00:00.000Z";

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

describe("FxRateRepo.get", () => {
  it("parses the stored item and drops the pair key", async () => {
    const { doc, calls } = stub(() => ({
      Item: { pair: "USD#ILS", base: "USD", quote: "ILS", rate: "3.7215", asOf: ISO },
    }));
    const repo = new FxRateRepo(doc, "fx_rate");
    expect(await repo.get("USD", "ILS")).toEqual({
      base: "USD",
      quote: "ILS",
      rate: "3.7215",
      asOf: ISO,
    });
    expect(calls[0]?.input.Key).toEqual({ pair: "USD#ILS" });
  });

  it("returns undefined when uncached", async () => {
    const { doc } = stub(() => ({}));
    const repo = new FxRateRepo(doc, "fx_rate");
    expect(await repo.get("USD", "ILS")).toBeUndefined();
  });
});

describe("FxRateRepo.put", () => {
  it("derives the pair partition key and writes the validated rate", async () => {
    const { doc, calls } = stub(() => ({}));
    const repo = new FxRateRepo(doc, "fx_rate");
    await repo.put({ base: "USD", quote: "ILS", rate: "3.7000", asOf: ISO });
    expect(calls[0]?.name).toBe("PutCommand");
    expect(calls[0]?.input.Item).toEqual({
      pair: "USD#ILS",
      base: "USD",
      quote: "ILS",
      rate: "3.7000",
      asOf: ISO,
    });
  });

  it("rejects a non-decimal rate", async () => {
    const { doc, calls } = stub(() => ({}));
    const repo = new FxRateRepo(doc, "fx_rate");
    await expect(
      repo.put({ base: "USD", quote: "ILS", rate: "3,70", asOf: ISO }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("FxRateRepo.getAll", () => {
  it("skips rows that fail validation", async () => {
    const { doc } = stub(() => ({
      Items: [
        { pair: "USD#ILS", base: "USD", quote: "ILS", rate: "3.7215", asOf: ISO },
        { pair: "BAD", base: "US", quote: "ILS", rate: "x", asOf: "nope" },
      ],
    }));
    const repo = new FxRateRepo(doc, "fx_rate");
    const rates = await repo.getAll();
    expect(rates).toEqual([{ base: "USD", quote: "ILS", rate: "3.7215", asOf: ISO }]);
  });
});
