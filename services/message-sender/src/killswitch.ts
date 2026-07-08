import { OtpChannel } from "@wanthat/contracts";
import type { RuntimeConfigReader } from "@wanthat/dynamo";

export interface OtpChannelAvailability {
  channels: OtpChannel[];
  defaultChannel: OtpChannel | null;
  /** Set iff `whatsapp` is in `channels` — the origination identity a WhatsApp send must use. */
  whatsappPhoneNumberId?: string;
}

/**
 * Which OTP channels are currently available (ADR-0006 sms kill switch; ADR-0019 whatsapp).
 * Ported from app-auth's killswitch.ts (ADR-0006 decision 5): Cognito forwards no ClientMetadata
 * to custom-sender triggers, so the per-request channel choice app-auth used to enforce cannot
 * exist — the sender itself is now the enforcement point. WhatsApp needs its switch on AND an
 * onboarded origination identity; the configured default only wins when it is itself enabled,
 * otherwise any enabled channel serves as the fallback.
 */
export async function otpChannelAvailability(
  config: RuntimeConfigReader,
): Promise<OtpChannelAvailability> {
  const [smsOn, whatsappOn, phoneNumberId, configuredDefault] = await Promise.all([
    config.get("auth.smsEnabled"),
    config.get("auth.whatsappEnabled"),
    config.get("whatsapp.phoneNumberId"),
    config.get("auth.defaultOtpChannel"),
  ]);
  const channels: OtpChannel[] = [];
  const whatsappId =
    typeof phoneNumberId === "string" && phoneNumberId !== "" ? phoneNumberId : undefined;
  if (whatsappOn === true && whatsappId !== undefined) channels.push("whatsapp");
  if (smsOn === true) channels.push("sms");
  const parsed = OtpChannel.safeParse(configuredDefault);
  const defaultChannel =
    parsed.success && channels.includes(parsed.data) ? parsed.data : (channels[0] ?? null);
  return {
    channels,
    defaultChannel,
    whatsappPhoneNumberId: channels.includes("whatsapp") ? whatsappId : undefined,
  };
}
