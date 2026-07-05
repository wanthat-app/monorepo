import { describe, expect, it } from "vitest";
import { createAuthChallenge } from "./create-auth-challenge";

describe("createAuthChallenge (ADR-0024) — no real challenge, proof rides in as the answer", () => {
  it("sets empty challenge parameters and descriptive metadata", () => {
    const event = { response: {} };
    const result = createAuthChallenge(event);
    expect(result.response).toEqual({
      publicChallengeParameters: {},
      privateChallengeParameters: {},
      challengeMetadata: "PASSKEY_PROOF",
    });
  });
});
