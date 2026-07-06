import { TicketVerifier } from "@wanthat/auth";
import { createDb } from "@wanthat/db";
import { GuestAttributionRepo, getDocClient, NotificationOutboxRepo } from "@wanthat/dynamo";

/** The Kysely handle type, derived from createDb so app-core needs no direct kysely dependency. */
type Db = ReturnType<typeof createDb>;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

export interface CoreContext {
  region: string;
  db: Db;
  guests: GuestAttributionRepo;
  tickets: TicketVerifier;
  outbox: NotificationOutboxRepo;
  /** Canonical SPA origin for links in outbound messages (env APP_URL). */
  appUrl: string;
}

let cached: CoreContext | undefined;

/**
 * Build the per-container dependency graph once and reuse it across warm invocations. The in-VPC core
 * (ADR-0020) reaches Aurora as `app_rw` via IAM auth (no RDS Proxy) and DynamoDB over the gateway
 * endpoint; it verifies the registration ticket but calls NO Cognito control-plane API.
 */
export function getContext(): CoreContext {
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
    guests: new GuestAttributionRepo(doc, requireEnv("GUEST_ATTRIBUTION_TABLE")),
    // Verification is secretless (Ed25519 PUBLIC keys via env) - app-core reads NO Secrets Manager,
    // which is what lets the VPC drop its secretsmanager interface endpoint.
    tickets: new TicketVerifier(requireEnv("AUTH_TICKET_PUBLIC_KEYS")),
    outbox: new NotificationOutboxRepo(doc, requireEnv("NOTIFICATION_OUTBOX_TABLE")),
    appUrl: requireEnv("APP_URL"),
  };
  return cached;
}
