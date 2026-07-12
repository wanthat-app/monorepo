import { ArnFormat, CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
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

/** The deployed SPA origin for links we send out (ADR-0019). Synth fails loudly on an env without a domain. */
function appUrl(wanthatEnv: WanthatEnv): string {
  if (!wanthatEnv.domainName) throw new Error(`appUrl: env ${wanthatEnv.name} has no domainName`);
  return `https://${wanthatEnv.domainName}`;
}

export interface ApiStackProps extends StackProps {
  readonly wanthatEnv: WanthatEnv;
  readonly userPool: cognito.IUserPool;
  readonly userPoolClient: cognito.IUserPoolClient;
  readonly productTable: dynamodb.ITable;
  readonly recommendationTable: dynamodb.ITable;
  readonly fxRateTable: dynamodb.ITable;
  readonly runtimeConfigTable: dynamodb.ITable;
  /** Dashboard metrics: daily counters + presence stamps (see packages/dynamo ops-metrics). */
  readonly opsCountersTable: dynamodb.ITable;
  // In-VPC placement + Aurora (ADR-0004/0003) — app-core only.
  readonly vpc: ec2.IVpc;
  readonly lambdaSg: ec2.ISecurityGroup;
  readonly cluster: rds.IDatabaseCluster;
}

/**
 * ApiStack — the app-api compute, split into two functions behind one HTTP API (ADR-0002,
 * ADR-0011, ADR-0006 rev: Cognito-native auth).
 *
 * Authentication has NO backend surface here: the SPA talks to Cognito's public endpoint directly
 * (SignUp / InitiateAuth / native WEB_AUTHN — ADR-0006), so this stack carries no `/auth/*` routes,
 * no ticket machinery, and no Cognito grants. What remains, sliced along the Aurora seam:
 *  - `app-links` (NON-VPC "links edge"): `/products/resolve` + `/recommendations*`. DynamoDB over
 *    the public endpoint; invokes the retailer-proxy synchronously (free from a non-VPC function,
 *    ADR-0004). Holds no Aurora access.
 *  - `app-core` (IN-VPC "wallet core"): `/wallet*` + `/healthz/db`. Reaches Aurora as `app_rw` via
 *    IAM auth (no RDS Proxy); Aurora is money-only (ADR-0003 as amended by ADR-0006).
 *
 * The Cognito JWT authorizer guards the links + wallet routes; only `GET /healthz` (+ the db probe)
 * stays public.
 */
export class ApiStack extends Stack {
  readonly httpApi: HttpApi;
  /** The non-VPC links edge — observed by the ObservabilityStack (errors/throttles/duration). */
  readonly appLinksFn: lambda.Function;
  /** The in-VPC wallet core — observed by the ObservabilityStack (errors/throttles/duration). */
  readonly appCoreFn: lambda.Function;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { wanthatEnv } = props;

    // --- app-links: NON-VPC links edge (DynamoDB + retailer-proxy invoke; no Cognito, no Aurora) ---
    const appLinksFn = new NodejsFunction(this, "AppLinks", {
      functionName: `wanthat-${wanthatEnv.name}-app-links`,
      entry: serviceEntry("app-links"),
      handler: "handler",
      runtime: LAMBDA_RUNTIME,
      architecture: LAMBDA_ARCHITECTURE,
      memorySize: 256,
      timeout: Duration.seconds(15),
      // X-Ray tracing + an explicit retention-bounded log group (ADR-0002 observability).
      tracing: lambda.Tracing.ACTIVE,
      logGroup: serviceLogGroup(this, "AppLinksLogs", wanthatEnv),
      // No VPC: the links edge reaches DynamoDB over public AWS endpoints and its sync
      // retailer-proxy invoke is free from outside the VPC (ADR-0004 asymmetry).
      // No reserved concurrency: the account Lambda concurrency limit (10) is itself the cap, and
      // this function is DynamoDB-only (no Aurora connection pressure). Re-introduce a reserved
      // budget once the account quota is raised - see infra issue (ADR-0002).
      environment: {
        WANTHAT_ENV: wanthatEnv.name,
        RUNTIME_CONFIG_TABLE: props.runtimeConfigTable.tableName,
        // Links module (ADR-0002). The proxy is invoked by its deterministic NAME (no cross-stack
        // export -> deploy-order independent).
        PRODUCT_TABLE: props.productTable.tableName,
        RECOMMENDATION_TABLE: props.recommendationTable.tableName,
        RETAILER_PROXY_FUNCTION: `wanthat-${wanthatEnv.name}-retailer-proxy`,
        FX_RATE_TABLE: props.fxRateTable.tableName,
        // Dashboard metrics (spec 2026-07-12): presence stamps + daily counters in OpsCounters.
        OPS_COUNTERS_TABLE: props.opsCountersTable.tableName,
        APP_URL: appUrl(wanthatEnv),
      },
      bundling: { minify: true, sourceMap: true },
    });
    this.appLinksFn = appLinksFn;

    // DynamoDB (ADR-0004 division of writes): app-links READS products (retailer-proxy is the
    // sole product writer), WRITES recommendations, reads the fx cache for display conversion,
    // and reads the runtime config (cashback split policy).
    props.productTable.grantReadData(appLinksFn);
    props.recommendationTable.grantReadWriteData(appLinksFn);
    props.fxRateTable.grantReadData(appLinksFn);
    props.runtimeConfigTable.grantReadData(appLinksFn);
    // Write-only on OpsCounters: presence stamps + daily counter ADDs are UpdateItems.
    props.opsCountersTable.grantWriteData(appLinksFn);
    // Synchronous generateLink invoke — free from a non-VPC function (ADR-0004 asymmetry). ARN
    // constructed from the deterministic function name so no CloudFormation export ties this
    // stack to EdgeServices.
    appLinksFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [
          this.formatArn({
            service: "lambda",
            resource: "function",
            resourceName: `wanthat-${wanthatEnv.name}-retailer-proxy`,
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      }),
    );

    // --- app-core: IN-VPC wallet core (Aurora only; ADR-0006 makes Aurora money-only) ---
    const appCoreFn = new NodejsFunction(this, "AppCore", {
      functionName: `wanthat-${wanthatEnv.name}-app-core`,
      entry: serviceEntry("app-core"),
      handler: "handler",
      runtime: LAMBDA_RUNTIME,
      architecture: LAMBDA_ARCHITECTURE,
      memorySize: 256,
      timeout: Duration.seconds(30), // first connect may resume a scale-to-zero cluster (up to ~30s)
      tracing: lambda.Tracing.ACTIVE,
      logGroup: serviceLogGroup(this, "AppCoreLogs", wanthatEnv),
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.lambdaSg],
      // No reserved concurrency: the account Lambda concurrency limit (10) is itself the cap, and
      // app-core's Aurora connection pressure is minimal vs max_connections=50. Re-introduce a
      // reserved budget once the account quota is raised - see infra issue (ADR-0002).
      environment: {
        WANTHAT_ENV: wanthatEnv.name,
        DB_HOST: props.cluster.clusterEndpoint.hostname,
        DB_NAME: "wanthat",
        DB_USER: "app_rw",
        // Wallet ILS estimate (ADR-0017): the cached USD-ILS rate + the conversion-commission
        // config, read through the VPC's free DynamoDB gateway endpoint (ADR-0004).
        FX_RATE_TABLE: props.fxRateTable.tableName,
        RUNTIME_CONFIG_TABLE: props.runtimeConfigTable.tableName,
        // The member activity feed merges recommendation creations (byOwner, read-only)
        // into the wallet movements - over the free DynamoDB gateway endpoint (ADR-0004).
        RECOMMENDATION_TABLE: props.recommendationTable.tableName,
        // Dashboard metrics (spec 2026-07-12): presence stamps in OpsCounters.
        OPS_COUNTERS_TABLE: props.opsCountersTable.tableName,
        ...RDS_CA_ENV,
      },
      bundling: rdsCaBundling,
    });
    this.appCoreFn = appCoreFn;

    // Aurora as app_rw via IAM auth (ADR-0003) - no RDS Proxy, no static credential.
    props.cluster.grantConnect(appCoreFn, "app_rw");
    props.fxRateTable.grantReadData(appCoreFn);
    props.recommendationTable.grantReadData(appCoreFn);
    props.runtimeConfigTable.grantReadData(appCoreFn);
    // Write-only on OpsCounters: presence stamps + the activeDaily ADD are UpdateItems.
    props.opsCountersTable.grantWriteData(appCoreFn);

    // --- One HTTP API fronting both functions ---
    const linksIntegration = new HttpLambdaIntegration("AppLinksIntegration", appLinksFn);
    const coreIntegration = new HttpLambdaIntegration("AppCoreIntegration", appCoreFn);
    const authorizer = new HttpJwtAuthorizer(
      "CognitoAuthorizer",
      `https://cognito-idp.${this.region}.amazonaws.com/${props.userPool.userPoolId}`,
      { jwtAudience: [props.userPoolClient.userPoolClientId] },
    );

    // CORS so the browser SPA (a different origin than execute-api) can call the API. Without it,
    // the preflight OPTIONS falls through to an authorizer-protected route and is rejected 401, so
    // the real request never fires. API Gateway answers OPTIONS itself (no authorizer) once this is
    // set. Origins shared with the Cognito callback list (config.webOrigins).
    this.httpApi = new HttpApi(this, "HttpApi", {
      apiName: `wanthat-${wanthatEnv.name}-app`,
      corsPreflight: {
        allowOrigins: webOrigins(wanthatEnv),
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST, CorsHttpMethod.PATCH],
        allowHeaders: ["content-type", "authorization"],
        maxAge: Duration.hours(1),
      },
    });
    // Per-surface request throttling - tuned centrally in config.ts (THROTTLING).
    applyThrottle(this.httpApi, THROTTLING.userWallet);

    // Explicit methods (NOT ANY) everywhere so `OPTIONS` has no matching route and falls through to
    // API Gateway's built-in CORS preflight handler - an ANY route would swallow the preflight into
    // the authorizer and 401 it (breaking browser CORS).

    // Liveness -> the links edge (either function serves it).
    this.httpApi.addRoutes({
      path: "/healthz",
      methods: [HttpMethod.GET],
      integration: linksIntegration,
    });

    // Public runtime-config projection -> the links edge. GET, NO authorizer (same wiring as
    // /healthz): the SPA reads it before any sign-in (e.g. the register screen's OTP channel
    // options). The handler serves ONLY keys allow-listed in contracts CONFIG_PUBLIC, so no
    // private value (whatsapp.phoneNumberId, retailer credentials, ...) is reachable on this route.
    this.httpApi.addRoutes({
      path: "/config",
      methods: [HttpMethod.GET],
      integration: linksIntegration,
    });

    // DB warm-up probe -> app-core (touches Aurora). Public; the SPA fires it (fire-and-forget) on
    // load so the scale-to-zero resume overlaps the human reading the page instead of serialising
    // in front of the wallet read.
    this.httpApi.addRoutes({
      path: "/healthz/db",
      methods: [HttpMethod.GET],
      integration: coreIntegration,
    });

    // Links module (ADR-0002/0011) -> app-links (non-VPC — its sync retailer-proxy invoke is free
    // there), behind the JWT authorizer. Resolve is a POST (it can mint via the retailer-proxy);
    // recommendations carry POST create, GET list/detail and PATCH review — PATCH is already in
    // the CORS allowMethods above.
    this.httpApi.addRoutes({
      path: "/products/resolve",
      methods: [HttpMethod.POST],
      integration: linksIntegration,
      authorizer,
    });
    this.httpApi.addRoutes({
      path: "/recommendations",
      methods: [HttpMethod.GET, HttpMethod.POST],
      integration: linksIntegration,
      authorizer,
    });
    this.httpApi.addRoutes({
      path: "/recommendations/{proxy+}",
      methods: [HttpMethod.GET, HttpMethod.PATCH],
      integration: linksIntegration,
      authorizer,
    });

    // Wallet reads -> app-core, behind the JWT authorizer. The handlers are stubs this slice
    // (member-home spec); routes and contract are final, the poller slice fills the data in.
    this.httpApi.addRoutes({
      path: "/wallet",
      methods: [HttpMethod.GET],
      integration: coreIntegration,
      authorizer,
    });
    this.httpApi.addRoutes({
      path: "/wallet/{proxy+}",
      methods: [HttpMethod.GET],
      integration: coreIntegration,
      authorizer,
    });
    // The member activity feed (recommendation creations + wallet movements, merged) -> app-core.
    this.httpApi.addRoutes({
      path: "/activity",
      methods: [HttpMethod.GET],
      integration: coreIntegration,
      authorizer,
    });

    new CfnOutput(this, "AppApiUrl", { value: this.httpApi.apiEndpoint });
    new CfnOutput(this, "UserPoolId", { value: props.userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: props.userPoolClient.userPoolClientId });

    // TRANSITIONAL (ADR-0006 split) - REMOVE in a follow-up once every env's observability stack has
    // redeployed. The old `AppApi` Lambda was deleted, but wanthat-{env}-observability still imports its
    // ref in the currently-deployed template. CloudFormation deploys `api` before `observability`, so
    // `api` would try to delete this export while it is still in use -> "cannot delete export ... in
    // use", the failure that rolled back the dev deploy. Retaining the export for one deploy lets
    // observability migrate first; the follow-up PR drops this line + the export.
    this.exportValue(`wanthat-${wanthatEnv.name}-app-api`, {
      name: `wanthat-${wanthatEnv.name}-api:ExportsOutputRefAppApiE7BADA0120FBA170`,
    });
    // TRANSITIONAL (T8 rename) - REMOVE in a follow-up once every env's observability stack has
    // redeployed. Same trap as above: the deployed observability template still imports the OLD
    // `AppAuth` function ref export; deleting it while in use rolls the api deploy back. Retain the
    // export (stale literal value - nothing evaluates it) for one deploy so observability can
    // migrate to the `AppLinks` export first; the follow-up PR drops this line.
    this.exportValue(`wanthat-${wanthatEnv.name}-app-auth`, {
      name: `wanthat-${wanthatEnv.name}-api:ExportsOutputRefAppAuthB8BC94674D7C9325`,
    });
  }
}
