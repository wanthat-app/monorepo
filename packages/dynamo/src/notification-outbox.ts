import {
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { MessageLanguage } from "@wanthat/contracts";

/**
 * Repository over the `notification_outbox` table (ADR-0023) — the transactional outbox bridging
 * in-VPC producers (app-core writes over the DynamoDB gateway endpoint) to the non-VPC
 * whatsapp-dispatcher (via the table's Stream). At-least-once: the dispatcher is idempotent on
 * `status` ("pending" is the only sendable state). TTL self-cleans (~30 days), so items skipped
 * while the notifications kill switch is off simply age out — intended pre-launch behaviour.
 */

export type NotificationStatus = "pending" | "sent" | "failed";

export interface NotificationOutboxItem {
  outboxId: string;
  /** Cognito sub of the recipient. */
  customerId: string;
  /** E.164 destination. */
  phone: string;
  messageType: "optin_welcome";
  language: MessageLanguage;
  variables: Record<string, string>;
  status: NotificationStatus;
  createdAt: string;
  ttl: number;
}

export class NotificationOutboxRepo {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async put(item: NotificationOutboxItem): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.tableName, Item: item }));
  }

  async get(outboxId: string): Promise<NotificationOutboxItem | undefined> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { outboxId } }),
    );
    return res.Item as NotificationOutboxItem | undefined;
  }

  async markSent(outboxId: string): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { outboxId },
        UpdateExpression: "SET #status = :status",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":status": "sent" },
      }),
    );
  }

  async markFailed(outboxId: string, error: string): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { outboxId },
        UpdateExpression: "SET #status = :status, #error = :error",
        ExpressionAttributeNames: { "#status": "status", "#error": "error" },
        ExpressionAttributeValues: { ":status": "failed", ":error": error },
      }),
    );
  }
}
