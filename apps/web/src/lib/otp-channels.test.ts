import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveOtpChannelOptions, fetchOtpChannelOptions, SMS_ONLY } from "./otp-channels";

vi.mock("./config", () => ({
  getConfig: () => ({ apiUrl: "https://api.test" }),
}));

afterEach(() => vi.unstubAllGlobals());

describe("deriveOtpChannelOptions", () => {
  it("offers both channels with the configured default when both switches are on", () => {
    expect(
      deriveOtpChannelOptions({
        "auth.whatsappEnabled": true,
        "auth.smsEnabled": true,
        "auth.defaultOtpChannel": "whatsapp",
      }),
    ).toEqual({ channels: ["whatsapp", "sms"], defaultChannel: "whatsapp" });
  });

  it("hides WhatsApp when its kill switch is off (the reported bug)", () => {
    expect(
      deriveOtpChannelOptions({
        "auth.whatsappEnabled": false,
        "auth.smsEnabled": true,
        "auth.defaultOtpChannel": "whatsapp",
      }),
    ).toEqual({ channels: ["sms"], defaultChannel: "sms" });
  });

  it("offers WhatsApp only when SMS is switched off", () => {
    expect(
      deriveOtpChannelOptions({
        "auth.whatsappEnabled": true,
        "auth.smsEnabled": false,
        "auth.defaultOtpChannel": "sms",
      }),
    ).toEqual({ channels: ["whatsapp"], defaultChannel: "whatsapp" });
  });

  it("ignores a configured default that is not itself enabled", () => {
    expect(
      deriveOtpChannelOptions({
        "auth.whatsappEnabled": false,
        "auth.smsEnabled": true,
        "auth.defaultOtpChannel": "whatsapp",
      }).defaultChannel,
    ).toBe("sms");
  });

  it("falls back to SMS-only when every switch is off (the sender enforces anyway)", () => {
    expect(
      deriveOtpChannelOptions({
        "auth.whatsappEnabled": false,
        "auth.smsEnabled": false,
        "auth.defaultOtpChannel": "whatsapp",
      }),
    ).toEqual(SMS_ONLY);
  });

  it("treats missing or malformed values as off (never trusts loose wire data)", () => {
    expect(deriveOtpChannelOptions({})).toEqual(SMS_ONLY);
    expect(
      deriveOtpChannelOptions({
        "auth.whatsappEnabled": "yes",
        "auth.smsEnabled": 1,
        "auth.defaultOtpChannel": 42,
      }),
    ).toEqual(SMS_ONLY);
  });
});

describe("fetchOtpChannelOptions", () => {
  it("requests exactly the three public auth keys and derives from the answer", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        values: {
          "auth.whatsappEnabled": true,
          "auth.smsEnabled": true,
          "auth.defaultOtpChannel": "sms",
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await fetchOtpChannelOptions()).toEqual({
      channels: ["whatsapp", "sms"],
      defaultChannel: "sms",
    });
    const url = (fetchMock.mock.calls[0] as [string])[0];
    expect(url).toBe(
      `https://api.test/config?keys=${encodeURIComponent(
        "auth.whatsappEnabled,auth.smsEnabled,auth.defaultOtpChannel",
      )}`,
    );
  });

  it("degrades to SMS-only when the endpoint fails (network error)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network down")));
    expect(await fetchOtpChannelOptions()).toEqual(SMS_ONLY);
  });

  it("degrades to SMS-only on a non-2xx answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({}) }),
    );
    expect(await fetchOtpChannelOptions()).toEqual(SMS_ONLY);
  });
});
