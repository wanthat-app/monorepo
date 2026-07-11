import type { OtpChannel } from "@wanthat/contracts";
import { profileFromAttributes } from "./claims";
import {
  type AuthFlowResponse,
  type AuthResultWire,
  CognitoError,
  completeWebAuthnRegistration,
  confirmSignUp,
  deleteWebAuthnCredential,
  getUser,
  initiateUserAuth,
  listWebAuthnCredentials,
  resendConfirmationCode,
  respondToAuthChallenge,
  revokeToken,
  signUp,
  startWebAuthnRegistration,
  updateUserAttributes,
  verifyUserAttribute,
} from "./cognito";
import { hasDevicePasskey, markDevicePasskey } from "./passkey-device";
import {
  clearSession,
  completeSignIn,
  currentAccessToken,
  getSnapshot,
  rememberedPhone,
  setProfile,
} from "./store";
import { createCredential, getAssertion, waitForDocumentFocus } from "./webauthn";

/**
 * The module's actions — everything a page may do to the session. All Cognito ceremonies
 * live here (ADR-0006: the browser talks to Cognito directly; no app code proxies auth);
 * success mutates the session store, which `useSession()` observes.
 */

/**
 * Guest attribution handoff (ADR-0008 → ADR-0006): the landing page parks a guestId here;
 * SignUp carries it via ClientMetadata so the Post-Confirmation trigger can claim it (T6).
 */
const GUEST_KEY = "wanthat.guestId";

function readGuestId(): string | null {
  try {
    return localStorage.getItem(GUEST_KEY);
  } catch {
    return null;
  }
}

function requireAccessToken(): string {
  const token = currentAccessToken();
  if (!token) throw new CognitoError("NotAuthorizedException", "not signed in", 0);
  return token;
}

/** Unwrap a final auth response — any leftover challenge means the ceremony went sideways. */
function requireAuthResult(res: AuthFlowResponse): AuthResultWire {
  if (!res.AuthenticationResult) {
    throw new CognitoError(res.ChallengeName ?? "UnknownError", "authentication incomplete", 0);
  }
  return res.AuthenticationResult;
}

// ---------------------------------------------------------------------------
// OTP login (returning member)
// ---------------------------------------------------------------------------

/** A pending OTP sign-in: the code was sent; `submit` finishes, `resend` re-sends. */
export interface OtpLoginFlow {
  submit(code: string): Promise<void>;
  resend(): Promise<void>;
}

async function startSmsChallenge(phone: string): Promise<{ session: string; username: string }> {
  const res = await initiateUserAuth({ phone, preferredChallenge: "SMS_OTP" });
  if (res.ChallengeName !== "SMS_OTP" || !res.Session) {
    throw new CognitoError(res.ChallengeName ?? "UnknownError", "unexpected challenge", 0);
  }
  return { session: res.Session, username: res.ChallengeParameters?.USERNAME ?? phone };
}

/**
 * Start an OTP sign-in for a known phone: `InitiateAuth(USER_AUTH, SMS_OTP)` sends the code
 * (WhatsApp/SMS — the message-sender enforces the sticky channel preference, ADR-0019).
 * Throws `CognitoError` with code `user_not_found` for an unknown phone — the caller
 * branches to sign-up (ADR-0006 unified phone-first flow) — and `user_not_confirmed` for an
 * abandoned sign-up — the caller resumes confirmation via {@link resumeSignUp}.
 */
export async function loginWithOtp(phone: string): Promise<OtpLoginFlow> {
  let challenge = await startSmsChallenge(phone);
  return {
    submit: async (code) => {
      const res = await respondToAuthChallenge({
        challengeName: "SMS_OTP",
        session: challenge.session,
        responses: { USERNAME: challenge.username, SMS_OTP_CODE: code },
      });
      // A wrong code throws (CodeMismatch) and the session stays retryable; anything else
      // must be the tokens.
      completeSignIn(requireAuthResult(res));
    },
    // Cognito has no resend on a live SMS_OTP challenge — a fresh InitiateAuth IS the resend.
    resend: async () => {
      challenge = await startSmsChallenge(phone);
    },
  };
}

// ---------------------------------------------------------------------------
// Sign-up (new member) — registration IS SignUp (ADR-0006 decision 3)
// ---------------------------------------------------------------------------

export interface SignUpInput {
  phone: string;
  firstName: string;
  lastName: string;
  email?: string;
  /** BCP-47, e.g. "he-IL" — drives the message-sender template language. */
  locale: string;
  otpChannel: OtpChannel;
}

