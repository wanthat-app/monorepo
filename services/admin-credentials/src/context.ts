import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { CustomerCounterRepo, getDocClient, RecommendationRepo } from "@wanthat/dynamo";
import { CognitoUserAdmin } from "./cognito-users";
import { RetailerSecretWriter } from "./retailer-secret";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

export interface AdminCredentialsContext {
  retailerSecret: RetailerSecretWriter;
  cognitoUsers: CognitoUserAdmin;
  /** User erasure also deletes the member's recommendations (deleteByOwner, ADR-0006 d8). */
  recommendations: RecommendationRepo;
  /** The exact customer counter: delete decrements, suspend / lift move the disabled count. */
  customerCounter: CustomerCounterRepo;
}

let cached: AdminCredentialsContext | undefined;

/** Per-container deps: the write-only Secrets Manager accessor + the customer-pool user admin
 * + the recommendation repo (erased alongside the account on delete). */
export function getContext(): AdminCredentialsContext {
  if (cached) return cached;
  const region = process.env.AWS_REGION ?? "il-central-1";
  cached = {
    retailerSecret: new RetailerSecretWriter(
      new SecretsManagerClient({ region }),
      requireEnv("RETAILER_SECRET_ARN"),
    ),
    cognitoUsers: new CognitoUserAdmin(
      new CognitoIdentityProviderClient({ region }),
      requireEnv("CUSTOMER_USER_POOL_ID"),
    ),
    recommendations: new RecommendationRepo(
      getDocClient(region),
      requireEnv("RECOMMENDATION_TABLE"),
    ),
    customerCounter: new CustomerCounterRepo(
      getDocClient(region),
      requireEnv("RUNTIME_CONFIG_TABLE"),
    ),
  };
  return cached;
}
