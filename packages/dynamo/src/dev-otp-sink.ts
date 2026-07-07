import {
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import type { OtpChannel } from "@wanthat/contracts";

/**
 * Dev-only OTP sink (`auth.otpSink = "devSink"`): message-sender parks decrypted codes here
 * instead of delivering, so a developer can complete login without SMS/WhatsApp (both blocked:
 * sandbox cap / Meta onboarding). NEVER active in prod — the sender honours the config key only
 * when WANTHAT_ENV !== "prod", so the prod table exists but stays empty. Items self-expire
 * (5-minute TTL). The read path is the AWS CLI (docs/dev-otp-sink.md), not the app.
 */
export interface DevOtpSinkItem {
  /** E.164 destination — the lookup key the developer knows. */
  phone: string;
  code: string;
  channel: OtpChannel;
  triggerSource: string;
  createdAt: string;
  ttl: number;
}

export class DevOtpSinkRepo {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async put(item: DevOtpSinkItem): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.tableName, Item: item }));
  }

  async get(phone: string): Promise<DevOtpSinkItem | undefined> {
    const res = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: { phone } }));
    return res.Item as DevOtpSinkItem | undefined;
  }

  /**
   * Every parked item — the admin activity feed (dev only) lists current codes. The sink holds
   * at most one 5-minute-TTL item per phone, so a single unpaginated scan is plenty; TTL
   * deletion lags are filtered by the caller (Dynamo TTL is best-effort).
   */
  async scanAll(): Promise<DevOtpSinkItem[]> {
    const res = await this.doc.send(new ScanCommand({ TableName: this.tableName }));
    return (res.Items ?? []) as DevOtpSinkItem[];
  }
}
