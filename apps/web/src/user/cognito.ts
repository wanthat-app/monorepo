import { getConfig } from "../lib/config";

/**
 * Thin browser client for the Cognito public API (ADR-0006): plain `fetch` to
 * `https://cognito-idp.<region>.amazonaws.com/` with the `X-Amz-Target` operation header —
 * no Amplify, no AWS SDK (ADR-0016). Every ceremony the SPA runs (sign-up, OTP, passkeys,
 * refresh, profile edits) goes through here; nothing else in the app talks to Cognito.
 */
const TARGET_PREFIX = "AWSCognitoIdentityProviderService";

/**
 * Cognito exception name → the stable snake_case code the UI maps to i18n (`auth.errors.*`).
 * Unlisted exceptions render the generic error. `UserNotFoundException` is load-bearing:
 * the unified phone-first flow branches sign-in vs sign-up on it (the pool client keeps
 * "prevent user existence errors" OFF so the real signal arrives — see identity-stack).
 */
const ERROR_CODES: Record<string, string> = {
  UserNotFoundException: "user_not_found",
  UserNotConfirmedException: "user_not_confirmed",
  UsernameExistsException: "phone_exists",
  AliasExistsException: "email_exists",
  CodeMismatchException: "invalid_code",
  ExpiredCodeException: "code_expired",
  NotAuthorizedException: "not_authorized",
  TooManyRequestsException: "rate_limited",
  TooManyFailedAttemptsException: "rate_limited",
  LimitExceededException: "rate_limited",
  CodeDeliveryFailureException: "send_failed",
  InvalidParameterException: "invalid_request",
  InvalidPasswordException: "invalid_request",
  WebAuthnNotEnabledException: "invalid_passkey",
  WebAuthnChallengeNotFoundException: "invalid_passkey",
  WebAuthnClientMismatchException: "invalid_passkey",
  WebAuthnCredentialNotSupportedException: "invalid_passkey",
  WebAuthnOriginNotAllowedException: "invalid_passkey",
  WebAuthnRelyingPartyMismatchException: "invalid_passkey",
  WebAuthnConfigurationMissingException: "invalid_passkey",
};

/** A Cognito API failure. `name` is the raw exception; `code` is the UI-stable mapping. */
export class CognitoError extends Error {
  readonly code: string;
  constructor(
    exception: string,
    message: string | undefined,
    readonly status: number,
  ) {
    super(message || exception);
    this.name = exception;
    this.code = ERROR_CODES[exception] ?? "generic";
  }
}

