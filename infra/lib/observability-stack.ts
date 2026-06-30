import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import type { IHttpApi } from "aws-cdk-lib/aws-apigatewayv2";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatch_actions from "aws-cdk-lib/aws-cloudwatch-actions";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import type * as rds from "aws-cdk-lib/aws-rds";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sns_subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import type { Construct } from "constructs";
import type { WanthatEnv } from "./config";

/** A labelled HTTP API to observe (app-api, admin-api, landing). */
export interface ObservedApi {
  readonly label: string;
  readonly api: IHttpApi;
}

/** A labelled application Lambda to observe (errors alarmed; the one-shot migrator is excluded). */
export interface ObservedFunction {
  readonly label: string;
  readonly fn: lambda.IFunction;
}

export interface ObservabilityStackProps extends StackProps {
  readonly wanthatEnv: WanthatEnv;
  readonly httpApis: ObservedApi[];
  readonly functions: ObservedFunction[];
  readonly cluster: rds.IDatabaseCluster;
  /** The account SMS spend cap (USD/month) from IdentityStack — the SMS alarm fires at 80% of it. */
  readonly smsSpendLimitUsd: number;
}

/**
 * ObservabilityStack — a starter monitoring layer for the il-central-1 app resources (ADR-0002,
 * ADR-0006). Deploys LAST (it only references resources the other stacks already created).
 *
 * Owns: one SNS alarm topic (optional email subscriber), CloudWatch alarms (SMS month-to-date spend,
 * per-Lambda errors, per-HTTP-API 5xx, Aurora connections approaching the max_connections cap), and a
 * per-surface dashboard. X-Ray tracing + log retention on the Lambdas themselves are set at each
 * function's call site via config.serviceLogGroup, not here.
 *
 * Out of scope for the starter (follow-ups): CloudFront/WAF dashboards (us-east-1), a CloudTrail alarm
 * on reads of the retailer secret, and business/funnel metrics.
 */
export class ObservabilityStack extends Stack {
  readonly alarmTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);
    const { wanthatEnv, httpApis, functions, cluster, smsSpendLimitUsd } = props;
    const env = wanthatEnv.name;
    const period = Duration.minutes(5);

    // --- Alarm fan-out topic ---
    this.alarmTopic = new sns.Topic(this, "AlarmTopic", {
      topicName: `wanthat-${env}-alarms`,
      displayName: `Wanthat ${env} alarms`,
    });
    if (wanthatEnv.alarmEmail) {
      this.alarmTopic.addSubscription(
        new sns_subscriptions.EmailSubscription(wanthatEnv.alarmEmail),
      );
    }
    const alarmAction = new cloudwatch_actions.SnsAction(this.alarmTopic);
    const addAction = (alarm: cloudwatch.Alarm): cloudwatch.Alarm => {
      alarm.addAlarmAction(alarmAction);
      return alarm;
    };

    // --- SMS month-to-date spend (account-level AWS/SNS metric, no dimensions) ---
    // Fires at 80% of the IdentityStack SMS cap so an operator can react before the hard limit (and
    // the kill switch, ADR-0006) stops OTP delivery. ~6h period since the metric updates slowly.
    const smsSpendMetric = new cloudwatch.Metric({
      namespace: "AWS/SNS",
      metricName: "SMSMonthToDateSpentUSD",
      statistic: "Maximum",
      period: Duration.hours(6),
    });
    addAction(
      smsSpendMetric.createAlarm(this, "SmsSpendAlarm", {
        alarmName: `wanthat-${env}-sms-spend`,
        alarmDescription: `SMS month-to-date spend at 80 percent of the ${env} cap (${smsSpendLimitUsd} USD)`,
        threshold: 0.8 * smsSpendLimitUsd,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );

    // --- Per-Lambda error alarms ---
    for (const { label, fn } of functions) {
      addAction(
        fn.metricErrors({ period, statistic: "Sum" }).createAlarm(this, `${label}ErrorsAlarm`, {
          alarmName: `wanthat-${env}-${label}-errors`,
          alarmDescription: `Lambda ${label} reported 5 or more errors in 5 minutes`,
          threshold: 5,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          evaluationPeriods: 1,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        }),
      );
    }

    // --- Per-HTTP-API 5xx alarms ---
    for (const { label, api } of httpApis) {
      addAction(
        api
          .metricServerError({ period, statistic: "Sum" })
          .createAlarm(this, `${label}ServerErrorAlarm`, {
            alarmName: `wanthat-${env}-${label}-5xx`,
            alarmDescription: `HTTP API ${label} returned 5 or more 5xx responses in 5 minutes`,
            threshold: 5,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            evaluationPeriods: 1,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
          }),
      );
    }

    // --- Aurora connections approaching the max_connections=50 cap (DataStack) ---
    const auroraConnections = cluster.metricDatabaseConnections({ statistic: "Maximum", period });
    addAction(
      auroraConnections.createAlarm(this, "AuroraConnectionsAlarm", {
        alarmName: `wanthat-${env}-aurora-connections`,
        alarmDescription:
          "Aurora database connections at 80 percent of the max_connections cap (40 of 50)",
        threshold: 40,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );

    // --- Dashboard ---
    const dashboard = new cloudwatch.Dashboard(this, "Dashboard", {
      dashboardName: `wanthat-${env}`,
    });

    // (a) Per-API: request count, 5xx, p95 latency.
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "API requests",
        left: httpApis.map(({ label, api }) =>
          api.metricCount({ period, statistic: "Sum", label }),
        ),
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: "API 5xx",
        left: httpApis.map(({ label, api }) =>
          api.metricServerError({ period, statistic: "Sum", label }),
        ),
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: "API p95 latency (ms)",
        left: httpApis.map(({ label, api }) =>
          api.metricLatency({ period, statistic: "p95", label }),
        ),
        width: 8,
      }),
    );

    // (b) Per-Lambda: errors, throttles, p95 duration.
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "Lambda errors",
        left: functions.map(({ label, fn }) =>
          fn.metricErrors({ period, statistic: "Sum", label }),
        ),
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: "Lambda throttles",
        left: functions.map(({ label, fn }) =>
          fn.metricThrottles({ period, statistic: "Sum", label }),
        ),
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: "Lambda p95 duration (ms)",
        left: functions.map(({ label, fn }) =>
          fn.metricDuration({ period, statistic: "p95", label }),
        ),
        width: 8,
      }),
    );

    // (c) Aurora: serverless capacity (ACU) + database connections.
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "Aurora capacity (ACU)",
        left: [
          cluster
            .metric("ServerlessDatabaseCapacity", { period, statistic: "Average" })
            .with({ label: "ACU" }),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: "Aurora connections",
        left: [auroraConnections.with({ label: "connections" })],
        leftAnnotations: [{ value: 50, label: "max_connections", color: cloudwatch.Color.RED }],
        width: 12,
      }),
    );

    // (d) SMS month-to-date spend with the cap as a horizontal annotation.
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "SMS month-to-date spend (USD)",
        left: [smsSpendMetric.with({ label: "spend USD" })],
        leftAnnotations: [
          { value: smsSpendLimitUsd, label: "spend cap", color: cloudwatch.Color.RED },
        ],
        width: 24,
      }),
    );

    new CfnOutput(this, "AlarmTopicArn", { value: this.alarmTopic.topicArn });
  }
}
