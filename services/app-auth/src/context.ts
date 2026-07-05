import { PasskeyProofSigner, TicketSigner } from "@wanthat/auth";
import {
  AuthChallengeRepo,
  GuestAttributionRepo,
  getDocClient,
  PasskeyCredentialRepo,
  PhoneVelocityRepo,
  type RuntimeConfigReader,
  RuntimeConfigRepo,
} from "@wanthat/dynamo";
import { Cognito } from "./auth/cognito";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

export interface AuthContext {
  region: string;
  /** Read-only by design: the config table is single-writer (admin-api) — ADR-0023 spec. */
  config: RuntimeConfigReader;
  challenges: AuthChallengeRepo;
  velocity: PhoneVelocityRepo;
  guests: GuestAttributionRepo;
  cognito: Cognito;
  tickets: TicketSigner;
  /** Own-store passkey credentials (ADR-0024) — `app-auth` verifies WebAuthn itself, not Cognito. */
  passkeys: PasskeyCredentialRepo;
  /** Signs/verifies the short-lived proof that bridges a verified passkey login into Cognito's
   * CUSTOM_AUTH triggers (ADR-0024) — see {@link Cognito.passkeyCustomAuth}. */
  passkeyProof: PasskeyProofSigner;
  /** WebAuthn Relying Party identity (ADR-0024): `rpId` is the site's registrable domain;
   * `origins` are the exact origins the SPA is served from. Both pin `verifyRegistration`/
   * `verifyAuthentication` to this site so an assertion for another origin/RP is rejected. */
  webauthn: { rpId: string; origins: string[] };
}

let cached: AuthContext | undefined;

/**
 * Build the per-container dependency graph once and reuse it across warm invocations. The non-VPC
 * auth edge (ADR-0021) reaches Cognito + DynamoDB over public AWS endpoints; the ticket signing key
 * is lazy/cached inside {@link TicketSigner}. No Aurora — that seam belongs to `app-core`.
 */
export function getContext(): AuthContext {
  if (cached) return cached;
  const region = process.env.AWS_REGION ?? "il-central-1";
  const doc = getDocClient(region);
  cached = {
    region,
    config: new RuntimeConfigRepo(doc, requireEnv("RUNTIME_CONFIG_TABLE")),
    challenges: new AuthChallengeRepo(doc, requireEnv("AUTH_CHALLENGE_TABLE")),
    velocity: new PhoneVelocityRepo(doc, requireEnv("PHONE_VELOCITY_TABLE")),
    guests: new GuestAttributionRepo(doc, requireEnv("GUEST_ATTRIBUTION_TABLE")),
    cognito: new Cognito(requireEnv("USER_POOL_ID"), requireEnv("USER_POOL_CLIENT_ID"), region),
    tickets: new TicketSigner(requireEnv("AUTH_TICKET_SECRET_ARN"), region),
    passkeys: new PasskeyCredentialRepo(doc, requireEnv("PASSKEY_CREDENTIAL_TABLE")),
    passkeyProof: new PasskeyProofSigner(requireEnv("PASSKEY_PROOF_SECRET_ARN"), region),
    webauthn: {
      rpId: requireEnv("WEBAUTHN_RP_ID"),
      origins: requireEnv("WEBAUTHN_ORIGINS")
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
    },
  };
  return cached;
}
