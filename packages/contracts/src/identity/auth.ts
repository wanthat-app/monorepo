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

/** A signed-in session payload: tokens + the member's profile. */
export const AuthSession = z.object({ tokens: AuthTokens, customer: CustomerProfile });
export type AuthSession = z.infer<typeof AuthSession>;

/**
 * OTP delivery channel (ADR-0023). REQUIRED in requests — the UI picks it (from GET /auth/config)
 * and states it explicitly; the server never defaults or silently switches a channel.
 */
export const OtpChannel = z.enum(["whatsapp", "sms"]);
export type OtpChannel = z.infer<typeof OtpChannel>;

/** Languages our Meta templates are approved in (ADR-0023). */
export const MessageLanguage = z.enum(["he", "en"]);
export type MessageLanguage = z.infer<typeof MessageLanguage>;

// GET /auth/config — the public projection the SPA renders the channel choice from. Advisory
// only: /auth/start re-checks the same availability predicate server-side.
export const AuthConfigResponse = z.object({
  channels: z.array(OtpChannel),
  defaultChannel: OtpChannel.nullable(),
});
export type AuthConfigResponse = z.infer<typeof AuthConfigResponse>;

// POST /auth/start — phone-only entry (login-or-register, uniform/enumeration-safe). `locale` is
// the SPA's active UI language; app-auth writes it to the Cognito `locale` attribute so the
// message-sender picks the template language (app-core is in-VPC and cannot, ADR-0020).
export const AuthStartBody = z.object({
  phone: PhoneE164,
  channel: OtpChannel,
  locale: MessageLanguage.optional(),
});
export type AuthStartBody = z.infer<typeof AuthStartBody>;

export const AuthStartResponse = z.object({
  challengeId: z.string(),
  resendAfterSec: z.number().int().nonnegative(),
  expiresInSec: z.number().int().positive(),
  /** The channel the OTP was submitted through (optimistic send — delivery is async). */
  channel: OtpChannel,
});
export type AuthStartResponse = z.infer<typeof AuthStartResponse>;

// POST /auth/resend — resend under a server-enforced cooldown. `channel` is required and MAY
// differ from the original request: "didn't get it on WhatsApp? send via SMS" is this field.
export const AuthResendBody = z.object({ challengeId: z.string(), channel: OtpChannel });
export type AuthResendBody = z.infer<typeof AuthResendBody>;

export const AuthResendResponse = z.object({
  resendAfterSec: z.number().int().nonnegative(),
  expiresInSec: z.number().int().positive(),
  channel: OtpChannel,
});
export type AuthResendResponse = z.infer<typeof AuthResendResponse>;

// POST /auth/verify — verify OTP; branches on whether the phone is new.
export const AuthVerifyBody = z.object({
  challengeId: z.string(),
  // Cognito USER_AUTH sign-in OTP (SMS_OTP/EMAIL_OTP) codes are 8 digits (sign-up verification is 6).
  code: z.string().regex(/^\d{8}$/, "8-digit OTP"),
});
export type AuthVerifyBody = z.infer<typeof AuthVerifyBody>;

// `/auth/verify` runs on the non-VPC `app-auth` edge (Cognito-only, ADR-0020), which cannot read
// Aurora — so it cannot decide login-vs-register. On success it just hands off a signed, self-contained
// ticket; the client then calls `/auth/session` to resolve it. (The login-vs-register decision moved
// there from `/auth/verify`.)
export const AuthVerifyResponse = z.object({ registrationTicket: z.string() });
export type AuthVerifyResponse = z.infer<typeof AuthVerifyResponse>;

// POST /auth/session — resolve a verify ticket to a session. Served in-VPC by `app-core`, which reads
// Aurora: an existing customer for the ticket's Cognito `sub` logs in (`authenticated`); otherwise the
// caller must complete onboarding via `/auth/register` (`registration_required`, ticket echoed back).
export const AuthSessionBody = z.object({ registrationTicket: z.string() });
export type AuthSessionBody = z.infer<typeof AuthSessionBody>;

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
export type AuthSessionResponse = z.infer<typeof AuthSessionResponse>;

