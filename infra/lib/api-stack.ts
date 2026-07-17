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
  // In-VPC placement + Aurora (ADR-0004/0003) — member-wallet only.
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
 *  - `member-catalog` (NON-VPC "links edge"): `/products/resolve` + `/recommendations*`. DynamoDB over
 *    the public endpoint; invokes the retailer-linkgen synchronously (free from a non-VPC function,
 *    ADR-0004). Holds no Aurora access.
 *  - `member-wallet` (IN-VPC "wallet core"): `/wallet*` + `/healthz/db`. Reaches Aurora as
 *    `wallet_reader` via IAM auth (no RDS Proxy); Aurora is money-only (ADR-0003 as amended by
 *    ADR-0006).
 *
 * The Cognito JWT authorizer guards the links + wallet routes; only `GET /healthz` (+ the db probe)
 * stays public.
 */
export class ApiStack extends Stack {
  readonly httpApi: HttpApi;
  /** The non-VPC links edge — observed by the ObservabilityStack (errors/throttles/duration). */
  readonly memberCatalogFn: lambda.Function;
  /** The in-VPC wallet core — observed by the ObservabilityStack (errors/throttles/duration). */
  readonly memberWalletFn: lambda.Function;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { wanthatEnv } = props;

    // --- member-catalog: NON-VPC links edge (DynamoDB + retailer-linkgen invoke; no Cognito, no Aurora) ---
    // No VPC: the links edge reaches DynamoDB over public AWS endpoints and its sync
    // retailer-linkgen invoke is free from outside the VPC (ADR-0004 asymmetry).
    // No reserved concurrency: the account Lambda concurrency limit (10) is itself the cap, and
    // this function is DynamoDB-only (no Aurora connection pressure). Re-introduce a reserved
    // budget once the account quota is raised - see infra issue (ADR-0002).
    const memberCatalogFn = makeServiceFunction(this, wanthatEnv, "member-catalog", {
      environment: {
        WANTHAT_ENV: wanthatEnv.name,
        RUNTIME_CONFIG_TABLE: props.runtimeConfigTable.tableName,
        // Links module (ADR-0002). The linkgen (refactor PR-6: the sync half of the retailer
        // split) is invoked by its deterministic NAME (no cross-stack export -> deploy-order
        // independent).
        PRODUCT_TABLE: props.productTable.tableName,
        RECOMMENDATION_TABLE: props.recommendationTable.tableName,
        RETAILER_LINKGEN_FUNCTION: physicalName(wanthatEnv, "retailer-linkgen"),
        FX_RATE_TABLE: props.fxRateTable.tableName,
        // Dashboard metrics (spec 2026-07-12): presence stamps + daily counters in OpsCounters.
        OPS_COUNTERS_TABLE: props.opsCountersTable.tableName,
        APP_URL: appUrl(wanthatEnv),
      },
      bundling: { minify: true, sourceMap: true },
    });
    this.memberCatalogFn = memberCatalogFn;

