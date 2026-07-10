import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import { HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as ec2 from "aws-cdk-lib/aws-ec2";
import { SubnetType } from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import type * as rds from "aws-cdk-lib/aws-rds";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
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
} from "./config";

export interface EdgeServicesStackProps extends StackProps {
  readonly wanthatEnv: WanthatEnv;
  readonly productTable: dynamodb.ITable;
  readonly recommendationTable: dynamodb.ITable;
  readonly guestAttributionTable: dynamodb.ITable;
  readonly runtimeConfigTable: dynamodb.ITable;
  readonly fxRateTable: dynamodb.ITable;
  readonly retailerSecret: secretsmanager.ISecret;
  readonly pollerStateTable: dynamodb.ITable;
  readonly unattributedOrderTable: dynamodb.ITable;
  /** Customer pool + SPA client ids: the landing resolve verifies Bearer tokens OFFLINE (JWKS). */
  readonly userPoolId: string;
  readonly userPoolClientId: string;
  /** The conversion-poller-WRITER is the stack's one in-VPC function (ADR-0002: Aurora access). */
  readonly vpc: ec2.IVpc;
  readonly lambdaSg: ec2.ISecurityGroup;
  readonly cluster: rds.IDatabaseCluster;
}

/**
 * EdgeServicesStack — the non-VPC functions (ADR-0004, ADR-0007, ADR-0008, ADR-0009).
 *
 * - `landing`: public, cookieless; behind a **public HTTP API** (no authorizer), reads the DynamoDB
 *   projection. (CloudFront fronts this in the EdgeStack.) A Lambda Function URL was the original
 *   front door, but those are unavailable in il-central-1 — ADR-0007 settled on the HTTP API.
 * - `retailer-proxy`: the sole egress to retailer APIs; holds the secret-scoped credential.
 * - `conversion-poller`: the ADR-0009 chain's in-VPC WRITER — the one deliberate exception to the
 *   stack's non-VPC charter. It stays in this stack (rather than api-stack) so its log group's
 *   cross-stack export to Observability's funnel subscription survives the slice unchanged
 *   (removing a consumed export mid-deploy fails — see the export-ordering note in the infra
 *   README). Invoked by the retailer-proxy poll, never scheduled directly.
 * - `fx-rates`: scheduled, live (ADR-0017).
 */
export class EdgeServicesStack extends Stack {
  /** The public landing HTTP API — the us-east-1 EdgeStack fronts it on `/p/*` (cross-region). */
  readonly landingApi: HttpApi;
  /** Non-VPC application functions — observed by the ObservabilityStack (errors/throttles/duration). */
  readonly landingFn: lambda.Function;
  readonly retailerProxyFn: lambda.Function;
  readonly conversionPollerFn: lambda.Function;
  readonly fxRatesFn: lambda.Function;

