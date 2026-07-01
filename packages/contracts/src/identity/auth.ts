import { z } from "zod";
import { PhoneE164 } from "../common";
import { CustomerProfile } from "./customer";
import {
  Passkey,
  PasskeyAuthenticator,
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
} from "./passkey";
import { AuthTokens } from "./tokens";

/** A signed-in session payload: tokens + the member's profile. */
export const AuthSession = z.object({ tokens: AuthTokens, customer: CustomerProfile });
export type AuthSession = z.infer<typeof AuthSession>;

// POST /auth/start — phone-only entry (login-or-register, uniform/enumeration-safe).
export const AuthStartBody = z.object({ phone: PhoneE164 });
export type AuthStartBody = z.infer<typeof AuthStartBody>;

export const AuthStartResponse = z.object({
  challengeId: z.string(),
  resendAfterSec: z.number().int().nonnegative(),
  expiresInSec: z.number().int().positive(),
});
export type AuthStartResponse = z.infer<typeof AuthStartResponse>;

// POST /auth/resend — resend OTP under a server-enforced cooldown.
export const AuthResendBody = z.object({ challengeId: z.string() });
export type AuthResendBody = z.infer<typeof AuthResendBody>;

export const AuthResendResponse = z.object({
  resendAfterSec: z.number().int().nonnegative(),
  expiresInSec: z.number().int().positive(),
});
export type AuthResendResponse = z.infer<typeof AuthResendResponse>;

// POST /auth/verify — verify OTP; branches on whether the phone is new.
export const AuthVerifyBody = z.object({
  challengeId: z.string(),
  code: z.string().regex(/^\d{6}$/, "6-digit OTP"),
});
export type AuthVerifyBody = z.infer<typeof AuthVerifyBody>;

// `/auth/verify` runs on the non-VPC `app-auth` edge (Cognito-only, ADR-0021), which cannot read
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

export const PasskeyRegisterOptionsResponse = z.object({
  options: PublicKeyCredentialCreationOptionsJSON,
});
export type PasskeyRegisterOptionsResponse = z.infer<typeof PasskeyRegisterOptionsResponse>;

// POST /auth/passkey/register/verify — finish passkey enrolment.
export const PasskeyRegisterVerifyBody = z.object({ credential: RegistrationResponseJSON });
export type PasskeyRegisterVerifyBody = z.infer<typeof PasskeyRegisterVerifyBody>;

export const PasskeyRegisterVerifyResponse = z.object({ passkey: Passkey });
export type PasskeyRegisterVerifyResponse = z.infer<typeof PasskeyRegisterVerifyResponse>;
