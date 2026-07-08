import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as cr from "aws-cdk-lib/custom-resources";
import type { Construct } from "constructs";
import {
  LAMBDA_ARCHITECTURE,
  LAMBDA_RUNTIME,
  serviceEntry,
  serviceLogGroup,
  type WanthatEnv,
  webOrigins,
} from "./config";

export interface IdentityStackProps extends StackProps {
  readonly wanthatEnv: WanthatEnv;
  /** From DataStack — message-sender reads whatsapp.phoneNumberId at send time (ADR-0019). */
  readonly runtimeConfigTable: dynamodb.ITable;
  /** From DataStack — message-sender's dev-only OTP park (docs/dev-otp-sink.md), write-only grant. */
  /** Dev OTP sink table — absent in prod by design (fail-closed; docs/dev-otp-sink.md). */
  readonly devOtpSinkTable?: dynamodb.ITable;
}

/** Per-env SNS monthly SMS spend hard cap (USD), the kill-switch fail-safe (ADR-0006 layer 4). */
export const SMS_MONTHLY_SPEND_LIMIT_USD: Record<WanthatEnv["name"], number> = {
  dev: 1,
  // Capped at the SMS-sandbox account ceiling ($1). Raise to 25 once AWS lifts the account-level SMS
  // monthly spend limit (support case) and the account exits the SMS sandbox.
  prod: 1,
};

/**
 * IdentityStack — Cognito (ADR-0006, ADR-0006).
 *
 * A passwordless user pool: phone-first sign-in with native SMS OTP **and** passkeys as first-auth
 * factors (the choice-based `USER_AUTH` flow), Essentials feature plan. The public SPA app client
 * carries the JWT as a Bearer header (no secret, ADR-0007). Managed Login (hosted UI) is provisioned
 * for the userless/discoverable passkey path (PR4 reconciles it with the API-driven contract).
 *
 * No Post-Confirmation trigger (ADR-0006): the `customer` row is provisioned by `/auth/register`,
 * since `first_name`/`last_name` are only known then. The SMS kill switch is the DynamoDB
 * `auth.smsEnabled` config key (read by app-api), backstopped here by the SNS monthly spend cap.
 *
 * **Two pools, by population (ADR-0006 §two-pool).** Customers and employees are different
 * populations with different trust levels and lifecycles, so they get separate user pools rather than
 * one pool split by group. The `employeePool` below is for company staff: **no self-signup**
 * (provisioned only), email + **mandatory TOTP MFA** (no SMS), its own Managed Login hosted UI. The
 * admin API authorizer points at this pool (Slice 6), so a customer token structurally can't reach
 * `/admin` — a boundary, not just an in-handler check. First admin is bootstrapped out-of-band
 * (`admin-create-user` + add to the `admin` group); see the runbook.
 */
export class IdentityStack extends Stack {
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;
  readonly userPoolDomain: cognito.UserPoolDomain;
  // Separate employee/admin pool (ADR-0006 §two-pool): company staff, not customers.
  readonly employeePool: cognito.UserPool;
  readonly employeePoolClient: cognito.UserPoolClient;
  readonly employeePoolDomain: cognito.UserPoolDomain;
  /** ADR-0019: the Cognito custom-SMS-sender executor — observed by ObservabilityStack. */
  readonly messageSenderFn: lambda.Function;

