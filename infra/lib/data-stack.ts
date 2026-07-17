import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as ec2 from "aws-cdk-lib/aws-ec2";
import { SubnetType } from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Trigger } from "aws-cdk-lib/triggers";
import type { Construct } from "constructs";
import {
  MIGRATIONS_DIR_ENV,
  makeServiceFunction,
  migratorBundling,
  RDS_CA_ENV,
  rdsCaBundling,
  type WanthatEnv,
} from "./config";

export interface DataStackProps extends StackProps {
  readonly wanthatEnv: WanthatEnv;
  /** From NetworkStack — Aurora + the in-VPC migrator live here (ADR-0004/0006). */
  readonly vpc: ec2.IVpc;
  readonly auroraSg: ec2.ISecurityGroup;
  readonly lambdaSg: ec2.ISecurityGroup;
}

/**
 * DataStack — the data plane (ADR-0003, ADR-0005, ADR-0006).
 *
 * DynamoDB (on-demand) holds everything that isn't money: the landing projection
 * (`recommendationId → affiliate url + product`, `byOwner` GSI), `guest_attribution`, the runtime
 * `config` table, the `OpsCounters` table (exact operational counters, e.g. the customer
 * counter), and the `fx_rate` cache. The former auth working tables
 * (`auth_challenge`, `phone_velocity`, `passkey_credential`) died with the app-owned auth
 * ceremonies (ADR-0006: the browser talks to Cognito directly). Aurora Serverless v2
 * (scale-to-zero, IAM auth, no RDS Proxy) holds money only. A one-shot migrator Trigger runs the
 * schema after the cluster is created. PITR on all DynamoDB tables; a Secrets Manager placeholder
 * holds the retailer credential.
 */
export class DataStack extends Stack {
  readonly productTable: dynamodb.Table;
  readonly recommendationTable: dynamodb.Table;
  readonly guestAttributionTable: dynamodb.Table;
  readonly pollerStateTable: dynamodb.Table;
  readonly unattributedOrderTable: dynamodb.Table;
  readonly runtimeConfigTable: dynamodb.Table;
  /** Operational counters (exact entity totals), disjoint from config - see OpsCounters below. */
  readonly opsCountersTable: dynamodb.Table;
  readonly fxRateTable: dynamodb.Table;
  /** OTP sink for admin-visible codes — see the construct below. */
  readonly otpSinkTable: dynamodb.Table;
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

