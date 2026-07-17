/**
 * `@wanthat/whatsapp` (ADR-0019) — a pure library over AWS End User Messaging Social: the
 * message-type registry, the template payload builder, and the sender. Consumed by
 * services/otp-sender (OTP) and services/notification-sender (notifications).
 */
export { META_API_VERSION, WhatsAppSender } from "./client";
export { buildTemplateMessage, type TemplateMessage } from "./payload";
export {
  MESSAGE_TYPES,
  type MessageType,
  type MessageTypeSpec,
  OptinWelcomeVariables,
  OtpCodeVariables,
  type TemplateComponent,
} from "./registry";
