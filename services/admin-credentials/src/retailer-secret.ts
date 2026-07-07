import {
  DescribeSecretCommand,
  PutSecretValueCommand,
  type SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import type { PutRetailerCredentialsBody, RetailerCredentialsStatus } from "@wanthat/contracts";

/**
 * Write-only access to the retailer credential secret (`wanthat/{env}/retailer/aliexpress`).
 * admin-api's IAM role holds PutSecretValue + DescribeSecret only — it structurally cannot
 * read the value back; retailer-proxy stays the sole reader. Credential values must never
 * be logged or echoed anywhere in this service.
 */
export class RetailerSecretWriter {
  constructor(
    private readonly client: SecretsManagerClient,
    private readonly secretArn: string,
  ) {}

  /** Replace the whole secret value with `{"appKey":"...","appSecret":"..."}`. */
  async put(credentials: PutRetailerCredentialsBody): Promise<void> {
    await this.client.send(
      new PutSecretValueCommand({
        SecretId: this.secretArn,
        SecretString: JSON.stringify(credentials),
      }),
    );
  }

  /**
   * Non-secret metadata only. On a fresh environment LastChangedDate is the deploy-time
   * placeholder write; after the first admin write it is the real rotation timestamp.
   */
  async status(): Promise<RetailerCredentialsStatus> {
    const res = await this.client.send(new DescribeSecretCommand({ SecretId: this.secretArn }));
    const changed = res.LastChangedDate;
    return changed
      ? { configured: true, lastUpdatedAt: changed.toISOString() }
      : { configured: false, lastUpdatedAt: null };
  }
}
