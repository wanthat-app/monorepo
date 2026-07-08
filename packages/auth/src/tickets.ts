import { createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

/**
 * Self-contained registration ticket (ADR-0006 decision 3). The client carries it from `/auth/verify`
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
 * The JSON stored in the `AuthTicketSecret` Secrets Manager secret, written once by the
 * `ticket-keygen` custom resource at deploy time. Only `app-auth` ever reads it (over the FREE
 * public Secrets Manager endpoint — it is non-VPC); verification needs no secret at all.
 */
export interface TicketKeyMaterial {
  /** Ed25519 private key, PEM (PKCS#8). */
  privateKeyPem: string;
  /** Ed25519 public key(s), base64 DER (SPKI). Index 0 is the active key; extras support rotation. */
  publicKeys: string[];
}

/**
 * Registration-ticket SIGNER (ADR-0006, asymmetric since the Ed25519 switch). The wire form is
 * `<payload>.<signature>`: `payload` is the base64url JSON {@link RegistrationTicket}; `signature`
 * is an Ed25519 signature over the payload string, base64url. Asymmetric on purpose: `app-auth`
 * holds the PRIVATE key (Secrets Manager, public endpoint, cached per container), while `app-core`
 * verifies with the PUBLIC key from a plain env var ({@link TicketVerifier}) — so the in-VPC side
 * needs no Secrets Manager access (and no paid interface endpoint).
 */
export class TicketSigner {
  private keyPromise?: Promise<TicketKeyMaterial>;

  constructor(
    private readonly secretArn: string,
    private readonly region?: string,
  ) {}

  private getKey(): Promise<TicketKeyMaterial> {
    if (!this.keyPromise) {
      this.keyPromise = (async () => {
        const sm = new SecretsManagerClient(this.region ? { region: this.region } : {});
        const res = await sm.send(new GetSecretValueCommand({ SecretId: this.secretArn }));
        if (!res.SecretString) throw new Error("auth ticket secret has no SecretString");
        const material = JSON.parse(res.SecretString) as TicketKeyMaterial;
        if (!material.privateKeyPem) throw new Error("auth ticket secret is not keypair material");
        return material;
      })();
    }
    return this.keyPromise;
  }

  /** Sign a self-contained ticket into an opaque `<payload>.<signature>` string. */
  async sign(ticket: RegistrationTicket): Promise<string> {
    const { privateKeyPem } = await this.getKey();
    const payload = Buffer.from(JSON.stringify(ticket)).toString("base64url");
    const signature = edSign(null, Buffer.from(payload), privateKeyPem).toString("base64url");
    return `${payload}.${signature}`;
  }
}

/**
 * Registration-ticket VERIFIER — the secretless half. Takes the Ed25519 public key(s) as base64 DER
 * (SPKI), delivered via the `AUTH_TICKET_PUBLIC_KEYS` env var (a JSON string array; a verification
 * key is public material, safe in plain env). Accepting an ARRAY makes rotation a three-step deploy:
 * add the new public key → flip the signer's private key → drop the old public key. Tickets are
 * seconds-lived, so both keys verifying during the window is all rotation needs.
 */
export class TicketVerifier {
  private readonly keys: KeyObject[];

  /** @param publicKeysJson JSON string array of base64 DER (SPKI) Ed25519 public keys. */
  constructor(publicKeysJson: string) {
    const parsed = JSON.parse(publicKeysJson) as string[];
    if (!Array.isArray(parsed) || parsed.length === 0)
      throw new Error("AUTH_TICKET_PUBLIC_KEYS must be a non-empty JSON array");
    this.keys = parsed.map((b64) =>
      createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" }),
    );
  }

  /**
   * Verify a ticket; returns the {@link RegistrationTicket} if the signature checks out against any
   * configured public key and it has not expired, else null.
   */
  async verify(token: string): Promise<RegistrationTicket | null> {
    const dot = token.lastIndexOf(".");
    if (dot <= 0) return null;
    const payload = token.slice(0, dot);
    const signature = Buffer.from(token.slice(dot + 1), "base64url");
    const payloadBuf = Buffer.from(payload);
    const valid = this.keys.some((key) => {
      try {
        return edVerify(null, payloadBuf, key, signature);
      } catch {
        return false;
      }
    });
    if (!valid) return null;

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
