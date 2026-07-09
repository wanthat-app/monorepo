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

/** Pin the runtime config to `values` (missing keys read as undefined, like an unset mock). */
function config(values: Record<string, unknown>): void {
  deps.config.get.mockImplementation((key: string) => Promise.resolve(values[key]));
}

/** Both channels live, default whatsapp — the post-onboarding steady state. */
const BOTH_ENABLED = {
  "auth.smsEnabled": true,
  "auth.whatsappEnabled": true,
  "whatsapp.phoneNumberId": "phone-number-id-test",
  "auth.defaultOtpChannel": "whatsapp",
  "auth.otpSink": "delivery",
};

function event(
  attrs: Record<string, string | undefined>,
  triggerSource = "CustomSMSSender_Authentication",
): CustomSmsSenderEvent {
  return {
    triggerSource,
    request: { type: "customSMSSenderRequestV1", code: "ZW5jcnlwdGVk", userAttributes: attrs },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.decryptCode.mockResolvedValue("12345678");
  config(BOTH_ENABLED);
  // clearAllMocks() does not reset a mock's implementation (only .mock.calls/.results), so a
  // rejection set by an earlier test (e.g. "propagates an SNS error") would otherwise leak into
  // every later test that hits the sms path — re-pin the happy-path implementation here.
  deps.sms.publish.mockResolvedValue(undefined);
  deps.whatsapp.sendTemplate.mockResolvedValue({ messageId: "wamid.X" });
});

