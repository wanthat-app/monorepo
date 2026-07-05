import { describe, expect, it } from "vitest";
import { type DefineAuthChallengeEvent, defineAuthChallenge } from "./define-auth-challenge";

function event(session: DefineAuthChallengeEvent["request"]["session"]): DefineAuthChallengeEvent {
  return { request: { session }, response: {} };
}

describe("defineAuthChallenge (ADR-0024) — exactly one CUSTOM_CHALLENGE round", () => {
  it("issues CUSTOM_CHALLENGE on an empty session (first call)", () => {
    const result = defineAuthChallenge(event([]));
    expect(result.response).toEqual({
      issueTokens: false,
      failAuthentication: false,
      challengeName: "CUSTOM_CHALLENGE",
    });
  });

  it("issues CUSTOM_CHALLENGE when session is entirely absent", () => {
    const result = defineAuthChallenge(event(undefined));
    expect(result.response.challengeName).toBe("CUSTOM_CHALLENGE");
    expect(result.response.issueTokens).toBe(false);
  });

  it("issues tokens when the last challenge was CUSTOM_CHALLENGE and correct", () => {
    const result = defineAuthChallenge(
      event([{ challengeName: "CUSTOM_CHALLENGE", challengeResult: true }]),
    );
    expect(result.response.issueTokens).toBe(true);
    expect(result.response.failAuthentication).toBe(false);
  });

  it("fails authentication when the last CUSTOM_CHALLENGE was incorrect", () => {
    const result = defineAuthChallenge(
      event([{ challengeName: "CUSTOM_CHALLENGE", challengeResult: false }]),
    );
    expect(result.response.issueTokens).toBe(false);
    expect(result.response.failAuthentication).toBe(true);
  });

  it("presents a CUSTOM_CHALLENGE when the session holds only NON-custom entries (Cognito-seeded first call)", () => {
    // On the Essentials / choice-based pool Cognito can seed the first session with a non-custom
    // factor-selection entry. We must ignore it and still present our custom challenge, NOT fail.
    const result = defineAuthChallenge(event([{ challengeName: "SRP_A", challengeResult: false }]));
    expect(result.response).toEqual({
      issueTokens: false,
      failAuthentication: false,
      challengeName: "CUSTOM_CHALLENGE",
    });
  });

  it("issues tokens on a passed CUSTOM_CHALLENGE even if a non-custom entry precedes it", () => {
    const result = defineAuthChallenge(
      event([
        { challengeName: "SRP_A", challengeResult: false },
        { challengeName: "CUSTOM_CHALLENGE", challengeResult: true },
      ]),
    );
    expect(result.response.issueTokens).toBe(true);
    expect(result.response.failAuthentication).toBe(false);
  });
});
