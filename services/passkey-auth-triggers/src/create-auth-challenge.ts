/** The slice of Cognito's CreateAuthChallenge trigger event we consume. */
export interface CreateAuthChallengeEvent {
  response: {
    publicChallengeParameters?: Record<string, string>;
    privateChallengeParameters?: Record<string, string>;
    challengeMetadata?: string;
  };
}

/**
 * CreateAuthChallenge (ADR-0024): there is no real challenge to hand the client — the proof rides
 * in as the CUSTOM_CHALLENGE answer that `app-auth` already has in hand (an HMAC over a WebAuthn
 * assertion it verified itself). Both challenge-parameter maps stay empty; `challengeMetadata` is
 * purely descriptive (CloudWatch/console readability), not read by VerifyAuthChallengeResponse.
 */
export function createAuthChallenge(event: CreateAuthChallengeEvent): CreateAuthChallengeEvent {
  event.response.publicChallengeParameters = {};
  event.response.privateChallengeParameters = {};
  event.response.challengeMetadata = "PASSKEY_PROOF";
  return event;
}

export const handler = async (event: CreateAuthChallengeEvent): Promise<CreateAuthChallengeEvent> =>
  createAuthChallenge(event);
