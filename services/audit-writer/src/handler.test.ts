import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The db primitives are integration-tested against real Postgres in @wanthat/db; fakes here.
vi.mock("@wanthat/db", () => ({
  appendAudit: vi.fn(),
  waitForDb: vi.fn(),
}));
vi.mock("./context", () => ({
  getContext: vi.fn(() => ({ region: "il-central-1", db: {} })),
}));

import { appendAudit, waitForDb } from "@wanthat/db";
import { handler } from "./handler";

const appendAuditMock = vi.mocked(appendAudit);
const waitForDbMock = vi.mocked(waitForDb);

const SUB = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("audit-writer handler", () => {
  it("parses the invoke payload, waits for the db, and chains the shaped payload", async () => {
    await handler({ event: "user_deleted", sub: SUB, actor: "admin@wanthat.app" });
    expect(waitForDbMock).toHaveBeenCalledTimes(1);
    expect(appendAuditMock).toHaveBeenCalledTimes(1);
    expect(appendAuditMock).toHaveBeenCalledWith(expect.anything(), {
      type: "user_deleted",
      sub: SUB,
      actor: "admin@wanthat.app",
    });
  });

  it("THROWS on a malformed payload without touching the database", async () => {
    await expect(handler({ event: "user_deleted", sub: SUB })).rejects.toThrow();
    expect(waitForDbMock).not.toHaveBeenCalled();
    expect(appendAuditMock).not.toHaveBeenCalled();
  });

  it("THROWS when the append fails (sync callers must fail; async callers get the retry)", async () => {
    appendAuditMock.mockRejectedValueOnce(new Error("permission denied for function"));
    await expect(
      handler({ event: "config_changed", key: "k", value: 1, previous: 2, actor: "a@b.c" }),
    ).rejects.toThrow(/permission denied/);
  });

  it("THROWS when the cluster never wakes (waitForDb exhausts its attempts)", async () => {
    waitForDbMock.mockRejectedValueOnce(new Error("connect ETIMEDOUT"));
    await expect(
      handler({ event: "user_disabled", sub: SUB, actor: "admin@wanthat.app" }),
    ).rejects.toThrow(/ETIMEDOUT/);
    expect(appendAuditMock).not.toHaveBeenCalled();
  });
});
