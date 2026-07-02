import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as ec2 from "aws-cdk-lib/aws-ec2";
import { SubnetType } from "aws-cdk-lib/aws-ec2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Trigger } from "aws-cdk-lib/triggers";
import type { Construct } from "constructs";
import {
  LAMBDA_RUNTIME,
  MIGRATIONS_DIR_ENV,
  migratorBundling,
  RDS_CA_ENV,
  serviceEntry,
  serviceLogGroup,
  type WanthatEnv,
} from "./config";

export interface DataStackProps extends StackProps {
  readonly wanthatEnv: WanthatEnv;
  /** From NetworkStack — Aurora + the in-VPC migrator live here (ADR-0004/0020). */
  readonly vpc: ec2.IVpc;
  readonly auroraSg: ec2.ISecurityGroup;
  readonly lambdaSg: ec2.ISecurityGroup;
}

/**
 * DataStack — the data plane (ADR-0003, ADR-0005, ADR-0020).
 *
 * DynamoDB (on-demand) holds everything that isn't PII or money: the landing projection
 * (`recommendationId → affiliate url + product`, `byOwner` GSI), `guest_attribution`, the runtime
 * `config` table, the `fx_rate` cache, plus the auth working tables (`auth_challenge`,
 * `phone_velocity`, both TTL-expiring). Aurora Serverless v2 (scale-to-zero, IAM auth, no RDS Proxy)
 * holds PII + ledger. A one-shot migrator Trigger runs the schema after the cluster is created. PITR
 * on all DynamoDB tables; a Secrets Manager placeholder holds the retailer credential.
 */
export class DataStack extends Stack {
  readonly recommendationTable: dynamodb.Table;
  readonly guestAttributionTable: dynamodb.Table;
  readonly runtimeConfigTable: dynamodb.Table;
  readonly fxRateTable: dynamodb.Table;
  readonly authChallengeTable: dynamodb.Table;
  readonly phoneVelocityTable: dynamodb.Table;
  readonly notificationOutboxTable: dynamodb.Table;
  readonly retailerSecret: secretsmanager.Secret;
  readonly cluster: rds.DatabaseCluster;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { wanthatEnv, vpc, auroraSg, lambdaSg } = props;
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
    // "List my recommendations" (ADR-0003): owner-scoped, sorted by `createdAt` (ISO-8601, so it
    // sorts chronologically). DynamoDB stores a GSI ascending; the list query reads it **newest-first**
    // with `ScanIndexForward: false` — sort direction is a query-time parameter, not a GSI/table
    // property, so it's set by the "list my recommendations" handler (not here).
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

    // Admin-tunable runtime config (key-value), e.g. `landing.countdownSeconds` (ADR-0003).
    this.runtimeConfigTable = new dynamodb.Table(this, "RuntimeConfig", {
      partitionKey: { name: "configKey", type: dynamodb.AttributeType.STRING },
      ...common,
    });

    // FX rate cache keyed by `${base}#${quote}` (e.g. "USD#ILS"); see @wanthat/contracts ExchangeRate.
    this.fxRateTable = new dynamodb.Table(this, "FxRate", {
      partitionKey: { name: "pair", type: dynamodb.AttributeType.STRING },
      ...common,
    });

