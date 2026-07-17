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
  makeServiceFunction,
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
  // in it (ADR-0006: Cognito is the customer store). Only the non-VPC credentials function
  // touches it (cognito-idp is unreachable from the VPC, ADR-0004).
  readonly customerPool: cognito.IUserPool;
  readonly runtimeConfigTable: dynamodb.ITable;
  // Exact operational counters (customerCounter): admin-api READS the dashboard figures;
  // admin-credentials WRITES the moderation moves (decrement / suspend / lift).
  readonly opsCountersTable: dynamodb.ITable;
  /** Cached FX rates: the money KPIs' display-only ILS estimate (ADR-0017). */
  readonly fxRateTable: dynamodb.ITable;
  readonly unattributedOrderTable: dynamodb.ITable;
  readonly productTable: dynamodb.ITable;
  readonly recommendationTable: dynamodb.ITable;
  // OTP sink (docs/otp-sink.md) - the activity page lists every parked code (5-minute TTL);
  // message-sender parks each OTP before delivering, in every environment.
  readonly otpSinkTable: dynamodb.ITable;
  // Retailer credential secret — admin-api may WRITE it (credential drop from the admin panel)
  // but never read it; retailer-proxy stays the sole reader (see the inline policy below).
  readonly retailerSecret: secretsmanager.ISecret;
  readonly vpc: ec2.IVpc;
  readonly lambdaSg: ec2.ISecurityGroup;
  readonly cluster: rds.IDatabaseCluster;
}

/**
 * AdminStack — the admin API as a separate in-VPC Lambda with its own role and exposure (ADR-0002,
 * ADR-0006). Behind its own HTTP API + JWT authorizer; the admin-group check is re-enforced
 * in-handler. Reaches Aurora as `app_ro`; the users page's guarded hard delete goes through the
 * admin_delete_customer SECURITY DEFINER function (0004) - the one mutation exposed to app_ro,
 * with tables staying read-only. Writes the runtime `config` table (the admin panel). `/healthz`
 * is the only unauthenticated route (deploy probe).
 */
export class AdminStack extends Stack {
  readonly httpApi: HttpApi;
  /** The admin-api Lambda — observed by the ObservabilityStack (errors/throttles/duration). */
  readonly adminApiFn: lambda.Function;
  /** The non-VPC credential-drop Lambda — observed by the ObservabilityStack. */
  readonly adminCredentialsFn: lambda.Function;
  /** The in-VPC audit-writer Lambda (refactor PR-3) — observed by the ObservabilityStack. */
  readonly auditWriterFn: lambda.Function;

  constructor(scope: Construct, id: string, props: AdminStackProps) {
    super(scope, id, props);
    const { wanthatEnv } = props;

    // No reserved concurrency: the account's Lambda concurrency limit (10) is the cap; admin traffic
    // is tiny. Re-introduce app 7 / admin 2 / migrator 1 once the account quota is raised (ADR-0002).
    const fn = makeServiceFunction(this, wanthatEnv, "admin-api", {
      timeout: Duration.seconds(30), // in-VPC Aurora: first connect may resume a scale-to-zero cluster
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.lambdaSg],
      environment: {
        WANTHAT_ENV: wanthatEnv.name,
        RUNTIME_CONFIG_TABLE: props.runtimeConfigTable.tableName,
        // The exact customer counter (customerCounter in OpsCounters) - dashboard stats reads.
        OPS_COUNTERS_TABLE: props.opsCountersTable.tableName,
        // Cached FX rate for the money KPIs' display-only ILS estimate (ADR-0017).
        FX_RATE_TABLE: props.fxRateTable.tableName,
        UNATTRIBUTED_ORDER_TABLE: props.unattributedOrderTable.tableName,
        PRODUCT_TABLE: props.productTable.tableName,
        RECOMMENDATION_TABLE: props.recommendationTable.tableName,
        OTP_SINK_TABLE: props.otpSinkTable.tableName,
        DB_HOST: props.cluster.clusterEndpoint.hostname,
        DB_NAME: "wanthat",
        DB_USER: "app_ro",
        // Trust the Amazon RDS CA so the in-VPC TLS connection to Aurora verifies (ADR-0006) — the
        // same setup app-core/app-auth use. Without it pg throws "unable to get local issuer
        // certificate" and every DB-backed admin route (stats) fails. Pairs with rdsCaBundling below.
        ...RDS_CA_ENV,
      },
      // Ships the RDS CA bundle into the artifact so NODE_EXTRA_CA_CERTS above can point at it.
      bundling: rdsCaBundling,
    });
    this.adminApiFn = fn;

    // Read-only Aurora as app_ro (ADR-0002; mutations only via the 0004 SECURITY DEFINER
    // function) + the config table it writes.
    props.cluster.grantConnect(fn, "app_ro");
    props.runtimeConfigTable.grantReadWriteData(fn);
    // Stats reads (the transactional counters live in these tables).
    props.opsCountersTable.grantReadData(fn);
    props.fxRateTable.grantReadData(fn);
    // The claim queue: list + claim/dismiss intents (the retailer-proxy settles them).
    props.unattributedOrderTable.grantReadWriteData(fn);
    props.productTable.grantReadData(fn);
    props.recommendationTable.grantReadData(fn);
    // The activity feed scans the parked OTP codes (read-only); member signups arrive as
    // user_registered audit rows (post-confirmation -> audit-writer), read via Aurora.
    props.otpSinkTable.grantReadData(fn);

