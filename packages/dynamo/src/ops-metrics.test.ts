import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jerusalemDate, lastNDates, OpsMetricsRepo } from "./ops-metrics";

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

// touch() logs stamp failures via console.error; keep test output clean and assertable.
let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  error.mockRestore();
});

describe("jerusalemDate", () => {
  it("formats an instant as the Asia/Jerusalem calendar date", () => {
    // 22:30 UTC = 01:30 next day in Jerusalem (summer, UTC+3).
    expect(jerusalemDate(new Date("2026-07-11T22:30:00Z"))).toBe("2026-07-12");
    expect(jerusalemDate(new Date("2026-07-11T12:00:00Z"))).toBe("2026-07-11");
  });
});

describe("lastNDates", () => {
  it("returns a dense ascending list ending today (Jerusalem)", () => {
    const dates = lastNDates(3, new Date("2026-07-11T22:30:00Z")); // local 2026-07-12
    expect(dates).toEqual(["2026-07-10", "2026-07-11", "2026-07-12"]);
  });

  it("spans month boundaries", () => {
    expect(lastNDates(2, new Date("2026-07-01T12:00:00Z"))).toEqual(["2026-06-30", "2026-07-01"]);
  });
});

describe("OpsMetricsRepo.incrementDaily", () => {
  it("ADDs 1 to the daily counter item", async () => {
    const { doc, calls } = stub(() => ({}));
    await new OpsMetricsRepo(doc, "ops-counters").incrementDaily("recsDaily", "2026-07-12");
    expect(calls[0]?.name).toBe("UpdateCommand");
    expect(calls[0]?.input.Key).toEqual({ counterKey: "recsDaily#2026-07-12" });
    expect(calls[0]?.input.UpdateExpression).toBe("ADD #count :one");
  });
});

describe("OpsMetricsRepo.markActive", () => {
  it("stamps the presence item and bumps activeDaily on first touch", async () => {
    const { doc, calls } = stub(() => ({}));
    const repo = new OpsMetricsRepo(doc, "ops-counters");
    expect(await repo.markActive("sub-1", "2026-07-12")).toBe(true);
    expect(calls[0]?.input.Key).toEqual({ counterKey: "presence#sub-1" });
    expect(calls[1]?.input.Key).toEqual({ counterKey: "activeDaily#2026-07-12" });
  });

  it("memoizes: the second same-day touch makes NO DynamoDB call", async () => {
    const { doc, calls } = stub(() => ({}));
    const repo = new OpsMetricsRepo(doc, "ops-counters");
    await repo.markActive("sub-1", "2026-07-12");
    expect(await repo.markActive("sub-1", "2026-07-12")).toBe(false);
    expect(calls.length).toBe(2); // presence + activeDaily from the FIRST call only
  });

  it("a new day stamps again", async () => {
    const { doc, calls } = stub(() => ({}));
    const repo = new OpsMetricsRepo(doc, "ops-counters");
    await repo.markActive("sub-1", "2026-07-12");
    expect(await repo.markActive("sub-1", "2026-07-13")).toBe(true);
    expect(calls.length).toBe(4);
  });

  it("condition failure (already stamped by another container) skips the counter", async () => {
    const { doc, calls } = stub((name) => {
      if (name === "UpdateCommand") throw denied();
      return {};
    });
    const repo = new OpsMetricsRepo(doc, "ops-counters");
    expect(await repo.markActive("sub-1", "2026-07-12")).toBe(false);
    expect(calls.length).toBe(1); // presence attempt only, no activeDaily bump
    // ...and the memo remembers, so a retry is free:
    expect(await repo.markActive("sub-1", "2026-07-12")).toBe(false);
    expect(calls.length).toBe(1);
  });
});

describe("OpsMetricsRepo.touch", () => {
  it("swallows and logs failures (fire-and-forget)", async () => {
    const { doc } = stub(() => {
      throw new Error("dynamo down");
    });
    new OpsMetricsRepo(doc, "ops-counters").touch("sub-1", "2026-07-12");
    await new Promise((r) => setTimeout(r, 0)); // let the floating promise settle
    expect(error).toHaveBeenCalled();
  });
});

describe("OpsMetricsRepo.getDailyCounts", () => {
  it("zero-fills missing days and maps found items by date", async () => {
    const { doc } = stub(() => ({
      Responses: {
        "ops-counters": [{ counterKey: "signupsDaily#2026-07-11", count: 4 }],
      },
    }));
    const counts = await new OpsMetricsRepo(doc, "ops-counters").getDailyCounts("signupsDaily", [
      "2026-07-10",
      "2026-07-11",
    ]);
    expect(counts.get("2026-07-10")).toBe(0);
    expect(counts.get("2026-07-11")).toBe(4);
  });

  it("follows UnprocessedKeys", async () => {
    let call = 0;
    const { doc } = stub(() => {
      call += 1;
      if (call === 1)
        return {
          Responses: { "ops-counters": [{ counterKey: "signupsDaily#2026-07-10", count: 1 }] },
          UnprocessedKeys: {
            "ops-counters": { Keys: [{ counterKey: "signupsDaily#2026-07-11" }] },
          },
        };
      return {
        Responses: { "ops-counters": [{ counterKey: "signupsDaily#2026-07-11", count: 2 }] },
      };
    });
    const counts = await new OpsMetricsRepo(doc, "ops-counters").getDailyCounts("signupsDaily", [
      "2026-07-10",
      "2026-07-11",
    ]);
    expect(counts.get("2026-07-11")).toBe(2);
  });
});

describe("OpsMetricsRepo.countActiveSince", () => {
  it("COUNT-scans presence items past the cutoff, following pagination", async () => {
    let call = 0;
    const { doc, calls } = stub(() => {
      call += 1;
      if (call === 1) return { Count: 2, LastEvaluatedKey: { counterKey: "presence#x" } };
      return { Count: 1 };
    });
    const n = await new OpsMetricsRepo(doc, "ops-counters").countActiveSince("2026-06-13");
    expect(n).toBe(3);
    expect(calls[0]?.input.Select).toBe("COUNT");
    expect(calls[0]?.input.FilterExpression).toContain("begins_with");
  });
});
