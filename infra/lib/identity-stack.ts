import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
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
 */
export class IdentityStack extends Stack {
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;
  readonly userPoolDomain: cognito.UserPoolDomain;

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
  }
}
