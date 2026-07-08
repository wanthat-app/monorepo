import { MessageLanguage, OtpChannel } from "@wanthat/contracts";
import type { RuntimeConfigReader } from "@wanthat/dynamo";

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
   * "devSink", the code is parked for CLI pickup instead of delivered. `allowed` gates the config
   * read itself, so prod and the sms fast path make zero extra reads.
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
  /** Structured log sink. The success line carries `sub` — the field app-auth's otp_start log shares, so one Logs Insights query follows the chain. */
  log: (msg: string, ctx?: Record<string, unknown>) => void;
}

/**
 * Pure executor (ADR-0019, spec rev 2): deliver the OTP via EXACTLY the requested channel or
 * throw. No channel defaults, no kill-switch reads, no WhatsApp->SMS fallback — a throw fails the
 * initiating AdminInitiateAuth (UnexpectedLambdaException), app-auth maps it to `send_failed`,
 * and falling back is the UI's decision, not this function's.
 */
export async function deliverOtp(deps: SendDeps, event: CustomSmsSenderEvent): Promise<void> {
  const attrs = event.request.userAttributes;

  // app-auth writes custom:otpChannel on EVERY start/resend; absence is an invariant violation.
  const channel = OtpChannel.safeParse(attrs["custom:otpChannel"]);
  if (!channel.success)
    throw new Error("message-sender: missing or invalid custom:otpChannel user attribute");

  const to = attrs.phone_number;
  if (!to) throw new Error("message-sender: event carries no phone_number");

  const code = await deps.decryptCode(event.request.code);

  // Dev-only sink (docs/dev-otp-sink.md): park the code instead of delivering. Checked before the
  // channel dispatch so BOTH channels sink; the code itself is never logged.
  if (deps.devSink.allowed && (await deps.config.get("auth.otpSink")) === "devSink") {
    await deps.devSink.put({
      phone: to,
      code,
      channel: channel.data,
      triggerSource: event.triggerSource,
    });
    deps.log("otp_sunk_dev", { channel: channel.data, sub: attrs.sub });
    return;
  }

  if (channel.data === "whatsapp") {
    // The origination identity is a send parameter (it cannot ride the Cognito event), not flow logic.
    const phoneNumberId = await deps.config.get("whatsapp.phoneNumberId");
    if (typeof phoneNumberId !== "string" || phoneNumberId === "")
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
