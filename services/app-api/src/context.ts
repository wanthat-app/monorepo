import { createDb } from "@wanthat/db";
import {
  AuthChallengeRepo,
  GuestAttributionRepo,
  getDocClient,
  PhoneVelocityRepo,
  RuntimeConfigRepo,
} from "@wanthat/dynamo";
import { Cognito } from "./auth/cognito";
import { TicketSigner } from "./auth/tickets";

/** The Kysely handle type, derived from createDb so app-api needs no direct kysely dependency. */
type Db = ReturnType<typeof createDb>;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

export interface AppContext {
  region: string;
  db: Db;
  config: RuntimeConfigRepo;
  challenges: AuthChallengeRepo;
  velocity: PhoneVelocityRepo;
  guests: GuestAttributionRepo;
  cognito: Cognito;
  tickets: TicketSigner;
}

let cached: AppContext | undefined;

/**
 * Build the per-container dependency graph once and reuse it across warm invocations (mirrors the
 * fx-rates handler). Aurora is reached as `app_rw` via IAM auth; DynamoDB repos share one document
 * client; the ticket signing key + Cognito client are lazy/cached internally.
 */
export function getContext(): AppContext {
  if (cached) return cached;
  const region = process.env.AWS_REGION ?? "il-central-1";
  const doc = getDocClient(region);
  cached = {
    region,
    db: createDb({
      host: requireEnv("DB_HOST"),
      port: 5432,
      database: requireEnv("DB_NAME"),
      user: requireEnv("DB_USER"),
      region,
      caCerts: process.env.DB_CA_CERT,
    }),
    config: new RuntimeConfigRepo(doc, requireEnv("RUNTIME_CONFIG_TABLE")),
    challenges: new AuthChallengeRepo(doc, requireEnv("AUTH_CHALLENGE_TABLE")),
    velocity: new PhoneVelocityRepo(doc, requireEnv("PHONE_VELOCITY_TABLE")),
    guests: new GuestAttributionRepo(doc, requireEnv("GUEST_ATTRIBUTION_TABLE")),
    cognito: new Cognito(requireEnv("USER_POOL_ID"), requireEnv("USER_POOL_CLIENT_ID"), region),
    tickets: new TicketSigner(requireEnv("AUTH_TICKET_SECRET_ARN"), region),
  };
  return cached;
}