/** A pending sign-up: the confirmation code was sent; `confirm` finishes, `resend` re-sends. */
export interface SignUpFlow {
  /**
   * Confirm the code. Normally continues straight into a token mint (the ConfirmSignUp
   * session rides InitiateAuth) and resolves `"signedIn"`; if Cognito declines the seamless
   * continuation it resolves `"loginRequired"` — the caller starts a normal OTP login.
   */
  confirm(code: string): Promise<"signedIn" | "loginRequired">;
  resend(): Promise<void>;
}

function signUpFlow(phone: string, session: string | undefined): SignUpFlow {
  return {
    confirm: async (code) => {
      // The guestId must ride the CONFIRM call: Cognito forwards ConfirmSignUp's (not
      // SignUp's) ClientMetadata to the Post-Confirmation trigger, which claims the guest
      // attribution (T6). Missing guestId = the trigger just skips the claim.
      const guestId = readGuestId();
      const confirmed = await confirmSignUp({
        phone,
        code,
        session,
        ...(guestId ? { clientMetadata: { guestId } } : {}),
      });
      if (confirmed.Session) {
        const res = await initiateUserAuth({ phone, session: confirmed.Session });
        if (res.AuthenticationResult) {
          completeSignIn(res.AuthenticationResult);
          return "signedIn";
        }
      }
      return "loginRequired";
    },
    resend: async () => {
      await resendConfirmationCode(phone);
    },
  };
}

/**
 * Self-registration (ADR-0006): the whole profile rides `SignUp.UserAttributes`
 * (given_name / family_name / email / locale / custom:otpChannel), and a parked landing
 * guestId rides `ClientMetadata` for the Post-Confirmation attribution claim. Cognito sends
 * the confirmation code through the custom sender (WhatsApp/SMS per the chosen channel).
 */
export async function signUpWithOtp(input: SignUpInput): Promise<SignUpFlow> {
  const guestId = readGuestId();
  const res = await signUp({
    phone: input.phone,
    attributes: {
      phone_number: input.phone,
      given_name: input.firstName,
      family_name: input.lastName,
      locale: input.locale,
      "custom:otpChannel": input.otpChannel,
      ...(input.email ? { email: input.email } : {}),
    },
    ...(guestId ? { clientMetadata: { guestId } } : {}),
  });
  return signUpFlow(input.phone, res.Session);
}

/**
 * Resume an abandoned sign-up (the phone exists UNCONFIRMED — login threw
 * `user_not_confirmed`): re-send the confirmation code and hand back the same flow shape.
 * The profile attributes were already stored by the original SignUp call.
 */
export async function resumeSignUp(phone: string): Promise<SignUpFlow> {
  await resendConfirmationCode(phone);
  return signUpFlow(phone, undefined);
}

// ---------------------------------------------------------------------------
// Passkeys — Cognito-native WEB_AUTHN (ADR-0006 decision 2)
// ---------------------------------------------------------------------------

/**
 * Native passkey login: `InitiateAuth(USER_AUTH, WEB_AUTHN)` with the REMEMBERED phone
 * (Cognito's challenge is username-gated; userless login is waived — ADR-0006). Waits for
 * document focus before opening the sheet (iOS rejects an unfocused ceremony), so callers
 * may arm it on load and must not block rendering on the promise. Throws on cancel/failure;
 * the caller falls back to OTP.
 */
export async function loginWithPasskey(opts?: {
  /** Override the remembered phone (e.g. a just-typed one). */
  phone?: string;
  /** Fires after the biometric succeeds, before the Cognito round-trip — "signing you in…". */
  onCredential?: () => void;
}): Promise<void> {
  const phone = opts?.phone ?? rememberedPhone();
  if (!phone) throw new CognitoError("NoRememberedPhone", "passkey login needs a phone", 0);
  await waitForDocumentFocus();
  const res = await initiateUserAuth({ phone, preferredChallenge: "WEB_AUTHN" });
  if (res.ChallengeName !== "WEB_AUTHN" || !res.Session) {
    throw new CognitoError(res.ChallengeName ?? "WebAuthnNotEnabledException", "no challenge", 0);
  }
  // CREDENTIAL_REQUEST_OPTIONS is a JSON string of the request options (sometimes wrapped
  // in {publicKey}).
  const raw = JSON.parse(res.ChallengeParameters?.CREDENTIAL_REQUEST_OPTIONS ?? "{}") as {
    publicKey?: unknown;
  };
  // A ceremony failure (including NotAllowedError) deliberately leaves the per-device flag
  // alone: the browser raises the SAME NotAllowedError for a dismissed sheet as for a missing
  // credential, and clearing on it stripped an enrolled member's biometric button after one
  // cancelled prompt (leaving OTP as the only path). The flag is set only on success, so a
  // device that never enrolled still never shows the button.
  const credential = await getAssertion(raw.publicKey ?? raw);
  opts?.onCredential?.();
  const final = await respondToAuthChallenge({
    challengeName: "WEB_AUTHN",
    session: res.Session,
    responses: {
      USERNAME: res.ChallengeParameters?.USERNAME ?? phone,
      CREDENTIAL: JSON.stringify(credential),
    },
  });
  completeSignIn(requireAuthResult(final));
  markDevicePasskey();
}

