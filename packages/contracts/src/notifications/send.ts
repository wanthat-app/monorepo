import { z } from "zod";
import { PhoneE164 } from "../common";
import { MessageLanguage } from "../identity/channel";

/**
 * Invoke payload of the notification-sender Lambda (compute-topology refactor) — producers
 * async-invoke it directly (InvocationType Event) with the full notification; failures ride
 * Lambda's async retry (2 attempts) into the real-payload SQS DLQ. This replaced the ADR-0019
 * DynamoDB outbox + stream: the payload carries exactly what the outbox item carried for the
 * send itself — message type, destination, language, and the template variables the
 * `@wanthat/whatsapp` registry validates strictly at send time.
 */

/** The optin_welcome template's variables ({{1}} firstName, {{2}} appUrl — see packages/whatsapp). */
export const OptinWelcomeNotification = z.object({
  messageType: z.literal("optin_welcome"),
  /** E.164 destination. */
  phone: PhoneE164,
  language: MessageLanguage,
  /** firstName may be empty — given_name is optional at SignUp; the producer sends "". */
  variables: z.object({ firstName: z.string(), appUrl: z.string().url() }),
});
export type OptinWelcomeNotification = z.infer<typeof OptinWelcomeNotification>;

/** The notification-sender invoke payload — a discriminated union over `messageType`. */
export const SendNotificationRequest = z.discriminatedUnion("messageType", [
  OptinWelcomeNotification,
]);
export type SendNotificationRequest = z.infer<typeof SendNotificationRequest>;
