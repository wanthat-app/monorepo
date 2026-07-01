import { TicketSigner } from "@wanthat/auth";
import {
  AuthChallengeRepo,
  GuestAttributionRepo,
  getDocClient,
  PhoneVelocityRepo,
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
  config: RuntimeConfigRepo;
  challenges: AuthChallengeRepo;
  velocity: PhoneVelocityRepo;
  guests: GuestAttributionRepo;
  cognito: Cognito;
  tickets: TicketSigner;
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
  };
  return cached;
}