    // Auth OTP challenge state (ADR-0020): one item per /auth/start, carrying the Cognito session and
    // resend cooldown. TTL-expired by `ttl` so abandoned challenges self-clean.
    this.authChallengeTable = new dynamodb.Table(this, "AuthChallenge", {
      partitionKey: { name: "challengeId", type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: "ttl",
      ...common,
    });

    // Per-phone SMS velocity counter (ADR-0006 kill-switch layer 1). Hashed phone key; TTL windows.
    this.phoneVelocityTable = new dynamodb.Table(this, "PhoneVelocity", {
      partitionKey: { name: "phoneHash", type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: "ttl",
      ...common,
    });

    // ADR-0023: transactional outbox for WhatsApp notifications. In-VPC producers (app-core)
    // write over the free DynamoDB gateway endpoint; the Stream triggers the NON-VPC
    // whatsapp-dispatcher (the NAT-free bridge - no SQS interface endpoint). TTL ~30 days:
    // items skipped while the kill switch is off age out by design.
    this.notificationOutboxTable = new dynamodb.Table(this, "NotificationOutbox", {
      partitionKey: { name: "outboxId", type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: "ttl",
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      ...common,
    });

    // Secret-scoped retailer (AliExpress) credential — created empty, populated out-of-band.
    this.retailerSecret = new secretsmanager.Secret(this, "RetailerCredential", {
      secretName: `wanthat/${wanthatEnv.name}/retailer/aliexpress`,
      description: "AliExpress affiliate app key/secret - populate out-of-band (never in the repo)",
    });

    // --- Aurora Serverless v2 (PII + ledger) — scale-to-zero, IAM auth, no RDS Proxy (ADR-0003) ---
    // 16.13 is available in il-central-1 (16.6 is not) and supports serverless v2 min-ACU 0.
    const engine = rds.DatabaseClusterEngine.auroraPostgres({
      version: rds.AuroraPostgresEngineVersion.VER_16_13,
    });
    // Fixed max_connections instead of the ACU-derived default: app-api is DynamoDB-hot (Aurora holds
    // only PII + ledger, ADR-0003) and Lambda concurrency is small, so 50 is ample headroom over the
    // worst-case in-VPC connection count. (Static param → applied at instance creation.)
    const parameterGroup = new rds.ParameterGroup(this, "AuroraParams", {
      engine,
      parameters: { max_connections: "50" },
    });
    this.cluster = new rds.DatabaseCluster(this, "Aurora", {
      engine,
      vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      securityGroups: [auroraSg],
      writer: rds.ClusterInstance.serverlessV2("Writer", { parameterGroup }),
      serverlessV2MinCapacity: 0, // scale-to-zero (ADR-0003); confirm acceptance at deploy
      serverlessV2MaxCapacity: 2,
      iamAuthentication: true,
      defaultDatabaseName: "wanthat",
      credentials: rds.Credentials.fromGeneratedSecret("wanthat_master"),
      storageEncrypted: true,
      removalPolicy,
    });

    // --- One-shot migration runner (ADR-0012/0020) ---
    // A NodejsFunction (so esbuild bundles the TS handler + pg/kysely) wrapped by triggers.Trigger,
    // NOT triggers.TriggerFunction (which is a plain lambda.Function and would not bundle). Runs as
    // the master user from the cluster secret because the IAM login roles don't exist until 0001.
    const migratorFn = new NodejsFunction(this, "DbMigrator", {
      functionName: `wanthat-${wanthatEnv.name}-db-migrator`,
      entry: serviceEntry("db-migrator"),
      handler: "handler",
      runtime: LAMBDA_RUNTIME,
      memorySize: 256,
      timeout: Duration.minutes(5), // generous for a cold scale-to-zero resume
      // X-Ray tracing + an explicit retention-bounded log group (ADR-0002 observability). The
      // ObservabilityStack does NOT alarm this one-shot's errors (a failed migration surfaces via the
      // deploy itself), but its logs/traces are still retained for post-mortems.
      tracing: lambda.Tracing.ACTIVE,
      logGroup: serviceLogGroup(this, "DbMigratorLogs", wanthatEnv),
      vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      securityGroups: [lambdaSg],
      // No reserved concurrency: a one-shot Trigger invokes this once per deploy, so it runs in the
      // unreserved pool (reserving any concurrency needs account quota >= 21; see infra issues). The
      // app-api/admin reserved budget (7/2) is the Aurora connection ceiling; this migrator isn't part
      // of it. CDK's Trigger already serialises invocation, and migrations are transactional.
      environment: {
        WANTHAT_ENV: wanthatEnv.name,
        DB_SECRET_ARN: this.cluster.secret?.secretArn ?? "",
        DB_HOST: this.cluster.clusterEndpoint.hostname,
        DB_PORT: String(this.cluster.clusterEndpoint.port),
        DB_NAME: "wanthat",
        // Trust the Amazon RDS CA so the migrator's TLS connection to Aurora verifies (ADR-0020).
        ...RDS_CA_ENV,
        // Where the bundled .sql migrations live in the artifact (esbuild bundles only JS).
        ...MIGRATIONS_DIR_ENV,
      },
      // Ship the RDS CA bundle + the .sql migration files in the function artifact (see migratorBundling).
      bundling: migratorBundling,
    });
    this.cluster.secret?.grantRead(migratorFn);

    new Trigger(this, "MigrateTrigger", {
      handler: migratorFn,
      executeAfter: [this.cluster],
    });
  }
}
