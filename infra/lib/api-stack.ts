import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import { HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type * as cognito from "aws-cdk-lib/aws-cognito";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import type { Construct } from "constructs";
import { serviceEntry, type WanthatEnv } from "./config";

export interface ApiStackProps extends StackProps {
  readonly wanthatEnv: WanthatEnv;
  readonly vpc: ec2.IVpc;
  readonly lambdaSecurityGroup: ec2.ISecurityGroup;
  readonly userPool: cognito.IUserPool;
  readonly userPoolClient: cognito.IUserPoolClient;
  readonly recommendationTable: dynamodb.ITable;
  readonly guestAttributionTable: dynamodb.ITable;
  readonly runtimeConfigTable: dynamodb.ITable;
}

/**
 * ApiStack — the app-api Lambdalith behind an HTTP API (ADR-0002, ADR-0006, ADR-0011).
 *
 * In-VPC (it will reach Aurora via IAM auth once the wallet slice lands); reaches DynamoDB through
 * the gateway endpoint. A Cognito JWT authorizer guards every route except `GET /healthz`, which is
 * the unauthenticated liveness probe for the deploy smoke-test.
 */
export class ApiStack extends Stack {
  readonly httpApi: HttpApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { wanthatEnv, vpc, lambdaSecurityGroup } = props;

    const fn = new NodejsFunction(this, "AppApi", {
      functionName: `wanthat-${wanthatEnv.name}-app-api`,
      entry: serviceEntry("app-api"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 256,
      timeout: Duration.seconds(10),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [lambdaSecurityGroup],
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
