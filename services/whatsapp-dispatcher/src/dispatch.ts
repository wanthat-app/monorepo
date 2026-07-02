import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { MessageLanguage } from "@wanthat/contracts";
import type { NotificationOutboxItem, RuntimeConfigReader } from "@wanthat/dynamo";
import type { MessageType } from "@wanthat/whatsapp";

/** The slice of a DynamoDB stream record we consume. */
export interface OutboxStreamRecord {
  eventName?: string;
  dynamodb?: { NewImage?: Record<string, AttributeValue> };
}

export interface DispatchDeps {
  config: RuntimeConfigReader;
  outbox: {
    markSent(outboxId: string): Promise<void>;
    markFailed(outboxId: string, error: string): Promise<void>;
  };
  whatsapp: {
    sendTemplate(args: {
      phoneNumberId: string;
      type: MessageType;
      language: MessageLanguage;
      variables: unknown;
      to: string;
    }): Promise<unknown>;
  };
  log: (msg: string, ctx?: Record<string, unknown>) => void;
}

/**
 * The flow controller of the async notification flow (ADR-0023) — the only place a
 * skip-when-disabled legitimately lives (no user is present to decide). Per INSERT record:
 * pending items get sent + markSent; kill-switched items stay `pending` and age out via TTL
 * (intended pre-launch); a send-submission failure is markFailed WITHOUT rethrow (best-effort
 * message — a rejected template will not pass on retry). Infrastructure errors DO throw so the
 * event source retries/bisects and eventually parks the batch in the DLQ.
 */
export async function dispatchRecord(
  deps: DispatchDeps,
  record: OutboxStreamRecord,
): Promise<void> {
  if (record.eventName !== "INSERT") return;
  const image = record.dynamodb?.NewImage;
  if (!image) return;
  const item = unmarshall(image) as NotificationOutboxItem;
  if (item.status !== "pending") return; // at-least-once: a replayed record is a no-op

  const [enabled, phoneNumberId] = await Promise.all([
    deps.config.get("notifications.whatsappEnabled"),
    deps.config.get("whatsapp.phoneNumberId"),
  ]);
  if (enabled !== true || typeof phoneNumberId !== "string" || phoneNumberId === "") {
    deps.log("notification_skipped_disabled", { outboxId: item.outboxId });
    return;
  }

  try {
    await deps.whatsapp.sendTemplate({
      phoneNumberId,
      type: item.messageType,
      language: item.language,
      variables: item.variables,
      to: item.phone,
    });
  } catch (err) {
    await deps.outbox.markFailed(item.outboxId, err instanceof Error ? err.message : String(err));
    deps.log("notification_send_failed", { outboxId: item.outboxId });
    return;
  }
  await deps.outbox.markSent(item.outboxId);
}
