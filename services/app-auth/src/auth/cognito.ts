import { randomBytes } from "node:crypto";
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
  RevokeTokenCommand,
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
 * Thin wrapper over the Cognito admin APIs (ADR-0006/0020/0021/0024). All server-side (no app-client
 * secret); the non-VPC `app-auth` edge reaches Cognito over the public AWS endpoint (Managed Login
 * disables PrivateLink, ADR-0021). The unified flow creates a user on the fly for an unseen phone,
 * then drives the choice-based USER_AUTH SMS-OTP flow. Passkeys are no longer a Cognito WEB_AUTHN
 * challenge (ADR-0024): `app-auth` owns the WebAuthn ceremony itself against our own
 * `passkey_credential` store, then bridges into Cognito via `passkeyCustomAuth`'s CUSTOM_AUTH flow
 * purely to mint tokens.
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

  /** The E.164 phone (sign-in alias) for a user by username, or null. Fills the passkey-login ticket. */
  async getPhone(username: string): Promise<string | null> {
    try {
      const res = await this.client.send(
        new AdminGetUserCommand({ UserPoolId: this.userPoolId, Username: username }),
      );
      return res.UserAttributes?.find((a) => a.Name === "phone_number")?.Value ?? null;
    } catch (err) {
      if (err instanceof UserNotFoundException) return null;
      throw err;
    }
  }

  /**
   * Create a CONFIRMED user for a new phone (ADR-0020): suppressed invite + a random permanent
   * password the member never uses (auth is passwordless OTP/passkey).
   *
   * The pool uses `UsernameAttributes: [email, phone_number]` (ADR-0006), so the phone IS the sign-in
   * username at create time — a UUID is rejected ("Username should be either an email or a phone
   * number"). Cognito then assigns an immutable internal username (returned as `User.Username`) which
   * we use for all subsequent admin calls; the phone lives on as the `phone_number` attribute.
   */
  async createUser(phone: string): Promise<CognitoUser> {
    const created = await this.client.send(
      new AdminCreateUserCommand({
        UserPoolId: this.userPoolId,
        Username: phone,
        MessageAction: "SUPPRESS",
        UserAttributes: [
          { Name: "phone_number", Value: phone },
          { Name: "phone_number_verified", Value: "true" },
        ],
      }),
    );
    const username = created.User?.Username;
    const sub = created.User?.Attributes?.find((a) => a.Name === "sub")?.Value;
    if (!username || !sub) throw new Error("AdminCreateUser returned no username/sub");
    await this.client.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: this.userPoolId,
        Username: username,
        Password: `${randomBytes(24).toString("base64url")}aA1!`,
        Permanent: true,
      }),
    );
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

  /**
   * Mint tokens for an already-verified passkey login (ADR-0024). `app-auth` verified the WebAuthn
   * assertion itself, then proves it to Cognito's CUSTOM_AUTH triggers via a short-lived HMAC proof
   * passed as the challenge ANSWER. `username` is the Cognito username stored with the credential.
   */
  async passkeyCustomAuth(username: string, proof: string): Promise<AuthenticationResultType> {
    const init = await this.client.send(
      new AdminInitiateAuthCommand({
        UserPoolId: this.userPoolId,
        ClientId: this.clientId,
        AuthFlow: "CUSTOM_AUTH",
        AuthParameters: { USERNAME: username },
      }),
    );
    if (!init.Session) throw new Error("passkeyCustomAuth: no session from CUSTOM_AUTH initiate");
    const res = await this.client.send(
      new AdminRespondToAuthChallengeCommand({
        UserPoolId: this.userPoolId,
        ClientId: this.clientId,
        ChallengeName: "CUSTOM_CHALLENGE",
        Session: init.Session,
        ChallengeResponses: { USERNAME: username, ANSWER: proof },
      }),
    );
    if (!res.AuthenticationResult) throw new Error("passkeyCustomAuth: no AuthenticationResult");
    return res.AuthenticationResult;
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
}

/** The Cognito error names the router treats as "the user mistyped the OTP" (uniform 401). */
export const OTP_REJECTION_ERRORS = new Set([
  "CodeMismatchException",
  "ExpiredCodeException",
  "NotAuthorizedException",
]);
