import type { MessageLanguage } from "@wanthat/contracts";
import { SendNotificationRequest } from "@wanthat/contracts";
import type { RuntimeConfigReader } from "@wanthat/dynamo";
import type { MessageType } from "@wanthat/whatsapp";

export interface SendDeps {
  config: RuntimeConfigReader;
  whatsapp: {
    sendTemplate(args: {
      phoneNumberId: string;
      type: MessageType;
      language: MessageLanguage;
      variables: unknown;
      to: string;
    }): Promise<{ messageId?: string } | undefined>;
  };
  log: (msg: string, ctx?: Record<string, unknown>) => void;
}

/**
 * The flow controller of the async notification path (ADR-0019, reshaped by the compute-topology
 * refactor: producers async-invoke this function directly — no outbox, no stream). Still the only
 * place a skip-when-disabled legitimately lives (no user is present to decide): when the WhatsApp
 * kill switch is off or the phone-number-id is unset, the notification is logged and DROPPED —
 * returning success on purpose, because a disabled channel must not retry into the DLQ. Any real
 * failure (config read, send submission) THROWS so Lambda's async retry (2 attempts) runs and the
 * on-failure destination parks the ORIGINAL payload in the SQS DLQ for inspection/redrive.
 */
export async function sendNotification(deps: SendDeps, event: unknown): Promise<void> {
  const request = SendNotificationRequest.parse(event);

  const [enabled, phoneNumberId] = await Promise.all([
    deps.config.get("notifications.whatsappEnabled"),
    deps.config.get("whatsapp.phoneNumberId"),
  ]);
  if (enabled !== true || typeof phoneNumberId !== "string" || phoneNumberId === "") {
    deps.log("notification_skipped_disabled", { messageType: request.messageType });
    return;
  }

  const res = await deps.whatsapp.sendTemplate({
    phoneNumberId,
    type: request.messageType,
    language: request.language,
    variables: request.variables,
    to: request.phone,
  });
  // messageId is Meta's wamid — the handle for correlating delivery-status webhooks later.
  deps.log("notification_sent", { messageType: request.messageType, messageId: res?.messageId });
}
