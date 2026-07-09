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

describe("RuntimeConfigRepo.getMany", () => {
  it("batch-reads stored values and falls back to defaults for missing keys", async () => {
    const { doc, calls } = stub((_name, cmd) => {
      const request = (cmd.input.RequestItems as Record<string, { Keys: unknown[] }>).config;
      expect(request?.Keys).toEqual([
        { configKey: "fx.provider" },
        { configKey: "auth.smsEnabled" },
      ]);
      return { Responses: { config: [{ configKey: "fx.provider", value: "boi" }] } };
    });
    const repo = new RuntimeConfigRepo(doc, "config");
    expect(await repo.getMany(["fx.provider", "auth.smsEnabled"])).toEqual({
      "fx.provider": "boi",
      "auth.smsEnabled": true, // never stored — the CONFIG_DEFAULTS entry
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("BatchGetCommand");
  });

  it("deduplicates repeated keys (DynamoDB rejects duplicates in a batch)", async () => {
    const { doc, calls } = stub(() => ({ Responses: { config: [] } }));
    const repo = new RuntimeConfigRepo(doc, "config");
    await repo.getMany(["fx.provider", "fx.provider"]);
    const request = (calls[0]?.input.RequestItems as Record<string, { Keys: unknown[] }>).config;
    expect(request?.Keys).toEqual([{ configKey: "fx.provider" }]);
  });

  it("answers an empty key list without a network call", async () => {
    const { doc, calls } = stub(() => ({}));
    expect(await new RuntimeConfigRepo(doc, "config").getMany([])).toEqual({});
    expect(calls).toHaveLength(0);
  });

  it("throws above the 20-key BatchGetItem cap before any network call", async () => {
    const { doc, calls } = stub(() => ({}));
    const repo = new RuntimeConfigRepo(doc, "config");
    // The cap guards the DEDUPED list and fewer than 21 real keys exist, so exercise it with a
    // cast of 21 distinct raw strings — the guard fires before any per-key validation.
    const keys = [...Array(21).keys()].map((i) => `k${i}`) as unknown as Parameters<
      typeof repo.getMany
    >[0];
    await expect(repo.getMany(keys)).rejects.toThrow(/at most 20 keys/);
    expect(calls).toHaveLength(0);
  });

  it("rejects a stored value that violates its key schema", async () => {
    const { doc } = stub(() => ({
      Responses: { config: [{ configKey: "fx.provider", value: "nonsense" }] },
    }));
    await expect(new RuntimeConfigRepo(doc, "config").getMany(["fx.provider"])).rejects.toThrow();
  });

  it("drains UnprocessedKeys with a bounded retry", async () => {
    let call = 0;
    const { doc, calls } = stub(() => {
      call += 1;
      if (call === 1) {
        return {
          Responses: { config: [{ configKey: "fx.provider", value: "boi" }] },
          UnprocessedKeys: { config: { Keys: [{ configKey: "auth.smsEnabled" }] } },
        };
      }
      return { Responses: { config: [{ configKey: "auth.smsEnabled", value: false }] } };
    });
    const repo = new RuntimeConfigRepo(doc, "config");
    expect(await repo.getMany(["fx.provider", "auth.smsEnabled"])).toEqual({
      "fx.provider": "boi",
      "auth.smsEnabled": false,
    });
    expect(calls).toHaveLength(2);
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