    // DynamoDB (ADR-0004 division of writes): member-catalog READS products (retailer-linkgen is the
    // sole product writer), WRITES recommendations, reads the fx cache for display conversion,
    // and reads the runtime config (cashback split policy).
    props.productTable.grantReadData(memberCatalogFn);
    props.recommendationTable.grantReadWriteData(memberCatalogFn);
    props.fxRateTable.grantReadData(memberCatalogFn);
    props.runtimeConfigTable.grantReadData(memberCatalogFn);
    // Write-only on OpsCounters: presence stamps + daily counter ADDs are UpdateItems.
    props.opsCountersTable.grantWriteData(memberCatalogFn);
    // Synchronous generateLink invoke — free from a non-VPC function (ADR-0004 asymmetry). ARN
    // constructed from the deterministic function name so no CloudFormation export ties this
    // stack to EdgeServices.
    memberCatalogFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [functionArnFor(this, wanthatEnv, "retailer-linkgen")],
      }),
    );

    // --- member-wallet: IN-VPC wallet core (Aurora only; ADR-0006 makes Aurora money-only) ---
    // No reserved concurrency: the account Lambda concurrency limit (10) is itself the cap, and
    // member-wallet's Aurora connection pressure is minimal vs max_connections=50. Re-introduce a
    // reserved budget once the account quota is raised - see infra issue (ADR-0002).
    const memberWalletFn = makeServiceFunction(this, wanthatEnv, "member-wallet", {
      timeout: Duration.seconds(30), // first connect may resume a scale-to-zero cluster (up to ~30s)
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.lambdaSg],
      environment: {
        WANTHAT_ENV: wanthatEnv.name,
        DB_HOST: props.cluster.clusterEndpoint.hostname,
        DB_NAME: "wanthat",
        // Least-privilege role flip (refactor PR-7): the wallet surface is SELECT-only over the
        // ledger, so it connects as wallet_reader (granted in migration 0008), not app_rw.
        DB_USER: "wallet_reader",
        // Wallet ILS estimate (ADR-0017): the cached USD-ILS rate + the conversion-commission
        // config, read through the VPC's free DynamoDB gateway endpoint (ADR-0004).
        FX_RATE_TABLE: props.fxRateTable.tableName,
        RUNTIME_CONFIG_TABLE: props.runtimeConfigTable.tableName,
        // Dashboard metrics (spec 2026-07-12): presence stamps in OpsCounters.
        OPS_COUNTERS_TABLE: props.opsCountersTable.tableName,
        ...RDS_CA_ENV,
      },
      bundling: rdsCaBundling,
    });
    this.memberWalletFn = memberWalletFn;

    // Aurora as wallet_reader via IAM auth (ADR-0003) - no RDS Proxy, no static credential.
    props.cluster.grantConnect(memberWalletFn, "wallet_reader");
    props.fxRateTable.grantReadData(memberWalletFn);
    props.runtimeConfigTable.grantReadData(memberWalletFn);
    // Write-only on OpsCounters: presence stamps + the activeDaily ADD are UpdateItems.
    props.opsCountersTable.grantWriteData(memberWalletFn);

    // --- One HTTP API fronting both functions ---
    const linksIntegration = new HttpLambdaIntegration("MemberCatalogIntegration", memberCatalogFn);
    const coreIntegration = new HttpLambdaIntegration("MemberWalletIntegration", memberWalletFn);
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

    // DB warm-up probe -> member-wallet (touches Aurora). Public; the SPA fires it (fire-and-forget) on
    // load so the scale-to-zero resume overlaps the human reading the page instead of serialising
    // in front of the wallet read.
    this.httpApi.addRoutes({
      path: "/healthz/db",
      methods: [HttpMethod.GET],
      integration: coreIntegration,
    });

    // Links module (ADR-0002/0011) -> member-catalog (non-VPC — its sync retailer-linkgen invoke is free
    // there), behind the JWT authorizer. Resolve is a POST (it can mint via the retailer-linkgen);
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

    // Wallet reads -> member-wallet, behind the JWT authorizer. The handlers are stubs this slice
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
    // The member activity feed (recommendation creations + wallet movements, merged) -> member-wallet.
    this.httpApi.addRoutes({
      path: "/activity",
      methods: [HttpMethod.GET],
      integration: coreIntegration,
      authorizer,
    });

    new CfnOutput(this, "AppApiUrl", { value: this.httpApi.apiEndpoint });
    new CfnOutput(this, "UserPoolId", { value: props.userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: props.userPoolClient.userPoolClientId });

    // TRANSITIONAL — dropped in refactor PR-8. The deployed observability template still imports
    // the old AppLinks/AppCore function-Ref exports (its alarms + dashboard watched the functions
    // this PR renames), and a single-pass `cdk deploy --all` updates `api` BEFORE
    // `observability` — dropping an in-use export rolls the deploy back ("cannot delete export
    // ... in use"). The values are the old functions' PHYSICAL NAMES (deterministic
    // `wanthat-{env}-app-links` / `wanthat-{env}-app-core`), frozen as per-env literals captured
    // from `aws cloudformation list-exports --region il-central-1` (2026-07-17); nothing
    // evaluates them once observability redeploys without the imports.
    const transitionalApiExports: Record<WanthatEnv["name"], Record<string, string>> = {
      dev: {
        ExportsOutputRefAppLinks59919860467031AE: "wanthat-dev-app-links",
        ExportsOutputRefAppCore4ECC985A96B54444: "wanthat-dev-app-core",
      },
      prod: {
        ExportsOutputRefAppLinks59919860467031AE: "wanthat-prod-app-links",
        ExportsOutputRefAppCore4ECC985A96B54444: "wanthat-prod-app-core",
      },
    };
    for (const [output, value] of Object.entries(transitionalApiExports[wanthatEnv.name])) {
      this.exportValue(value, { name: `wanthat-${wanthatEnv.name}-api:${output}` });
    }
  }
}
