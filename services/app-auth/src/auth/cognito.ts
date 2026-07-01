import { randomBytes, randomUUID } from "node:crypto";
import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminInitiateAuthCommand,
  AdminRespondToAuthChallengeCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  type AttributeType,
  type AuthenticationResultType,
  CognitoIdentityProviderClient,
  CompleteWebAuthnRegistrationCommand,
  RevokeTokenCommand,
  StartWebAuthnRegistrationCommand,
  UserNotFoundException,
} from "@aws-sdk/client-cognito-identity-provider";
import type { AuthTokens } from "@wanthat/contracts";

/** A located/created Cognito user — username is the opaque id; phone is an alias. */
export interface CognitoUser {
  username: string;
  sub: string;
}

/**
 * Outcome of answering the SMS-OTP challenge: `tokens` on success, or `retry` with the fresh Cognito
 * session to carry forward when the code was wrong but more attempts remain.
 */
export type RespondSmsOtpResult =
  | { kind: "tokens"; result: AuthenticationResultType }
  | { kind: "retry"; session: string };

/** Map a Cognito AuthenticationResult to the AuthTokens contract; refresh reuses the prior token. */
export function toAuthTokens(
  result: AuthenticationResultType,
  fallbackRefreshToken?: string,
): AuthTokens {
  const refreshToken = result.RefreshToken ?? fallbackRefreshToken;
  if (!result.AccessToken || !result.IdToken || !refreshToken) {
    throw new Error("cognito returned an incomplete token set");
  }
  return {
    accessToken: result.AccessToken,
    idToken: result.IdToken,
    refreshToken,
    tokenType: "Bearer",
    expiresIn: result.ExpiresIn ?? 3600,
  };
}

/**
 * Thin wrapper over the Cognito admin APIs (ADR-0006/0020/0021). All server-side (no app-client
 * secret); the non-VPC `app-auth` edge reaches Cognito over the public AWS endpoint (Managed Login
 * disables PrivateLink, ADR-0021). The unified flow creates a user on the fly for an unseen phone,
 * then drives the choice-based USER_AUTH SMS-OTP flow.
 */
export class Cognito {
  private readonly client: CognitoIdentityProviderClient;

  constructor(
    private readonly userPoolId: string,
    private readonly clientId: string,
    region?: string,
  ) {
    this.client = new CognitoIdentityProviderClient(region ? { region } : {});
  }

  /** Resolve a user by phone (an alias), or null if none exists. */
  async getUserByPhone(phone: string): Promise<CognitoUser | null> {
    try {
      const res = await this.client.send(
        new AdminGetUserCommand({ UserPoolId: this.userPoolId, Username: phone }),
      );
      const sub = res.UserAttributes?.find((a) => a.Name === "sub")?.Value;
      if (!res.Username || !sub) throw new Error("AdminGetUser returned no username/sub");
      return { username: res.Username, sub };
    } catch (err) {
      if (err instanceof UserNotFoundException) return null;
      throw err;
    }
  }

