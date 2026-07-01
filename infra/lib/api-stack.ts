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
  RDS_CA_ENV,
  rdsCaBundling,
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
  // In-VPC placement + Aurora (ADR-0004/0020/0021) — app-core only.
  readonly vpc: ec2.IVpc;
  readonly lambdaSg: ec2.ISecurityGroup;
  readonly cluster: rds.IDatabaseCluster;
}

/**
 * ApiStack — the app-api compute, split into two functions behind one HTTP API (ADR-0002, ADR-0006,
 * ADR-0011, ADR-0020, ADR-0021).
 *
 * ADR-0021 resolves Managed Login vs PrivateLink by slicing the Lambdalith along its Cognito/Aurora
 * seam:
 *  - `app-auth` (NON-VPC "auth edge"): the `/auth/*` OTP + passkey flow. Reaches the Managed-Login
 *    customer pool over Cognito's public endpoint (PrivateLink is disabled for such pools) and
 *    DynamoDB over the public endpoint. Signs the registration ticket; holds no Aurora access.
 *  - `app-core` (IN-VPC "core"): `/auth/session`, `/auth/register`, `/me`, `/me/*`. Reaches Aurora as `app_rw` via IAM
 *    auth (no RDS Proxy) and DynamoDB over the gateway endpoint. Verifies the ticket; calls no
 *    Cognito, so the `cognito-idp` interface endpoint is removed (NetworkStack).
 *
 * The self-contained HMAC ticket is the sole cross-function handoff; both functions grantRead its
 * secret. A Cognito JWT authorizer guards `/me/*` and passkey enrolment; the token-issuing `/auth/*`
 * flow and `GET /healthz` stay public.
 */
export class ApiStack extends Stack {
  readonly httpApi: HttpApi;
  /** The non-VPC auth edge — observed by the ObservabilityStack (errors/throttles/duration). */
  readonly appAuthFn: lambda.Function;
  /** The in-VPC core — observed by the ObservabilityStack (errors/throttles/duration). */
  readonly appCoreFn: lambda.Function;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { wanthatEnv } = props;

    // HMAC key for registration tickets (ADR-0020/0021) - generated, never in the repo. Both
    // functions grantRead it: app-auth signs, app-core verifies.
    const ticketSecret = new secretsmanager.Secret(this, "AuthTicketSecret", {
      secretName: `wanthat/${wanthatEnv.name}/auth/ticket-hmac`,
      description: "HMAC key signing /auth registration tickets",
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });

    // --- app-auth: NON-VPC auth edge (Cognito + DynamoDB) ---
    const appAuthFn = new NodejsFunction(this, "AppAuth", {
      functionName: `wanthat-${wanthatEnv.name}-app-auth`,
      entry: serviceEntry("app-auth"),
      handler: "handler",
      runtime: LAMBDA_RUNTIME,
      memorySize: 256,
      timeout: Duration.seconds(15),
      // X-Ray tracing + an explicit retention-bounded log group (ADR-0002 observability).
      tracing: lambda.Tracing.ACTIVE,
      logGroup: serviceLogGroup(this, "AppAuthLogs", wanthatEnv),
      // No VPC: the auth edge reaches Cognito (Managed Login) + DynamoDB over public AWS endpoints.
      // No reserved concurrency: the account Lambda concurrency limit (10) is itself the cap, and this
      // function is Cognito/DynamoDB-only (no Aurora connection pressure). Re-introduce a reserved
      // budget once the account quota is raised - see infra issue (ADR-0002).
      environment: {
        WANTHAT_ENV: wanthatEnv.name,
        GUEST_ATTRIBUTION_TABLE: props.guestAttributionTable.tableName,
        RUNTIME_CONFIG_TABLE: props.runtimeConfigTable.tableName,
        AUTH_CHALLENGE_TABLE: props.authChallengeTable.tableName,
        PHONE_VELOCITY_TABLE: props.phoneVelocityTable.tableName,
        USER_POOL_ID: props.userPool.userPoolId,
        USER_POOL_CLIENT_ID: props.userPoolClient.userPoolClientId,
        AUTH_TICKET_SECRET_ARN: ticketSecret.secretArn,
      },
      bundling: { minify: true, sourceMap: true },
    });
    this.appAuthFn = appAuthFn;

    // DynamoDB: auth working tables RW, guest attribution RW, config read.
    props.authChallengeTable.grantReadWriteData(appAuthFn);
    props.phoneVelocityTable.grantReadWriteData(appAuthFn);
    props.guestAttributionTable.grantReadWriteData(appAuthFn);
    props.runtimeConfigTable.grantReadData(appAuthFn);
    ticketSecret.grantRead(appAuthFn);

