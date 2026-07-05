import {
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

/**
 * Repository over `passkey_credential` (ADR-0024) — the public keys of members' discoverable passkeys,
 * which WE store and verify (Cognito is no longer in the passkey verification path). Non-PII
 * (ADR-0003): a Cognito `sub` + a WebAuthn public key, no name/phone/email. PK is the WebAuthn
 * `credentialId`; the `byCustomerSub` GSI lists a member's credentials (enrol exclude-list, future
 * management). No TTL — passkeys persist until explicitly removed.
 */
export interface PasskeyCredentialItem {
  credentialId: string;
  customerSub: string;
  /** base64url of the COSE public key (see @wanthat/webauthn StoredCredential). */
  publicKey: string;
  signCount: number;
  transports?: string[];
  createdAt: string;
}

export class PasskeyCredentialRepo {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async put(item: PasskeyCredentialItem): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.tableName, Item: item }));
  }

  async getByCredentialId(credentialId: string): Promise<PasskeyCredentialItem | undefined> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { credentialId } }),
    );
    return res.Item as PasskeyCredentialItem | undefined;
  }

  /** All credentials for a member (GSI byCustomerSub). */
  async listByCustomer(customerSub: string): Promise<PasskeyCredentialItem[]> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "byCustomerSub",
        KeyConditionExpression: "customerSub = :s",
        ExpressionAttributeValues: { ":s": customerSub },
      }),
    );
    return (res.Items ?? []) as PasskeyCredentialItem[];
  }

  /** Persist the new signature counter after a verified assertion (clone-detection state). */
  async updateSignCount(credentialId: string, signCount: number): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { credentialId },
        UpdateExpression: "SET #c = :c",
        ExpressionAttributeNames: { "#c": "signCount" },
        ExpressionAttributeValues: { ":c": signCount },
      }),
    );
  }
}
