import { beforeEach, describe, expect, it, vi } from "vitest";
import { type CustomSmsSenderEvent, deliverOtp, type SendDeps } from "./send";

const deps = {
  config: { get: vi.fn() },
  decryptCode: vi.fn().mockResolvedValue("12345678"),
  whatsapp: { sendTemplate: vi.fn().mockResolvedValue({ messageId: "wamid.X" }) },
  sms: { publish: vi.fn().mockResolvedValue(undefined) },
  log: vi.fn(),
} satisfies SendDeps;

function event(attrs: Record<string, string | undefined>): CustomSmsSenderEvent {
  return {
    triggerSource: "CustomSMSSender_Authentication",
    request: { type: "customSMSSenderRequestV1", code: "ZW5jcnlwdGVk", userAttributes: attrs },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.decryptCode.mockResolvedValue("12345678");
  deps.config.get.mockResolvedValue("phone-number-id-test");
});

describe("deliverOtp — pure executor (spec rev 2: requested channel or throw)", () => {
  it("delivers via WhatsApp with the profile language", async () => {
    await deliverOtp(
      deps,
      event({ "custom:otpChannel": "whatsapp", phone_number: "+97254", locale: "he" }),
    );
    expect(deps.whatsapp.sendTemplate).toHaveBeenCalledWith({
      phoneNumberId: "phone-number-id-test",
      type: "otp_code",
      language: "he",
      variables: { code: "12345678" },
      to: "+97254",
    });
    expect(deps.sms.publish).not.toHaveBeenCalled();
    // The success line is the chain link app-auth's `sub` correlates on (log-chain PR).
    expect(deps.log).toHaveBeenCalledWith("otp_delivered", {
      channel: "whatsapp",
      triggerSource: "CustomSMSSender_Authentication",
      sub: undefined,
    });
  });

  it("defaults the template language to en when the profile has none", async () => {
    await deliverOtp(deps, event({ "custom:otpChannel": "whatsapp", phone_number: "+97254" }));
    expect(deps.whatsapp.sendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ language: "en" }),
    );
  });

  it("delivers via SNS SMS with Cognito's native wording", async () => {
    await deliverOtp(deps, event({ "custom:otpChannel": "sms", phone_number: "+97254" }));
    expect(deps.sms.publish).toHaveBeenCalledWith(
      "+97254",
      "Your authentication code is 12345678.",
    );
    expect(deps.whatsapp.sendTemplate).not.toHaveBeenCalled();
    expect(deps.config.get).not.toHaveBeenCalled(); // sms needs no config at all
    expect(deps.log).toHaveBeenCalledWith("otp_delivered", {
      channel: "sms",
      triggerSource: "CustomSMSSender_Authentication",
      sub: undefined,
    });
  });

  it("logs NO success line when the send throws (failure logging lives in the handler)", async () => {
    deps.sms.publish.mockRejectedValue(new Error("sns down"));
    await expect(
      deliverOtp(deps, event({ "custom:otpChannel": "sms", phone_number: "+97254" })),
    ).rejects.toThrow("sns down");
    expect(deps.log).not.toHaveBeenCalled();
  });

  it("THROWS on a missing/invalid channel attribute — never assumes a default", async () => {
    await expect(deliverOtp(deps, event({ phone_number: "+97254" }))).rejects.toThrow(/otpChannel/);
    await expect(
      deliverOtp(deps, event({ "custom:otpChannel": "email", phone_number: "+97254" })),
    ).rejects.toThrow(/otpChannel/);
    expect(deps.whatsapp.sendTemplate).not.toHaveBeenCalled();
    expect(deps.sms.publish).not.toHaveBeenCalled();
  });

  it("THROWS when whatsapp.phoneNumberId is unset — never degrades to sms", async () => {
    deps.config.get.mockResolvedValue("");
    await expect(
      deliverOtp(deps, event({ "custom:otpChannel": "whatsapp", phone_number: "+97254" })),
    ).rejects.toThrow(/phoneNumberId/);
    expect(deps.sms.publish).not.toHaveBeenCalled();
  });

  it("propagates a WhatsApp submission error — NO in-Lambda SMS fallback", async () => {
    deps.whatsapp.sendTemplate.mockRejectedValue(new Error("template not approved"));
    await expect(
      deliverOtp(deps, event({ "custom:otpChannel": "whatsapp", phone_number: "+97254" })),
    ).rejects.toThrow("template not approved");
    expect(deps.sms.publish).not.toHaveBeenCalled();
  });

  it("propagates an SNS error — sms failures fail too", async () => {
    deps.sms.publish.mockRejectedValue(new Error("sns down"));
    await expect(
      deliverOtp(deps, event({ "custom:otpChannel": "sms", phone_number: "+97254" })),
    ).rejects.toThrow("sns down");
  });
});