    // The shared retailer product (ADR-0003): fetched/minted once, reused across every member who
    // recommends it. Keyed by the store + its native product id; carries the product-level
    // affiliate URL (ADR-0008: ONE link.generate per product). Written by retailer-proxy
    // (ADR-0004), read by app-core's links module.
    this.productTable = new dynamodb.Table(this, "Product", {
      partitionKey: { name: "storeId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "storeProductId", type: dynamodb.AttributeType.STRING },
      ...common,
    });

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

    // Conversion-poll watermark + heartbeat state (ADR-0009), one item per retailer feed.
    this.pollerStateTable = new dynamodb.Table(this, "PollerState", {
      partitionKey: { name: "stateKey", type: dynamodb.AttributeType.STRING },
      ...common,
    });

    // Same-env orders the poller could not attribute (unattributed-cashback Phase 2): the admin
    // claim queue. The poller upserts sightings, admin-api claims/dismisses, retailer-proxy
    // settles claims through the conversion writer.
    this.unattributedOrderTable = new dynamodb.Table(this, "UnattributedOrder", {
      partitionKey: { name: "orderId", type: dynamodb.AttributeType.STRING },
      ...common,
    });
    // The admin list + the proxy's claimed-queue sweep, newest first.
    this.unattributedOrderTable.addGlobalSecondaryIndex({
      indexName: "byState",
      partitionKey: { name: "state", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "firstSeenAt", type: dynamodb.AttributeType.STRING },
    });

    // Admin-tunable runtime config (key-value), e.g. `landing.countdownSeconds` (ADR-0003).
    this.runtimeConfigTable = new dynamodb.Table(this, "RuntimeConfig", {
      partitionKey: { name: "configKey", type: dynamodb.AttributeType.STRING },
      ...common,
    });

    // Operational counters keyed by counterKey - e.g. the exact customerCounter item
    // (CustomerCounterRepo). A dedicated table so counter writes stay separable from the config
    // table above, whose single writer is the admin-console (refactor PR-5). Counters start at
    // zero, so no seed or migration is needed.
    this.opsCountersTable = new dynamodb.Table(this, "OpsCounters", {
      partitionKey: { name: "counterKey", type: dynamodb.AttributeType.STRING },
      ...common,
    });

    // FX rate cache keyed by `${base}#${quote}` (e.g. "USD#ILS"); see @wanthat/contracts ExchangeRate.
    this.fxRateTable = new dynamodb.Table(this, "FxRate", {
      partitionKey: { name: "pair", type: dynamodb.AttributeType.STRING },
      ...common,
    });

    // OTP sink (docs/otp-sink.md): message-sender parks EVERY code here before its delivery
    // attempt, and the admin activity feed lists current ones - a permanent feature in every
    // environment (it also keeps sign-in completable while the SMS sandbox blocks real prod
    // delivery). Items self-expire after 5 minutes, the OTP lifetime.
    // Construct id stays "DevOtpSink" (its historical name): changing it would REPLACE the
    // table and rewrite its cross-stack export while deployed consumers still import it —
    // the export-in-use deploy failure. Only code identifiers were renamed.
    this.otpSinkTable = new dynamodb.Table(this, "DevOtpSink", {
      partitionKey: { name: "phone", type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: "ttl",
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

    // --- One-shot service-role bootstrap (R1 as code; refactor 2026-07) ---
    // Runs AS MASTER before the migrator: create-if-missing the four service roles + rds_iam +
    // schema USAGE (packages/db runRoleBootstrap). wanthat_migrator has no CREATEROLE (0003), so
    // role creation is a master-only capability - exercised by exactly this one auditable,
    // deploy-time code path instead of a psql runbook (the psql equivalent stays in
    // infra/lib/README.md as disaster-recovery reference).
    // AUTH: IAM token as wanthat_master - NO password, NO Secrets Manager, NO interface
    // endpoint. 0003 made master a member of wanthat_migrator (which holds rds_iam), and RDS
    // routes any rds_iam member - even transitively - through IAM/PAM auth. That DISABLED
    // master password login cluster-wide (the first version of this function died on
    // "PAM authentication failed") and simultaneously enabled the same SigV4 path every other
    // in-VPC function uses.
    const roleBootstrapFn = makeServiceFunction(this, wanthatEnv, "role-bootstrap", {
      timeout: Duration.minutes(5), // waitForDb rides out a cold scale-to-zero resume
      vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      securityGroups: [lambdaSg],
      environment: {
        WANTHAT_ENV: wanthatEnv.name,
        DB_USER: "wanthat_master",
        DB_HOST: this.cluster.clusterEndpoint.hostname,
        DB_PORT: String(this.cluster.clusterEndpoint.port),
        DB_NAME: "wanthat",
        ...RDS_CA_ENV,
      },
      bundling: rdsCaBundling,
    });
    // IAM DB auth as the master user (see AUTH note above).
    this.cluster.grantConnect(roleBootstrapFn, "wanthat_master");
    const roleBootstrapTrigger = new Trigger(this, "RoleBootstrapTrigger", {
      handler: roleBootstrapFn,
      executeAfter: [this.cluster],
      timeout: Duration.minutes(5),
    });

    // --- One-shot migration runner (ADR-0012/0006) ---
    // A NodejsFunction (so esbuild bundles the TS handler + pg/kysely) wrapped by triggers.Trigger,
    // NOT triggers.TriggerFunction (which is a plain lambda.Function and would not bundle). Connects
    // as wanthat_migrator via IAM auth (0003) - no Secrets Manager read, so the VPC keeps no
    // secretsmanager interface endpoint. New-env bootstrap caveat: see 0003_migrator_role.sql.
    // The ObservabilityStack does NOT alarm this one-shot's errors (a failed migration surfaces via
    // the deploy itself, SERVICES["db-migrator"].alarms = false), but its logs/traces are still
    // retained for post-mortems.
    // No reserved concurrency: a one-shot Trigger invokes this once per deploy, so it runs in the
    // unreserved pool (reserving any concurrency needs account quota >= 21; see infra issues). The
    // app-api/admin reserved budget (7/2) is the Aurora connection ceiling; this migrator isn't part
    // of it. CDK's Trigger already serialises invocation, and migrations are transactional.
    const migratorFn = makeServiceFunction(this, wanthatEnv, "db-migrator", {
      timeout: Duration.minutes(5), // generous for a cold scale-to-zero resume
      vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      securityGroups: [lambdaSg],
      environment: {
        WANTHAT_ENV: wanthatEnv.name,
        DB_USER: "wanthat_migrator",
        DB_HOST: this.cluster.clusterEndpoint.hostname,
        DB_PORT: String(this.cluster.clusterEndpoint.port),
        DB_NAME: "wanthat",
        // Trust the Amazon RDS CA so the migrator's TLS connection to Aurora verifies (ADR-0006).
        ...RDS_CA_ENV,
        // Where the bundled .sql migrations live in the artifact (esbuild bundles only JS).
        ...MIGRATIONS_DIR_ENV,
      },
      // Ship the RDS CA bundle + the .sql migration files in the function artifact (see migratorBundling).
      bundling: migratorBundling,
    });
    // IAM DB auth as wanthat_migrator (ADR-0003 mechanics) - no master-secret read.
    this.cluster.grantConnect(migratorFn, "wanthat_migrator");

    new Trigger(this, "MigrateTrigger", {
      handler: migratorFn,
      // The bootstrap Trigger runs first: migration 0008 GRANTs on roles the bootstrap creates.
      executeAfter: [this.cluster, roleBootstrapTrigger],
      // Match the migrator's 5-min Lambda timeout. The Trigger's invocation timeout defaults to 2 min,
      // which would fail the deploy if a cold Aurora resume + migrations legitimately run past 2 min
      // even though the Lambda itself has 5 (the migrator now retries the connect via waitForDb).
      timeout: Duration.minutes(5),
    });

    // TRANSITIONAL — dropped in refactor PR-8. The deployed identity/whatsapp/admin templates
    // still import the deleted NotificationOutbox table's name/ARN/stream-ARN exports, and a
    // single-pass `cdk deploy --all` updates `data` BEFORE those consumers — dropping an in-use
    // export rolls the data deploy back ("cannot delete export ... in use"). An in-use export's
    // VALUE is as frozen as its existence, so each is retained with the exact literal it exported
    // while the table still existed (per env, captured from `aws cloudformation list-exports`);
    // nothing evaluates them once the consumers redeploy without the imports.
    const transitionalOutboxExports: Record<WanthatEnv["name"], Record<string, string>> = {
      dev: {
        ExportsOutputRefNotificationOutboxF565CEEECD77265C:
          "wanthat-dev-data-NotificationOutboxF565CEEE-1GNZZUSOICNR8",
        ExportsOutputFnGetAttNotificationOutboxF565CEEEArnCBE00B18:
          "arn:aws:dynamodb:il-central-1:818913587533:table/wanthat-dev-data-NotificationOutboxF565CEEE-1GNZZUSOICNR8",
        ExportsOutputFnGetAttNotificationOutboxF565CEEEStreamArnC0F9DACD:
          "arn:aws:dynamodb:il-central-1:818913587533:table/wanthat-dev-data-NotificationOutboxF565CEEE-1GNZZUSOICNR8/stream/2026-07-02T12:19:59.304",
      },
      prod: {
        ExportsOutputRefNotificationOutboxF565CEEECD77265C:
          "wanthat-prod-data-NotificationOutboxF565CEEE-1TX16YFE2O9B6",
        ExportsOutputFnGetAttNotificationOutboxF565CEEEArnCBE00B18:
          "arn:aws:dynamodb:il-central-1:818913587533:table/wanthat-prod-data-NotificationOutboxF565CEEE-1TX16YFE2O9B6",
        ExportsOutputFnGetAttNotificationOutboxF565CEEEStreamArnC0F9DACD:
          "arn:aws:dynamodb:il-central-1:818913587533:table/wanthat-prod-data-NotificationOutboxF565CEEE-1TX16YFE2O9B6/stream/2026-07-07T00:17:22.467",
      },
    };
    for (const [output, value] of Object.entries(transitionalOutboxExports[wanthatEnv.name])) {
      this.exportValue(value, { name: `wanthat-${wanthatEnv.name}-data:${output}` });
    }
  }
}