  constructor(scope: Construct, id: string, props: EdgeServicesStackProps) {
    super(scope, id, props);
    const { wanthatEnv } = props;

    const makeFn = (idPart: string, service: string, opts?: { timeoutSeconds?: number }) =>
      new NodejsFunction(this, idPart, {
        functionName: `wanthat-${wanthatEnv.name}-${service}`,
        entry: serviceEntry(service),
        handler: "handler",
        runtime: LAMBDA_RUNTIME,
        architecture: LAMBDA_ARCHITECTURE,
        memorySize: 256,
        timeout: Duration.seconds(opts?.timeoutSeconds ?? 15),
        // X-Ray tracing + an explicit retention-bounded log group (ADR-0002 observability).
        tracing: lambda.Tracing.ACTIVE,
        logGroup: serviceLogGroup(this, `${idPart}Logs`, wanthatEnv),
        environment: { WANTHAT_ENV: wanthatEnv.name },
        bundling: { minify: true, sourceMap: true },
      });

    // --- landing (public HTTP API; Lambda Function URLs are unavailable in il-central-1, ADR-0007) ---
    const landing = makeFn("Landing", "landing");
    this.landingFn = landing;
    // The public site origin (dev.wanthat.app / wanthat.app) for ABSOLUTE Open Graph URLs. Behind
    // CloudFront the Lambda's Host header is the API-Gateway domain, not the site domain, so the
    // og:image / og:url must come from the known domain, not the request.
    if (wanthatEnv.domainName)
      landing.addEnvironment("SITE_ORIGIN", `https://${wanthatEnv.domainName}`);
    props.recommendationTable.grantReadData(landing);
    props.runtimeConfigTable.grantReadData(landing);
    props.fxRateTable.grantReadData(landing);
    landing.addEnvironment("RECOMMENDATION_TABLE", props.recommendationTable.tableName);
    landing.addEnvironment("RUNTIME_CONFIG_TABLE", props.runtimeConfigTable.tableName);
    landing.addEnvironment("FX_RATE_TABLE", props.fxRateTable.tableName);
    landing.addEnvironment("USER_POOL_ID", props.userPoolId);
    landing.addEnvironment("USER_POOL_CLIENT_ID", props.userPoolClientId);
    const landingApi = new HttpApi(this, "LandingApi", {
      apiName: `wanthat-${wanthatEnv.name}-landing`,
    });
    this.landingApi = landingApi;
    landingApi.addRoutes({
      path: "/{proxy+}",
      methods: [HttpMethod.ANY],
      integration: new HttpLambdaIntegration("LandingIntegration", landing),
    });
    // Per-surface request throttling — tuned centrally in config.ts (THROTTLING).
    applyThrottle(landingApi, THROTTLING.landing);

    // --- retailer proxy (sole egress; holds the credential) ---
    // 300s: the scheduled poll pages the retailer sequentially and awaits the in-VPC writer;
    // the sync generateLink callers stay bounded by their own API Gateway 30s regardless.
    const retailerProxy = makeFn("RetailerProxy", "retailer-proxy", { timeoutSeconds: 300 });
    this.retailerProxyFn = retailerProxy;
    // generateLink upserts the shared Product (ADR-0004: the proxy owns the Product write; the
    // in-VPC caller writes the Recommendation — the proxy holds NO recommendation grant,
    // least-privilege per ADR-0002; the poll slice adds what listOrders actually needs).
    props.productTable.grantReadWriteData(retailerProxy);
    props.retailerSecret.grantRead(retailerProxy);
    // The poll op (ADR-0009): resolve attribution from the projection + guest map (reads only)
    // and own the watermark/heartbeat state (single writer of poller_state).
    props.recommendationTable.grantReadData(retailerProxy);
    props.guestAttributionTable.grantReadData(retailerProxy);
    props.pollerStateTable.grantReadWriteData(retailerProxy);
    // The claim queue: the poll upserts sightings, the heartbeat settles claimed items.
    props.unattributedOrderTable.grantReadWriteData(retailerProxy);
    // The AliExpress tracking id is runtime config (`retailer.aliexpressTrackingId`, admin-set
    // next to the credentials) - the proxy reads it per invoke, so changing it needs no redeploy.
    props.runtimeConfigTable.grantReadData(retailerProxy);
    retailerProxy.addEnvironment("RETAILER_SECRET_ARN", props.retailerSecret.secretArn);
    retailerProxy.addEnvironment("PRODUCT_TABLE", props.productTable.tableName);
    retailerProxy.addEnvironment("RUNTIME_CONFIG_TABLE", props.runtimeConfigTable.tableName);
    retailerProxy.addEnvironment("RECOMMENDATION_TABLE", props.recommendationTable.tableName);
    retailerProxy.addEnvironment("GUEST_ATTRIBUTION_TABLE", props.guestAttributionTable.tableName);
    retailerProxy.addEnvironment("POLLER_STATE_TABLE", props.pollerStateTable.tableName);
    retailerProxy.addEnvironment(
      "UNATTRIBUTED_ORDER_TABLE",
      props.unattributedOrderTable.tableName,
    );

    // --- conversion-poller-writer: IN-VPC, the sole money mutator (ADR-0002/0009) ---
    const poller = new NodejsFunction(this, "ConversionPoller", {
      functionName: `wanthat-${wanthatEnv.name}-conversion-poller`,
      entry: serviceEntry("conversion-poller"),
      handler: "handler",
      runtime: LAMBDA_RUNTIME,
      architecture: LAMBDA_ARCHITECTURE,
      memorySize: 256,
      // One Aurora scale-to-zero resume (waitForDb, 60s budget) + a batch of inserts.
      timeout: Duration.seconds(90),
      tracing: lambda.Tracing.ACTIVE,
      logGroup: serviceLogGroup(this, "ConversionPollerLogs", wanthatEnv),
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.lambdaSg],
      // No reserved concurrency: the account Lambda concurrency limit (10) is itself the cap —
      // reserving ANY amount here trips "UnreservedConcurrentExecution below its minimum" (bit
      // the 2026-07-10 deploy). Runs are serialized anyway: the heartbeat gate allows one due
      // poll at a time and the proxy's 300s timeout ends well inside the 15-minute heartbeat.
      // Re-introduce a reserved budget once the account quota is raised (ADR-0002 note).
      environment: {
        WANTHAT_ENV: wanthatEnv.name,
        DB_HOST: props.cluster.clusterEndpoint.hostname,
        DB_NAME: "wanthat",
        DB_USER: "poller_writer",
        RECOMMENDATION_TABLE: props.recommendationTable.tableName,
        ...RDS_CA_ENV,
      },
      bundling: rdsCaBundling,
    });
    this.conversionPollerFn = poller;
    // Aurora as poller_writer via IAM auth (ADR-0003) — append-only by DB grants (0006).
    props.cluster.grantConnect(poller, "poller_writer");
    // The conversions stat (DynamoDB over the VPC's free gateway endpoint) — read+write.
    props.recommendationTable.grantReadWriteData(poller);
    // The proxy poll invokes the writer with resolved conversions (same stack — direct grant).
    poller.grantInvoke(retailerProxy);
    retailerProxy.addEnvironment("CONVERSION_WRITER_FUNCTION", poller.functionName);

