import { MessageLanguage, OtpChannel } from "@wanthat/contracts";
import type { RuntimeConfigReader } from "@wanthat/dynamo";
import { otpChannelAvailability } from "./killswitch";

/** The slice of Cognito's custom-SMS-sender event we consume. */
export interface CustomSmsSenderEvent {
  triggerSource: string;
  request: {
    type: string;
    /** The OTP code, encrypted by Cognito with the pool's customSenderKmsKey (AWS Encryption SDK ciphertext, base64). */
    code: string;
    userAttributes: Record<string, string | undefined>;
  };
}

export interface SendDeps {
  config: RuntimeConfigReader;
  decryptCode: (encryptedB64: string) => Promise<string>;
  whatsapp: {
    sendTemplate(args: {
      phoneNumberId: string;
      type: "otp_code";
      language: MessageLanguage;
      variables: { code: string };
      to: string;
    }): Promise<unknown>;
  };
  sms: { publish(toE164: string, message: string): Promise<void> };
  /**
   * Dev-only sink: when `allowed` (deploy-time: WANTHAT_ENV !== "prod") AND `auth.otpSink` is
   * "devSink", the code is parked for CLI pickup instead of delivered. `allowed` gates the
   * otpSink config read itself, so prod makes zero sink-related reads.
   */
  devSink: {
    allowed: boolean;
    put(item: {
      phone: string;
      code: string;
      channel: OtpChannel;
      triggerSource: string;
    }): Promise<void>;
  };
  /** Structured log sink. The success line carries `sub` — the correlation field for Logs Insights chains. */
  log: (msg: string, ctx?: Record<string, unknown>) => void;
}

/**
 * Channel decision point (ADR-0006 decision 5): Cognito forwards no ClientMetadata to
 * custom-sender triggers, so the sender itself enforces the kill switches and the user's sticky
 * `custom:otpChannel` preference. Resolution: the preference wins when that channel is currently
 * enabled; otherwise fall back to an enabled channel (preferring `auth.defaultOtpChannel`); if
 * nothing is enabled, throw — the initiating Cognito call (SignUp / InitiateAuth) fails loudly.
 *
 * A missing or invalid `custom:otpChannel` is NOT an error — users self-registering via the
 * public SignUp may race the attribute write — it simply means "no preference", i.e. the default.
 *
 * All four trigger sources (CustomSMSSender_SignUp / _Authentication / _ResendCode /
 * _VerifyUserAttribute) share this path: the message content is trigger-independent today
 * (WhatsApp `otp_code` template in the profile language, fixed SNS wording).
 */
export async function deliverOtp(deps: SendDeps, event: CustomSmsSenderEvent): Promise<void> {
  const attrs = event.request.userAttributes;

  const to = attrs.phone_number;
  if (!to) throw new Error("message-sender: event carries no phone_number");

  const avail = await otpChannelAvailability(deps.config);
  const preference = OtpChannel.safeParse(attrs["custom:otpChannel"]);
  const channel =
    preference.success && avail.channels.includes(preference.data)
      ? preference.data
      : avail.defaultChannel;
  if (channel === null)
    throw new Error(
      "message-sender: no OTP channel is enabled (auth.smsEnabled off; auth.whatsappEnabled off or whatsapp.phoneNumberId unset)",
    );

  const code = await deps.decryptCode(event.request.code);

  // Dev-only sink (docs/dev-otp-sink.md): park the code instead of delivering. Checked before the
  // channel dispatch so BOTH channels sink; the code itself is never logged. The parked `channel`
  // is the RESOLVED one — what would have delivered — so at least one channel must be enabled
  // even in sink mode (the resolution throw above applies uniformly).
  if (deps.devSink.allowed && (await deps.config.get("auth.otpSink")) === "devSink") {
    await deps.devSink.put({
      phone: to,
      code,
      channel,
      triggerSource: event.triggerSource,
    });
    deps.log("otp_sunk_dev", { channel, sub: attrs.sub });
    return;
  }

  if (channel === "whatsapp") {
    // Availability guarantees a non-empty phoneNumberId whenever whatsapp is enabled; this guard
    // is a belt against a future refactor breaking that invariant — never expected to fire.
    const phoneNumberId = avail.whatsappPhoneNumberId;
    if (!phoneNumberId)
      throw new Error("message-sender: whatsapp.phoneNumberId is unset (onboarding incomplete)");
    const locale = MessageLanguage.safeParse(attrs.locale);
    await deps.whatsapp.sendTemplate({
      phoneNumberId,
      type: "otp_code",
      language: locale.success ? locale.data : "en",
      variables: { code },
      to,
    });
    deps.log("otp_delivered", {
      channel: "whatsapp",
      triggerSource: event.triggerSource,
      sub: attrs.sub,
    });
    return;
  }

  // sms — replicate Cognito's native wording: once the trigger is attached, Cognito sends nothing
  // itself and this function owns ALL OTP delivery (including plain SMS).
  await deps.sms.publish(to, `Your authentication code is ${code}.`);
  // "Delivered" = submitted downstream. SNS can still drop silently (e.g. the sandbox monthly
  // spend cap accepts the publish and never delivers) — this line proves OUR side completed.
  deps.log("otp_delivered", { channel: "sms", triggerSource: event.triggerSource, sub: attrs.sub });
}
