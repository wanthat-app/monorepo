import { z } from "zod";
import { PhoneE164 } from "../common";
import { CustomerProfile } from "./customer";
import {
  AuthenticationResponseJSON,
  Passkey,
  PasskeyAuthenticator,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "./passkey";
import { AuthTokens } from "./tokens";

/**
 * A signed-in session payload: tokens + the member's profile.
 * @deprecated removed by ADR-0006, deleted in T8
 */
export const AuthSession = z.object({ tokens: AuthTokens, customer: CustomerProfile });
/** @deprecated removed by ADR-0006, deleted in T8 */
export type AuthSession = z.infer<typeof AuthSession>;

/**
 * OTP delivery channel (ADR-0019). Survives ADR-0006 as the `custom:otpChannel` user
 * attribute (set at SignUp, edited from the profile) and the message-sender's enforcement
 * input — only the per-request `/auth/start` channel field dies with the proxy.
 */
export const OtpChannel = z.enum(["whatsapp", "sms"]);
export type OtpChannel = z.infer<typeof OtpChannel>;

/** Languages our Meta templates are approved in (ADR-0019). */
export const MessageLanguage = z.enum(["he", "en"]);
export type MessageLanguage = z.infer<typeof MessageLanguage>;

// GET /auth/config — the public projection the SPA renders the channel choice from. Advisory
// only: /auth/start re-checks the same availability predicate server-side.
/** @deprecated removed by ADR-0006, deleted in T8 */
export const AuthConfigResponse = z.object({
  channels: z.array(OtpChannel),
  defaultChannel: OtpChannel.nullable(),
});
/** @deprecated removed by ADR-0006, deleted in T8 */
export type AuthConfigResponse = z.infer<typeof AuthConfigResponse>;

// POST /auth/start — phone-only entry (login-or-register, uniform/enumeration-safe). `locale` is
// the SPA's active UI language; app-auth writes it to the Cognito `locale` attribute so the
// message-sender picks the template language (app-core is in-VPC and cannot, ADR-0006).
/** @deprecated removed by ADR-0006, deleted in T8 */
export const AuthStartBody = z.object({
  phone: PhoneE164,
  channel: OtpChannel,
  locale: MessageLanguage.optional(),
});
/** @deprecated removed by ADR-0006, deleted in T8 */
export type AuthStartBody = z.infer<typeof AuthStartBody>;

/** @deprecated removed by ADR-0006, deleted in T8 */
export const AuthStartResponse = z.object({
  challengeId: z.string(),
  resendAfterSec: z.number().int().nonnegative(),
  expiresInSec: z.number().int().positive(),
  /** The channel the OTP was submitted through (optimistic send — delivery is async). */
  channel: OtpChannel,
});
/** @deprecated removed by ADR-0006, deleted in T8 */
export type AuthStartResponse = z.infer<typeof AuthStartResponse>;

// POST /auth/resend — resend under a server-enforced cooldown. `channel` is required and MAY
// differ from the original request: "didn't get it on WhatsApp? send via SMS" is this field.
/** @deprecated removed by ADR-0006, deleted in T8 */
export const AuthResendBody = z.object({ challengeId: z.string(), channel: OtpChannel });
/** @deprecated removed by ADR-0006, deleted in T8 */
export type AuthResendBody = z.infer<typeof AuthResendBody>;

/** @deprecated removed by ADR-0006, deleted in T8 */
export const AuthResendResponse = z.object({
  resendAfterSec: z.number().int().nonnegative(),
  expiresInSec: z.number().int().positive(),
  channel: OtpChannel,
});
/** @deprecated removed by ADR-0006, deleted in T8 */
export type AuthResendResponse = z.infer<typeof AuthResendResponse>;

// POST /auth/verify — verify OTP; branches on whether the phone is new.
/** @deprecated removed by ADR-0006, deleted in T8 */
export const AuthVerifyBody = z.object({
  challengeId: z.string(),
  // Cognito USER_AUTH sign-in OTP (SMS_OTP/EMAIL_OTP) codes are 8 digits (sign-up verification is 6).
  code: z.string().regex(/^\d{8}$/, "8-digit OTP"),
});
/** @deprecated removed by ADR-0006, deleted in T8 */
export type AuthVerifyBody = z.infer<typeof AuthVerifyBody>;

// `/auth/verify` runs on the non-VPC `app-auth` edge (Cognito-only), which cannot read
// Aurora — so it cannot decide login-vs-register. On success it just hands off a signed, self-contained
// ticket; the client then calls `/auth/session` to resolve it. (The login-vs-register decision moved
// there from `/auth/verify`.)
/** @deprecated removed by ADR-0006, deleted in T8 */
export const AuthVerifyResponse = z.object({ registrationTicket: z.string() });
/** @deprecated removed by ADR-0006, deleted in T8 */
export type AuthVerifyResponse = z.infer<typeof AuthVerifyResponse>;

// POST /auth/session — resolve a verify ticket to a session. Served in-VPC by `app-core`, which reads
// Aurora: an existing customer for the ticket's Cognito `sub` logs in (`authenticated`); otherwise the
// caller must complete onboarding via `/auth/register` (`registration_required`, ticket echoed back).
/** @deprecated removed by ADR-0006, deleted in T8 */
export const AuthSessionBody = z.object({ registrationTicket: z.string() });
/** @deprecated removed by ADR-0006, deleted in T8 */
export type AuthSessionBody = z.infer<typeof AuthSessionBody>;

/** @deprecated removed by ADR-0006, deleted in T8 */
export const AuthSessionResponse = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("authenticated"),
    tokens: AuthTokens,
    customer: CustomerProfile,
  }),
  z.object({
    status: z.literal("registration_required"),
    registrationTicket: z.string(),
  }),
]);
/** @deprecated removed by ADR-0006, deleted in T8 */
export type AuthSessionResponse = z.infer<typeof AuthSessionResponse>;

