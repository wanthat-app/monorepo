import { RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type { Construct } from "constructs";
import type { WanthatEnv } from "./config";

export interface DataStackProps extends StackProps {
  readonly wanthatEnv: WanthatEnv;
}

/**
 * DataStack — the non-relational data plane (ADR-0003, ADR-0005).
 *
 * DynamoDB (on-demand) holds everything that isn't PII or money. Built up one table at a time:
 * the landing projection (`recommendationId → affiliate url + product`, with a `byOwner` GSI for
 * "my recommendations"), then `guest_attribution`, the runtime `config` table, the `fx_rate` cache,
 * and a Secrets Manager placeholder for the retailer credential. PITR on all tables.
 *
 * Aurora Serverless v2 (PII + ledger) is **deferred** to the wallet slice.
 */
export class DataStack extends Stack {
  readonly recommendationTable: dynamodb.Table;
  readonly guestAttributionTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { wanthatEnv } = props;
    const removalPolicy = wanthatEnv.name === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const common = {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy,
    } as const;

    this.recommendationTable = new dynamodb.Table(this, "Recommendation", {
      partitionKey: { name: "recommendationId", type: dynamodb.AttributeType.STRING },
      ...common,
    });
    // "List my recommendations" (ADR-0003) — owner-scoped, newest first.
    this.recommendationTable.addGlobalSecondaryIndex({
      indexName: "byOwner",
      partitionKey: { name: "ownerId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.STRING },
    });

    // Maps an anonymous guestId → customer once they register (ADR-0008, consumer attribution).
    this.guestAttributionTable = new dynamodb.Table(this, "GuestAttribution", {
      partitionKey: { name: "guestId", type: dynamodb.AttributeType.STRING },
      ...common,
    });
  }
}
