import { Duration, Stack, type StackProps } from "aws-cdk-lib";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import { SqsDestination } from "aws-cdk-lib/aws-lambda-destinations";
import * as sqs from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import { makeServiceFunction, physicalName, type WanthatEnv } from "./config";

export interface WhatsAppStackProps extends StackProps {
  readonly wanthatEnv: WanthatEnv;
  readonly runtimeConfigTable: dynamodb.ITable;
}

/**
 * WhatsAppStack (ADR-0019, reshaped by the compute-topology refactor) - the notification side of
 * the WhatsApp capability: the NON-VPC notification-sender, async-invoked directly by producers
 * (InvocationType Event) with the full SendNotificationRequest payload — the outbox table and its
 * stream are gone. Failed invokes retry twice and then land the ORIGINAL payload in the SQS DLQ
 * via the async on-failure destination. The OTP side (otp-sender) lives in IdentityStack with
 * the pool trigger. Depends only on DataStack.
 */
export class WhatsAppStack extends Stack {
  /** Observed by ObservabilityStack (errors/throttles/duration). */
  readonly notificationSenderFn: lambda.Function;

  constructor(scope: Construct, id: string, props: WhatsAppStackProps) {
    super(scope, id, props);
    const { wanthatEnv } = props;

    // Payloads that still fail after the async retries land here — the REAL notification payload,
    // not a stream pointer (14 days to inspect/redrive).
    const dlq = new sqs.Queue(this, "NotificationSenderDlq", {
      queueName: `${physicalName(wanthatEnv, "notification-sender")}-dlq`,
      retentionPeriod: Duration.days(14),
    });

    // Non-VPC by design: this is ADR-0019's NAT-free bridge to the public End User Messaging
    // Social endpoint. It must NOT be placed in the VPC.
    const notificationSenderFn = makeServiceFunction(this, wanthatEnv, "notification-sender", {
      timeout: Duration.seconds(30),
      environment: {
        WANTHAT_ENV: wanthatEnv.name,
        RUNTIME_CONFIG_TABLE: props.runtimeConfigTable.tableName,
        // End User Messaging Social is not in il-central-1; matches IdentityStack's otp-sender.
        WHATSAPP_SOCIAL_REGION: "eu-central-1",
      },
      bundling: { minify: true, sourceMap: true },
    });
    this.notificationSenderFn = notificationSenderFn;

    // Async-invoke policy: two retries, then the on-failure destination parks the payload in the
    // DLQ. The handler returns success on a kill-switched channel, so a deliberate skip never DLQs.
    notificationSenderFn.configureAsyncInvoke({
      retryAttempts: 2,
      onFailure: new SqsDestination(dlq),
    });

    // Config stays read-only (single-writer: admin-console).
    props.runtimeConfigTable.grantReadData(notificationSenderFn);
    // Region+account+resource-type-scoped: the phone-number-id resource exists only after Meta
    // onboarding, so the id itself is a wildcard — but the grant is pinned to phone-number-id
    // resources in the one region (eu-central-1) and account we send from.
    notificationSenderFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["social-messaging:SendWhatsAppMessage"],
        resources: [`arn:aws:social-messaging:eu-central-1:${this.account}:phone-number-id/*`],
      }),
    );
  }
}
