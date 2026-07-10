import { Duration, Stack } from "aws-cdk-lib";
import * as glue from "aws-cdk-lib/aws-glue";
import * as iam from "aws-cdk-lib/aws-iam";
import * as firehose from "aws-cdk-lib/aws-kinesisfirehose";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import type { WanthatEnv } from "./config";

export interface FunnelAnalyticsProps {
  readonly wanthatEnv: WanthatEnv;
  /** Log groups whose structured funnel events (impression/click/conversion) feed the pipeline. */
  readonly logGroups: logs.ILogGroup[];
}

/**
 * FunnelAnalytics — the off-band business-metrics pipeline (ADR-0007, ADR-0008, ADR-0009):
 * CloudWatch Logs subscription filters ship the structured `console.log` funnel events
 * (impression → click → conversion, `packages/contracts` FunnelEvent/ConversionEvent shapes)
 * through a Firehose delivery stream into S3 as date-partitioned NDJSON, queryable in Athena
 * via a Glue external table with partition projection (no crawler, no Lambda processor).
 *
 * The Firehose processor chain does all the unwrapping natively: `Decompression` gunzips the
 * CloudWatch Logs envelope, `CloudWatchLogProcessing` (DataMessageExtraction) strips the
 * envelope metadata and emits one record per log event, `MetadataExtraction` pulls the
 * partition date from the event's own `at` timestamp, and `AppendDelimiterToRecord` restores
 * the trailing newline the extraction drops.
 */
export class FunnelAnalytics extends Construct {
  constructor(scope: Construct, id: string, props: FunnelAnalyticsProps) {
    super(scope, id);
    const { wanthatEnv, logGroups } = props;
    const env = wanthatEnv.name;
    const stack = Stack.of(this);

    // --- S3 destination (dev + prod share the account — env in the name; ADR-0005) ---
    const bucket = new s3.Bucket(this, "Bucket", {
      bucketName: `wanthat-${env}-funnel-${stack.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [
        {
          transitions: [
            { storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: Duration.days(90) },
          ],
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
      ],
    });

    // --- Firehose delivery stream (DirectPut; CloudWatch Logs is the only producer) ---
    const deliveryRole = new iam.Role(this, "DeliveryRole", {
      assumedBy: new iam.ServicePrincipal("firehose.amazonaws.com"),
    });
    // Grant BEFORE the stream so the bucket policy statements exist when Firehose validates at create.
    bucket.grantReadWrite(deliveryRole);

    const streamName = `wanthat-${env}-funnel`;
    const stream = new firehose.CfnDeliveryStream(this, "Stream", {
      deliveryStreamName: streamName,
      deliveryStreamType: "DirectPut",
      extendedS3DestinationConfiguration: {
        bucketArn: bucket.bucketArn,
        roleArn: deliveryRole.roleArn,
        // Dynamic partitioning by event date — the Glue table's projection reads the same layout.
        prefix: "funnel/date=!{partitionKeyFromQuery:date}/",
        errorOutputPrefix: "funnel-errors/!{firehose:error-output-type}/",
        bufferingHints: { intervalInSeconds: 300, sizeInMBs: 64 },
        dynamicPartitioningConfiguration: { enabled: true },
        processingConfiguration: {
          enabled: true,
          processors: [
            // Gunzip the CloudWatch Logs envelope.
            { type: "Decompression" },
            // Strip the envelope (owner/logGroup/logEvents...) — one record per log event message.
            {
              type: "CloudWatchLogProcessing",
              parameters: [{ parameterName: "DataMessageExtraction", parameterValue: "true" }],
            },
            // Partition key: the DATE of the event's own ISO `at` timestamp (first 10 chars).
            {
              type: "MetadataExtraction",
              parameters: [
                { parameterName: "MetadataExtractionQuery", parameterValue: "{date: .at[0:10]}" },
                { parameterName: "JsonParsingEngine", parameterValue: "JQ-1.6" },
              ],
            },
            // Extracted messages have no trailing newline; Athena needs one JSON object per line.
            {
              type: "AppendDelimiterToRecord",
              parameters: [{ parameterName: "Delimiter", parameterValue: "\\n" }],
            },
          ],
        },
      },
    });
    // The role's inline policy must be deployed before the stream references it.
    stream.node.addDependency(deliveryRole);

    // --- CloudWatch Logs → Firehose subscription filters (one per producing log group) ---
    const subscriptionRole = new iam.Role(this, "SubscriptionRole", {
      assumedBy: new iam.ServicePrincipal(`logs.${stack.region}.amazonaws.com`),
    });
    subscriptionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["firehose:PutRecord", "firehose:PutRecordBatch"],
        resources: [stream.attrArn],
      }),
    );
    logGroups.forEach((logGroup, i) => {
      const filter = new logs.CfnSubscriptionFilter(this, `Subscription${i}`, {
        logGroupName: logGroup.logGroupName,
        // Only the structured funnel events — plain-text service logs never leave CloudWatch.
        filterPattern:
          '{ $.type = "impression" || $.type = "click" || $.type = "conversion" || $.type = "order_untracked" }',
        destinationArn: stream.attrArn,
        roleArn: subscriptionRole.roleArn,
      });
      filter.node.addDependency(subscriptionRole);
    });

    // --- Glue database + external table (Athena queries; partition projection — no crawler) ---
    const database = new glue.CfnDatabase(this, "Database", {
      catalogId: stack.account,
      databaseInput: { name: `wanthat_${env}_analytics` },
    });
    // The `\${date}` stays a LITERAL `${date}` in the template value — Athena partition
    // projection substitutes it at query time; neither JS nor CloudFormation interpolates it.
    const locationTemplate = `s3://${bucket.bucketName}/funnel/date=\${date}/`;
    const table = new glue.CfnTable(this, "Table", {
      catalogId: stack.account,
      databaseName: `wanthat_${env}_analytics`,
      tableInput: {
        name: "funnel_events",
        tableType: "EXTERNAL_TABLE",
        parameters: {
          // Partition projection (yyyy-MM-dd) — new date partitions are queryable immediately.
          "projection.enabled": "true",
          "projection.date.type": "date",
          "projection.date.format": "yyyy-MM-dd",
          "projection.date.range": "2026-07-01,NOW",
          "projection.date.interval": "1",
          "projection.date.interval.unit": "DAYS",
          "storage.location.template": locationTemplate,
        },
        partitionKeys: [{ name: "date", type: "string" }],
        storageDescriptor: {
          location: `s3://${bucket.bucketName}/funnel/`,
          inputFormat: "org.apache.hadoop.mapred.TextInputFormat",
          outputFormat: "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat",
          serdeInfo: { serializationLibrary: "org.openx.data.jsonserde.JsonSerDe" },
          // The FunnelEvent union's superset (contracts/landing/events.ts + contracts/conversion/
          // event.ts, incl. UntrackedOrderEvent) — JsonSerDe matches JSON keys case-insensitively,
          // absent fields read as NULL.
          columns: [
            { name: "type", type: "string" },
            { name: "recommendationid", type: "string" },
            { name: "consumer", type: "string" },
            { name: "orderid", type: "string" },
            { name: "amount", type: "struct<amountminor:string,currency:string>" },
            { name: "status", type: "string" },
            { name: "reason", type: "string" },
            { name: "orderstatus", type: "string" },
            { name: "at", type: "string" },
          ],
        },
      },
    });
    table.addDependency(database);
  }
}
