import { OtpChannel } from "@wanthat/contracts";
import type { RuntimeConfigReader } from "@wanthat/dynamo";

export interface OtpChannelAvailability {
  channels: OtpChannel[];
  defaultChannel: OtpChannel | null;
}

/**
 * Which OTP channels are currently available (ADR-0020 sms kill switch; ADR-0023 whatsapp).
 * ONE predicate feeds both GET /auth/config (what the UI may offer) and the start/resend gates
 * (what the API accepts), so they cannot drift. WhatsApp needs its switch on AND an onboarded
 * origination identity. A requested-but-unavailable channel is an explicit 503 — never a silent
 * switch (spec rev 2); the server default is only WHICH channel /auth/config tells the UI to
 * preselect, applied here, at the flow-controlling level.
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
  if (whatsappOn === true && phoneNumberId !== "") channels.push("whatsapp");
  if (smsOn === true) channels.push("sms");
  const parsed = OtpChannel.safeParse(configuredDefault);
  const defaultChannel =
    parsed.success && channels.includes(parsed.data) ? parsed.data : (channels[0] ?? null);
  return { channels, defaultChannel };
}
