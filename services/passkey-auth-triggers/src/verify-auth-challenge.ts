/** The slice of Cognito's VerifyAuthChallengeResponse trigger event we consume. */
export interface VerifyAuthChallengeEvent {
  request: {
    /** The CUSTOM_CHALLENGE answer `app-auth` supplied: the short-TTL HMAC proof. */
    challengeAnswer?: string;
    userAttributes?: Record<string, string | undefined>;
  };
  response: {
    answerCorrect?: boolean;
  };
}

/** The one thing this trigger needs from `@wanthat/auth`'s `PasskeyProofSigner`. */
export interface ProofVerifier {
  verify(token: string): Promise<{ sub: string } | null>;
}

/**
 * VerifyAuthChallengeResponse (ADR-0024) — **the trust gate** for the whole CUSTOM_AUTH bridge.
 * `app-auth` verified the WebAuthn assertion itself (against our own `passkey_credential` store,
 * not Cognito's), then proves that here via a short-TTL HMAC proof passed as the challenge answer.
 * This function is the only place that proof is checked, so it must:
 *
 *  1. Verify the proof's HMAC + expiry (delegated to {@link ProofVerifier.verify}).
 *  2. Confirm the proof's `sub` matches the `sub` of the user Cognito is trying to authenticate as
 *     — otherwise a proof minted for one user could be replayed against a different `USERNAME` in
 *     the same pool.
 *
 * **Fails closed**: any missing/invalid/expired proof, any `sub` mismatch, or the verifier
 * throwing, all resolve to `answerCorrect: false`. There is no default-true path.
 */
export async function verifyAuthChallenge(
  event: VerifyAuthChallengeEvent,
  signer: ProofVerifier,
  log: (msg: string, ctx?: Record<string, unknown>) => void,
): Promise<VerifyAuthChallengeEvent> {
  const proof = event.request.challengeAnswer;
  const expectedSub = event.request.userAttributes?.sub;
  let ok = false;
  try {
    const payload = proof ? await signer.verify(proof) : null;
    ok = !!payload && !!expectedSub && payload.sub === expectedSub;
  } catch {
    ok = false;
  }
  event.response.answerCorrect = ok;
  // Never log the proof itself — only the outcome + the sub it was checked against.
  log("passkey_proof_verify", { ok, sub: expectedSub });
  return event;
}
