import type { OtpChannel } from "@wanthat/contracts";
import type { CognitoAttribute } from "./cognito";

/**
 * The member profile the SPA displays — decoded locally from ID-token claims (ADR-0006
 * decision 3: all customer PII lives in Cognito user attributes; no backend profile read).
 * After an attribute edit the claims are stale until the next refresh, so the same shape is
 * also built from a `GetUser` attribute list.
 */
export interface UserProfile {
  /** Cognito sub — the canonical user id (ADR-0020). */
  sub: string;
  /** E.164 phone — the sign-in identity anchor. */
  phone: string;
  firstName: string;
  lastName: string;
  email: string | null;
  /** BCP-47, e.g. "he-IL". */
  locale: string;
  /** Sticky OTP delivery preference (ADR-0019); the otp-sender enforces availability. */
  otpChannel: OtpChannel;
}

/**
 * Decode a JWT payload without verification — display only. Every claim that reaches the UI
 * is re-validated server-side (API Gateway JWT authorizer / Cognito itself), so a forged
 * token only changes what this browser shows itself. UTF-8-safe (Hebrew names): atob yields
 * latin1, so the bytes go through TextDecoder rather than straight into JSON.parse.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) return {};
  try {
    const binary = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Claim/attribute map → profile. Missing optionals degrade to ""/null, never throw. */
function profileFromMap(claims: Record<string, unknown>): UserProfile {
  const channel = str(claims["custom:otpChannel"]);
  return {
    sub: str(claims.sub),
    phone: str(claims.phone_number),
    firstName: str(claims.given_name),
    lastName: str(claims.family_name),
    email: typeof claims.email === "string" && claims.email ? claims.email : null,
    locale: str(claims.locale) || "he-IL",
    otpChannel: channel === "sms" ? "sms" : "whatsapp",
  };
}

/** The profile as carried by an ID token (the normal source — zero network). */
export function profileFromIdToken(idToken: string): UserProfile {
  return profileFromMap(decodeJwtPayload(idToken));
}

/** The profile as returned by `GetUser` — the fresh source right after an attribute edit. */
export function profileFromAttributes(attributes: CognitoAttribute[]): UserProfile {
  return profileFromMap(Object.fromEntries(attributes.map((a) => [a.Name, a.Value])));
}
