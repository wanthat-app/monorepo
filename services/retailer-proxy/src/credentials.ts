import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { PutRetailerCredentialsBody } from "@wanthat/contracts";

/**
 * Cached reader of the `wanthat/{env}/retailer/aliexpress` secret (ADR-0002: this function is
 * the sole reader; admin writes it write-only). The secret is created as an EMPTY placeholder
 * at deploy and populated out-of-band, so "not configured yet" is a normal state: `get()`
 * answers null for it. Success is memoized per warm container; a not-configured answer is NOT,
 * so the first invoke after the admin drop picks the credential up without a redeploy.
 */
export class RetailerCredentialsReader {
  private cached?: Promise<PutRetailerCredentialsBody>;

  constructor(
    private readonly secretArn: string,
    private readonly sm: SecretsManagerClient = new SecretsManagerClient({}),
  ) {}

  async get(): Promise<PutRetailerCredentialsBody | null> {
    if (this.cached) return this.cached;
    const attempt = (async () => {
      const res = await this.sm.send(new GetSecretValueCommand({ SecretId: this.secretArn }));
      if (!res.SecretString) return null;
      let raw: unknown;
      try {
        raw = JSON.parse(res.SecretString);
      } catch {
        return null; // the deploy-time placeholder is not JSON — treat as not configured
      }
      const parsed = PutRetailerCredentialsBody.safeParse(raw);
      return parsed.success ? parsed.data : null;
    })();
    const value = await attempt;
    if (value !== null) this.cached = Promise.resolve(value);
    return value;
  }
}