describe("deliverOtp — channel decision point (ADR-0006 decision 5)", () => {
  it("honours the whatsapp preference with the profile language", async () => {
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
    expect(deps.log).toHaveBeenCalledWith("otp_delivered", {
      channel: "whatsapp",
      triggerSource: "CustomSMSSender_Authentication",
      sub: undefined,
    });
  });

  it("honours the sms preference even when the default is whatsapp", async () => {
    await deliverOtp(deps, event({ "custom:otpChannel": "sms", phone_number: "+97254" }));
    expect(deps.sms.publish).toHaveBeenCalledWith(
      "+97254",
      "Your authentication code is 12345678.",
    );
    expect(deps.whatsapp.sendTemplate).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith("otp_delivered", {
      channel: "sms",
      triggerSource: "CustomSMSSender_Authentication",
      sub: undefined,
    });
  });

  it("falls back when the preferred channel is kill-switched off (whatsapp -> sms)", async () => {
    config({ ...BOTH_ENABLED, "auth.whatsappEnabled": false });
    await deliverOtp(deps, event({ "custom:otpChannel": "whatsapp", phone_number: "+97254" }));
    expect(deps.sms.publish).toHaveBeenCalled();
    expect(deps.whatsapp.sendTemplate).not.toHaveBeenCalled();
  });

  it("treats whatsapp-on-but-unonboarded (empty phoneNumberId) as disabled — falls back to sms", async () => {
    config({ ...BOTH_ENABLED, "whatsapp.phoneNumberId": "" });
    await deliverOtp(deps, event({ "custom:otpChannel": "whatsapp", phone_number: "+97254" }));
    expect(deps.sms.publish).toHaveBeenCalled();
    expect(deps.whatsapp.sendTemplate).not.toHaveBeenCalled();
  });

  it("falls back when the preferred channel is kill-switched off (sms -> whatsapp)", async () => {
    config({ ...BOTH_ENABLED, "auth.smsEnabled": false });
    await deliverOtp(deps, event({ "custom:otpChannel": "sms", phone_number: "+97254" }));
    expect(deps.whatsapp.sendTemplate).toHaveBeenCalled();
    expect(deps.sms.publish).not.toHaveBeenCalled();
  });

  it("THROWS when no channel is enabled — the initiating Cognito call must fail", async () => {
    config({ ...BOTH_ENABLED, "auth.smsEnabled": false, "auth.whatsappEnabled": false });
    await expect(
      deliverOtp(deps, event({ "custom:otpChannel": "whatsapp", phone_number: "+97254" })),
    ).rejects.toThrow(/no OTP channel is enabled/);
    expect(deps.whatsapp.sendTemplate).not.toHaveBeenCalled();
    expect(deps.sms.publish).not.toHaveBeenCalled();
    expect(deps.decryptCode).not.toHaveBeenCalled(); // no channel -> the code is never decrypted
    expect(deps.log).not.toHaveBeenCalled();
  });

  it("uses the configured default on a MISSING custom:otpChannel (SignUp may race the write)", async () => {
    await deliverOtp(deps, event({ phone_number: "+97254" }, "CustomSMSSender_SignUp"));
    expect(deps.whatsapp.sendTemplate).toHaveBeenCalled(); // default = whatsapp
    expect(deps.sms.publish).not.toHaveBeenCalled();
  });

  it("uses the configured default on an INVALID custom:otpChannel — no throw", async () => {
    await deliverOtp(deps, event({ "custom:otpChannel": "email", phone_number: "+97254" }));
    expect(deps.whatsapp.sendTemplate).toHaveBeenCalled();
    expect(deps.sms.publish).not.toHaveBeenCalled();
  });

  it("no preference + default channel disabled -> any enabled channel", async () => {
    config({ ...BOTH_ENABLED, "auth.whatsappEnabled": false }); // default whatsapp is dead
    await deliverOtp(deps, event({ phone_number: "+97254" }));
    expect(deps.sms.publish).toHaveBeenCalled();
    expect(deps.whatsapp.sendTemplate).not.toHaveBeenCalled();
  });

  it.each([
    "CustomSMSSender_SignUp",
    "CustomSMSSender_Authentication",
    "CustomSMSSender_ResendCode",
    "CustomSMSSender_VerifyUserAttribute",
  ])("delivers for trigger source %s through the same path", async (triggerSource) => {
    await deliverOtp(
      deps,
      event({ "custom:otpChannel": "sms", phone_number: "+97254" }, triggerSource),
    );
    expect(deps.sms.publish).toHaveBeenCalledWith(
      "+97254",
      "Your authentication code is 12345678.",
    );
    expect(deps.log).toHaveBeenCalledWith("otp_delivered", {
      channel: "sms",
      triggerSource,
      sub: undefined,
    });
  });

  it("defaults the WhatsApp template language to en when the profile has none", async () => {
    await deliverOtp(deps, event({ "custom:otpChannel": "whatsapp", phone_number: "+97254" }));
    expect(deps.whatsapp.sendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ language: "en" }),
    );
  });

  it("throws when the event carries no phone_number", async () => {
    await expect(deliverOtp(deps, event({ "custom:otpChannel": "sms" }))).rejects.toThrow(
      /phone_number/,
    );
    expect(deps.config.get).not.toHaveBeenCalled();
  });

  it("logs NO success line when the send throws (failure logging lives in the handler)", async () => {
    deps.sms.publish.mockRejectedValue(new Error("sns down"));
    await expect(
      deliverOtp(deps, event({ "custom:otpChannel": "sms", phone_number: "+97254" })),
    ).rejects.toThrow("sns down");
    expect(deps.log).not.toHaveBeenCalled();
  });

  it("propagates a WhatsApp submission error — NO in-Lambda SMS fallback (only a DISABLED channel falls back, a FAILED send does not)", async () => {
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
    config({ ...BOTH_ENABLED, "auth.otpSink": "devSink" });
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

  it("parks the RESOLVED channel, not the raw preference (disabled whatsapp sinks as sms)", async () => {
    deps.devSink.allowed = true;
    config({ ...BOTH_ENABLED, "auth.whatsappEnabled": false, "auth.otpSink": "devSink" });
    await deliverOtp(deps, event({ "custom:otpChannel": "whatsapp", phone_number: "+97254" }));
    expect(deps.devSink.put).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "sms", code: "12345678" }),
    );
    expect(deps.whatsapp.sendTemplate).not.toHaveBeenCalled();
    expect(deps.sms.publish).not.toHaveBeenCalled();
  });

  it("sinks the whatsapp channel too — no real send is attempted", async () => {
    deps.devSink.allowed = true;
    config({ ...BOTH_ENABLED, "auth.otpSink": "devSink" });
    await deliverOtp(deps, event({ "custom:otpChannel": "whatsapp", phone_number: "+97254" }));
    expect(deps.devSink.put).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "whatsapp", code: "12345678" }),
    );
    expect(deps.whatsapp.sendTemplate).not.toHaveBeenCalled();
  });

  it("still throws when NOTHING is enabled — the sink parks a would-be delivery, not a dead one", async () => {
    deps.devSink.allowed = true;
    config({
      ...BOTH_ENABLED,
      "auth.smsEnabled": false,
      "auth.whatsappEnabled": false,
      "auth.otpSink": "devSink",
    });
    await expect(
      deliverOtp(deps, event({ "custom:otpChannel": "sms", phone_number: "+97254" })),
    ).rejects.toThrow(/no OTP channel is enabled/);
    expect(deps.devSink.put).not.toHaveBeenCalled();
  });

  it("never reads auth.otpSink when not allowed (the prod guard)", async () => {
    // allowed stays false; even a poisoned config value cannot activate the sink.
    config({ ...BOTH_ENABLED, "auth.otpSink": "devSink" });
    await deliverOtp(deps, event({ "custom:otpChannel": "sms", phone_number: "+97254" }));
    expect(deps.devSink.put).not.toHaveBeenCalled();
    expect(deps.sms.publish).toHaveBeenCalledWith(
      "+97254",
      "Your authentication code is 12345678.",
    );
    expect(deps.config.get).not.toHaveBeenCalledWith("auth.otpSink"); // guard short-circuits the read
  });
});
