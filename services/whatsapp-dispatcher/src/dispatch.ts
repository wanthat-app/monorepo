import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { MessageLanguage } from "@wanthat/contracts";
import type {
  NotificationOutboxItem,
  NotificationOutboxRepo,
  RuntimeConfigReader,
} from "@wanthat/dynamo";
import type { MessageType } from "@wanthat/whatsapp";

/** The slice of a DynamoDB stream record we consume. */
export interface OutboxStreamRecord {
  eventName?: string;
  dynamodb?: { NewImage?: Record<string, AttributeValue> };
}

export interface DispatchDeps {
  config: RuntimeConfigReader;
  outbox: Pick<NotificationOutboxRepo, "get" | "markSent" | "markFailed">;
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
 * The flow controller of the async notification flow (ADR-0019) — the only place a
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
  // Cheap image-level guard only (an INSERT's image always says "pending"); the REAL replay
  // protection is the table re-read below — the stream image is a frozen snapshot.
  if (item.status !== "pending") return;

  const [enabled, phoneNumberId] = await Promise.all([
    deps.config.get("notifications.whatsappEnabled"),
    deps.config.get("whatsapp.phoneNumberId"),
  ]);
  if (enabled !== true || typeof phoneNumberId !== "string" || phoneNumberId === "") {
    deps.log("notification_skipped_disabled", { outboxId: item.outboxId });
    return;
  }

  // The stream image is a frozen snapshot (an INSERT's status is always "pending"), so replayed
  // records after a partial-batch failure must re-check the TABLE: only a still-pending item may
  // send. This is the at-least-once idempotency the outbox status exists for.
  const current = await deps.outbox.get(item.outboxId);
  if (current?.status !== "pending") {
    deps.log("notification_skipped_not_pending", { outboxId: item.outboxId });
    return;
  }

  let messageId: string | undefined;
  try {
    const res = await deps.whatsapp.sendTemplate({
      phoneNumberId,
      type: item.messageType,
      language: item.language,
      variables: item.variables,
      to: item.phone,
    });
    messageId = res?.messageId;
  } catch (err) {
    await deps.outbox.markFailed(item.outboxId, err instanceof Error ? err.message : String(err));
    deps.log("notification_send_failed", { outboxId: item.outboxId });
    return;
  }
  await deps.outbox.markSent(item.outboxId);
  // messageId is Meta's wamid — the handle for correlating delivery-status webhooks later.
  deps.log("notification_sent", { outboxId: item.outboxId, messageId });
}
