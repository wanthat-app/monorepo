import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import { CorsHttpMethod, HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type * as cognito from "aws-cdk-lib/aws-cognito";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as ec2 from "aws-cdk-lib/aws-ec2";
import { SubnetType } from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import type * as rds from "aws-cdk-lib/aws-rds";
import type * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import {
  applyThrottle,
  functionArnFor,
  makeServiceFunction,
  physicalName,
  RDS_CA_ENV,
  rdsCaBundling,
  THROTTLING,
  type WanthatEnv,
  webOrigins,
} from "./config";

export interface AdminStackProps extends StackProps {
  readonly wanthatEnv: WanthatEnv;
  // Employee/admin pool, not the customer pool (ADR-0006 §two-pool): a customer token structurally
  // can't satisfy this authorizer, so it can't reach /admin. The in-handler `admin` group check stays
  // as defence-in-depth.
  readonly employeePool: cognito.IUserPool;
  readonly employeePoolClient: cognito.IUserPoolClient;
  // CUSTOMER pool (the members) - the users page lists, moderates, and deletes customer accounts
  // in it (ADR-0006: Cognito is the customer store). Only the non-VPC console touches it
  // (cognito-idp is unreachable from the VPC, ADR-0004).
  readonly customerPool: cognito.IUserPool;
  readonly runtimeConfigTable: dynamodb.ITable;
  // Exact operational counters (customerCounter + daily/presence metrics): the console READS the
  // dashboard figures AND WRITES the moderation moves (decrement / suspend / lift).
  readonly opsCountersTable: dynamodb.ITable;
  /** Cached FX rates (read-only). */
  readonly fxRateTable: dynamodb.ITable;
  readonly unattributedOrderTable: dynamodb.ITable;
  readonly productTable: dynamodb.ITable;
  readonly recommendationTable: dynamodb.ITable;
  // OTP sink (docs/otp-sink.md) - GET /admin/otp-sink lists every parked code (5-minute TTL);
  // message-sender parks each OTP before delivering, in every environment.
  readonly otpSinkTable: dynamodb.ITable;
  // Retailer credential secret — the console may WRITE it (credential drop from the admin panel)
  // but never read it; retailer-proxy stays the sole reader (see the inline policy below).
  readonly retailerSecret: secretsmanager.ISecret;
  readonly vpc: ec2.IVpc;
  readonly lambdaSg: ec2.ISecurityGroup;
  readonly cluster: rds.IDatabaseCluster;
}

/**
 * AdminStack — the admin surface regrouped by actions-vs-record-reads (refactor PR-5, on the
 * ADR-0002/0006 seams):
 *
 * - **admin-console** (non-VPC): ALL admin actions + ALL Dynamo-backed views — Cognito user
 *   management, the write-only retailer-credential drop, runtime config (sole writer), Dynamo
 *   stats/queues/OTP sink, and synchronous invokes of audit-writer (audit-or-fail on config +
 *   moderation) and fx-rates (on-demand refresh). Non-VPC because Secrets Manager, cognito-idp
 *   and the Lambda Invoke API are public-endpoint-only (ADR-0004 endpoint-free VPC).
 * - **admin-ledger-view** (in-VPC): ONLY the Aurora reads — money stats, the audit activity
 *   feed, the user wallet tab — as `ledger_reader` (SELECT on wallet_entry + audit_log, 0008).
 * - **audit-writer** (in-VPC): the ONE generic append path into the hash-chained audit_log.
 *
 * One HTTP API + JWT authorizer fronts both route sets; the admin-group check is re-enforced
 * in-handler. `/healthz` (console) is the only unauthenticated route (deploy probe).
 */
export class AdminStack extends Stack {
  readonly httpApi: HttpApi;
  /** The non-VPC actions/views Lambda — observed by the ObservabilityStack. */
  readonly adminConsoleFn: lambda.Function;
  /** The in-VPC Aurora-reads Lambda (ledger_reader) — observed by the ObservabilityStack. */
  readonly adminLedgerViewFn: lambda.Function;
  /** The in-VPC audit-writer Lambda (refactor PR-3) — observed by the ObservabilityStack. */
  readonly auditWriterFn: lambda.Function;

  constructor(scope: Construct, id: string, props: AdminStackProps) {
    super(scope, id, props);
    const { wanthatEnv } = props;

    // The audit-writer (refactor PR-3): the ONE generic append path into the hash-chained
    // audit_log. In-VPC (it is an Aurora writer, ADR-0004) as the `audit_writer` role, whose
    // sole capability is EXECUTE on audit_append (migration 0008; the role itself is created
    // by the DataStack role-bootstrap Trigger). Invoked directly with a typed AuditWriteRequest
    // payload; post-confirmation async-invokes it for user_registered (PR-4), and the console
    // below SYNC-invokes it for config + moderation events (PR-5, audit-or-fail).
    const auditWriterFn = makeServiceFunction(this, wanthatEnv, "audit-writer", {
      timeout: Duration.seconds(30), // in-VPC Aurora: first connect may resume a scale-to-zero cluster
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.lambdaSg],
      environment: {
        WANTHAT_ENV: wanthatEnv.name,
        DB_HOST: props.cluster.clusterEndpoint.hostname,
        DB_NAME: "wanthat",
        DB_USER: "audit_writer",
        // Trust the Amazon RDS CA so the in-VPC TLS connection to Aurora verifies (ADR-0006).
        ...RDS_CA_ENV,
      },
      // Ships the RDS CA bundle into the artifact so NODE_EXTRA_CA_CERTS above can point at it.
      bundling: rdsCaBundling,
    });
    this.auditWriterFn = auditWriterFn;
    props.cluster.grantConnect(auditWriterFn, "audit_writer");

    // --- admin-console: ALL admin actions + ALL Dynamo-backed views (non-VPC) ---
    const consoleFn = makeServiceFunction(this, wanthatEnv, "admin-console", {
      timeout: Duration.seconds(10),
      environment: {
        WANTHAT_ENV: wanthatEnv.name,
        RETAILER_SECRET_ARN: props.retailerSecret.secretArn,
        CUSTOMER_USER_POOL_ID: props.customerPool.userPoolId,
        RUNTIME_CONFIG_TABLE: props.runtimeConfigTable.tableName,
        // The exact customer counter + daily/presence metrics (OpsCounters): dashboard stats
        // reads AND the moderation moves (decrement / suspend / lift).
        OPS_COUNTERS_TABLE: props.opsCountersTable.tableName,
        UNATTRIBUTED_ORDER_TABLE: props.unattributedOrderTable.tableName,
        PRODUCT_TABLE: props.productTable.tableName,
        // User erasure deletes the member's recommendations (ADR-0006 decision 8); the detail
        // page's recommendations tab reads the byOwner GSI.
        RECOMMENDATION_TABLE: props.recommendationTable.tableName,
        OTP_SINK_TABLE: props.otpSinkTable.tableName,
        // Invoke targets by deterministic physical name — no cross-stack refs (ADR-0004).
        AUDIT_WRITER_FUNCTION: physicalName(wanthatEnv, "audit-writer"),
        FX_RATES_FUNCTION: physicalName(wanthatEnv, "fx-rates"),
      },
    });
    this.adminConsoleFn = consoleFn;

    // Customer-pool user management for the users page (ADR-0006 decision 8): list/search via
    // ListUsers, approximate totals via DescribeUserPool, suspend/lift/kick via
    // AdminDisableUser / AdminEnableUser / AdminUserGlobalSignOut, erasure via AdminGetUser (sub
    // resolution for the recommendation cleanup + audit events) + AdminDeleteUser.
    // Lifecycle-only on purpose: no attribute writes, no token reads.
    consoleFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "cognito-idp:AdminDeleteUser",
          "cognito-idp:AdminDisableUser",
          "cognito-idp:AdminEnableUser",
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminUserGlobalSignOut",
          "cognito-idp:DescribeUserPool",
          "cognito-idp:ListUsers",
        ],
        resources: [props.customerPool.userPoolArn],
      }),
    );
    // WRITE-ONLY grant on the retailer credential secret: PutSecretValue (replace the value) +
    // DescribeSecret (non-secret status metadata). Deliberately not grantWrite (adds UpdateSecret)
    // and no GetSecretValue - the admin role structurally cannot read the credential back.
    consoleFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["secretsmanager:PutSecretValue", "secretsmanager:DescribeSecret"],
        resources: [props.retailerSecret.secretArn],
      }),
    );
    // Runtime config: the console is the config table's SOLE writer (the admin panel).
    props.runtimeConfigTable.grantReadWriteData(consoleFn);
    // OpsCounters: stats reads (customerCounter + daily/presence metrics) AND the moderation
    // counter moves (UpdateItems on the counter item).
    props.opsCountersTable.grantReadWriteData(consoleFn);
    // The claim queue: list + claim/dismiss intents (the retailer-proxy settles them).
    props.unattributedOrderTable.grantReadWriteData(consoleFn);
    // Stats reads (the transactional counters live in these tables).
    props.productTable.grantReadData(consoleFn);
    props.fxRateTable.grantReadData(consoleFn);
    // GET /admin/otp-sink lists the parked codes (read-only).
    props.otpSinkTable.grantReadData(consoleFn);
    // Recommendation: NARROWED write grant (decided, PR-5). deleteByOwner's erasure runs one
    // TransactWrite per recommendation: Delete on the rec item + Update on the "#counter"
    // sentinel (RECOMMENDATION_COUNTER_PK, packages/dynamo/src/recommendation.ts). So beyond
    // reads the console gets exactly DeleteItem (any key) and UpdateItem CONDITIONED to the
    // counter partition key — and NO PutItem: the console can erase a member's recommendations
    // but can never rewrite or forge one.
    props.recommendationTable.grantReadData(consoleFn);
    consoleFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:DeleteItem"],
        resources: [props.recommendationTable.tableArn],
      }),
    );
    consoleFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:UpdateItem"],
        resources: [props.recommendationTable.tableArn],
        conditions: {
          "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["#counter"] },
        },
      }),
    );
    // Invoke grants: audit-writer is same-stack (direct grant); fx-rates lives in the
    // edge-services stack, so the grant goes on its deterministic ARN (deploy-order
    // independent, ADR-0004 — same pattern as post-confirmation -> audit-writer).
    auditWriterFn.grantInvoke(consoleFn);
    consoleFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [functionArnFor(this, wanthatEnv, "fx-rates")],
      }),
    );

    // --- admin-ledger-view: ONLY the Aurora reads (in-VPC, ledger_reader) ---
    // No reserved concurrency: the account's Lambda concurrency limit (10) is the cap; admin
    // traffic is tiny. Re-introduce a reserved budget once the account quota is raised (ADR-0002).
    const ledgerViewFn = makeServiceFunction(this, wanthatEnv, "admin-ledger-view", {
      timeout: Duration.seconds(30), // in-VPC Aurora: first connect may resume a scale-to-zero cluster
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.lambdaSg],
      environment: {
        WANTHAT_ENV: wanthatEnv.name,
        RUNTIME_CONFIG_TABLE: props.runtimeConfigTable.tableName,
        // Cached FX rate for the money KPIs' display-only ILS estimate (ADR-0017).
        FX_RATE_TABLE: props.fxRateTable.tableName,
        DB_HOST: props.cluster.clusterEndpoint.hostname,
        DB_NAME: "wanthat",
        DB_USER: "ledger_reader",
        // Trust the Amazon RDS CA so the in-VPC TLS connection to Aurora verifies (ADR-0006).
        ...RDS_CA_ENV,
      },
      // Ships the RDS CA bundle into the artifact so NODE_EXTRA_CA_CERTS above can point at it.
      bundling: rdsCaBundling,
    });
    this.adminLedgerViewFn = ledgerViewFn;
    // Aurora as ledger_reader (0008): SELECT on wallet_entry + audit_log, nothing else — the
    // ledger view is a pure record reader by DB grant, not just by code.
    props.cluster.grantConnect(ledgerViewFn, "ledger_reader");
    // Read-only DynamoDB: the FX cache + the commission config key.
    props.fxRateTable.grantReadData(ledgerViewFn);
    props.runtimeConfigTable.grantReadData(ledgerViewFn);

    const authorizer = new HttpJwtAuthorizer(
      "CognitoAuthorizer",
      `https://cognito-idp.${this.region}.amazonaws.com/${props.employeePool.userPoolId}`,
      { jwtAudience: [props.employeePoolClient.userPoolClientId] },
    );

    // CORS so the admin SPA (a different origin than execute-api) can call /admin/*. Without it the
    // preflight OPTIONS is rejected 401 by the authorizer and the console's data calls never fire.
    // API Gateway answers OPTIONS itself once this is set. Origins shared with config.webOrigins.
    // allowMethods MUST cover every method in use (GET/PUT/POST/DELETE today) — a new method
    // without a matching entry fails browser-only with zero server-side evidence.
    this.httpApi = new HttpApi(this, "HttpApi", {
      apiName: `wanthat-${wanthatEnv.name}-admin`,
      corsPreflight: {
        allowOrigins: webOrigins(wanthatEnv),
        allowMethods: [
          CorsHttpMethod.GET,
          CorsHttpMethod.PUT,
          CorsHttpMethod.POST,
          CorsHttpMethod.DELETE,
        ],
        allowHeaders: ["content-type", "authorization"],
        maxAge: Duration.hours(1),
      },
    });
    // Per-surface request throttling — tuned centrally in config.ts (THROTTLING).
    applyThrottle(this.httpApi, THROTTLING.admin);

    const consoleIntegration = new HttpLambdaIntegration("AdminConsoleIntegration", consoleFn);
    const ledgerViewIntegration = new HttpLambdaIntegration(
      "AdminLedgerViewIntegration",
      ledgerViewFn,
    );

    // Unauthenticated liveness probe (the console — the ONE public probe of the admin surface;
    // ledger-view keeps only the authenticated /admin/health below). Everything else sits
    // behind the JWT authorizer (+ the in-handler group check).
    this.httpApi.addRoutes({
      path: "/healthz",
      methods: [HttpMethod.GET],
      integration: consoleIntegration,
    });

    // The FOUR ledger-view paths — the only routes on the in-VPC reader. HTTP APIs route by
    // specificity, so /admin/users/{sub}/wallet beats the console catch-all below.
    for (const path of [
      "/admin/stats/money",
      "/admin/activity",
      "/admin/users/{sub}/wallet",
      "/admin/health",
    ]) {
      this.httpApi.addRoutes({
        path,
        methods: [HttpMethod.GET],
        integration: ledgerViewIntegration,
        authorizer,
      });
    }

    // The console's explicit routes. /admin/retailer/* is the write-only credential drop; the
    // users surface is Cognito-backed (ADR-0006): list/search, ban tooling, account cleanup,
    // one-member-by-sub; /admin/otp-sink lists the parked codes; /admin/fx-rates/refresh
    // sync-runs the FX updater. Everything else (config, Dynamo stats, the unattributed queue,
    // the recommendations tab, the 410 delete stub) reaches the console via the catch-all.
    this.httpApi.addRoutes({
      path: "/admin/retailer/{proxy+}",
      methods: [HttpMethod.GET, HttpMethod.PUT],
      integration: consoleIntegration,
      authorizer,
    });
    this.httpApi.addRoutes({
      path: "/admin/users",
      methods: [HttpMethod.GET],
      integration: consoleIntegration,
      authorizer,
    });
    for (const action of ["disable", "enable", "global-signout", "cognito-delete"]) {
      this.httpApi.addRoutes({
        path: `/admin/users/${action}`,
        methods: [HttpMethod.POST],
        integration: consoleIntegration,
        authorizer,
      });
    }
    // One member by sub (the user detail page's identity). Single-segment param:
    // /admin/users/{sub}/wallet still routes to ledger-view above (more specific), and
    // /admin/users/{sub}/recommendations falls to the catch-all (console).
    this.httpApi.addRoutes({
      path: "/admin/users/{sub}",
      methods: [HttpMethod.GET],
      integration: consoleIntegration,
      authorizer,
    });
    this.httpApi.addRoutes({
      path: "/admin/otp-sink",
      methods: [HttpMethod.GET],
      integration: consoleIntegration,
      authorizer,
    });
    this.httpApi.addRoutes({
      path: "/admin/fx-rates/refresh",
      methods: [HttpMethod.POST],
      integration: consoleIntegration,
      authorizer,
    });
    // Explicit methods (NOT ANY) so `OPTIONS` has no matching route and falls through to API
    // Gateway's built-in CORS preflight handler instead of being 401'd by the authorizer.
    this.httpApi.addRoutes({
      path: "/{proxy+}",
      methods: [
        HttpMethod.GET,
        HttpMethod.POST,
        HttpMethod.PUT,
        HttpMethod.PATCH,
        HttpMethod.DELETE,
      ],
      integration: consoleIntegration,
      authorizer,
    });

    new CfnOutput(this, "AdminApiUrl", { value: this.httpApi.apiEndpoint });

    // TRANSITIONAL — dropped in refactor PR-8. The deployed observability template still imports
    // the old AdminApi/AdminCredentials function-Ref exports (its alarms watched the functions
    // this PR replaces), and a single-pass `cdk deploy --all` updates `admin` BEFORE
    // `observability` — dropping an in-use export rolls the deploy back ("cannot delete export
    // ... in use"). The values are the old functions' PHYSICAL NAMES (deterministic
    // `wanthat-{env}-admin-api` / `wanthat-{env}-admin-credentials`), frozen as per-env literals
    // captured from `aws cloudformation list-exports` (2026-07-17); nothing evaluates them once
    // observability redeploys without the imports.
    const transitionalAdminExports: Record<WanthatEnv["name"], Record<string, string>> = {
      dev: {
        ExportsOutputRefAdminApi059A0912DCBEE105: "wanthat-dev-admin-api",
        ExportsOutputRefAdminCredentialsCD1C0A3A329B9BC2: "wanthat-dev-admin-credentials",
      },
      prod: {
        ExportsOutputRefAdminApi059A0912DCBEE105: "wanthat-prod-admin-api",
        ExportsOutputRefAdminCredentialsCD1C0A3A329B9BC2: "wanthat-prod-admin-credentials",
      },
    };
    for (const [output, value] of Object.entries(transitionalAdminExports[wanthatEnv.name])) {
      this.exportValue(value, { name: `wanthat-${wanthatEnv.name}-admin:${output}` });
    }
  }
}
