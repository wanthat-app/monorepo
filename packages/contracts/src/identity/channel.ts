import { z } from "zod";

/**
 * OTP delivery channel (ADR-0019). Survives ADR-0006 as the `custom:otpChannel` user
 * attribute (set at SignUp, edited from the profile) and the otp-sender's enforcement
 * input — the per-request `/auth/start` channel field died with the auth proxy (T8).
 */
export const OtpChannel = z.enum(["whatsapp", "sms"]);
export type OtpChannel = z.infer<typeof OtpChannel>;

/** Languages our Meta templates are approved in (ADR-0019). */
export const MessageLanguage = z.enum(["he", "en"]);
export type MessageLanguage = z.infer<typeof MessageLanguage>;
