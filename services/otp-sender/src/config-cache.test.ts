import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cachedConfigReader } from "./config-cache";

describe("cachedConfigReader — per-container TTL cache over the runtime config", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves repeat reads of a key from the cache within the TTL", async () => {
    const inner = { get: vi.fn().mockResolvedValue(true) };
    const cached = cachedConfigReader(inner, 30_000);
    await expect(cached.get("auth.smsEnabled")).resolves.toBe(true);
    await expect(cached.get("auth.smsEnabled")).resolves.toBe(true);
    expect(inner.get).toHaveBeenCalledTimes(1);
  });

  it("caches per key — distinct keys each hit the table once", async () => {
    const inner = { get: vi.fn().mockResolvedValue("x") };
    const cached = cachedConfigReader(inner, 30_000);
    await cached.get("auth.smsEnabled");
    await cached.get("auth.whatsappEnabled");
    await cached.get("auth.smsEnabled");
    expect(inner.get).toHaveBeenCalledTimes(2);
  });

  it("re-reads after the TTL expires — a kill-switch flip lands within ttlMs", async () => {
    const inner = { get: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false) };
    const cached = cachedConfigReader(inner, 30_000);
    await expect(cached.get("auth.smsEnabled")).resolves.toBe(true);
    vi.advanceTimersByTime(30_001);
    await expect(cached.get("auth.smsEnabled")).resolves.toBe(false);
    expect(inner.get).toHaveBeenCalledTimes(2);
  });

  it("never caches a failed read — the next call retries the table", async () => {
    const inner = {
      get: vi.fn().mockRejectedValueOnce(new Error("dynamo down")).mockResolvedValueOnce(true),
    };
    const cached = cachedConfigReader(inner, 30_000);
    await expect(cached.get("auth.smsEnabled")).rejects.toThrow("dynamo down");
    await expect(cached.get("auth.smsEnabled")).resolves.toBe(true);
    expect(inner.get).toHaveBeenCalledTimes(2);
  });
});
