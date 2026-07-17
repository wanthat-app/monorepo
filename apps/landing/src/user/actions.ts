import {
  type AuthFlowResponse,
  type AuthResultWire,
  CognitoError,
  initiateUserAuth,
  respondToAuthChallenge,
} from "./cognito";
import { completeSignIn, rememberedPhone } from "./store";
import { getAssertion, waitForDocumentFocus } from "./webauthn";

/**
 * The landing app's auth actions — the RETURNING-MEMBER subset of the member app's actions.ts
 * (ADR-0006: the browser talks to Cognito directly; no app code proxies auth). The `/p/*`
 * page only ever signs in a member who already has a passkey on this device; everyone else is
 * linked to the member app's /auth flow. Success mutates the session store, which
 * `useSession()` observes.
 */

/** Unwrap a final auth response — any leftover challenge means the ceremony went sideways. */
function requireAuthResult(res: AuthFlowResponse): AuthResultWire {
  if (!res.AuthenticationResult) {
    throw new CognitoError(res.ChallengeName ?? "UnknownError", "authentication incomplete", 0);
  }
  return res.AuthenticationResult;
}

/**
 * Native passkey login: `InitiateAuth(USER_AUTH, WEB_AUTHN)` with the REMEMBERED phone
 * (Cognito's challenge is username-gated; native userless login is waived — ADR-0006). Waits
 * for document focus before opening the sheet (iOS rejects an unfocused ceremony), so callers
 * may arm it on load and must not block rendering on the promise. Throws on cancel/failure;
 * the caller falls back to the signed-out CTAs.
 */
export async function loginWithPasskey(opts?: {
  /** Fires after the biometric succeeds, before the Cognito round-trip — "signing you in…". */
  onCredential?: () => void;
}): Promise<void> {
  const phone = rememberedPhone();
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
  // A ceremony failure changes no local state: the browser raises the same NotAllowedError
  // for a dismissed sheet as for a missing credential, and the gate is Cognito's answer
  // anyway (passkeyLoginAvailable) — a cancel can never cost the member their button.
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
}

/**
 * Whether passkey login can work for this account — COGNITO'S answer, not a local flag:
 * `InitiateAuth(USER_AUTH)` without a preferred challenge returns the account's
 * `AvailableChallenges`, listing WEB_AUTHN iff a passkey credential is registered. Nothing is
 * sent by this call (SELECT_CHALLENGE is inert until answered) and it needs no auth. Server
 * truth self-heals every localStorage-drift failure mode a per-device flag would have.
 * Defaults to the remembered phone; false when no username is known or on any failure.
 */
export async function passkeyLoginAvailable(): Promise<boolean> {
  const username = rememberedPhone();
  if (!username) return false;
  try {
    const res = await initiateUserAuth({ phone: username });
    return (res.AvailableChallenges ?? []).includes("WEB_AUTHN");
  } catch {
    return false; // unknown user / offline / throttled — the CTAs stay in charge
  }
}
