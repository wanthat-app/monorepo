import { createHmac, timingSafeEqual } from "node:crypto";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

/**
 * Registration-ticket signer (ADR-0020). The ticket the client carries from `/auth/verify` to
 * `/auth/register` is `<ticketId>.<hmac>`: the id is an unguessable server-side key into the
 * `auth_challenge` table (where the freshly minted tokens are parked), and the HMAC — keyed by a
 * Secrets Manager secret — lets the server reject a forged/tampered id before any DB lookup.
 *
 * The signing key is fetched once per container and cached (a single Secrets Manager call on the
 * first verify/register), reached over the VPC `secretsmanager` interface endpoint.
 */
export class TicketSigner {
  private keyPromise?: Promise<string>;

  constructor(
    private readonly secretArn: string,
    private readonly region?: string,
  ) {}

  private getKey(): Promise<string> {
    if (!this.keyPromise) {
      this.keyPromise = (async () => {
        const sm = new SecretsManagerClient(this.region ? { region: this.region } : {});
        const res = await sm.send(new GetSecretValueCommand({ SecretId: this.secretArn }));
        if (!res.SecretString) throw new Error("auth ticket secret has no SecretString");
        return res.SecretString;
      })();
    }
    return this.keyPromise;
  }

  async sign(ticketId: string): Promise<string> {
    const mac = createHmac("sha256", await this.getKey())
      .update(ticketId)
      .digest("base64url");
    return `${ticketId}.${mac}`;
  }

  /** Verify an opaque ticket; returns the ticketId if the HMAC checks out, else null. */
  async verify(token: string): Promise<string | null> {
    const dot = token.lastIndexOf(".");
    if (dot <= 0) return null;
    const id = token.slice(0, dot);
    const mac = token.slice(dot + 1);
    const expected = createHmac("sha256", await this.getKey())
      .update(id)
      .digest("base64url");
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return id;
  }
}
