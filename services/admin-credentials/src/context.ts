import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { CognitoUserRemover } from "./cognito-users";
import { RetailerSecretWriter } from "./retailer-secret";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

export interface AdminCredentialsContext {
  retailerSecret: RetailerSecretWriter;
  cognitoUsers: CognitoUserRemover;
}

let cached: AdminCredentialsContext | undefined;

/** Per-container deps: the write-only Secrets Manager accessor + the customer-pool remover. */
export function getContext(): AdminCredentialsContext {
  if (cached) return cached;
  const region = process.env.AWS_REGION ?? "il-central-1";
  cached = {
    retailerSecret: new RetailerSecretWriter(
      new SecretsManagerClient({ region }),
      requireEnv("RETAILER_SECRET_ARN"),
    ),
    cognitoUsers: new CognitoUserRemover(
      new CognitoIdentityProviderClient({ region }),
      requireEnv("CUSTOMER_USER_POOL_ID"),
    ),
  };
  return cached;
}
