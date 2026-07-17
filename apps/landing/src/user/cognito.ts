import { getConfig } from "../lib/config";

/**
 * Thin browser client for the Cognito public API (ADR-0006): plain `fetch` to
 * `https://cognito-idp.<region>.amazonaws.com/` with the `X-Amz-Target` operation header —
 * no Amplify, no AWS SDK (ADR-0016). The LANDING subset of the member app's client
 * (apps/web/src/user/cognito.ts): only the returning-member ceremonies the `/p/*` page runs —
 * passkey login (InitiateAuth/RespondToAuthChallenge) and the refresh-token rehydrate. Sign-up
 * and profile edits live in the member app; the landing page links there instead.
 */
const TARGET_PREFIX = "AWSCognitoIdentityProviderService";

/**
 * Cognito exception name → the stable snake_case code the UI maps to i18n. Unlisted
 * exceptions render the generic error.
 */
const ERROR_CODES: Record<string, string> = {
  UserNotFoundException: "user_not_found",
  NotAuthorizedException: "not_authorized",
  TooManyRequestsException: "rate_limited",
  LimitExceededException: "rate_limited",
  InvalidParameterException: "invalid_request",
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

// ---------------------------------------------------------------------------
// Wire shapes (only the fields the landing page reads).
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
  /** USER_AUTH without PREFERRED_CHALLENGE: the sign-in methods this account supports. */
  AvailableChallenges?: string[];
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Start a `USER_AUTH` sign-in (ADR-0006): `PREFERRED_CHALLENGE` picks WEB_AUTHN here; without
 * it the response's `AvailableChallenges` answers "does this account have a passkey?".
 */
export function initiateUserAuth(input: {
  phone: string;
  preferredChallenge?: "SMS_OTP" | "WEB_AUTHN";
}): Promise<AuthFlowResponse> {
  return cognito("InitiateAuth", {
    ClientId: clientId(),
    AuthFlow: "USER_AUTH",
    AuthParameters: {
      USERNAME: input.phone,
      ...(input.preferredChallenge ? { PREFERRED_CHALLENGE: input.preferredChallenge } : {}),
    },
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
