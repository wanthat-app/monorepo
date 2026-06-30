import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import { HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type * as cognito from "aws-cdk-lib/aws-cognito";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as ec2 from "aws-cdk-lib/aws-ec2";
import { SubnetType } from "aws-cdk-lib/aws-ec2";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import type * as rds from "aws-cdk-lib/aws-rds";
import type { Construct } from "constructs";
import { applyThrottle, LAMBDA_RUNTIME, serviceEntry, THROTTLING, type WanthatEnv } from "./config";

export interface AdminStackProps extends StackProps {
  readonly wanthatEnv: WanthatEnv;
  // Employee/admin pool, not the customer pool (ADR-0020 §two-pool): a customer token structurally
  // can't satisfy this authorizer, so it can't reach /admin. The in-handler `admin` group check stays
  // as defence-in-depth.
  readonly employeePool: cognito.IUserPool;
  readonly employeePoolClient: cognito.IUserPoolClient;
  readonly runtimeConfigTable: dynamodb.ITable;
  readonly recommendationTable: dynamodb.ITable;
  readonly vpc: ec2.IVpc;
  readonly lambdaSg: ec2.ISecurityGroup;
  readonly cluster: rds.IDatabaseCluster;
}

/**
 * AdminStack — the admin API as a separate in-VPC Lambda with its own role and exposure (ADR-0002,
 * ADR-0020). Behind its own HTTP API + JWT authorizer; the admin-group check is re-enforced
 * in-handler. Reaches Aurora read-only as `app_ro` (live users count) and writes the runtime
 * `config` table (the admin panel). `/healthz` is the only unauthenticated route (deploy probe).
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
      timeout: Duration.seconds(15),
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.lambdaSg],
      // No reserved concurrency: the account's Lambda concurrency limit (10) is the cap; admin traffic
      // is tiny. Re-introduce app 7 / admin 2 / migrator 1 once the account quota is raised (ADR-0002).
      environment: {
        WANTHAT_ENV: wanthatEnv.name,
        RUNTIME_CONFIG_TABLE: props.runtimeConfigTable.tableName,
        RECOMMENDATION_TABLE: props.recommendationTable.tableName,
        DB_HOST: props.cluster.clusterEndpoint.hostname,
        DB_NAME: "wanthat",
        DB_USER: "app_ro",
      },
      bundling: { minify: true, sourceMap: true },
    });

    // Read-only Aurora as app_ro (ADR-0002) + the config table it writes.
    props.cluster.grantConnect(fn, "app_ro");
    props.runtimeConfigTable.grantReadWriteData(fn);
    props.recommendationTable.grantReadData(fn);

    const integration = new HttpLambdaIntegration("AdminApiIntegration", fn);
    const authorizer = new HttpJwtAuthorizer(
      "CognitoAuthorizer",
      `https://cognito-idp.${this.region}.amazonaws.com/${props.employeePool.userPoolId}`,
      { jwtAudience: [props.employeePoolClient.userPoolClientId] },
    );

    this.httpApi = new HttpApi(this, "HttpApi", { apiName: `wanthat-${wanthatEnv.name}-admin` });
    // Per-surface request throttling — tuned centrally in config.ts (THROTTLING).
    applyThrottle(this.httpApi, THROTTLING.admin);

    // Unauthenticated liveness probe; everything else behind the JWT authorizer (+ in-handler group).
    this.httpApi.addRoutes({ path: "/healthz", methods: [HttpMethod.GET], integration });
    this.httpApi.addRoutes({
      path: "/{proxy+}",
      methods: [HttpMethod.ANY],
      integration,
      authorizer,
    });

    new CfnOutput(this, "AdminApiUrl", { value: this.httpApi.apiEndpoint });
  }
}