  /**
   * Create a CONFIRMED user for a new phone (ADR-0020): suppressed invite + a random permanent
   * password the member never uses (auth is passwordless OTP/passkey). Username is a UUID because
   * phone is a sign-in alias and cannot itself be the username.
   */
  async createUser(phone: string): Promise<CognitoUser> {
    const username = randomUUID();
    const created = await this.client.send(
      new AdminCreateUserCommand({
        UserPoolId: this.userPoolId,
        Username: username,
        MessageAction: "SUPPRESS",
        UserAttributes: [
          { Name: "phone_number", Value: phone },
          { Name: "phone_number_verified", Value: "true" },
        ],
      }),
    );
    await this.client.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: this.userPoolId,
        Username: username,
        Password: `${randomBytes(24).toString("base64url")}aA1!`,
        Permanent: true,
      }),
    );
    const sub = created.User?.Attributes?.find((a) => a.Name === "sub")?.Value;
    if (!sub) throw new Error("AdminCreateUser returned no sub");
    return { username, sub };
  }

  /** Begin (or resend) the SMS-OTP challenge; returns the Cognito Session to carry forward. */
  async startSmsOtp(username: string): Promise<{ session: string }> {
    const res = await this.client.send(
      new AdminInitiateAuthCommand({
        UserPoolId: this.userPoolId,
        ClientId: this.clientId,
        AuthFlow: "USER_AUTH",
        AuthParameters: { USERNAME: username, PREFERRED_CHALLENGE: "SMS_OTP" },
      }),
    );
    if (!res.Session) throw new Error("startSmsOtp: cognito returned no session");
    return { session: res.Session };
  }

  /**
   * Answer the SMS-OTP challenge. `tokens` on success; `retry` (carrying a fresh Cognito session)
   * when the code is wrong but Cognito re-issues the challenge — a wrong answer spends the session,
   * so the caller must persist the new one to keep the same challengeId usable. Throws on a terminal
   * failure (handled by the router via OTP_REJECTION_ERRORS).
   */
  async respondSmsOtp(
    username: string,
    session: string,
    code: string,
  ): Promise<RespondSmsOtpResult> {
    const res = await this.client.send(
      new AdminRespondToAuthChallengeCommand({
        UserPoolId: this.userPoolId,
        ClientId: this.clientId,
        ChallengeName: "SMS_OTP",
        Session: session,
        ChallengeResponses: { USERNAME: username, SMS_OTP_CODE: code },
      }),
    );
    if (res.AuthenticationResult) return { kind: "tokens", result: res.AuthenticationResult };
    if (res.ChallengeName && res.Session) return { kind: "retry", session: res.Session };
    throw new Error("respondSmsOtp: no AuthenticationResult");
  }

  /** Exchange a refresh token for fresh access/id tokens. */
  async refresh(refreshToken: string): Promise<AuthenticationResultType> {
    const res = await this.client.send(
      new AdminInitiateAuthCommand({
        UserPoolId: this.userPoolId,
        ClientId: this.clientId,
        AuthFlow: "REFRESH_TOKEN_AUTH",
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      }),
    );
    if (!res.AuthenticationResult) throw new Error("refresh: no AuthenticationResult");
    return res.AuthenticationResult;
  }

  /** Revoke a refresh token (sign-out). Best-effort: a bad token simply 400s upstream. */
  async revoke(refreshToken: string): Promise<void> {
    await this.client.send(
      new RevokeTokenCommand({ Token: refreshToken, ClientId: this.clientId }),
    );
  }

  /** Update standard attributes (e.g. email) for a user by username. */
  async updateAttributes(username: string, attributes: AttributeType[]): Promise<void> {
    await this.client.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: this.userPoolId,
        Username: username,
        UserAttributes: attributes,
      }),
    );
  }

  /**
   * Begin passkey (WebAuthn) enrolment for the signed-in user (ADR-0006). Authorised by the caller's
   * access token; returns the `PublicKeyCredentialCreationOptions` the browser feeds to
   * `navigator.credentials.create()`.
   */
  async startWebAuthnRegistration(accessToken: string): Promise<unknown> {
    const res = await this.client.send(
      new StartWebAuthnRegistrationCommand({ AccessToken: accessToken }),
    );
    if (!res.CredentialCreationOptions) throw new Error("no CredentialCreationOptions");
    return res.CredentialCreationOptions;
  }

  /** Finish passkey enrolment: register the browser's attestation against the signed-in user. */
  async completeWebAuthnRegistration(accessToken: string, credential: unknown): Promise<void> {
    await this.client.send(
      new CompleteWebAuthnRegistrationCommand({
        AccessToken: accessToken,
        // biome-ignore lint/suspicious/noExplicitAny: Cognito models Credential as an open document
        Credential: credential as any,
      }),
    );
  }
}

/** The Cognito error names the router treats as "the user mistyped the OTP" (uniform 401). */
export const OTP_REJECTION_ERRORS = new Set([
  "CodeMismatchException",
  "ExpiredCodeException",
  "NotAuthorizedException",
]);
