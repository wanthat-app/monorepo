import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CustomSmsSenderEvent, deliverOtp, type SendDeps } from "./send";

const deps = {
  config: { get: vi.fn() },
  decryptCode: vi.fn().mockResolvedValue("12345678"),
  whatsapp: { sendTemplate: vi.fn().mockResolvedValue({ messageId: "wamid.X" }) },
  sms: { publish: vi.fn().mockResolvedValue(undefined) },
  // `false as boolean`: under `satisfies` (unlike a `: SendDeps` annotation) object-literal
  // properties keep their narrowed literal type, so an un-widened `false` would forbid the
  // `deps.devSink.allowed = true` flips the sink tests below perform.
  devSink: { allowed: false as boolean, put: vi.fn() },
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
  // clearAllMocks() does not reset a mock's implementation (only .mock.calls/.results), so a
  // rejection set by an earlier test (e.g. "propagates an SNS error") would otherwise leak into
  // every later test that hits the sms fast path — re-pin the happy-path implementation here.
  deps.sms.publish.mockResolvedValue(undefined);
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

describe("dev OTP sink (auth.otpSink = devSink, never in prod)", () => {
  // Structural reset: a failing assertion mid-test must not leak `allowed = true` into later tests.
  afterEach(() => {
    deps.devSink.allowed = false;
  });

  it("parks the code instead of delivering when allowed AND configured", async () => {
    deps.devSink.allowed = true;
    deps.config.get.mockImplementation((key: string) =>
      Promise.resolve(key === "auth.otpSink" ? "devSink" : "phone-number-id-test"),
    );
    await deliverOtp(deps, event({ "custom:otpChannel": "sms", phone_number: "+97254" }));
    expect(deps.devSink.put).toHaveBeenCalledWith({
      phone: "+97254",
      code: "12345678",
      channel: "sms",
      triggerSource: "CustomSMSSender_Authentication",
    });
    expect(deps.sms.publish).not.toHaveBeenCalled();
    expect(deps.whatsapp.sendTemplate).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith("otp_sunk_dev", { channel: "sms", sub: undefined });
  });

  it("sinks the whatsapp channel too, before any phoneNumberId read", async () => {
    deps.devSink.allowed = true;
    deps.config.get.mockImplementation((key: string) =>
      Promise.resolve(key === "auth.otpSink" ? "devSink" : ""),
    );
    await deliverOtp(deps, event({ "custom:otpChannel": "whatsapp", phone_number: "+97254" }));
    expect(deps.devSink.put).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "whatsapp", code: "12345678" }),
    );
    expect(deps.whatsapp.sendTemplate).not.toHaveBeenCalled();
  });

  it("ignores the config entirely when not allowed (the prod guard)", async () => {
    // allowed stays false; even a poisoned config value cannot activate the sink.
    deps.config.get.mockResolvedValue("devSink");
    await deliverOtp(deps, event({ "custom:otpChannel": "sms", phone_number: "+97254" }));
    expect(deps.devSink.put).not.toHaveBeenCalled();
    expect(deps.sms.publish).toHaveBeenCalledWith(
      "+97254",
      "Your authentication code is 12345678.",
    );
    expect(deps.config.get).not.toHaveBeenCalled(); // guard short-circuits before any read
  });
});
