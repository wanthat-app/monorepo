import { Duration, Stack, type StackProps } from "aws-cdk-lib";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { DynamoEventSource, SqsDlq } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as sqs from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import {
  LAMBDA_ARCHITECTURE,
  LAMBDA_RUNTIME,
  serviceEntry,
  serviceLogGroup,
  type WanthatEnv,
} from "./config";

export interface WhatsAppStackProps extends StackProps {
  readonly wanthatEnv: WanthatEnv;
  readonly notificationOutboxTable: dynamodb.ITable;
  readonly runtimeConfigTable: dynamodb.ITable;
}

/**
 * WhatsAppStack (ADR-0023) - the notification side of the WhatsApp capability: the NON-VPC
 * whatsapp-dispatcher consuming the notification_outbox Stream, plus its on-failure DLQ. The OTP
 * side (message-sender) lives in IdentityStack with the pool trigger. Depends only on DataStack.
 */
export class WhatsAppStack extends Stack {
  /** Observed by ObservabilityStack (errors/throttles/duration). */
  readonly dispatcherFn: lambda.Function;

  constructor(scope: Construct, id: string, props: WhatsAppStackProps) {
    super(scope, id, props);
    const { wanthatEnv } = props;

    // Batches that still fail after the event-source retries land here (14 days to inspect/redrive).
    const dlq = new sqs.Queue(this, "DispatcherDlq", {
      queueName: `wanthat-${wanthatEnv.name}-whatsapp-dispatcher-dlq`,
      retentionPeriod: Duration.days(14),
    });

    const dispatcherFn = new NodejsFunction(this, "Dispatcher", {
      functionName: `wanthat-${wanthatEnv.name}-whatsapp-dispatcher`,
      entry: serviceEntry("whatsapp-dispatcher"),
      handler: "handler",
      runtime: LAMBDA_RUNTIME,
      architecture: LAMBDA_ARCHITECTURE,
      memorySize: 256,
      timeout: Duration.seconds(30),
      tracing: lambda.Tracing.ACTIVE,
      logGroup: serviceLogGroup(this, "DispatcherLogs", wanthatEnv),
      // Non-VPC by design: this is ADR-0023's NAT-free bridge to the public End User Messaging
      // Social endpoint. It must NOT be placed in the VPC.
      environment: {
        WANTHAT_ENV: wanthatEnv.name,
        RUNTIME_CONFIG_TABLE: props.runtimeConfigTable.tableName,
        NOTIFICATION_OUTBOX_TABLE: props.notificationOutboxTable.tableName,
        // End User Messaging Social is not in il-central-1; matches IdentityStack's message-sender.
        WHATSAPP_SOCIAL_REGION: "eu-central-1",
      },
      bundling: { minify: true, sourceMap: true },
    });
    this.dispatcherFn = dispatcherFn;

    dispatcherFn.addEventSource(
      new DynamoEventSource(props.notificationOutboxTable, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
        retryAttempts: 3,
        bisectBatchOnError: true,
        onFailure: new SqsDlq(dlq),
      }),
    );
    // markSent/markFailed need item updates; reads for completeness. Stream read is granted by
    // the event source itself. Config stays read-only (single-writer: admin-api).
    props.notificationOutboxTable.grantReadWriteData(dispatcherFn);
    props.runtimeConfigTable.grantReadData(dispatcherFn);
    // The phone-number-id resource exists only after onboarding, hence "*".
    dispatcherFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["social-messaging:SendWhatsAppMessage"],
        resources: ["*"],
      }),
    );
  }
}