    // Scoped Cognito control-plane actions on this pool only (ADR-0020).
    appAuthFn.addToRolePolicy(
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

    // --- app-core: IN-VPC core (Aurora + DynamoDB); no Cognito ---
    const appCoreFn = new NodejsFunction(this, "AppCore", {
      functionName: `wanthat-${wanthatEnv.name}-app-core`,
      entry: serviceEntry("app-core"),
      handler: "handler",
      runtime: LAMBDA_RUNTIME,
      memorySize: 256,
      timeout: Duration.seconds(15), // first connect may resume a scale-to-zero cluster
      tracing: lambda.Tracing.ACTIVE,
      logGroup: serviceLogGroup(this, "AppCoreLogs", wanthatEnv),
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.lambdaSg],
      // No reserved concurrency: the account Lambda concurrency limit (10) is itself the cap, and
      // app-core is DynamoDB-hot (Aurora holds only PII + ledger, ADR-0003), so its Aurora connection
      // pressure is minimal vs max_connections=50. Re-introduce a reserved budget once the account
      // quota is raised - see infra issue (ADR-0002).
      environment: {
        WANTHAT_ENV: wanthatEnv.name,
        GUEST_ATTRIBUTION_TABLE: props.guestAttributionTable.tableName,
        RUNTIME_CONFIG_TABLE: props.runtimeConfigTable.tableName,
        AUTH_TICKET_SECRET_ARN: ticketSecret.secretArn,
        DB_HOST: props.cluster.clusterEndpoint.hostname,
        DB_NAME: "wanthat",
        DB_USER: "app_rw",
        ...RDS_CA_ENV,
      },
      bundling: rdsCaBundling,
    });
    this.appCoreFn = appCoreFn;

    // Aurora as app_rw via IAM auth (ADR-0003) - no RDS Proxy, no static credential.
    props.cluster.grantConnect(appCoreFn, "app_rw");

    // DynamoDB: guest attribution RW (attribution claim), config read.
    props.guestAttributionTable.grantReadWriteData(appCoreFn);
    props.runtimeConfigTable.grantReadData(appCoreFn);
    ticketSecret.grantRead(appCoreFn);

    // --- One HTTP API fronting both functions ---
    const authIntegration = new HttpLambdaIntegration("AppAuthIntegration", appAuthFn);
    const coreIntegration = new HttpLambdaIntegration("AppCoreIntegration", appCoreFn);
    const authorizer = new HttpJwtAuthorizer(
      "CognitoAuthorizer",
      `https://cognito-idp.${this.region}.amazonaws.com/${props.userPool.userPoolId}`,
      { jwtAudience: [props.userPoolClient.userPoolClientId] },
    );

    // CORS so the browser SPA (a different origin than execute-api) can call /auth + /me. Without it,
    // the preflight OPTIONS falls through to an authorizer-protected route and is rejected 401, so the
    // real request never fires. API Gateway answers OPTIONS itself (no authorizer) once this is set.
    // Origins shared with the Cognito callback list (config.webOrigins).
    this.httpApi = new HttpApi(this, "HttpApi", {
      apiName: `wanthat-${wanthatEnv.name}-app`,
      corsPreflight: {
        allowOrigins: webOrigins(wanthatEnv),
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST, CorsHttpMethod.PATCH],
        allowHeaders: ["content-type", "authorization"],
        maxAge: Duration.hours(1),
      },
    });
    // Per-surface request throttling - tuned centrally in config.ts (THROTTLING).
    applyThrottle(this.httpApi, THROTTLING.userWallet);

    // Explicit methods (NOT ANY) everywhere so `OPTIONS` has no matching route and falls through to
    // API Gateway's built-in CORS preflight handler - an ANY route would swallow the preflight into
    // the authorizer and 401 it (breaking browser CORS).

    // Liveness -> the auth edge (either function serves it).
    this.httpApi.addRoutes({
      path: "/healthz",
      methods: [HttpMethod.GET],
      integration: authIntegration,
    });

    // Public, token-issuing auth flow -> app-auth. Explicit paths (no {proxy+}) so OPTIONS -> CORS.
    for (const p of [
      "/auth/start",
      "/auth/resend",
      "/auth/verify",
      "/auth/refresh",
      "/auth/signout",
    ]) {
      this.httpApi.addRoutes({ path: p, methods: [HttpMethod.POST], integration: authIntegration });
    }

    // Public registration-ticket exchange -> app-core (the ticket is the credential). `/auth/session`
    // resolves the ticket to login-vs-register (needs Aurora); `/auth/register` provisions the row.
    for (const p of ["/auth/session", "/auth/register"]) {
      this.httpApi.addRoutes({ path: p, methods: [HttpMethod.POST], integration: coreIntegration });
    }

    // Passkey enrolment -> app-auth, behind the JWT authorizer (the access token is a valid pool JWT).
    this.httpApi.addRoutes({
      path: "/auth/passkey/{proxy+}",
      methods: [HttpMethod.POST],
      integration: authIntegration,
      authorizer,
    });

    // Member profile -> app-core, behind the JWT authorizer.
    this.httpApi.addRoutes({
      path: "/me",
      methods: [HttpMethod.GET, HttpMethod.PATCH],
      integration: coreIntegration,
      authorizer,
    });
    this.httpApi.addRoutes({
      path: "/me/{proxy+}",
      methods: [HttpMethod.GET, HttpMethod.POST, HttpMethod.PATCH],
      integration: coreIntegration,
      authorizer,
    });

    new CfnOutput(this, "AppApiUrl", { value: this.httpApi.apiEndpoint });
    new CfnOutput(this, "UserPoolId", { value: props.userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: props.userPoolClient.userPoolClientId });
  }
}
