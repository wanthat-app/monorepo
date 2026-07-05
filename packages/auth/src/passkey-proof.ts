import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

/** The HMAC-proof payload minted by `app-auth` and consumed by the CUSTOM_AUTH Cognito triggers. */
export interface PasskeyProofPayload {
  /** Cognito `sub` — the passkey holder `app-auth` just verified via WebAuthn. */
  sub: string;
  /** Expiry, Unix seconds — rejected once elapsed. */
  exp: number;
  /** Random per-sign nonce so two proofs for the same `sub` are never byte-identical. */
  nonce: string;
}

const PROOF_TTL_SEC = 60;
const nowEpoch = (): number => Math.floor(Date.now() / 1000);

/**
 * Signs/verifies the short-lived HMAC proof that bridges `app-auth`'s own WebAuthn verification to
 * Cognito's CUSTOM_AUTH triggers (ADR-0024): `app-auth` verifies the passkey assertion itself
 * (against our own `passkey_credential` store, not Cognito's), then proves that to Cognito's
 * Define/Create/VerifyAuthChallenge Lambdas by passing this proof as the CUSTOM_CHALLENGE answer —
 * see {@link Cognito.passkeyCustomAuth} in `app-auth`. Same wire form + crypto as
 * {@link TicketSigner}: `<payload>.<hmac>`, both base64url; the HMAC is keyed by a Secrets Manager
 * secret and compared timing-safely, so the CUSTOM_AUTH trigger can trust the proof without
 * re-deriving it. This is the ONLY thing `app-auth` and the trigger share, so it lives here in
 * `@wanthat/auth` (self-contained) rather than in either function's own package.
 */
export class PasskeyProofSigner {
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
        if (!res.SecretString) throw new Error("passkey proof secret has no SecretString");
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

  /** Sign a fresh proof for `sub`, valid for {@link PROOF_TTL_SEC} seconds. */
  async sign(sub: string): Promise<string> {
    const payload: PasskeyProofPayload = {
      sub,
      exp: nowEpoch() + PROOF_TTL_SEC,
      nonce: randomBytes(16).toString("base64url"),
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${encoded}.${await this.mac(encoded)}`;
  }

  /**
   * Verify a proof; returns `{sub}` if the HMAC checks out and it has not expired, else null on any
   * failure (bad shape, tampered HMAC, expired). The HMAC compare is constant-time
   * (`timingSafeEqual`).
   */
  async verify(token: string): Promise<{ sub: string } | null> {
    const dot = token.lastIndexOf(".");
    if (dot <= 0) return null;
    const encoded = token.slice(0, dot);
    const provided = Buffer.from(token.slice(dot + 1));
    const expected = Buffer.from(await this.mac(encoded));
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

    let payload: PasskeyProofPayload;
    try {
      payload = JSON.parse(
        Buffer.from(encoded, "base64url").toString("utf8"),
      ) as PasskeyProofPayload;
    } catch {
      return null;
    }
    if (typeof payload.sub !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp < nowEpoch()) return null;
    return { sub: payload.sub };
  }
}
