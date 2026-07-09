import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import { HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import type * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import {
  applyThrottle,
  LAMBDA_ARCHITECTURE,
  LAMBDA_RUNTIME,
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
  /** Customer pool + SPA client ids: the landing resolve verifies Bearer tokens OFFLINE (JWKS). */
  readonly userPoolId: string;
  readonly userPoolClientId: string;
}

/**
 * EdgeServicesStack — the non-VPC functions (ADR-0004, ADR-0007, ADR-0008, ADR-0009).
 *
 * - `landing`: public, cookieless; behind a **public HTTP API** (no authorizer), reads the DynamoDB
 *   projection. (CloudFront fronts this in the EdgeStack.) A Lambda Function URL was the original
 *   front door, but those are unavailable in il-central-1 — ADR-0007 settled on the HTTP API.
 * - `retailer-proxy`: the sole egress to retailer APIs; holds the secret-scoped credential.
 * - `conversion-poller` / `fx-rates`: scheduled. The EventBridge schedules are created **disabled**
 *   (the handlers are 501 stubs); they're enabled and made admin-tunable with their real slices.
 *
 * The poller's in-VPC writer split (ADR-0009) is deferred — for the skeleton it's a single non-VPC
 * stub. Aurora-touching wiring lands with the wallet slice.
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

    const makeFn = (idPart: string, service: string) =>
      new NodejsFunction(this, idPart, {
        functionName: `wanthat-${wanthatEnv.name}-${service}`,
        entry: serviceEntry(service),
        handler: "handler",
        runtime: LAMBDA_RUNTIME,
        architecture: LAMBDA_ARCHITECTURE,
        memorySize: 256,
        timeout: Duration.seconds(15),
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
    const retailerProxy = makeFn("RetailerProxy", "retailer-proxy");
    this.retailerProxyFn = retailerProxy;
    // generateLink upserts the shared Product (ADR-0004: the proxy owns the Product write; the
    // in-VPC caller writes the Recommendation — the proxy holds NO recommendation grant,
    // least-privilege per ADR-0002; the poll slice adds what listOrders actually needs).
    props.productTable.grantReadWriteData(retailerProxy);
    props.retailerSecret.grantRead(retailerProxy);
    // The AliExpress tracking id is runtime config (`retailer.aliexpressTrackingId`, admin-set
    // next to the credentials) - the proxy reads it per invoke, so changing it needs no redeploy.
    props.runtimeConfigTable.grantReadData(retailerProxy);
    retailerProxy.addEnvironment("RETAILER_SECRET_ARN", props.retailerSecret.secretArn);
    retailerProxy.addEnvironment("PRODUCT_TABLE", props.productTable.tableName);
    retailerProxy.addEnvironment("RUNTIME_CONFIG_TABLE", props.runtimeConfigTable.tableName);

    // --- scheduled writers ---
    const poller = makeFn("ConversionPoller", "conversion-poller");
    this.conversionPollerFn = poller;
    props.recommendationTable.grantReadData(poller);
    props.guestAttributionTable.grantReadData(poller);

    // fx-rates is implemented (ADR-0017): reads CONFIG `fx.provider`, writes the fx_rate cache.
    const fxRates = makeFn("FxRates", "fx-rates");
    this.fxRatesFn = fxRates;
    props.fxRateTable.grantReadWriteData(fxRates);
    props.runtimeConfigTable.grantReadData(fxRates);
    fxRates.addEnvironment("FX_RATE_TABLE", props.fxRateTable.tableName);
    fxRates.addEnvironment("RUNTIME_CONFIG_TABLE", props.runtimeConfigTable.tableName);

    // The poller is still a 501 stub → its schedule stays DISABLED until that slice lands (ADR-0009).
    this.addSchedule("ConversionPollerSchedule", poller, "rate(15 minutes)", false);
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
  ): void {
    const role = new iam.Role(this, `${id}Role`, {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
    });
    fn.grantInvoke(role);
    new scheduler.CfnSchedule(this, id, {
      flexibleTimeWindow: { mode: "OFF" },
      scheduleExpression: expression,
      state: enabled ? "ENABLED" : "DISABLED",
      target: { arn: fn.functionArn, roleArn: role.roleArn },
    });
  }
}
