import { CfnOutput, CustomResource, Duration, Stack, type StackProps } from "aws-cdk-lib";
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
import { Provider } from "aws-cdk-lib/custom-resources";
import type { Construct } from "constructs";
import {
  applyThrottle,
  LAMBDA_ARCHITECTURE,
  LAMBDA_RUNTIME,
  RDS_CA_ENV,
  rdsCaBundling,
  serviceEntry,
  serviceLogGroup,
  THROTTLING,
  type WanthatEnv,
  webOrigins,
} from "./config";

/** The deployed SPA origin for links we send out (ADR-0023). Synth fails loudly on an env without a domain. */
function appUrl(wanthatEnv: WanthatEnv): string {
  if (!wanthatEnv.domainName) throw new Error(`appUrl: env ${wanthatEnv.name} has no domainName`);
  return `https://${wanthatEnv.domainName}`;
}

export interface ApiStackProps extends StackProps {
  readonly wanthatEnv: WanthatEnv;
  readonly userPool: cognito.IUserPool;
  readonly userPoolClient: cognito.IUserPoolClient;
  readonly recommendationTable: dynamodb.ITable;
  readonly guestAttributionTable: dynamodb.ITable;
  readonly runtimeConfigTable: dynamodb.ITable;
  readonly authChallengeTable: dynamodb.ITable;
  readonly phoneVelocityTable: dynamodb.ITable;
  readonly notificationOutboxTable: dynamodb.ITable;
  readonly passkeyCredentialTable: dynamodb.ITable;
  // In-VPC placement + Aurora (ADR-0004/0020/0021) — app-core only.
  readonly vpc: ec2.IVpc;
  readonly lambdaSg: ec2.ISecurityGroup;
  readonly cluster: rds.IDatabaseCluster;
}

