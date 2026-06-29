import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as cr from "aws-cdk-lib/custom-resources";
import type { Construct } from "constructs";
import type { WanthatEnv } from "./config";

export interface IdentityStackProps extends StackProps {
  readonly wanthatEnv: WanthatEnv;
}

/** Per-env SNS monthly SMS spend hard cap (USD), the kill-switch fail-safe (ADR-0006 layer 4). */
const SMS_MONTHLY_SPEND_LIMIT_USD: Record<WanthatEnv["name"], number> = {
  dev: 1,
  prod: 25,
};

/**
 * IdentityStack — Cognito (ADR-0006, ADR-0020).
 *
 * A passwordless user pool: phone-first sign-in with native SMS OTP **and** passkeys as first-auth
 * factors (the choice-based `USER_AUTH` flow), Essentials feature plan. The public SPA app client
 * carries the JWT as a Bearer header (no secret, ADR-0007). Managed Login (hosted UI) is provisioned
 * for the userless/discoverable passkey path (PR4 reconciles it with the API-driven contract).
 *
 * No Post-Confirmation trigger (ADR-0020): the `customer` row is provisioned by `/auth/register`,
 * since `first_name`/`last_name` are only known then. The SMS kill switch is the DynamoDB
 * `auth.smsEnabled` config key (read by app-api), backstopped here by the SNS monthly spend cap.
 *
 * **Two pools, by population (ADR-0020 §two-pool).** Customers and employees are different
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
  // Separate employee/admin pool (ADR-0020 §two-pool): company staff, not customers.
  readonly employeePool: cognito.UserPool;
  readonly employeePoolClient: cognito.UserPoolClient;
  readonly employeePoolDomain: cognito.UserPoolDomain;

  constructor(scope: Construct, id: string, props: IdentityStackProps) {
    super(scope, id, props);
    const { wanthatEnv } = props;
    const isProd = wanthatEnv.name === "prod";

    this.userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `wanthat-${wanthatEnv.name}`,
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      signInAliases: { phone: true, email: true },
      standardAttributes: {
        phoneNumber: { required: true, mutable: true },
        email: { required: false, mutable: true },
      },
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
      ...(isProd && wanthatEnv.domainName ? { passkeyRelyingPartyId: wanthatEnv.domainName } : {}),
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

    // Public SPA client: no secret; only the choice-based USER_AUTH flow (ADR-0006) — never
    // userSrp/userPassword/custom. Token revocation on so /auth/signout can revoke refresh tokens.
    const callbackUrls = isProd
      ? [`https://${wanthatEnv.domainName}/auth/callback`]
      : ["http://localhost:5173/auth/callback"];
    this.userPoolClient = this.userPool.addClient("Spa", {
      userPoolClientName: `wanthat-${wanthatEnv.name}-spa`,
      generateSecret: false,
      authFlows: { user: true },
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

    // Managed Login (hosted UI) for userless/discoverable passkey login (ADR-0020 decision 3). Domain
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
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
      // sns:setSMSAttributes is in Lambda's built-in SDK; no need to fetch the latest at deploy.
      installLatestAwsSdk: false,
    });

    // The SPA needs these to build the Managed Login authorize URL for discoverable passkey login.
    new CfnOutput(this, "ManagedLoginBaseUrl", { value: this.userPoolDomain.baseUrl() });
    new CfnOutput(this, "UserPoolClientIdOut", { value: this.userPoolClient.userPoolClientId });

    // --- Employee/admin pool (ADR-0020 §two-pool) — staff identities, isolated from customers ---
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
    const adminCallbackUrls = isProd
      ? [`https://${wanthatEnv.domainName}/admin/callback`]
      : ["http://localhost:5173/admin/callback"];
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
