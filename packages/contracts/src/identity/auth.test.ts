import { describe, expect, it } from "vitest";
import { CONFIG_DEFAULTS, parseConfigValue } from "../config/keys";
import { AuthConfigResponse, AuthResendBody, AuthStartBody, OtpChannel } from "./auth";

describe("OTP channel contracts (ADR-0023)", () => {
  it("requires an explicit channel on /auth/start — no server-side default", () => {
    expect(AuthStartBody.safeParse({ phone: "+972541234567" }).success).toBe(false);
    expect(
      AuthStartBody.safeParse({ phone: "+972541234567", channel: "whatsapp" }).success,
    ).toBe(true);
    expect(
      AuthStartBody.safeParse({ phone: "+972541234567", channel: "email" }).success,
    ).toBe(false);
  });

  it("accepts an optional template language on /auth/start", () => {
    expect(
      AuthStartBody.safeParse({ phone: "+972541234567", channel: "sms", locale: "he" }).success,
    ).toBe(true);
    expect(
      AuthStartBody.safeParse({ phone: "+972541234567", channel: "sms", locale: "fr" }).success,
    ).toBe(false);
  });

  it("requires an explicit channel on /auth/resend", () => {
    expect(AuthResendBody.safeParse({ challengeId: "c1" }).success).toBe(false);
    expect(AuthResendBody.safeParse({ challengeId: "c1", channel: "sms" }).success).toBe(true);
  });

  it("models the /auth/config projection", () => {
    expect(
      AuthConfigResponse.parse({ channels: ["whatsapp", "sms"], defaultChannel: "whatsapp" }),
    ).toEqual({ channels: ["whatsapp", "sms"], defaultChannel: "whatsapp" });
    expect(AuthConfigResponse.parse({ channels: [], defaultChannel: null }).defaultChannel).toBe(
      null,
    );
  });

  it("ships the WhatsApp config keys kill-switched OFF", () => {
    expect(CONFIG_DEFAULTS["auth.whatsappEnabled"]).toBe(false);
    expect(CONFIG_DEFAULTS["auth.defaultOtpChannel"]).toBe("whatsapp");
    expect(CONFIG_DEFAULTS["whatsapp.phoneNumberId"]).toBe("");
    expect(parseConfigValue("auth.defaultOtpChannel", "sms")).toBe("sms");
    expect(() => parseConfigValue("auth.defaultOtpChannel", "email")).toThrow();
    expect(OtpChannel.parse("whatsapp")).toBe("whatsapp");
  });
});