    // fx-rates is implemented (ADR-0017): reads CONFIG `fx.provider`, writes the fx_rate cache.
    const fxRates = makeFn("FxRates", "fx-rates");
    this.fxRatesFn = fxRates;
    props.fxRateTable.grantReadWriteData(fxRates);
    props.runtimeConfigTable.grantReadData(fxRates);
    fxRates.addEnvironment("FX_RATE_TABLE", props.fxRateTable.tableName);
    fxRates.addEnvironment("RUNTIME_CONFIG_TABLE", props.runtimeConfigTable.tableName);

    // The conversion poll heartbeat (ADR-0009): fires the PROXY every 15 minutes; the op gates
    // itself on CONFIG poller.intervalMinutes (default 30), so admins tune cadence without any
    // scheduler mutation. Dev only for now — prod stays disabled (decision 2026-07-10).
    this.addSchedule(
      "OrderPollHeartbeat",
      retailerProxy,
      "rate(15 minutes)",
      wanthatEnv.name === "dev",
      JSON.stringify({ op: "listOrders", retailer: "aliexpress" }),
    );
    // fx-rates is live: refresh on the CONFIG default cadence (fx.updateIntervalMinutes = 720m).
    // admin-api retunes this schedule when the config key changes (later slice).
    this.addSchedule("FxRatesSchedule", fxRates, "rate(720 minutes)", true);

    new CfnOutput(this, "LandingApiUrl", { value: landingApi.apiEndpoint });
  }

  /**
   * An EventBridge schedule that invokes `fn`. `enabled` is false while a target is still a 501 stub
   * (ADR-0009) and flips true as its slice lands; admin-api retunes the expression at runtime.
   */
  private addSchedule(
    id: string,
    fn: lambda.IFunction,
    expression: string,
    enabled: boolean,
    input?: string,
  ): void {
    const role = new iam.Role(this, `${id}Role`, {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
    });
    fn.grantInvoke(role);
    new scheduler.CfnSchedule(this, id, {
      flexibleTimeWindow: { mode: "OFF" },
      scheduleExpression: expression,
      state: enabled ? "ENABLED" : "DISABLED",
      target: { arn: fn.functionArn, roleArn: role.roleArn, input },
    });
  }
}
