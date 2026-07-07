import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { RetailerSecretWriter } from "./retailer-secret";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

export interface AdminCredentialsContext {
  retailerSecret: RetailerSecretWriter;
}

let cached: AdminCredentialsContext | undefined;

/** Per-container deps: just the write-only Secrets Manager accessor (see handler.ts header). */
export function getContext(): AdminCredentialsContext {
  if (cached) return cached;
  const region = process.env.AWS_REGION ?? "il-central-1";
  cached = {
    retailerSecret: new RetailerSecretWriter(
      new SecretsManagerClient({ region }),
      requireEnv("RETAILER_SECRET_ARN"),
    ),
  };
  return cached;
}
