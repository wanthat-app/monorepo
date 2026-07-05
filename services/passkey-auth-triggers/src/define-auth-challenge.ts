/** The slice of Cognito's DefineAuthChallenge trigger event we consume. */
export interface DefineAuthChallengeEvent {
  request: {
    /** Prior challenges in this CUSTOM_AUTH session, oldest first. Empty on the first call. */
    session?: Array<{ challengeName?: string; challengeResult?: boolean }>;
  };
  response: {
    issueTokens?: boolean;
    failAuthentication?: boolean;
    challengeName?: string;
  };
}

/**
 * DefineAuthChallenge (ADR-0024): drives EXACTLY one CUSTOM_CHALLENGE round, then decides the
 * outcome. `app-auth` already verified the WebAuthn assertion itself and is presenting an HMAC
 * proof as the answer (see `verify-auth-challenge.ts`, the actual trust gate) — this trigger never
 * issues tokens on an empty session, and only issues them after a CUSTOM_CHALLENGE that came back
 * correct. There is no other challenge type and no password fallback on this pool for CUSTOM_AUTH,
 * so a wrong/missing proof fails the sign-in outright (no second chance, no partial success).
 */
export function defineAuthChallenge(event: DefineAuthChallengeEvent): DefineAuthChallengeEvent {
  const sessions = event.request.session ?? [];
  // Look only at CUSTOM_CHALLENGE rounds. On this Essentials / choice-based (USER_AUTH) pool, Cognito
  // can seed the first DefineAuthChallenge session with a NON-custom entry (e.g. an initial factor
  // selection) — a naive `session.length === 0` check would then fall into the else branch and fail
  // the auth outright. We instead present a CUSTOM_CHALLENGE until exactly one has been attempted, and
  // decide the outcome from that attempt (one-shot: a wrong/missing proof fails the sign-in).
  const custom = sessions.filter((s) => s.challengeName === "CUSTOM_CHALLENGE");
  if (custom.some((s) => s.challengeResult === true)) {
    event.response.issueTokens = true;
    event.response.failAuthentication = false;
  } else if (custom.length > 0) {
    event.response.issueTokens = false;
    event.response.failAuthentication = true;
  } else {
    event.response.issueTokens = false;
    event.response.failAuthentication = false;
    event.response.challengeName = "CUSTOM_CHALLENGE";
  }
  return event;
}

export const handler = async (event: DefineAuthChallengeEvent): Promise<DefineAuthChallengeEvent> =>
  defineAuthChallenge(event);
