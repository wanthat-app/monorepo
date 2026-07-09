import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";

/**
 * The conversion poll's persistent state (ADR-0009: "persist a watermark/cursor"), one item per
 * retailer feed, PK `stateKey` ("aliexpress#orders"). `lastRunAt` drives the heartbeat gate
 * (the 15-minute schedule fires; the op no-ops unless `poller.intervalMinutes` elapsed) and
 * `watermarkEndTime` the next window's start. Timestamps are ISO UTC — the proxy converts to
 * the retailer's GMT+8 only at the API edge. Single writer: the retailer-proxy poll op.
 */
export const PollerStateItem = z.object({
  stateKey: z.string().min(1),
  lastRunAt: z.string(),
  watermarkEndTime: z.string(),
});
export type PollerStateItem = z.infer<typeof PollerStateItem>;

/** Repository over the `poller_state` table. */
export class PollerStateRepo {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async get(stateKey: string): Promise<PollerStateItem | undefined> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { stateKey } }),
    );
    return res.Item ? PollerStateItem.parse(res.Item) : undefined;
  }

  /** Full-item upsert; a failed run simply never calls this (the window re-reads next run). */
  async put(item: PollerStateItem): Promise<void> {
    const validated = PollerStateItem.parse(item);
    await this.doc.send(new PutCommand({ TableName: this.tableName, Item: validated }));
  }
}