/**
 * ApiStack — the app-api compute, split into two functions behind one HTTP API (ADR-0002, ADR-0006,
 * ADR-0011, ADR-0020, ADR-0020).
 *
 * ADR-0020 resolves Managed Login vs PrivateLink by slicing the Lambdalith along its Cognito/Aurora
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

    // Ed25519 keypair for registration tickets (ADR-0020/0021, asymmetric) - generated at deploy
    // by the ticket-keygen custom resource below, never in the repo. Only app-auth (the SIGNER)
    // reads this secret - over the free public Secrets Manager endpoint, since it is non-VPC.
    // app-core verifies with the PUBLIC key via plain env, so the VPC needs no secretsmanager
    // interface endpoint. (The secret NAME still says ticket-hmac - renaming would REPLACE the
    // secret; the generateSecretString placeholder value is overwritten by the keygen on first run.)
    const ticketSecret = new secretsmanager.Secret(this, "AuthTicketSecret", {
      secretName: `wanthat/${wanthatEnv.name}/auth/ticket-hmac`,
      description: "HMAC key signing /auth registration tickets",
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });

    // ticket-keygen (custom resource): on first run generates the Ed25519 pair into the secret and
    // returns the public key(s); on every later run it returns the EXISTING public keys untouched
    // (idempotent - a deploy must never silently rotate the signing key). Non-VPC; sourceMap off so
    // the asset hash does not churn per deploy (the db-migrator lesson).
    const keygenFn = new NodejsFunction(this, "TicketKeygen", {
      functionName: `wanthat-${wanthatEnv.name}-ticket-keygen`,
      entry: serviceEntry("ticket-keygen"),
      handler: "handler",
      runtime: LAMBDA_RUNTIME,
      architecture: LAMBDA_ARCHITECTURE,
      memorySize: 256,
      timeout: Duration.seconds(30),
      bundling: { minify: true, sourceMap: false },
    });
    ticketSecret.grantRead(keygenFn);
    ticketSecret.grantWrite(keygenFn);
    const keygenProvider = new Provider(this, "TicketKeygenProvider", { onEventHandler: keygenFn });
    const ticketKeys = new CustomResource(this, "TicketKeypair", {
      serviceToken: keygenProvider.serviceToken,
      properties: { secretArn: ticketSecret.secretArn },
    });

    // --- app-auth: NON-VPC auth edge (Cognito + DynamoDB) ---
    const appAuthFn = new NodejsFunction(this, "AppAuth", {
      functionName: `wanthat-${wanthatEnv.name}-app-auth`,
      entry: serviceEntry("app-auth"),
      handler: "handler",
      runtime: LAMBDA_RUNTIME,
      architecture: LAMBDA_ARCHITECTURE,
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
        PASSKEY_CREDENTIAL_TABLE: props.passkeyCredentialTable.tableName,
        USER_POOL_ID: props.userPool.userPoolId,
        USER_POOL_CLIENT_ID: props.userPoolClient.userPoolClientId,
        AUTH_TICKET_SECRET_ARN: ticketSecret.secretArn,
        // ADR-0022: pins the WebAuthn ceremony to this site (rpId is the registrable domain; origins
        // are the exact SPA origins) so an assertion for another origin/RP is rejected.
        WEBAUTHN_RP_ID: wanthatEnv.domainName ?? "",
        WEBAUTHN_ORIGINS: webOrigins(wanthatEnv).join(","),
      },
      bundling: { minify: true, sourceMap: true },
    });
    this.appAuthFn = appAuthFn;
    // The signer expects keypair material in the secret - make sure the keygen CR has run (and
    // overwritten the legacy HMAC placeholder) before this function's new code goes live.
    appAuthFn.node.addDependency(ticketKeys);

    // DynamoDB: auth working tables RW, guest attribution RW, config read.
    props.authChallengeTable.grantReadWriteData(appAuthFn);
    props.phoneVelocityTable.grantReadWriteData(appAuthFn);
    props.guestAttributionTable.grantReadWriteData(appAuthFn);
    props.runtimeConfigTable.grantReadData(appAuthFn);
    // ADR-0022: put on enrol, get on login, updateSignCount after login, query for exclude-list.
    props.passkeyCredentialTable.grantReadWriteData(appAuthFn);
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
      architecture: LAMBDA_ARCHITECTURE,
      memorySize: 256,
      timeout: Duration.seconds(30), // first connect may resume a scale-to-zero cluster (up to ~30s)
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
        // PUBLIC verification keys (JSON array) from the keygen custom resource - not a secret, so
        // the in-VPC core needs no Secrets Manager access at all.
        AUTH_TICKET_PUBLIC_KEYS: ticketKeys.getAttString("publicKeys"),
        DB_HOST: props.cluster.clusterEndpoint.hostname,
        DB_NAME: "wanthat",
        DB_USER: "app_rw",
        ...RDS_CA_ENV,
        NOTIFICATION_OUTBOX_TABLE: props.notificationOutboxTable.tableName,
        // Link target for outbound messages (ADR-0023): the DEPLOYED site, never webOrigins()[0]
        // (which is the localhost dev origin for non-prod envs).
        APP_URL: appUrl(wanthatEnv),
      },
      bundling: rdsCaBundling,
    });
    this.appCoreFn = appCoreFn;

    // Aurora as app_rw via IAM auth (ADR-0003) - no RDS Proxy, no static credential.
    props.cluster.grantConnect(appCoreFn, "app_rw");

    // DynamoDB: guest attribution RW (attribution claim), config read.
    props.guestAttributionTable.grantReadWriteData(appCoreFn);
    props.runtimeConfigTable.grantReadData(appCoreFn);
    // (No ticketSecret grant: verification is secretless - Ed25519 public keys via env.)
    // Outbox producer: write-only (no read grant) - the dispatcher owns status updates (ADR-0023).
    props.notificationOutboxTable.grantWriteData(appCoreFn);

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

    // DB warm-up probe -> app-core (touches Aurora). Public; the SPA fires it (fire-and-forget) on
    // landing/auth load so the scale-to-zero resume overlaps the human reading the page / doing
    // Face ID instead of serialising ~20s after the biometric.
    this.httpApi.addRoutes({
      path: "/healthz/db",
      methods: [HttpMethod.GET],
      integration: coreIntegration,
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

    // Passkey LOGIN (ADR-0022, userless discoverable) -> app-auth, PUBLIC (the assertion is the
    // credential; the user is not signed in yet). Explicit static routes so they take precedence over
    // the authorizer-protected /auth/passkey/{proxy+} enrolment route below. GET issues a single-use
    // challenge; POST verifies the assertion and bridges to Cognito tokens.
    this.httpApi.addRoutes({
      path: "/auth/passkey/login/challenge",
      methods: [HttpMethod.GET],
      integration: authIntegration,
    });
    this.httpApi.addRoutes({
      path: "/auth/passkey/login/verify",
      methods: [HttpMethod.POST],
      integration: authIntegration,
    });

    // Public channel-availability projection (ADR-0023) -> app-auth. GET, no authorizer.
    this.httpApi.addRoutes({
      path: "/auth/config",
      methods: [HttpMethod.GET],
      integration: authIntegration,
    });

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

    // TRANSITIONAL (ADR-0020 split) - REMOVE in a follow-up once every env's observability stack has
    // redeployed. The old `AppApi` Lambda was deleted, but wanthat-{env}-observability still imports its
    // ref in the currently-deployed template. CloudFormation deploys `api` before `observability`, so
    // `api` would try to delete this export while it is still in use -> "cannot delete export ... in
    // use", the failure that rolled back the dev deploy. Retaining the export for one deploy lets
    // observability migrate to app-auth/app-core first; the follow-up PR drops this line + the export.
    this.exportValue(`wanthat-${wanthatEnv.name}-app-api`, {
      name: `wanthat-${wanthatEnv.name}-api:ExportsOutputRefAppApiE7BADA0120FBA170`,
    });
  }
}