// POST /auth/register — complete profile (new users); locale defaults by country.
/** @deprecated removed by ADR-0006, deleted in T8 */
export const AuthRegisterBody = z.object({
  registrationTicket: z.string(),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.string().email().optional(),
  locale: z.string().optional(),
});
/** @deprecated removed by ADR-0006, deleted in T8 */
export type AuthRegisterBody = z.infer<typeof AuthRegisterBody>;

/** @deprecated removed by ADR-0006, deleted in T8 */
export const AuthRegisterResponse = AuthSession;
/** @deprecated removed by ADR-0006, deleted in T8 */
export type AuthRegisterResponse = AuthSession;

// POST /auth/passkey/register/options — begin passkey (FaceID) enrolment.
/** @deprecated removed by ADR-0006, deleted in T8 */
export const PasskeyRegisterOptionsBody = z.object({
  authenticator: PasskeyAuthenticator.default("platform"),
});
/** @deprecated removed by ADR-0006, deleted in T8 */
export type PasskeyRegisterOptionsBody = z.infer<typeof PasskeyRegisterOptionsBody>;

// The server generates + stores the challenge (single-use); the client echoes `challengeId` back at
// verify so app-auth can look it up (we owned the WebAuthn ceremony, not Cognito — reversed by ADR-0006).
/** @deprecated removed by ADR-0006, deleted in T8 */
export const PasskeyRegisterOptionsResponse = z.object({
  challengeId: z.string(),
  options: PublicKeyCredentialCreationOptionsJSON,
});
/** @deprecated removed by ADR-0006, deleted in T8 */
export type PasskeyRegisterOptionsResponse = z.infer<typeof PasskeyRegisterOptionsResponse>;

// POST /auth/passkey/register/verify — finish enrolment; app-auth verifies the attestation and stores
// our own public key (the `passkey_credential` table), not Cognito's.
/** @deprecated removed by ADR-0006, deleted in T8 */
export const PasskeyRegisterVerifyBody = z.object({
  challengeId: z.string(),
  credential: RegistrationResponseJSON,
});
/** @deprecated removed by ADR-0006, deleted in T8 */
export type PasskeyRegisterVerifyBody = z.infer<typeof PasskeyRegisterVerifyBody>;

/** @deprecated removed by ADR-0006, deleted in T8 */
export const PasskeyRegisterVerifyResponse = z.object({ passkey: Passkey });
/** @deprecated removed by ADR-0006, deleted in T8 */
export type PasskeyRegisterVerifyResponse = z.infer<typeof PasskeyRegisterVerifyResponse>;

// GET /auth/passkey/list — the signed-in member's enrolled passkeys (summaries only; the public key
// and sign counter never leave the server). Drives the SPA's "set up Face ID" prompt: it renders
// only while this list is empty, so already-enrolled members are not nagged on every visit.
/** @deprecated removed by ADR-0006, deleted in T8 */
export const PasskeyListResponse = z.object({ passkeys: z.array(Passkey) });
/** @deprecated removed by ADR-0006, deleted in T8 */
export type PasskeyListResponse = z.infer<typeof PasskeyListResponse>;

// GET /auth/passkey/login/challenge — begin a USERLESS discoverable passkey login. No
// username/phone: the discoverable credential resolves itself (userHandle = the Cognito sub). Public.
// The `options` carry an EMPTY allowCredentials + a single-use challenge; `challengeId` is echoed at
// verify. This enabled conditional UI — userless login is waived by ADR-0006.
/** @deprecated removed by ADR-0006, deleted in T8 */
export const PasskeyLoginChallengeResponse = z.object({
  challengeId: z.string(),
  options: PublicKeyCredentialRequestOptionsJSON,
});
/** @deprecated removed by ADR-0006, deleted in T8 */
export type PasskeyLoginChallengeResponse = z.infer<typeof PasskeyLoginChallengeResponse>;

// POST /auth/passkey/login/verify — app-auth verifies the assertion against the stored public key,
// resolves the sub from the credential, bridges to Cognito (the admin token exchange), and hands off
// the SAME signed ticket as /auth/verify so /auth/session resolves the member. It ALSO returns the
// minted `tokens` directly: a passkey credential maps to an existing member by construction (no
// register branch), so an Aurora-free caller — the /p/ referral landing, ADR-0007 — persists the
// session and redirects without touching /auth/session. /auth keeps exchanging the ticket (it needs
// the customer profile for /home).
/** @deprecated removed by ADR-0006, deleted in T8 */
export const PasskeyLoginVerifyBody = z.object({
  challengeId: z.string(),
  credential: AuthenticationResponseJSON,
});
/** @deprecated removed by ADR-0006, deleted in T8 */
export type PasskeyLoginVerifyBody = z.infer<typeof PasskeyLoginVerifyBody>;

/** @deprecated removed by ADR-0006, deleted in T8 */
export const PasskeyLoginVerifyResponse = z.object({
  registrationTicket: z.string(),
  tokens: AuthTokens,
});
/** @deprecated removed by ADR-0006, deleted in T8 */
export type PasskeyLoginVerifyResponse = z.infer<typeof PasskeyLoginVerifyResponse>;
