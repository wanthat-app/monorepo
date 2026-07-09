import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
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
  /** From DataStack — the post-confirmation trigger queues the optin_welcome item here (ADR-0019). */
  readonly notificationOutboxTable: dynamodb.ITable;
  /** From DataStack — guestId -> sub mapping, claimed best-effort at confirmation (ADR-0008). */
  readonly guestAttributionTable: dynamodb.ITable;
}

/** The deployed SPA origin for links in outbound messages (ADR-0019). Fails loudly without a domain. */
function appUrl(wanthatEnv: WanthatEnv): string {
  if (!wanthatEnv.domainName) throw new Error(`appUrl: env ${wanthatEnv.name} has no domainName`);
  return `https://${wanthatEnv.domainName}`;
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
 * carries the JWT as a Bearer header (no secret, ADR-0007). Self-signup is ON: the browser calls
 * the public `SignUp` API directly and registration IS SignUp (ADR-0006 decision 1) - the console
 * "anyone can sign up" warning is the product, not a misconfiguration.
 *
 * All customer PII lives in Cognito user attributes (ADR-0006 decision 3): `phone_number`,
 * `given_name`, `family_name`, `email`, `locale`, plus `custom:otpChannel`. The kill switches
 * (`auth.smsEnabled`, `auth.whatsappEnabled`, ...) are DynamoDB runtime-config keys enforced by
 * the message-sender trigger, backstopped here by the SNS monthly spend cap.
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
  // Separate employee/admin pool (ADR-0006 §two-pool): company staff, not customers.
  readonly employeePool: cognito.UserPool;
  readonly employeePoolClient: cognito.UserPoolClient;
  readonly employeePoolDomain: cognito.UserPoolDomain;
  /** ADR-0019: the Cognito custom-SMS-sender executor — observed by ObservabilityStack. */
  readonly messageSenderFn: lambda.Function;
  /** ADR-0006 decision 7: the Post-Confirmation welcome/attribution trigger — observed by ObservabilityStack. */
  readonly postConfirmationFn: lambda.Function;

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
      // ADR-0006 decision 1: registration is the public SignUp call from the SPA - no admin-created
      // customers, no backend registration endpoint. Abuse control sits at the pool boundary (WAF
      // rate rules + Cognito quotas + the SMS spend cap below), not behind a signup gate.
      selfSignUpEnabled: true,
      signInAliases: { phone: true, email: true },
      // Profile attributes ride SignUp.UserAttributes and are edited via UpdateUserAttributes
      // (ADR-0006 decision 3). All optional (NOT required): flipping an attribute to required
      // REPLACES the pool - never do that here.
      standardAttributes: {
        phoneNumber: { required: true, mutable: true },
        email: { required: false, mutable: true },
        givenName: { required: false, mutable: true },
        familyName: { required: false, mutable: true },
        locale: { required: false, mutable: true },
      },
      // ADR-0006 decision 5: the OTP delivery channel preference. Set at SignUp (rides
      // UserAttributes), edited post-auth from the profile; the message-sender trigger is the
      // enforcement point (honours it when that channel is enabled, else falls back).
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

    // ADR-0006 decision 5 (+ ADR-0019 pipeline): the OTP channel decision point. IMPORTANT: once
    // this trigger is attached, Cognito sends NO SMS natively - this function owns ALL OTP delivery
    // (WhatsApp via End User Messaging Social, SMS via SNS Publish). It reads the runtime-config
    // kill switches (auth.whatsappEnabled, auth.smsEnabled, ...), honours custom:otpChannel when
    // that channel is enabled, and falls back to the other enabled channel otherwise.
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

    // ADR-0006 decision 7: the welcome notification_outbox write (formerly /auth/register) plus the
    // best-effort guest_attribution claim move to the Post-Confirmation trigger. DynamoDB only, no
    // Aurora — which is exactly what makes a trigger acceptable here (no VPC, no cold DB resume).
    // The handler NEVER throws (it logs and returns the event), so an outbox or attribution failure
    // structurally cannot block a user's ConfirmSignUp.
    const postConfirmationFn = new NodejsFunction(this, "PostConfirmation", {
      functionName: `wanthat-${wanthatEnv.name}-post-confirmation`,
      entry: serviceEntry("post-confirmation"),
      handler: "handler",
      runtime: LAMBDA_RUNTIME,
      architecture: LAMBDA_ARCHITECTURE,
      memorySize: 256,
      timeout: Duration.seconds(10),
      tracing: lambda.Tracing.ACTIVE,
      logGroup: serviceLogGroup(this, "PostConfirmationLogs", wanthatEnv),
      // Non-VPC: Cognito-invoked; reaches DynamoDB over public AWS endpoints (ADR-0004 NAT-free).
      environment: {
        NOTIFICATION_OUTBOX_TABLE: props.notificationOutboxTable.tableName,
        GUEST_ATTRIBUTION_TABLE: props.guestAttributionTable.tableName,
        APP_URL: appUrl(wanthatEnv),
      },
      bundling: { minify: true, sourceMap: true },
    });
    this.postConfirmationFn = postConfirmationFn;
    props.notificationOutboxTable.grantWriteData(postConfirmationFn);
    props.guestAttributionTable.grantWriteData(postConfirmationFn);
    this.userPool.addTrigger(cognito.UserPoolOperation.POST_CONFIRMATION, postConfirmationFn);

    // Browser origins allowed to complete the ADMIN hosted-UI OAuth redirect — the same list the
    // app/admin HTTP APIs allow for CORS (shared helper, so callbacks and CORS can't drift apart).
    // The CUSTOMER flow has no redirect at all: the SPA calls Cognito's public API directly
    // (ADR-0006), so the customer client carries no OAuth configuration.
    const origins = webOrigins(wanthatEnv);

    // Attribute permissions for the SPA client (ADR-0006 decision 3): the profile the SPA shows is
    // the ID-token claims, and edits go through UpdateUserAttributes with the user's access token -
    // so the client needs explicit read AND write on the profile attributes + custom:otpChannel.
    // phone_number is in the WRITE set too (not only read) because it is a required attribute that
    // rides SignUp.UserAttributes (username = phone): an explicit write list that omits it would
    // reject the SignUp call itself. Post-signup phone changes still verify via VerifyUserAttribute.
    const spaProfileAttributes = { givenName: true, familyName: true, email: true, locale: true };
    const spaReadAttributes = new cognito.ClientAttributes()
      .withStandardAttributes({
        ...spaProfileAttributes,
        phoneNumber: true,
        phoneNumberVerified: true,
        emailVerified: true,
      })
      .withCustomAttributes("otpChannel");
    const spaWriteAttributes = new cognito.ClientAttributes()
      .withStandardAttributes({ ...spaProfileAttributes, phoneNumber: true })
      .withCustomAttributes("otpChannel");

    // Public SPA client: no secret; only the choice-based USER_AUTH flow (ADR-0006) — never
    // userSrp/userPassword/custom, and NO OAuth/hosted-UI: the browser drives SignUp/InitiateAuth/
    // native WEB_AUTHN against the public cognito-idp endpoint directly, so there is no redirect,
    // no callback URL, and no customer Managed Login domain. `adminUserPassword` (the former
    // passkey->token bridge) is gone with the app-owned ceremony. Token revocation on so the SPA
    // can revoke refresh tokens via RevokeToken at signout.
    this.userPoolClient = this.userPool.addClient("Spa", {
      userPoolClientName: `wanthat-${wanthatEnv.name}-spa`,
      generateSecret: false,
      authFlows: { user: true },
      // No hosted UI for customers -> no OAuth at all. Without this, CDK silently defaults to
      // implicit+code grants with an example.com callback (the L2's legacy default).
      disableOAuth: true,
      // "Prevent user existence errors" deliberately OFF (LEGACY): the SPA branches sign-in vs
      // sign-up on Cognito's real user-not-found signal (ADR-0006 - unified "enter phone" flow via
      // InitiateAuth, fall back to SignUp on unknown phone). Phone enumeration is accepted for MVP;
      // WAF rate rules on the pool + Cognito quotas + the SMS spend cap mitigate abuse.
      preventUserExistenceErrors: false,
      readAttributes: spaReadAttributes,
      writeAttributes: spaWriteAttributes,
      enableTokenRevocation: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
    });

    // ADR-0006 decision 6: abuse control at the pool boundary. A REGIONAL web ACL (same region as
    // the pool) rate-limits the UNAUTHENTICATED Cognito operations the browser calls directly —
    // the requests carry an `x-amz-target` header naming the operation — with a looser all-request
    // backstop. Thresholds are MVP guesses erring loose (IL mobile CGNAT stacks users behind one
    // IP); tune from CloudWatch sampled requests (T0 spike, 2026-07-09). CAPTCHA deferred: it
    // would require the WAF JS integration SDK in the SPA. ASCII-only names/descriptions.
    const unauthOps = [
      "SignUp",
      "ConfirmSignUp",
      "ResendConfirmationCode",
      "InitiateAuth",
      "RespondToAuthChallenge",
    ];
    const unauthOpMatch = (op: string): wafv2.CfnWebACL.StatementProperty => ({
      byteMatchStatement: {
        fieldToMatch: { singleHeader: { Name: "x-amz-target" } },
        positionalConstraint: "EXACTLY",
        searchString: `AWSCognitoIdentityProviderService.${op}`,
        textTransformations: [{ priority: 0, type: "NONE" }],
      },
    });
    const poolWebAcl = new wafv2.CfnWebACL(this, "CustomerPoolWebAcl", {
      name: `wanthat-${wanthatEnv.name}-customer-pool`,
      description: "Rate limits on the customer user pool unauthenticated operations (ADR-0006)",
      scope: "REGIONAL",
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `wanthat-${wanthatEnv.name}-customer-pool`,
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: "rate-limit-unauth-ops",
          priority: 1,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 100, // per 5 minutes (the default evaluation window), per IP
              aggregateKeyType: "IP",
              scopeDownStatement: { orStatement: { statements: unauthOps.map(unauthOpMatch) } },
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `wanthat-${wanthatEnv.name}-customer-pool-unauth`,
            sampledRequestsEnabled: true,
          },
        },
        {
          name: "rate-limit-all",
          priority: 2,
          action: { block: {} },
          statement: {
            rateBasedStatement: { limit: 500, aggregateKeyType: "IP" }, // per 5 min backstop
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `wanthat-${wanthatEnv.name}-customer-pool-all`,
            sampledRequestsEnabled: true,
          },
        },
      ],
    });
    new wafv2.CfnWebACLAssociation(this, "CustomerPoolWebAclAssociation", {
      resourceArn: this.userPool.userPoolArn,
      webAclArn: poolWebAcl.attrArn,
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
