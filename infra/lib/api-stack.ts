import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import { CorsHttpMethod, HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type * as cognito from "aws-cdk-lib/aws-cognito";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as ec2 from "aws-cdk-lib/aws-ec2";
import { SubnetType } from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import type * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import {
  applyThrottle,
  LAMBDA_RUNTIME,
  serviceEntry,
  serviceLogGroup,
  THROTTLING,
  type WanthatEnv,
  webOrigins,
} from "./config";

export interface ApiStackProps extends StackProps {
  readonly wanthatEnv: WanthatEnv;
  readonly userPool: cognito.IUserPool;
  readonly userPoolClient: cognito.IUserPoolClient;
  readonly recommendationTable: dynamodb.ITable;
  readonly guestAttributionTable: dynamodb.ITable;
  readonly runtimeConfigTable: dynamodb.ITable;
  readonly authChallengeTable: dynamodb.ITable;
  readonly phoneVelocityTable: dynamodb.ITable;
  // In-VPC placement + Aurora (ADR-0004/0020).
  readonly vpc: ec2.IVpc;
  readonly lambdaSg: ec2.ISecurityGroup;
  readonly cluster: rds.IDatabaseCluster;
}

/**
 * ApiStack — the app-api Lambdalith behind an HTTP API (ADR-0002, ADR-0006, ADR-0011, ADR-0020).
 *
 * In-VPC (PRIVATE_ISOLATED, `lambdaSg`): reaches Aurora as `app_rw` via IAM auth, Cognito over the
 * `cognito-idp` interface endpoint, and DynamoDB over the gateway endpoint — no NAT. A Cognito JWT
 * authorizer guards every route except the `/auth/*` flow (which issues the tokens) and `GET
 * /healthz`. Reserved concurrency caps in-VPC connections (ADR-0002).
 */
export class ApiStack extends Stack {
  readonly httpApi: HttpApi;
  /** The app-api Lambdalith — observed by the ObservabilityStack (errors/throttles/duration). */
  readonly appApiFn: lambda.Function;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { wanthatEnv } = props;

    // HMAC key for registration tickets (ADR-0020) — generated, never in the repo.
    const ticketSecret = new secretsmanager.Secret(this, "AuthTicketSecret", {
      secretName: `wanthat/${wanthatEnv.name}/auth/ticket-hmac`,
      description: "HMAC key signing /auth registration tickets",
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });

    const fn = new NodejsFunction(this, "AppApi", {
      functionName: `wanthat-${wanthatEnv.name}-app-api`,
      entry: serviceEntry("app-api"),
      handler: "handler",
      runtime: LAMBDA_RUNTIME,
      memorySize: 256,
      timeout: Duration.seconds(15), // first connect may resume a scale-to-zero cluster
      // X-Ray tracing + an explicit retention-bounded log group (ADR-0002 observability).
      tracing: lambda.Tracing.ACTIVE,
      logGroup: serviceLogGroup(this, "AppApiLogs", wanthatEnv),
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.lambdaSg],
      // No reserved concurrency: the account's Lambda concurrency limit (10) is itself the cap, and
      // app-api is DynamoDB-hot (Aurora holds only PII + ledger, ADR-0003), so its Aurora connection
      // pressure is minimal vs max_connections=50. Re-introduce a reserved budget (app 7 / admin 2 /
      // migrator 1) once the account quota is raised — see infra issue (ADR-0002).
      environment: {
        WANTHAT_ENV: wanthatEnv.name,
        RECOMMENDATION_TABLE: props.recommendationTable.tableName,
        GUEST_ATTRIBUTION_TABLE: props.guestAttributionTable.tableName,
        RUNTIME_CONFIG_TABLE: props.runtimeConfigTable.tableName,
        AUTH_CHALLENGE_TABLE: props.authChallengeTable.tableName,
        PHONE_VELOCITY_TABLE: props.phoneVelocityTable.tableName,
        USER_POOL_ID: props.userPool.userPoolId,
        USER_POOL_CLIENT_ID: props.userPoolClient.userPoolClientId,
        AUTH_TICKET_SECRET_ARN: ticketSecret.secretArn,
        DB_HOST: props.cluster.clusterEndpoint.hostname,
        DB_NAME: "wanthat",
        DB_USER: "app_rw",
      },
      bundling: { minify: true, sourceMap: true },
    });
    this.appApiFn = fn;

    // Aurora as app_rw via IAM auth (ADR-0003) — no RDS Proxy, no static credential.
    props.cluster.grantConnect(fn, "app_rw");

    // DynamoDB: app data RW, auth working tables RW, config read.
    props.recommendationTable.grantReadWriteData(fn);
    props.guestAttributionTable.grantReadWriteData(fn);
    props.authChallengeTable.grantReadWriteData(fn);
    props.phoneVelocityTable.grantReadWriteData(fn);
    props.runtimeConfigTable.grantReadData(fn);
    ticketSecret.grantRead(fn);

    // Scoped Cognito control-plane actions on this pool only (ADR-0020).
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "cognito-idp:AdminCreateUser",
          "cognito-idp:AdminSetUserPassword",
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminUpdateUserAttributes",
          "cognito-idp:AdminInitiateAuth",
          "cognito-idp:AdminRespondToAuthChallenge",
          "cognito-idp:InitiateAuth",
          "cognito-idp:RespondToAuthChallenge",
          "cognito-idp:RevokeToken",
          "cognito-idp:StartWebAuthnRegistration",
          "cognito-idp:CompleteWebAuthnRegistration",
        ],
        resources: [props.userPool.userPoolArn],
      }),
    );

    const integration = new HttpLambdaIntegration("AppApiIntegration", fn);
    const authorizer = new HttpJwtAuthorizer(
      "CognitoAuthorizer",
      `https://cognito-idp.${this.region}.amazonaws.com/${props.userPool.userPoolId}`,
      { jwtAudience: [props.userPoolClient.userPoolClientId] },
    );

    // CORS so the browser SPA (a different origin than execute-api) can call /auth + /me. Without it,
    // the preflight OPTIONS falls through to the authorizer-protected catch-all route and is rejected
    // 401, so the real request never fires. API Gateway answers OPTIONS itself (no authorizer) once
    // this is set. Origins shared with the Cognito callback list (config.webOrigins).
    this.httpApi = new HttpApi(this, "HttpApi", {
      apiName: `wanthat-${wanthatEnv.name}-app`,
      corsPreflight: {
        allowOrigins: webOrigins(wanthatEnv),
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST, CorsHttpMethod.PATCH],
        allowHeaders: ["content-type", "authorization"],
        maxAge: Duration.hours(1),
      },
    });
    // Per-surface request throttling — tuned centrally in config.ts (THROTTLING).
    applyThrottle(this.httpApi, THROTTLING.userWallet);

    // Unauthenticated: liveness + the token-issuing auth flow.
    this.httpApi.addRoutes({ path: "/healthz", methods: [HttpMethod.GET], integration });
    this.httpApi.addRoutes({
      path: "/auth/{proxy+}",
      methods: [HttpMethod.POST],
      integration,
    });
    // Everything else behind the JWT authorizer. Explicit methods (NOT ANY) so `OPTIONS` has no
    // matching route and falls through to API Gateway's built-in CORS preflight handler — an ANY
    // route would swallow the preflight into the authorizer and 401 it (breaking browser CORS).
    this.httpApi.addRoutes({
      path: "/{proxy+}",
      methods: [
        HttpMethod.GET,
        HttpMethod.POST,
        HttpMethod.PUT,
        HttpMethod.PATCH,
        HttpMethod.DELETE,
      ],
      integration,
      authorizer,
    });

    new CfnOutput(this, "AppApiUrl", { value: this.httpApi.apiEndpoint });
    new CfnOutput(this, "UserPoolId", { value: props.userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: props.userPoolClient.userPoolClientId });
  }
}