  constructor(scope: Construct, id: string, props: IdentityStackProps) {
    super(scope, id, props);
    const { wanthatEnv } = props;
    const isProd = wanthatEnv.name === "prod";

    // ADR-0019: Cognito encrypts the OTP code for the custom sender trigger with this key (via
    // the AWS Encryption SDK); message-sender holds the decrypt grant. Fixed cost ~1 USD/month.
    const customSenderKey = new kms.Key(this, "CustomSenderKey", {
      enableKeyRotation: true,
      description: `wanthat-${wanthatEnv.name} Cognito custom-sender OTP code encryption (ADR-0019)`,
    });

    this.userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `wanthat-${wanthatEnv.name}`,
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      signInAliases: { phone: true, email: true },
      standardAttributes: {
        phoneNumber: { required: true, mutable: true },
        email: { required: false, mutable: true },
      },
      // ADR-0019: the OTP delivery channel for the message-sender trigger. Written by app-auth on
      // every /auth/start + /auth/resend; the sender FAILS if it is missing (never defaults).
      customAttributes: {
        otpChannel: new cognito.StringAttribute({ mutable: true, minLen: 3, maxLen: 8 }),
      },
      customSenderKmsKey: customSenderKey,
      // Choice-based first-auth factors (ADR-0006). `password` MUST be true even for a passwordless
      // pool (Cognito requirement); we simply never enable the userPassword flow on the client, so no
      // password is ever accepted at the API.
      signInPolicy: {
        allowedFirstAuthFactors: { password: true, smsOtp: true, passkey: true },
      },
      // FaceID/TouchID, platform authenticators, verification required (ADR-0006). The relying-party
      // id must match the SPA origin: prod = the apex domain; dev defers to PR4 (Cognito defaults to
      // the managed-login domain until the CloudFront origin is wired).
      passkeyUserVerification: cognito.PasskeyUserVerification.REQUIRED,
      // WebAuthn binds a passkey to a single relying-party id (one origin), so we point it at the
      // deployed site domain (prod apex / dev subdomain). Passkeys therefore work on that hosted
      // origin, not on localhost — but localhost keeps SMS-OTP login (a first-auth factor) working.
      ...(wanthatEnv.domainName ? { passkeyRelyingPartyId: wanthatEnv.domainName } : {}),
      // Let CDK create the SNS publish role Cognito uses to send OTP SMS.
      enableSmsRole: true,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    // Authorisation groups (ADR-0002): `admin` gates the admin API; `user` is the default member set.
    new cognito.UserPoolGroup(this, "AdminGroup", {
      userPool: this.userPool,
      groupName: "admin",
      precedence: 0,
    });
    new cognito.UserPoolGroup(this, "UserGroup", {
      userPool: this.userPool,
      groupName: "user",
      precedence: 10,
    });

    // ADR-0019: pure OTP executor. IMPORTANT: once this trigger is attached, Cognito sends NO SMS
    // natively - this function owns ALL OTP delivery (WhatsApp via End User Messaging Social, SMS
    // via SNS Publish), routed ONLY by the custom:otpChannel attribute. It reads no kill switches
    // and never falls back across channels; a throw fails the callers AdminInitiateAuth, which
    // app-auth maps to send_failed (spec rev 2).
    const messageSenderFn = new NodejsFunction(this, "MessageSender", {
      functionName: `wanthat-${wanthatEnv.name}-message-sender`,
      entry: serviceEntry("message-sender"),
      handler: "handler",
      runtime: LAMBDA_RUNTIME,
      architecture: LAMBDA_ARCHITECTURE,
      memorySize: 256,
      timeout: Duration.seconds(10),
      tracing: lambda.Tracing.ACTIVE,
      logGroup: serviceLogGroup(this, "MessageSenderLogs", wanthatEnv),
      // Non-VPC: Cognito-invoked; reaches KMS, DynamoDB, SNS and the End User Messaging Social
      // endpoint over public AWS endpoints (ADR-0004 NAT-free).
      environment: {
        WANTHAT_ENV: wanthatEnv.name,
        RUNTIME_CONFIG_TABLE: props.runtimeConfigTable.tableName,
        // Absent in prod (no table exists there) - the handler treats absence as sink-disabled.
        ...(props.devOtpSinkTable ? { DEV_OTP_SINK_TABLE: props.devOtpSinkTable.tableName } : {}),
        KMS_KEY_ARN: customSenderKey.keyArn,
        // End User Messaging Social is not available in il-central-1; Frankfurt is the closest
        // supported endpoint. Deploy-time by design (moving regions is a redeploy either way).
        WHATSAPP_SOCIAL_REGION: "eu-central-1",
      },
      bundling: { minify: true, sourceMap: true },
    });
    this.messageSenderFn = messageSenderFn;
    customSenderKey.grantDecrypt(messageSenderFn);
    props.runtimeConfigTable.grantReadData(messageSenderFn);
    // Write-only — the read path is the developer AWS CLI (docs/dev-otp-sink.md), not the app.
    // No grant at all in prod: the table does not exist there (fail-closed).
    props.devOtpSinkTable?.grantWriteData(messageSenderFn);
    // sns:Publish scoped away from every topic ARN = direct-to-phone SMS only.
    messageSenderFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["sns:Publish"],
        notResources: ["arn:aws:sns:*:*:*"],
      }),
    );
    // The phone-number-id resource exists only after onboarding, hence "*".
    messageSenderFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["social-messaging:SendWhatsAppMessage"],
        resources: ["*"],
      }),
    );
    this.userPool.addTrigger(cognito.UserPoolOperation.CUSTOM_SMS_SENDER, messageSenderFn);

    // Browser origins allowed to complete the hosted-UI OAuth redirect — the same list the app/admin
    // HTTP APIs allow for CORS (shared helper, so callbacks and CORS can't drift apart).
    const origins = webOrigins(wanthatEnv);

    // Public SPA client: no secret; only the choice-based USER_AUTH flow (ADR-0006) — never
    // userSrp/userPassword/custom. Token revocation on so /auth/signout can revoke refresh tokens.
    const callbackUrls = origins.map((o) => `${o}/auth/callback`);
    this.userPoolClient = this.userPool.addClient("Spa", {
      userPoolClientName: `wanthat-${wanthatEnv.name}-spa`,
      generateSecret: false,
      // `user` = the choice-based USER_AUTH OTP flow. `adminUserPassword` enables the ADR-0006
      // passkey->token bridge (Cognito.passkeyAdminAuth): app-auth sets an ephemeral password and
      // exchanges it for tokens after verifying the assertion. This is an ADMIN-only flow — it is not
      // reachable from the browser (the SPA never sees a password) — the admin token exchange (ADR-0006
      // decision 3), our ESSENTIALS pool doesn't support the custom-challenge trigger bridge it replaced.
      authFlows: { user: true, adminUserPassword: true },
      enableTokenRevocation: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      // OAuth is only for the Managed Login passkey redirect path (PR4); the SPA's primary flow is the
      // API-driven /auth/* JSON contract. Callback URLs are finalised in PR4 once the origin is fixed.
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.PHONE, cognito.OAuthScope.PROFILE],
        callbackUrls,
        logoutUrls: callbackUrls,
      },
    });

    // Managed Login (hosted UI) for userless/discoverable passkey login (ADR-0006 decision 3). Domain
    // prefix is unique per env within the account; prod can move to a custom domain in PR4.
    this.userPoolDomain = this.userPool.addDomain("ManagedLoginDomain", {
      cognitoDomain: { domainPrefix: `wanthat-${wanthatEnv.name}` },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });
    // Use Cognito's default branding for the new managed login UI (no custom assets in MVP).
    new cognito.CfnManagedLoginBranding(this, "ManagedLoginBranding", {
      userPoolId: this.userPool.userPoolId,
      clientId: this.userPoolClient.userPoolClientId,
      useCognitoProvidedValues: true,
    });

    // SNS monthly SMS spend hard cap (ADR-0006 layer 4) — account/region-level, so set via an SDK
    // call. DefaultSMSType Transactional prioritises OTP delivery over throughput.
    new cr.AwsCustomResource(this, "SmsSpendLimit", {
      onUpdate: {
        service: "SNS",
        action: "setSMSAttributes",
        parameters: {
          attributes: {
            MonthlySpendLimit: String(SMS_MONTHLY_SPEND_LIMIT_USD[wanthatEnv.name]),
            DefaultSMSType: "Transactional",
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of(`wanthat-${wanthatEnv.name}-sms-attrs`),
      },
      // Setting MonthlySpendLimit via SNS is now brokered by AWS End User Messaging, so the call also
      // needs the sms-voice spend-limit action — which fromSdkCalls would NOT derive (it sees only the
      // SNS action). Grant both explicitly.
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ["sns:SetSMSAttributes", "sms-voice:SetTextMessageSpendLimitOverride"],
          resources: ["*"],
        }),
      ]),
      // sns:setSMSAttributes is in Lambda's built-in SDK; no need to fetch the latest at deploy.
      installLatestAwsSdk: false,
    });

    // WebAuthn relying-party ID (ADR-0006 passkeys). The L2 `passkeyRelyingPartyId` prop above maps
    // to CfnUserPool.WebAuthnRelyingPartyID, but that does NOT apply to an already-created pool:
    // CloudFormation carries the value yet the live pool's WebAuthnConfiguration stays null, so
    // Cognito hands out rp.id = the managed-login domain (e.g. wanthat-dev.auth...amazoncognito.com),
    // which is not a registrable suffix of the SPA origin (dev.wanthat.app) - so the browser rejects
    // navigator.credentials.create() with a SecurityError before the Face ID sheet appears, and no
    // passkey can ever enrol. SetUserPoolMfaConfig is the API that actually writes the RP ID onto an
    // existing pool (per the WebAuthnConfigurationType docs), so we enforce it here. MFA stays OFF
    // (SMS is a first-factor OTP via SignInPolicy, not an MFA factor), so clearing the MFA-side SMS
    // config is a no-op for the OTP login path. Only where the env has a real site domain to bind to.
    if (wanthatEnv.domainName) {
      const rpId = wanthatEnv.domainName;
      new cr.AwsCustomResource(this, "WebAuthnRelyingParty", {
        onUpdate: {
          service: "CognitoIdentityServiceProvider",
          action: "setUserPoolMfaConfig",
          parameters: {
            UserPoolId: this.userPool.userPoolId,
            MfaConfiguration: "OFF",
            WebAuthnConfiguration: { RelyingPartyId: rpId, UserVerification: "required" },
          },
          // RP id in the physical id so a domain change re-applies the config on the next deploy.
          physicalResourceId: cr.PhysicalResourceId.of(
            `wanthat-${wanthatEnv.name}-webauthn-rp-${rpId}`,
          ),
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ["cognito-idp:SetUserPoolMfaConfig"],
            resources: [this.userPool.userPoolArn],
          }),
        ]),
        // WebAuthnConfiguration on SetUserPoolMfaConfig is a recent API param; fetch a current SDK at
        // deploy so it is not silently dropped by an older bundled SDK (which would leave rp.id wrong).
        installLatestAwsSdk: true,
      });
    }

    // The SPA needs these to build the Managed Login authorize URL for discoverable passkey login.
    new CfnOutput(this, "ManagedLoginBaseUrl", { value: this.userPoolDomain.baseUrl() });
    new CfnOutput(this, "UserPoolClientIdOut", { value: this.userPoolClient.userPoolClientId });

    // --- Employee/admin pool (ADR-0006 §two-pool) — staff identities, isolated from customers ---
    this.employeePool = new cognito.UserPool(this, "EmployeePool", {
      userPoolName: `wanthat-${wanthatEnv.name}-employees`,
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      selfSignUpEnabled: false, // staff are provisioned (admin-create-user), never self-signup
      signInAliases: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      autoVerify: { email: true },
      // Privileged access → MFA mandatory, TOTP only (no SMS — keeps staff auth off the SMS abuse
      // surface the customer pool is hardened against).
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { sms: false, otp: true },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    // Every employee is an admin for the MVP; the group leaves room for finer roles later (support…).
    new cognito.UserPoolGroup(this, "EmployeeAdminGroup", {
      userPool: this.employeePool,
      groupName: "admin",
      precedence: 0,
    });

    // Admin SPA client: public (no secret), OAuth code+PKCE via the hosted UI; shorter refresh TTL
    // than customers (privileged). The admin SPA serves its callback at /admin/callback.
    const adminCallbackUrls = origins.map((o) => `${o}/admin/callback`);
    this.employeePoolClient = this.employeePool.addClient("AdminSpa", {
      userPoolClientName: `wanthat-${wanthatEnv.name}-admin-spa`,
      generateSecret: false,
      authFlows: { user: true },
      enableTokenRevocation: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(7),
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: adminCallbackUrls,
        logoutUrls: adminCallbackUrls,
      },
    });

    // Hosted UI (email + password + TOTP) for staff login — separate domain prefix from customers.
    this.employeePoolDomain = this.employeePool.addDomain("AdminLoginDomain", {
      cognitoDomain: { domainPrefix: `wanthat-${wanthatEnv.name}-admin` },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });
    new cognito.CfnManagedLoginBranding(this, "AdminLoginBranding", {
      userPoolId: this.employeePool.userPoolId,
      clientId: this.employeePoolClient.userPoolClientId,
      useCognitoProvidedValues: true,
    });

    new CfnOutput(this, "EmployeePoolIdOut", { value: this.employeePool.userPoolId });
    new CfnOutput(this, "AdminLoginBaseUrl", { value: this.employeePoolDomain.baseUrl() });
    new CfnOutput(this, "AdminSpaClientIdOut", {
      value: this.employeePoolClient.userPoolClientId,
    });
  }
}
