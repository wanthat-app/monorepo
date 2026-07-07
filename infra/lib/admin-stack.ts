import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import { CorsHttpMethod, HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type * as cognito from "aws-cdk-lib/aws-cognito";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as ec2 from "aws-cdk-lib/aws-ec2";
import { SubnetType } from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import type * as rds from "aws-cdk-lib/aws-rds";
import type * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import {
  applyThrottle,
  LAMBDA_ARCHITECTURE,
  LAMBDA_RUNTIME,
  RDS_CA_ENV,
  rdsCaBundling,
  serviceEntry,
  serviceLogGroup,
  THROTTLING,
  type WanthatEnv,
  webOrigins,
} from "./config";

export interface AdminStackProps extends StackProps {
  readonly wanthatEnv: WanthatEnv;
  // Employee/admin pool, not the customer pool (ADR-0020 §two-pool): a customer token structurally
  // can't satisfy this authorizer, so it can't reach /admin. The in-handler `admin` group check stays
  // as defence-in-depth.
  readonly employeePool: cognito.IUserPool;
  readonly employeePoolClient: cognito.IUserPoolClient;
  // CUSTOMER pool (the members) - the users page deletes customer accounts from it. Only the
  // non-VPC credentials function touches it (cognito-idp is unreachable from the VPC, ADR-0004).
  readonly customerPool: cognito.IUserPool;
  readonly runtimeConfigTable: dynamodb.ITable;
  readonly recommendationTable: dynamodb.ITable;
  // Dev OTP sink (docs/dev-otp-sink.md) - the activity page lists parked codes in dev. Absent in
  // prod by design (the table is not provisioned there), so prod gets no env var and no grant:
  // the otp_sent feed item type structurally cannot appear in prod.
  readonly devOtpSinkTable?: dynamodb.ITable;
  // Retailer credential secret — admin-api may WRITE it (credential drop from the admin panel)
  // but never read it; retailer-proxy stays the sole reader (see the inline policy below).
  readonly retailerSecret: secretsmanager.ISecret;
  readonly vpc: ec2.IVpc;
  readonly lambdaSg: ec2.ISecurityGroup;
  readonly cluster: rds.IDatabaseCluster;
}

/**
 * AdminStack — the admin API as a separate in-VPC Lambda with its own role and exposure (ADR-0002,
 * ADR-0020). Behind its own HTTP API + JWT authorizer; the admin-group check is re-enforced
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

  constructor(scope: Construct, id: string, props: AdminStackProps) {
    super(scope, id, props);
    const { wanthatEnv } = props;

    const fn = new NodejsFunction(this, "AdminApi", {
      functionName: `wanthat-${wanthatEnv.name}-admin-api`,
      entry: serviceEntry("admin-api"),
      handler: "handler",
      runtime: LAMBDA_RUNTIME,
      architecture: LAMBDA_ARCHITECTURE,
      memorySize: 256,
      timeout: Duration.seconds(30), // in-VPC Aurora: first connect may resume a scale-to-zero cluster
      // X-Ray tracing + an explicit retention-bounded log group (ADR-0002 observability).
      tracing: lambda.Tracing.ACTIVE,
      logGroup: serviceLogGroup(this, "AdminApiLogs", wanthatEnv),
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.lambdaSg],
      // No reserved concurrency: the account's Lambda concurrency limit (10) is the cap; admin traffic
      // is tiny. Re-introduce app 7 / admin 2 / migrator 1 once the account quota is raised (ADR-0002).
      environment: {
        WANTHAT_ENV: wanthatEnv.name,
        RUNTIME_CONFIG_TABLE: props.runtimeConfigTable.tableName,
        RECOMMENDATION_TABLE: props.recommendationTable.tableName,
        ...(props.devOtpSinkTable
          ? { DEV_OTP_SINK_TABLE: props.devOtpSinkTable.tableName }
          : {}),
        DB_HOST: props.cluster.clusterEndpoint.hostname,
        DB_NAME: "wanthat",
        DB_USER: "app_ro",
        // Trust the Amazon RDS CA so the in-VPC TLS connection to Aurora verifies (ADR-0020) — the
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
    props.recommendationTable.grantReadData(fn);
    // Dev-only: the activity feed scans the parked OTP codes (read-only; table absent in prod).
    props.devOtpSinkTable?.grantReadData(fn);

    // The retailer-credential drop runs as a separate NON-VPC function: Secrets Manager is only
    // reachable over its public endpoint, and the VPC is deliberately endpoint-free (ADR-0004;
    // the SM interface endpoint was removed once nothing in the VPC read secrets). Same HTTP API
    // and authorizer; only this function's role can touch the secret - and only write it.
    const credentialsFn = new NodejsFunction(this, "AdminCredentials", {
      functionName: `wanthat-${wanthatEnv.name}-admin-credentials`,
      entry: serviceEntry("admin-credentials"),
      handler: "handler",
      runtime: LAMBDA_RUNTIME,
      architecture: LAMBDA_ARCHITECTURE,
      memorySize: 256,
      timeout: Duration.seconds(10),
      tracing: lambda.Tracing.ACTIVE,
      logGroup: serviceLogGroup(this, "AdminCredentialsLogs", wanthatEnv),
      environment: {
        WANTHAT_ENV: wanthatEnv.name,
        RETAILER_SECRET_ARN: props.retailerSecret.secretArn,
        CUSTOMER_USER_POOL_ID: props.customerPool.userPoolId,
      },
    });
    this.adminCredentialsFn = credentialsFn;
    // Customer-account removal for the users page (AdminDeleteUser only - the admin surface can
    // delete a member's sign-in but never read or alter one).
    credentialsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cognito-idp:AdminDeleteUser"],
        resources: [props.customerPool.userPoolArn],
      }),
    );
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
    // Cognito cleanup for the users page - also the non-VPC function (cognito-idp is unreachable
    // from the VPC). Exact path beats the catch-all; /admin/users itself stays on admin-api.
    this.httpApi.addRoutes({
      path: "/admin/users/cognito-delete",
      methods: [HttpMethod.POST],
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
