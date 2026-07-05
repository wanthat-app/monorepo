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
  if (sessions.length === 0) {
    event.response.issueTokens = false;
    event.response.failAuthentication = false;
    event.response.challengeName = "CUSTOM_CHALLENGE";
  } else {
    const last = sessions[sessions.length - 1];
    const ok = last?.challengeName === "CUSTOM_CHALLENGE" && last?.challengeResult === true;
    event.response.issueTokens = ok;
    event.response.failAuthentication = !ok;
  }
  return event;
}

export const handler = async (event: DefineAuthChallengeEvent): Promise<DefineAuthChallengeEvent> =>
  defineAuthChallenge(event);
