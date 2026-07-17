import {
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import type { OtpChannel } from "@wanthat/contracts";

/**
 * The OTP sink (docs/otp-sink.md): otp-sender parks EVERY decrypted code here before its
 * delivery attempt — a permanent feature in every environment, so the admin activity feed can
 * show current codes (and sign-in stays completable while the SMS sandbox blocks real
 * delivery). Items self-expire (5-minute TTL, the OTP lifetime). Read paths: admin-api's
 * activity feed and the AWS CLI.
 */
export interface OtpSinkItem {
  /** E.164 destination — the lookup key the developer knows. */
  phone: string;
  code: string;
  channel: OtpChannel;
  triggerSource: string;
  createdAt: string;
  ttl: number;
}

export class OtpSinkRepo {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async put(item: OtpSinkItem): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.tableName, Item: item }));
  }

  async get(phone: string): Promise<OtpSinkItem | undefined> {
    const res = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: { phone } }));
    return res.Item as OtpSinkItem | undefined;
  }

  /**
   * Every parked item — the admin activity feed lists current codes. The sink holds
   * at most one 5-minute-TTL item per phone, so a single unpaginated scan is plenty; TTL
   * deletion lags are filtered by the caller (Dynamo TTL is best-effort).
   */
  async scanAll(): Promise<OtpSinkItem[]> {
    const res = await this.doc.send(new ScanCommand({ TableName: this.tableName }));
    return (res.Items ?? []) as OtpSinkItem[];
  }
}