async function cognito<T>(op: string, body: Record<string, unknown>): Promise<T> {
  const { cognitoRegion } = getConfig();
  const res = await fetch(`https://cognito-idp.${cognitoRegion}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": `${TARGET_PREFIX}.${op}`,
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    // `__type` is the exception, sometimes namespace-qualified ("com.…#UserNotFoundException").
    const exception =
      String(data.__type ?? "UnknownError")
        .split("#")
        .pop() ?? "UnknownError";
    const message = (data.message ?? data.Message) as string | undefined;
    throw new CognitoError(exception, message, res.status);
  }
  return data as T;
}

const clientId = () => getConfig().userPoolClientId;

/** `{name: value}` → Cognito's `[{Name, Value}]` attribute list. */
const toAttributeList = (attrs: Record<string, string>) =>
  Object.entries(attrs).map(([Name, Value]) => ({ Name, Value }));

// ---------------------------------------------------------------------------
// Wire shapes (only the fields the SPA reads).
// ---------------------------------------------------------------------------

export interface AuthResultWire {
  AccessToken: string;
  IdToken: string;
  /** Absent on REFRESH_TOKEN_AUTH unless the pool rotates refresh tokens. */
  RefreshToken?: string;
  ExpiresIn: number;
}

export interface AuthFlowResponse {
  AuthenticationResult?: AuthResultWire;
  ChallengeName?: string;
  Session?: string;
  ChallengeParameters?: Record<string, string>;
}

export interface CognitoAttribute {
  Name: string;
  Value: string;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Passwordless self-registration (ADR-0006 decision 1): the profile rides `UserAttributes`
 * (no Password on a choice-based pool) and the landing guestId rides `ClientMetadata` so the
 * Post-Confirmation trigger can claim the attribution (T6).
 */
export function signUp(input: {
  phone: string;
  attributes: Record<string, string>;
  clientMetadata?: Record<string, string>;
}): Promise<{ UserSub: string; Session?: string }> {
  return cognito("SignUp", {
    ClientId: clientId(),
    Username: input.phone,
    UserAttributes: toAttributeList(input.attributes),
    ...(input.clientMetadata ? { ClientMetadata: input.clientMetadata } : {}),
  });
}

/**
 * Confirm the sign-up code. The returned `Session` continues straight into InitiateAuth.
 * `clientMetadata` matters HERE (not only on SignUp): Cognito forwards the ConfirmSignUp
 * call's ClientMetadata to the Post-Confirmation trigger — the guest-attribution handoff
 * (T6) only works if this request carries the guestId.
 */
export function confirmSignUp(input: {
  phone: string;
  code: string;
  session?: string;
  clientMetadata?: Record<string, string>;
}): Promise<{ Session?: string }> {
  return cognito("ConfirmSignUp", {
    ClientId: clientId(),
    Username: input.phone,
    ConfirmationCode: input.code,
    ...(input.session ? { Session: input.session } : {}),
    ...(input.clientMetadata ? { ClientMetadata: input.clientMetadata } : {}),
  });
}

export function resendConfirmationCode(phone: string): Promise<unknown> {
  return cognito("ResendConfirmationCode", { ClientId: clientId(), Username: phone });
}

/**
 * Start a `USER_AUTH` sign-in (ADR-0006): `PREFERRED_CHALLENGE` picks SMS_OTP or WEB_AUTHN.
 * `session` continues a ConfirmSignUp session (sign-in without a second code).
 */
export function initiateUserAuth(input: {
  phone: string;
  preferredChallenge?: "SMS_OTP" | "WEB_AUTHN";
  session?: string;
}): Promise<AuthFlowResponse> {
  return cognito("InitiateAuth", {
    ClientId: clientId(),
    AuthFlow: "USER_AUTH",
    AuthParameters: {
      USERNAME: input.phone,
      ...(input.preferredChallenge ? { PREFERRED_CHALLENGE: input.preferredChallenge } : {}),
    },
    ...(input.session ? { Session: input.session } : {}),
  });
}

export function respondToAuthChallenge(input: {
  challengeName: "SMS_OTP" | "WEB_AUTHN";
  session: string;
  responses: Record<string, string>;
}): Promise<AuthFlowResponse> {
  return cognito("RespondToAuthChallenge", {
    ClientId: clientId(),
    ChallengeName: input.challengeName,
    Session: input.session,
    ChallengeResponses: input.responses,
  });
}

/** Mint fresh access/id tokens from the stored refresh token (ADR-0006: browser-direct). */
export function refreshTokens(refreshToken: string): Promise<AuthFlowResponse> {
  return cognito("InitiateAuth", {
    ClientId: clientId(),
    AuthFlow: "REFRESH_TOKEN_AUTH",
    AuthParameters: { REFRESH_TOKEN: refreshToken },
  });
}

/** Revoke a refresh token on sign-out (the pool has token revocation enabled). */
export function revokeToken(refreshToken: string): Promise<unknown> {
  return cognito("RevokeToken", { ClientId: clientId(), Token: refreshToken });
}

/** The authoritative profile read — used after edits, when ID-token claims are stale. */
export function getUser(
  accessToken: string,
): Promise<{ Username: string; UserAttributes: CognitoAttribute[] }> {
  return cognito("GetUser", { AccessToken: accessToken });
}

/** Self-service profile edit (ADR-0006 decision 3). An email change sends a verify code. */
export function updateUserAttributes(
  accessToken: string,
  attributes: Record<string, string>,
): Promise<{ CodeDeliveryDetailsList?: { AttributeName?: string }[] }> {
  return cognito("UpdateUserAttributes", {
    AccessToken: accessToken,
    UserAttributes: toAttributeList(attributes),
  });
}

export function verifyUserAttribute(
  accessToken: string,
  attributeName: string,
  code: string,
): Promise<unknown> {
  return cognito("VerifyUserAttribute", {
    AccessToken: accessToken,
    AttributeName: attributeName,
    Code: code,
  });
}

// Native passkey enrolment + inventory (ADR-0006 decision 2) — access-token authorized.

export function startWebAuthnRegistration(
  accessToken: string,
): Promise<{ CredentialCreationOptions: Record<string, unknown> }> {
  return cognito("StartWebAuthnRegistration", { AccessToken: accessToken });
}

export function completeWebAuthnRegistration(
  accessToken: string,
  credential: unknown,
): Promise<unknown> {
  return cognito("CompleteWebAuthnRegistration", {
    AccessToken: accessToken,
    Credential: credential,
  });
}

export interface WebAuthnCredentialWire {
  CredentialId: string;
  FriendlyCredentialName?: string;
  CreatedAt?: number;
}

export function listWebAuthnCredentials(
  accessToken: string,
): Promise<{ Credentials: WebAuthnCredentialWire[] }> {
  return cognito("ListWebAuthnCredentials", { AccessToken: accessToken, MaxResults: 20 });
}

export function deleteWebAuthnCredential(
  accessToken: string,
  credentialId: string,
): Promise<unknown> {
  return cognito("DeleteWebAuthnCredential", {
    AccessToken: accessToken,
    CredentialId: credentialId,
  });
}
