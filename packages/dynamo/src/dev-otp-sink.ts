import { type DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
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
}