    // The audit-writer (refactor PR-3): the ONE generic append path into the hash-chained
    // audit_log. In-VPC (it is an Aurora writer, ADR-0004) as the `audit_writer` role, whose
    // sole capability is EXECUTE on audit_append (migration 0008; the role itself is created
    // out-of-band by runbook R1 — see lib/README.md — which must run in an env BEFORE this
    // deploys there). Invoked directly with a typed AuditWriteRequest payload; post-confirmation
    // async-invokes it for user_registered (PR-4), the admin-console caller arrives in PR-5.
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

    // The retailer-credential drop runs as a separate NON-VPC function: Secrets Manager is only
    // reachable over its public endpoint, and the VPC is deliberately endpoint-free (ADR-0004;
    // the SM interface endpoint was removed once nothing in the VPC read secrets). Same HTTP API
    // and authorizer; only this function's role can touch the secret - and only write it.
    const credentialsFn = makeServiceFunction(this, wanthatEnv, "admin-credentials", {
      timeout: Duration.seconds(10),
      environment: {
        WANTHAT_ENV: wanthatEnv.name,
        RETAILER_SECRET_ARN: props.retailerSecret.secretArn,
        CUSTOMER_USER_POOL_ID: props.customerPool.userPoolId,
        // User erasure also deletes the member's DynamoDB recommendations (ADR-0006 decision 8).
        RECOMMENDATION_TABLE: props.recommendationTable.tableName,
        // The exact customer counter - the customerCounter item in the dedicated OpsCounters
        // table: cognito-delete decrements the total, suspend/lift move the disabled count.
        OPS_COUNTERS_TABLE: props.opsCountersTable.tableName,
      },
    });
    this.adminCredentialsFn = credentialsFn;
    // Customer-pool user management for the users page (ADR-0006 decision 8): list/search via
    // ListUsers, approximate totals via DescribeUserPool, suspend/lift/kick via
    // AdminDisableUser / AdminEnableUser / AdminUserGlobalSignOut, erasure via AdminGetUser (sub
    // resolution for the recommendation cleanup) + AdminDeleteUser. Lifecycle-only on purpose:
    // no attribute writes, no token reads.
    credentialsFn.addToRolePolicy(
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
    // deleteByOwner pages the byOwner GSI and pairs each delete with the counter decrement -
    // read + write on the table and its indexes.
    props.recommendationTable.grantReadWriteData(credentialsFn);
    // Write-only on OpsCounters: the customer-counter moves are UpdateItems on the counter item.
    // Deliberately NO grant on the config table - admin-api stays its single writer.
    props.opsCountersTable.grantWriteData(credentialsFn);
    // WRITE-ONLY grant on the retailer credential secret: PutSecretValue (replace the value) +
    // DescribeSecret (non-secret status metadata). Deliberately not grantWrite (adds UpdateSecret)
    // and no GetSecretValue - the admin role structurally cannot read the credential back.
    credentialsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["secretsmanager:PutSecretValue", "secretsmanager:DescribeSecret"],
        resources: [props.retailerSecret.secretArn],
      }),
    );

    const integration = new HttpLambdaIntegration("AdminApiIntegration", fn);
    const authorizer = new HttpJwtAuthorizer(
      "CognitoAuthorizer",
      `https://cognito-idp.${this.region}.amazonaws.com/${props.employeePool.userPoolId}`,
      { jwtAudience: [props.employeePoolClient.userPoolClientId] },
    );

    // CORS so the admin SPA (a different origin than execute-api) can call /admin/*. Without it the
    // preflight OPTIONS is rejected 401 by the authorizer and the console's data calls never fire.
    // API Gateway answers OPTIONS itself once this is set. Origins shared with config.webOrigins.
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

    // Unauthenticated liveness probe; everything else behind the JWT authorizer (+ in-handler group).
    this.httpApi.addRoutes({ path: "/healthz", methods: [HttpMethod.GET], integration });
    // /admin/retailer/* → the non-VPC credentials function. HTTP APIs route by specificity, so
    // this greedy path beats the catch-all below for credential calls; same authorizer.
    const credentialsIntegration = new HttpLambdaIntegration(
      "AdminCredentialsIntegration",
      credentialsFn,
    );
    this.httpApi.addRoutes({
      path: "/admin/retailer/{proxy+}",
      methods: [HttpMethod.GET, HttpMethod.PUT],
      integration: credentialsIntegration,
      authorizer,
    });
    // The users surface is Cognito-backed (ADR-0006), so it is served by the non-VPC function:
    // list/search (GET /admin/users), ban tooling (disable / enable / global-signout), and the
    // account cleanup (cognito-delete). Exact paths beat the catch-all; the Aurora-side
    // DELETE /admin/users/{id} stays on admin-api until T7 drops the customer table.
    this.httpApi.addRoutes({
      path: "/admin/users",
      methods: [HttpMethod.GET],
      integration: credentialsIntegration,
      authorizer,
    });
    for (const action of ["disable", "enable", "global-signout", "cognito-delete"]) {
      this.httpApi.addRoutes({
        path: `/admin/users/${action}`,
        methods: [HttpMethod.POST],
        integration: credentialsIntegration,
        authorizer,
      });
    }
    // One member by sub (the user detail page's identity) — Cognito, so the non-VPC function.
    // Single-segment param: /admin/users/{sub}/recommendations|wallet still fall to the
    // catch-all below (admin-api), which serves the detail page's data tabs.
    this.httpApi.addRoutes({
      path: "/admin/users/{sub}",
      methods: [HttpMethod.GET],
      integration: credentialsIntegration,
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
      integration,
      authorizer,
    });

    new CfnOutput(this, "AdminApiUrl", { value: this.httpApi.apiEndpoint });
  }
}
