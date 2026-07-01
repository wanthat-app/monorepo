import { createHmac, timingSafeEqual } from "node:crypto";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

/**
 * Self-contained registration ticket (ADR-0021 decision 3). The client carries it from `/auth/verify`
 * (signed by `app-auth`) to `/auth/register` (verified by `app-core`). Everything `/auth/register`
 * needs to provision the customer and return a session is inside the ticket, so the two functions
 * share no session store and never invoke each other: the signed ticket is the only handoff.
 */
export interface RegistrationTicket {
  /** Cognito `sub`. */
  sub: string;
  /** E.164 phone. */
  phone: string;
  accessToken: string;
  idToken: string;
  refreshToken: string;
  expiresIn: number;
  /** Ticket expiry, Unix seconds — rejected once elapsed. */
  exp: number;
}

/**
 * Registration-ticket signer/verifier (ADR-0020, ADR-0021). The wire form is `<payload>.<hmac>`:
 * `payload` is the base64url JSON {@link RegistrationTicket}; `hmac` is keyed by a Secrets Manager
 * secret, so the server rejects a forged/tampered ticket before trusting its contents. `app-auth`
 * signs; `app-core` verifies. Both `grantRead` the same secret.
 *
 * The signing key is fetched once per container and cached (a single Secrets Manager call on the
 * first sign/verify). `app-auth` reaches Secrets Manager over the public endpoint; `app-core` over
 * the VPC `secretsmanager` interface endpoint.
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

  private async mac(payload: string): Promise<string> {
    return createHmac("sha256", await this.getKey())
      .update(payload)
      .digest("base64url");
  }

  /** Sign a self-contained ticket into an opaque `<payload>.<hmac>` string. */
  async sign(ticket: RegistrationTicket): Promise<string> {
    const payload = Buffer.from(JSON.stringify(ticket)).toString("base64url");
    return `${payload}.${await this.mac(payload)}`;
  }

  /**
   * Verify a ticket; returns the {@link RegistrationTicket} if the HMAC checks out and it has not
   * expired, else null. The HMAC compare is constant-time (`timingSafeEqual`).
   */
  async verify(token: string): Promise<RegistrationTicket | null> {
    const dot = token.lastIndexOf(".");
    if (dot <= 0) return null;
    const payload = token.slice(0, dot);
    const provided = Buffer.from(token.slice(dot + 1));
    const expected = Buffer.from(await this.mac(payload));
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

    let ticket: RegistrationTicket;
    try {
      ticket = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as RegistrationTicket;
    } catch {
      return null;
    }
    if (typeof ticket.exp !== "number" || ticket.exp < Math.floor(Date.now() / 1000)) return null;
    return ticket;
  }
}
