import { RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import type { WanthatEnv } from "./config";

export interface DataStackProps extends StackProps {
  readonly wanthatEnv: WanthatEnv;
}

/**
 * DataStack — the non-relational data plane (ADR-0003, ADR-0005).
 *
 * DynamoDB (on-demand) holds everything that isn't PII or money: the landing projection
 * (`recommendationId → affiliate url + product`, with a `byOwner` GSI for "my recommendations"),
 * `guest_attribution`, the runtime `config` key-value table, and the `fx_rate` cache. PITR on all.
 *
 * Aurora Serverless v2 (PII + ledger) is **deferred** to the identity/wallet slice; a 501-only
 * app-api needs no database. The Secrets Manager placeholder for the retailer credential is created
 * now (empty — populated out-of-band) so the proxy can be granted read access.
 */
export class DataStack extends Stack {
  readonly recommendationTable: dynamodb.Table;
  readonly guestAttributionTable: dynamodb.Table;
  readonly runtimeConfigTable: dynamodb.Table;
  readonly fxRateTable: dynamodb.Table;
  readonly retailerSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { wanthatEnv } = props;
    const removalPolicy = wanthatEnv.name === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const common = {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
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

    this.guestAttributionTable = new dynamodb.Table(this, "GuestAttribution", {
      partitionKey: { name: "guestId", type: dynamodb.AttributeType.STRING },
      ...common,
    });

    this.runtimeConfigTable = new dynamodb.Table(this, "RuntimeConfig", {
      partitionKey: { name: "configKey", type: dynamodb.AttributeType.STRING },
      ...common,
    });

    // Keyed by `${base}#${quote}` (e.g. "USD#ILS"); see @wanthat/contracts ExchangeRate.
    this.fxRateTable = new dynamodb.Table(this, "FxRate", {
      partitionKey: { name: "pair", type: dynamodb.AttributeType.STRING },
      ...common,
    });

    this.retailerSecret = new secretsmanager.Secret(this, "RetailerCredential", {
      secretName: `wanthat/${wanthatEnv.name}/retailer/aliexpress`,
      description: "AliExpress affiliate app key/secret — populate out-of-band (never in the repo)",
    });
  }
}
