import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import { HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type * as cognito from "aws-cdk-lib/aws-cognito";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import type { Construct } from "constructs";
import { applyThrottle, LAMBDA_RUNTIME, serviceEntry, THROTTLING, type WanthatEnv } from "./config";

export interface AdminStackProps extends StackProps {
  readonly wanthatEnv: WanthatEnv;
  readonly userPool: cognito.IUserPool;
  readonly userPoolClient: cognito.IUserPoolClient;
  readonly runtimeConfigTable: dynamodb.ITable;
  readonly recommendationTable: dynamodb.ITable;
}

/**
 * AdminStack — the admin API as a separate Lambda with its own role and exposure (ADR-0002).
 * Behind its own HTTP API + JWT authorizer (every route gated — there is no public probe). The
 * sanctioned writes (audited ledger adjustments, the runtime-config panel) land later; for now it
 * returns 501, so an unauthenticated request returns 401 and an authed one returns 501.
 *
 * Non-VPC for now — it moves in-VPC with Aurora (ADR-0004), like app-api.
 */
export class AdminStack extends Stack {
  readonly httpApi: HttpApi;

  constructor(scope: Construct, id: string, props: AdminStackProps) {
    super(scope, id, props);
    const { wanthatEnv } = props;

    const fn = new NodejsFunction(this, "AdminApi", {
      functionName: `wanthat-${wanthatEnv.name}-admin-api`,
      entry: serviceEntry("admin-api"),
      handler: "handler",
      runtime: LAMBDA_RUNTIME,
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: {
        WANTHAT_ENV: wanthatEnv.name,
        RUNTIME_CONFIG_TABLE: props.runtimeConfigTable.tableName,
        RECOMMENDATION_TABLE: props.recommendationTable.tableName,
      },
      bundling: { minify: true, sourceMap: true },
    });

    props.runtimeConfigTable.grantReadWriteData(fn);
    props.recommendationTable.grantReadData(fn);

    const integration = new HttpLambdaIntegration("AdminApiIntegration", fn);
    const authorizer = new HttpJwtAuthorizer(
      "CognitoAuthorizer",
      `https://cognito-idp.${this.region}.amazonaws.com/${props.userPool.userPoolId}`,
      { jwtAudience: [props.userPoolClient.userPoolClientId] },
    );

    this.httpApi = new HttpApi(this, "HttpApi", { apiName: `wanthat-${wanthatEnv.name}-admin` });
    // Per-surface request throttling — tuned centrally in config.ts (THROTTLING).
    applyThrottle(this.httpApi, THROTTLING.admin);
    this.httpApi.addRoutes({
      path: "/{proxy+}",
      methods: [HttpMethod.ANY],
      integration,
      authorizer,
    });

    new CfnOutput(this, "AdminApiUrl", { value: this.httpApi.apiEndpoint });
  }
}
