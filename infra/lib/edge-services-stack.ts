import { CfnOutput, Duration, Fn, Stack, type StackProps } from "aws-cdk-lib";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import type * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import { LAMBDA_RUNTIME, serviceEntry, type WanthatEnv } from "./config";

export interface EdgeServicesStackProps extends StackProps {
  readonly wanthatEnv: WanthatEnv;
  readonly recommendationTable: dynamodb.ITable;
  readonly guestAttributionTable: dynamodb.ITable;
  readonly runtimeConfigTable: dynamodb.ITable;
  readonly fxRateTable: dynamodb.ITable;
  readonly retailerSecret: secretsmanager.ISecret;
}

/**
 * EdgeServicesStack — the non-VPC functions (ADR-0004, ADR-0007, ADR-0008, ADR-0009).
 *
 * - `landing`: public, cookieless; behind a Lambda Function URL (auth NONE), reads the DynamoDB
 *   projection. (CloudFront fronts this in the EdgeStack / PR B2.)
 * - `retailer-proxy`: the sole egress to retailer APIs; holds the secret-scoped credential.
 * - `conversion-poller` / `fx-rates`: scheduled. The EventBridge schedules are created **disabled**
 *   (the handlers are 501 stubs); they're enabled and made admin-tunable with their real slices.
 *
 * The poller's in-VPC writer split (ADR-0009) is deferred — for the skeleton it's a single non-VPC
 * stub. Aurora-touching wiring lands with the wallet slice.
 */
export class EdgeServicesStack extends Stack {
  /** Host of the landing Function URL (no scheme/path) — a CloudFront origin in the EdgeStack. */
  readonly landingUrlDomain: string;

  constructor(scope: Construct, id: string, props: EdgeServicesStackProps) {
    super(scope, id, props);
    const { wanthatEnv } = props;

    const makeFn = (idPart: string, service: string) =>
      new NodejsFunction(this, idPart, {
        functionName: `wanthat-${wanthatEnv.name}-${service}`,
        entry: serviceEntry(service),
        handler: "handler",
        runtime: LAMBDA_RUNTIME,
        memorySize: 256,
        timeout: Duration.seconds(15),
        environment: { WANTHAT_ENV: wanthatEnv.name },
        bundling: { minify: true, sourceMap: true },
      });

    // --- landing (public Function URL) ---
    const landing = makeFn("Landing", "landing");
    props.recommendationTable.grantReadData(landing);
    props.runtimeConfigTable.grantReadData(landing);
    props.fxRateTable.grantReadData(landing);
    const landingUrl = landing.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
    // `https://<host>/` → `<host>` for use as a CloudFront origin.
    this.landingUrlDomain = Fn.select(2, Fn.split("/", landingUrl.url));

    // --- retailer proxy (sole egress; holds the credential) ---
    const retailerProxy = makeFn("RetailerProxy", "retailer-proxy");
    props.recommendationTable.grantReadWriteData(retailerProxy);
    props.retailerSecret.grantRead(retailerProxy);
    retailerProxy.addEnvironment("RETAILER_SECRET_ARN", props.retailerSecret.secretArn);

    // --- scheduled writers ---
    const poller = makeFn("ConversionPoller", "conversion-poller");
    props.recommendationTable.grantReadData(poller);
    props.guestAttributionTable.grantReadData(poller);

    const fxRates = makeFn("FxRates", "fx-rates");
    props.fxRateTable.grantReadWriteData(fxRates);

    this.addDisabledSchedule("ConversionPollerSchedule", poller, "rate(15 minutes)");
    this.addDisabledSchedule("FxRatesSchedule", fxRates, "rate(60 minutes)");

    new CfnOutput(this, "LandingUrl", { value: landingUrl.url });
  }

  /** A disabled EventBridge schedule that invokes `fn` (ADR-0009 — enabled/tunable with its slice). */
  private addDisabledSchedule(id: string, fn: lambda.IFunction, expression: string): void {
    const role = new iam.Role(this, `${id}Role`, {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
    });
    fn.grantInvoke(role);
    new scheduler.CfnSchedule(this, id, {
      flexibleTimeWindow: { mode: "OFF" },
      scheduleExpression: expression,
      state: "DISABLED",
      target: { arn: fn.functionArn, roleArn: role.roleArn },
    });
  }
}
