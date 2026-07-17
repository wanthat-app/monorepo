import { CONFIG_KEYS, isPublicConfigKey } from "@wanthat/contracts";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted fake so the vi.mock factory can close over it (vitest hoists vi.mock above imports).
const { fake } = vi.hoisted(() => ({
  fake: { config: { getMany: vi.fn() } },
}));

vi.mock("../context", () => ({ getContext: () => fake }));

import { publicConfigRouter } from "./router";

const app = new Hono();
app.route("/config", publicConfigRouter());

const get = (query: string) => app.request(`/config${query}`, { method: "GET" });

beforeEach(() => {
  fake.config.getMany.mockReset();
});

describe("GET /config (public projection)", () => {
  it("answers the requested public keys with cache-control no-store", async () => {
    fake.config.getMany.mockResolvedValue({
      "auth.whatsappEnabled": false,
      "auth.smsEnabled": true,
      "auth.defaultOtpChannel": "whatsapp",
    });
    const res = await get("?keys=auth.whatsappEnabled,auth.smsEnabled,auth.defaultOtpChannel");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      values: {
        "auth.whatsappEnabled": false,
        "auth.smsEnabled": true,
        "auth.defaultOtpChannel": "whatsapp",
      },
    });
    expect(fake.config.getMany).toHaveBeenCalledWith([
      "auth.whatsappEnabled",
      "auth.smsEnabled",
      "auth.defaultOtpChannel",
    ]);
  });

  it("400s a NON-PUBLIC key (the private set is unreachable here)", async () => {
    for (const key of ["retailer.aliexpressTrackingId", "whatsapp.phoneNumberId"]) {
      const res = await get(`?keys=${key}`);
      expect(res.status).toBe(400);
    }
    expect(fake.config.getMany).not.toHaveBeenCalled();
  });

  it("400s the WHOLE request when one key of a mixed list is private — no partial answer", async () => {
    const res = await get("?keys=auth.smsEnabled,whatsapp.phoneNumberId");
    expect(res.status).toBe(400);
    expect(fake.config.getMany).not.toHaveBeenCalled();
  });

  it("400s an unknown key", async () => {
    const res = await get("?keys=not.a.key");
    expect(res.status).toBe(400);
    expect(fake.config.getMany).not.toHaveBeenCalled();
  });

  it("400s a missing or empty keys parameter", async () => {
    expect((await get("")).status).toBe(400);
    expect((await get("?keys=")).status).toBe(400);
    expect(fake.config.getMany).not.toHaveBeenCalled();
  });

  it("400s more than 20 keys", async () => {
    const keys = Array.from({ length: 21 }, () => "auth.smsEnabled").join(",");
    const res = await get(`?keys=${keys}`);
    expect(res.status).toBe(400);
    expect(fake.config.getMany).not.toHaveBeenCalled();
  });

  it("guards the whole key space: every non-allow-listed ConfigKey 400s", async () => {
    for (const key of CONFIG_KEYS.filter((k) => !isPublicConfigKey(k))) {
      expect((await get(`?keys=${key}`)).status).toBe(400);
    }
    expect(fake.config.getMany).not.toHaveBeenCalled();
  });
});
