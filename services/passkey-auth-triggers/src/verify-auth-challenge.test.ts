import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ProofVerifier,
  type VerifyAuthChallengeEvent,
  verifyAuthChallenge,
} from "./verify-auth-challenge";

const signer: ProofVerifier = { verify: vi.fn() };
const log = vi.fn();

function event(
  challengeAnswer: string | undefined,
  sub: string | undefined,
): VerifyAuthChallengeEvent {
  return {
    request: { challengeAnswer, userAttributes: sub === undefined ? {} : { sub } },
    response: {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("verifyAuthChallenge (ADR-0024) — the trust gate, fails closed", () => {
  it("answerCorrect: true when the proof verifies AND the sub matches", async () => {
    vi.mocked(signer.verify).mockResolvedValue({ sub: "sub-123" });
    const result = await verifyAuthChallenge(event("proof-token", "sub-123"), signer, log);
    expect(result.response.answerCorrect).toBe(true);
    expect(signer.verify).toHaveBeenCalledWith("proof-token");
    expect(log).toHaveBeenCalledWith("passkey_proof_verify", { ok: true, sub: "sub-123" });
  });

  it("answerCorrect: false when the proof is missing", async () => {
    const result = await verifyAuthChallenge(event(undefined, "sub-123"), signer, log);
    expect(result.response.answerCorrect).toBe(false);
    expect(signer.verify).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("passkey_proof_verify", { ok: false, sub: "sub-123" });
  });

  it("answerCorrect: false when verify() returns null (invalid/expired proof)", async () => {
    vi.mocked(signer.verify).mockResolvedValue(null);
    const result = await verifyAuthChallenge(event("bad-token", "sub-123"), signer, log);
    expect(result.response.answerCorrect).toBe(false);
  });

  it("answerCorrect: false on a sub mismatch — a proof for one user cannot auth another", async () => {
    vi.mocked(signer.verify).mockResolvedValue({ sub: "sub-OTHER" });
    const result = await verifyAuthChallenge(event("proof-token", "sub-123"), signer, log);
    expect(result.response.answerCorrect).toBe(false);
  });

  it("answerCorrect: false when userAttributes carries no sub at all", async () => {
    vi.mocked(signer.verify).mockResolvedValue({ sub: "sub-123" });
    const result = await verifyAuthChallenge(event("proof-token", undefined), signer, log);
    expect(result.response.answerCorrect).toBe(false);
  });

  it("fails CLOSED when the verifier throws — never defaults to true", async () => {
    vi.mocked(signer.verify).mockRejectedValue(new Error("secrets manager unavailable"));
    const result = await verifyAuthChallenge(event("proof-token", "sub-123"), signer, log);
    expect(result.response.answerCorrect).toBe(false);
    expect(log).toHaveBeenCalledWith("passkey_proof_verify", { ok: false, sub: "sub-123" });
  });

  it("never logs the proof token itself", async () => {
    vi.mocked(signer.verify).mockResolvedValue({ sub: "sub-123" });
    await verifyAuthChallenge(event("super-secret-proof", "sub-123"), signer, log);
    for (const call of log.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("super-secret-proof");
    }
  });
});