// POST /auth/register — complete profile (new users); locale defaults by country.
export const AuthRegisterBody = z.object({
  registrationTicket: z.string(),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.string().email().optional(),
  locale: z.string().optional(),
});
export type AuthRegisterBody = z.infer<typeof AuthRegisterBody>;

export const AuthRegisterResponse = AuthSession;
export type AuthRegisterResponse = AuthSession;

// POST /auth/passkey/register/options — begin passkey (FaceID) enrolment.
export const PasskeyRegisterOptionsBody = z.object({
  authenticator: PasskeyAuthenticator.default("platform"),
});
export type PasskeyRegisterOptionsBody = z.infer<typeof PasskeyRegisterOptionsBody>;

// The server generates + stores the challenge (single-use); the client echoes `challengeId` back at
// verify so app-auth can look it up (ADR-0022 — we own the WebAuthn ceremony now, not Cognito).
export const PasskeyRegisterOptionsResponse = z.object({
  challengeId: z.string(),
  options: PublicKeyCredentialCreationOptionsJSON,
});
export type PasskeyRegisterOptionsResponse = z.infer<typeof PasskeyRegisterOptionsResponse>;

// POST /auth/passkey/register/verify — finish enrolment; app-auth verifies the attestation and stores
// our own public key (the `passkey_credential` table), not Cognito's.
export const PasskeyRegisterVerifyBody = z.object({
  challengeId: z.string(),
  credential: RegistrationResponseJSON,
});
export type PasskeyRegisterVerifyBody = z.infer<typeof PasskeyRegisterVerifyBody>;

export const PasskeyRegisterVerifyResponse = z.object({ passkey: Passkey });
export type PasskeyRegisterVerifyResponse = z.infer<typeof PasskeyRegisterVerifyResponse>;

// GET /auth/passkey/list — the signed-in member's enrolled passkeys (summaries only; the public key
// and sign counter never leave the server). Drives the SPA's "set up Face ID" prompt: it renders
// only while this list is empty, so already-enrolled members are not nagged on every visit.
export const PasskeyListResponse = z.object({ passkeys: z.array(Passkey) });
export type PasskeyListResponse = z.infer<typeof PasskeyListResponse>;

// GET /auth/passkey/login/challenge — begin a USERLESS discoverable passkey login (ADR-0022). No
// username/phone: the discoverable credential resolves itself (userHandle = the Cognito sub). Public.
// The `options` carry an EMPTY allowCredentials + a single-use challenge; `challengeId` is echoed at
// verify. This enables conditional UI (Slice 2) — the passkey offers itself, no prompt.
export const PasskeyLoginChallengeResponse = z.object({
  challengeId: z.string(),
  options: PublicKeyCredentialRequestOptionsJSON,
});
export type PasskeyLoginChallengeResponse = z.infer<typeof PasskeyLoginChallengeResponse>;

// POST /auth/passkey/login/verify — app-auth verifies the assertion against the stored public key,
// resolves the sub from the credential, bridges to Cognito (the admin token exchange, ADR-0022
// decision 3), and hands off the SAME signed ticket as /auth/verify so /auth/session resolves the
// member (ADR-0020/0024). It ALSO returns the minted `tokens` directly: a passkey credential maps to
// an existing member by construction (no register branch), so an Aurora-free caller — the /p/
// referral landing, ADR-0007 — persists the session and redirects without touching /auth/session.
// /auth keeps exchanging the ticket (it needs the customer profile for /home).
export const PasskeyLoginVerifyBody = z.object({
  challengeId: z.string(),
  credential: AuthenticationResponseJSON,
});
export type PasskeyLoginVerifyBody = z.infer<typeof PasskeyLoginVerifyBody>;

export const PasskeyLoginVerifyResponse = z.object({
  registrationTicket: z.string(),
  tokens: AuthTokens,
});
export type PasskeyLoginVerifyResponse = z.infer<typeof PasskeyLoginVerifyResponse>;
