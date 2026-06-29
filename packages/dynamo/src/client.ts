import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

/**
 * The DynamoDB **document** client (`@wanthat/dynamo`) — the single shared low-level handle the
 * per-table repositories sit on (ADR-0003). Returns native JS values (no AttributeValue marshalling
 * at call sites) and strips `undefined` so optional fields are simply absent rather than erroring.
 *
 * One instance per Lambda container (module-level cache) so the SDK's connection pool is reused
 * across warm invocations. The `@aws-sdk/*` packages are provided by the Node Lambda runtime and are
 * externalised at bundle time, so this adds no real weight to the deployed artifact.
 */
let cached: DynamoDBDocumentClient | undefined;

export function getDocClient(region?: string): DynamoDBDocumentClient {
  if (!cached) {
    const base = new DynamoDBClient(region ? { region } : {});
    cached = DynamoDBDocumentClient.from(base, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return cached;
}
