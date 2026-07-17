import type { OtpChannel } from "@wanthat/contracts";
import { configApi } from "./api";

/**
 * OTP channel options for the register screen, derived from the PUBLIC config keys — the same
 * kill switches the otp-sender enforces (`otpChannelAvailability`). The SPA-visible
 * predicate is deliberately narrower: `whatsapp.phoneNumberId` is private, so the UI offers
 * WhatsApp on `auth.whatsappEnabled` alone — the sender still enforces the full predicate (an
 * onboarded origination identity) and falls back, so the worst case of the difference is a
 * choice the sender overrides, never a dead signup.
 */
export interface OtpChannelOptions {
  /** Channels the UI may offer, in display order. Never empty. */
  channels: OtpChannel[];
  /** The preselected channel — always a member of `channels`. */
  defaultChannel: OtpChannel;
}

/**
 * The graceful floor: offered when the config fetch fails, and when every switch is off (the
 * UI must still collect a channel for `custom:otpChannel`; the sender is the enforcement point).
 */
export const SMS_ONLY: OtpChannelOptions = { channels: ["sms"], defaultChannel: "sms" };

/** Pure derivation over the fetched values — unit-tested; the fetch wrapper below adds I/O. */
export function deriveOtpChannelOptions(values: Record<string, unknown>): OtpChannelOptions {
  const channels: OtpChannel[] = [];
  if (values["auth.whatsappEnabled"] === true) channels.push("whatsapp");
  if (values["auth.smsEnabled"] === true) channels.push("sms");
  if (channels.length === 0) return SMS_ONLY;
  const preferred = values["auth.defaultOtpChannel"];
  const defaultChannel =
    (preferred === "whatsapp" || preferred === "sms") && channels.includes(preferred)
      ? preferred
      : (channels[0] ?? "sms");
  return { channels, defaultChannel };
}

/** Fetch the kill switches and derive the offered channels. Degrades to SMS-only on any failure. */
export async function fetchOtpChannelOptions(): Promise<OtpChannelOptions> {
  try {
    const { values } = await configApi.getPublic([
      "auth.whatsappEnabled",
      "auth.smsEnabled",
      "auth.defaultOtpChannel",
    ]);
    return deriveOtpChannelOptions(values);
  } catch {
    return SMS_ONLY;
  }
}
