import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { RuntimeConfigRepo } from "./runtime-config";

const ISO = "2026-06-27T00:00:00.000Z";

/** A doc-client stub: `respond` returns the canned result per command; sent commands are recorded. */
function stub(respond: (name: string, cmd: { input: Record<string, unknown> }) => unknown) {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const doc = {
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      calls.push({ name: cmd.constructor.name, input: cmd.input });
      return respond(cmd.constructor.name, cmd);
    },
  } as unknown as DynamoDBDocumentClient;
  return { doc, calls };
}

describe("RuntimeConfigRepo.get", () => {
  it("falls back to the key default when the item is absent", async () => {
    const { doc } = stub(() => ({}));
    const repo = new RuntimeConfigRepo(doc, "config");
    expect(await repo.get("fx.provider")).toBe("ecb");
    expect(await repo.get("fx.updateIntervalMinutes")).toBe(720);
  });

  it("returns the stored value when present", async () => {
    const { doc } = stub(() => ({ Item: { configKey: "fx.provider", value: "boi" } }));
    const repo = new RuntimeConfigRepo(doc, "config");
    expect(await repo.get("fx.provider")).toBe("boi");
  });

  it("rejects a stored value that violates the key schema", async () => {
    const { doc } = stub(() => ({ Item: { value: "nonsense" } }));
    const repo = new RuntimeConfigRepo(doc, "config");
    await expect(repo.get("fx.provider")).rejects.toThrow();
  });
});

describe("RuntimeConfigRepo.put", () => {
  it("validates then writes under the configKey partition key", async () => {
    const { doc, calls } = stub(() => ({}));
    const repo = new RuntimeConfigRepo(doc, "config");
    const item = await repo.put("fx.updateIntervalMinutes", 360, ISO);
    expect(item).toEqual({ key: "fx.updateIntervalMinutes", value: 360, updatedAt: ISO });
    expect(calls[0]?.name).toBe("PutCommand");
    expect(calls[0]?.input.Item).toEqual({
      configKey: "fx.updateIntervalMinutes",
      value: 360,
      updatedAt: ISO,
    });
  });

  it("rejects an out-of-range value before writing", async () => {
    const { doc, calls } = stub(() => ({}));
    const repo = new RuntimeConfigRepo(doc, "config");
    await expect(repo.put("fx.updateIntervalMinutes", 99999, ISO)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("RuntimeConfigRepo.getAll", () => {
  it("maps stored rows and skips unknown keys", async () => {
    const { doc } = stub(() => ({
      Items: [
        { configKey: "fx.provider", value: "boi", updatedAt: ISO },
        { configKey: "legacy.unknown", value: "x", updatedAt: ISO },
      ],
    }));
    const repo = new RuntimeConfigRepo(doc, "config");
    const items = await repo.getAll();
    expect(items).toEqual([{ key: "fx.provider", value: "boi", updatedAt: ISO }]);
  });
});
