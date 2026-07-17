import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import { HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as ec2 from "aws-cdk-lib/aws-ec2";
import { SubnetType } from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import type * as rds from "aws-cdk-lib/aws-rds";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import type * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import {
  applyThrottle,
  makeServiceFunction,
  RDS_CA_ENV,
  rdsCaBundling,
  type ServiceSlug,
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
  /** The ledger-writer is the stack's one in-VPC function (ADR-0002: Aurora access). */
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
 * - `retailer-linkgen` + `retailer-settlement` (refactor PR-6 split of the retailer proxy): the
 *   two retailer-egress functions, split by trust boundary. Linkgen is the synchronous link
 *   minter — it parses customer-pasted input and therefore never holds the ledger-writer invoke;
 *   settlement is the scheduled poll + claim settlement — its inputs are the retailer API and the
 *   admin-claimed queue, and it alone invokes the writer and applies the derived conversion
 *   totals to the recommendation stat.
 * - `ledger-writer` (renamed from conversion-poller, same PR): the ADR-0009 chain's in-VPC WRITER
 *   — the one deliberate exception to the stack's non-VPC charter. Pure Aurora (as the
 *   `ledger_writer` role, migration 0008): the conversions stat leaves it only as derived totals
 *   in the response, so it holds no DynamoDB grant at all. It stays in this stack so its log
 *   group's cross-stack export to Observability's funnel subscription lives beside the other
 *   emitters. Invoked by the settlement poll, never scheduled directly.
 * - `fx-rates`: scheduled, live (ADR-0017).
 */
export class EdgeServicesStack extends Stack {
  /** The public landing HTTP API — the us-east-1 EdgeStack fronts it on `/p/*` (cross-region). */
  readonly landingApi: HttpApi;
  /** Application functions — observed by the ObservabilityStack (errors/throttles/duration). */
  readonly landingFn: lambda.Function;
  readonly retailerLinkgenFn: lambda.Function;
  readonly retailerSettlementFn: lambda.Function;
  readonly ledgerWriterFn: lambda.Function;
  readonly fxRatesFn: lambda.Function;

  constructor(scope: Construct, id: string, props: EdgeServicesStackProps) {
    super(scope, id, props);
    const { wanthatEnv } = props;

    // The stack's non-VPC baseline: config.makeServiceFunction with just the shared env var.
    const makeFn = (slug: ServiceSlug, opts?: { timeoutSeconds?: number }) =>
      makeServiceFunction(this, wanthatEnv, slug, {
        timeout: Duration.seconds(opts?.timeoutSeconds ?? 15),
        environment: { WANTHAT_ENV: wanthatEnv.name },
        bundling: { minify: true, sourceMap: true },
      });

    // --- landing (public HTTP API; Lambda Function URLs are unavailable in il-central-1, ADR-0007) ---
    const landing = makeFn("landing");
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

    // --- retailer-linkgen (synchronous link minting; refactor PR-6) ---
    // 30s: bounded by the callers' own API Gateway 30s anyway; covers the sequential
    // productdetail.get + link.generate pair with one ApiCallLimit retry each.
    const linkgen = makeFn("retailer-linkgen", { timeoutSeconds: 30 });
    this.retailerLinkgenFn = linkgen;
    // generateLink upserts the shared Product (ADR-0004: the linkgen owns the Product write; the
    // caller writes the Recommendation — linkgen holds NO recommendation grant and NO writer
    // invoke: it is the function that parses customer-pasted input, so it never shares a role
    // with the money path (least-privilege per ADR-0002).
    props.productTable.grantReadWriteData(linkgen);
    props.retailerSecret.grantRead(linkgen);
    // The AliExpress tracking id is runtime config (`retailer.aliexpressTrackingId`, admin-set
    // next to the credentials) - read per invoke, so changing it needs no redeploy.
    props.runtimeConfigTable.grantReadData(linkgen);
    linkgen.addEnvironment("RETAILER_SECRET_ARN", props.retailerSecret.secretArn);
    linkgen.addEnvironment("PRODUCT_TABLE", props.productTable.tableName);
    linkgen.addEnvironment("RUNTIME_CONFIG_TABLE", props.runtimeConfigTable.tableName);

    // --- retailer-settlement (scheduled poll + claim settlement; refactor PR-6) ---
    // 300s: the scheduled poll pages the retailer sequentially and awaits the in-VPC writer.
    const settlement = makeFn("retailer-settlement", { timeoutSeconds: 300 });
    this.retailerSettlementFn = settlement;
    props.retailerSecret.grantRead(settlement);
    // The poll (ADR-0009): resolve attribution from the projection + guest map (reads only)
    // and own the watermark/heartbeat state (single writer of poller_state).
    props.guestAttributionTable.grantReadData(settlement);
    props.pollerStateTable.grantReadWriteData(settlement);
    // The claim queue: the poll upserts sightings, the heartbeat settles claimed items.
    props.unattributedOrderTable.grantReadWriteData(settlement);
    props.runtimeConfigTable.grantReadData(settlement);
    // Recommendation: reads for attribution/claims PLUS a bare UpdateItem for the derived
    // conversions stat (`setConversions` — idempotent SETs from the writer's absolute totals).
    // The narrowed-grant pattern mirrors admin-stack's console grant, but WITHOUT its
    // LeadingKeys condition: totals apply to arbitrary recommendation ids, not one sentinel
    // key. Deliberately no PutItem/DeleteItem — settlement can retune a stat attribute but can
    // never forge or erase a recommendation.
    props.recommendationTable.grantReadData(settlement);
    settlement.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:UpdateItem"],
        resources: [props.recommendationTable.tableArn],
      }),
    );
    settlement.addEnvironment("RETAILER_SECRET_ARN", props.retailerSecret.secretArn);
    settlement.addEnvironment("RUNTIME_CONFIG_TABLE", props.runtimeConfigTable.tableName);
    settlement.addEnvironment("RECOMMENDATION_TABLE", props.recommendationTable.tableName);
    settlement.addEnvironment("GUEST_ATTRIBUTION_TABLE", props.guestAttributionTable.tableName);
    settlement.addEnvironment("POLLER_STATE_TABLE", props.pollerStateTable.tableName);
    settlement.addEnvironment("UNATTRIBUTED_ORDER_TABLE", props.unattributedOrderTable.tableName);

    // --- ledger-writer: IN-VPC, the sole money mutator (ADR-0002/0009; renamed in PR-6) ---
    // No reserved concurrency: the account Lambda concurrency limit (10) is itself the cap —
    // reserving ANY amount here trips "UnreservedConcurrentExecution below its minimum" (bit
    // the 2026-07-10 deploy). Runs are serialized anyway: the heartbeat gate allows one due
    // poll at a time and the settlement's 300s timeout ends well inside the 15-minute
    // heartbeat. Re-introduce a reserved budget once the account quota is raised (ADR-0002).
    const writer = makeServiceFunction(this, wanthatEnv, "ledger-writer", {
      // One Aurora scale-to-zero resume (waitForDb, 60s budget) + a batch of inserts.
      timeout: Duration.seconds(90),
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.lambdaSg],
      environment: {
        WANTHAT_ENV: wanthatEnv.name,
        DB_HOST: props.cluster.clusterEndpoint.hostname,
        DB_NAME: "wanthat",
        DB_USER: "ledger_writer",
        ...RDS_CA_ENV,
      },
      bundling: rdsCaBundling,
    });
    this.ledgerWriterFn = writer;
    // Aurora as ledger_writer via IAM auth (ADR-0003) — append-only by DB grants (migration
    // 0008). PURE Aurora (refactor PR-6): no DynamoDB grant or table env — the conversions stat
    // leaves this function only as derived totals in the response, applied by the settlement.
    props.cluster.grantConnect(writer, "ledger_writer");
    // The settlement invokes the writer with resolved conversions (same stack — direct grant).
    writer.grantInvoke(settlement);
    settlement.addEnvironment("LEDGER_WRITER_FUNCTION", writer.functionName);

    // fx-rates is implemented (ADR-0017): reads CONFIG `fx.provider`, writes the fx_rate cache.
    const fxRates = makeFn("fx-rates");
    this.fxRatesFn = fxRates;
    props.fxRateTable.grantReadWriteData(fxRates);
    props.runtimeConfigTable.grantReadData(fxRates);
    fxRates.addEnvironment("FX_RATE_TABLE", props.fxRateTable.tableName);
    fxRates.addEnvironment("RUNTIME_CONFIG_TABLE", props.runtimeConfigTable.tableName);

    // The conversion poll heartbeat (ADR-0009): fires the SETTLEMENT every 15 minutes with no
    // payload (refactor PR-6 dropped the `{op}` discriminator — the heartbeat is the function's
    // only entry); the poll gates itself on CONFIG poller.intervalMinutes (default 30), so
    // admins tune cadence without any scheduler mutation. Enabled in EVERY env (2026-07-11):
    // the prod retailer credential is populated and prod order ingestion is live.
    this.addSchedule("OrderPollHeartbeat", settlement, "rate(15 minutes)", true);
    // fx-rates is live: refresh on the CONFIG default cadence (fx.updateIntervalMinutes = 720m).
    // admin-api retunes this schedule when the config key changes (later slice).
    this.addSchedule("FxRatesSchedule", fxRates, "rate(720 minutes)", true);

    new CfnOutput(this, "LandingApiUrl", { value: landingApi.apiEndpoint });

    // TRANSITIONAL — dropped in refactor PR-8. The deployed observability template still
    // imports the old RetailerProxy/ConversionPoller function Refs (alarms + dashboard) AND
    // their LOG-GROUP Refs (funnel subscription filters), and a single-pass `cdk deploy --all`
    // updates `edge-services` BEFORE `observability` — dropping an in-use export rolls the
    // deploy back ("cannot delete export ... in use"). Values are frozen per-env literals
    // captured from `aws cloudformation list-exports --region il-central-1` (2026-07-17): the
    // function Refs are the old deterministic physical names, the log-group Refs are the
    // CDK-GENERATED group names of the deleted log groups. Nothing evaluates them once
    // observability redeploys without the imports.
    const transitionalEdgeExports: Record<WanthatEnv["name"], Record<string, string>> = {
      dev: {
        ExportsOutputRefRetailerProxyA66CCEDE760D8557: "wanthat-dev-retailer-proxy",
        ExportsOutputRefRetailerProxyLogs4B1573CFB238D1EB:
          "wanthat-dev-edge-services-RetailerProxyLogs4B1573CF-lZkS2pjlW9aM",
        ExportsOutputRefConversionPoller24BBF790CD7D102E: "wanthat-dev-conversion-poller",
        ExportsOutputRefConversionPollerLogs66E22CDDDE1B6F52:
          "wanthat-dev-edge-services-ConversionPollerLogs66E22CDD-bJF9s2dQBWKH",
      },
      prod: {
        ExportsOutputRefRetailerProxyA66CCEDE760D8557: "wanthat-prod-retailer-proxy",
        ExportsOutputRefRetailerProxyLogs4B1573CFB238D1EB:
          "wanthat-prod-edge-services-RetailerProxyLogs4B1573CF-PTFcMJykfUNN",
        ExportsOutputRefConversionPoller24BBF790CD7D102E: "wanthat-prod-conversion-poller",
        ExportsOutputRefConversionPollerLogs66E22CDDDE1B6F52:
          "wanthat-prod-edge-services-ConversionPollerLogs66E22CDD-9tGuuTdH4mwo",
      },
    };
    for (const [output, value] of Object.entries(transitionalEdgeExports[wanthatEnv.name])) {
      this.exportValue(value, { name: `wanthat-${wanthatEnv.name}-edge-services:${output}` });
    }
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