/**
 * Whether the automatic/manual passkey login can work here at all (ADR-0006 gate): a phone is
 * remembered (Cognito's WEB_AUTHN challenge is username-gated) AND a passkey ceremony has
 * actually succeeded on THIS device (per-device flag — see passkey-device.ts).
 */
export function canLoginWithPasskey(): boolean {
  return hasDevicePasskey() && !!rememberedPhone();
}

/**
 * Enrol a passkey for the signed-in member: Cognito mints the creation options, the browser
 * runs the ceremony, Cognito stores + verifies the credential (no app credential store).
 */
export async function enrollPasskey(): Promise<void> {
  const token = requireAccessToken();
  const { CredentialCreationOptions } = await startWebAuthnRegistration(token);
  const options = (CredentialCreationOptions.publicKey ?? CredentialCreationOptions) as Record<
    string,
    unknown
  >;
  const credential = await createCredential(options);
  await completeWebAuthnRegistration(token, credential);
  // A credential now verifiably exists on this device — arm the biometric login gate.
  markDevicePasskey();
}

export interface PasskeySummary {
  credentialId: string;
  name: string | null;
  createdAt: string | null;
}

/** The member's enrolled passkeys — gates the home "set up Face ID" prompt (server truth). */
export async function listPasskeys(): Promise<PasskeySummary[]> {
  const { Credentials } = await listWebAuthnCredentials(requireAccessToken());
  return (Credentials ?? []).map((c) => ({
    credentialId: c.CredentialId,
    name: c.FriendlyCredentialName ?? null,
    createdAt: c.CreatedAt ? new Date(c.CreatedAt * 1000).toISOString() : null,
  }));
}

export async function removePasskey(credentialId: string): Promise<void> {
  await deleteWebAuthnCredential(requireAccessToken(), credentialId);
}

// ---------------------------------------------------------------------------
// Profile (ADR-0006 decision 3: edits via UpdateUserAttributes, display via claims)
// ---------------------------------------------------------------------------

export interface ProfilePatch {
  firstName?: string;
  lastName?: string;
  /** "" clears nothing — email removal is not offered; a new value triggers verification. */
  email?: string;
  locale?: string;
  otpChannel?: OtpChannel;
}

const ATTRIBUTE_BY_FIELD: Record<keyof ProfilePatch, string> = {
  firstName: "given_name",
  lastName: "family_name",
  email: "email",
  locale: "locale",
  otpChannel: "custom:otpChannel",
};

/**
 * Self-service profile edit. Returns whether an email verification code was sent (the
 * caller then collects it for {@link verifyEmail}). ID-token claims are stale after an
 * edit, so the displayed profile is re-read via `GetUser` (ADR-0006 stale-claims note).
 */
export async function updateProfile(patch: ProfilePatch): Promise<{ emailCodeSent: boolean }> {
  const token = requireAccessToken();
  const attributes: Record<string, string> = {};
  for (const [field, name] of Object.entries(ATTRIBUTE_BY_FIELD) as [
    keyof ProfilePatch,
    string,
  ][]) {
    const value = patch[field];
    if (value !== undefined && value !== "") attributes[name] = value;
  }
  if (Object.keys(attributes).length === 0) return { emailCodeSent: false };
  const res = await updateUserAttributes(token, attributes);
  await refreshProfile();
  const emailCodeSent = (res.CodeDeliveryDetailsList ?? []).some(
    (d) => d.AttributeName === "email",
  );
  return { emailCodeSent };
}

/** Confirm an email change with the code Cognito mailed (VerifyUserAttribute). */
export async function verifyEmail(code: string): Promise<void> {
  await verifyUserAttribute(requireAccessToken(), "email", code);
  await refreshProfile();
}

/** Re-read the profile from Cognito (`GetUser`) into the store — fresher than the claims. */
export async function refreshProfile(): Promise<void> {
  const { UserAttributes } = await getUser(requireAccessToken());
  setProfile(profileFromAttributes(UserAttributes));
}

// ---------------------------------------------------------------------------
// Sign-out
// ---------------------------------------------------------------------------

/**
 * Sign out: revoke the refresh token (best-effort — revocation is enabled on the client)
 * and drop the local session. The remembered phone survives so the next visit still gets
 * the one-prompt passkey login.
 */
export async function signOut(): Promise<void> {
  const refreshToken = getSnapshot().tokens?.refreshToken;
  clearSession();
  if (refreshToken) await revokeToken(refreshToken).catch(() => undefined);
}
