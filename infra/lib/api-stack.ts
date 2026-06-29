import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import { HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type * as cognito from "aws-cdk-lib/aws-cognito";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import type { Construct } from "constructs";
import { applyThrottle, LAMBDA_RUNTIME, serviceEntry, THROTTLING, type WanthatEnv } from "./config";

export interface ApiStackProps extends StackProps {
  readonly wanthatEnv: WanthatEnv;
  readonly userPool: cognito.IUserPool;
  readonly userPoolClient: cognito.IUserPoolClient;
  readonly recommendationTable: dynamodb.ITable;
  readonly guestAttributionTable: dynamodb.ITable;
  readonly runtimeConfigTable: dynamodb.ITable;
}

/**
 * ApiStack — the app-api Lambdalith behind an HTTP API (ADR-0002, ADR-0006, ADR-0011).
 *
 * Reaches DynamoDB directly. A Cognito JWT authorizer guards every route except `GET /healthz`, the
 * unauthenticated liveness probe for the deploy smoke-test.
 *
 * Non-VPC for now: app-api only needs the VPC once it reaches Aurora via IAM auth (the wallet
 * slice). It moves in-VPC then, alongside the NetworkStack (ADR-0004).
 */
export class ApiStack extends Stack {
  readonly httpApi: HttpApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { wanthatEnv } = props;

    const fn = new NodejsFunction(this, "AppApi", {
      functionName: `wanthat-${wanthatEnv.name}-app-api`,
      entry: serviceEntry("app-api"),
      handler: "handler",
      runtime: LAMBDA_RUNTIME,
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: {
        WANTHAT_ENV: wanthatEnv.name,
        RECOMMENDATION_TABLE: props.recommendationTable.tableName,
        GUEST_ATTRIBUTION_TABLE: props.guestAttributionTable.tableName,
        RUNTIME_CONFIG_TABLE: props.runtimeConfigTable.tableName,
      },
      bundling: { minify: true, sourceMap: true },
    });

    // Least-ish privilege for the skeleton: app data RW, config read.
    props.recommendationTable.grantReadWriteData(fn);
    props.guestAttributionTable.grantReadWriteData(fn);
    props.runtimeConfigTable.grantReadData(fn);

    const integration = new HttpLambdaIntegration("AppApiIntegration", fn);
    const authorizer = new HttpJwtAuthorizer(
      "CognitoAuthorizer",
      `https://cognito-idp.${this.region}.amazonaws.com/${props.userPool.userPoolId}`,
      { jwtAudience: [props.userPoolClient.userPoolClientId] },
    );

    this.httpApi = new HttpApi(this, "HttpApi", { apiName: `wanthat-${wanthatEnv.name}-app` });
    // Per-surface request throttling — tuned centrally in config.ts (THROTTLING).
    applyThrottle(this.httpApi, THROTTLING.userWallet);

    // Unauthenticated liveness probe.
    this.httpApi.addRoutes({ path: "/healthz", methods: [HttpMethod.GET], integration });
    // Everything else behind the JWT authorizer.
    this.httpApi.addRoutes({
      path: "/{proxy+}",
      methods: [HttpMethod.ANY],
      integration,
      authorizer,
    });

    new CfnOutput(this, "AppApiUrl", { value: this.httpApi.apiEndpoint });
    new CfnOutput(this, "UserPoolId", { value: props.userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: props.userPoolClient.userPoolClientId });
  }
}
