import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { AuthChallengeRepo } from "./auth-challenge";

function repo() {
  const send = vi.fn();
  return { repo: new AuthChallengeRepo({ send } as never, "auth"), send };
}

describe("AuthChallengeRepo.consumePasskeyChallenge (atomic single-use, ADR-0006)", () => {
  it("conditionally deletes and returns the prior pk-challenge record", async () => {
    const { repo: r, send } = repo();
    const rec = { challengeId: "c1", kind: "login", sub: "", username: "", challenge: "x", ttl: 9 };
    send.mockResolvedValue({ Attributes: { recordType: "pk-challenge", ...rec } });
    const out = await r.consumePasskeyChallenge("c1");
    expect(out).toEqual({ recordType: "pk-challenge", ...rec });
    const input = send.mock.calls[0]?.[0]?.input;
    expect(input.ConditionExpression).toBe("attribute_exists(challengeId)");
    expect(input.ReturnValues).toBe("ALL_OLD");
    expect(input.Key).toEqual({ challengeId: "c1" });
  });

  it("returns undefined when already consumed (conditional check fails) — the single-use race guard", async () => {
    const { repo: r, send } = repo();
    send.mockRejectedValue(new ConditionalCheckFailedException({ message: "gone", $metadata: {} }));
    expect(await r.consumePasskeyChallenge("c1")).toBeUndefined();
  });

  it("returns undefined for a non-passkey record id", async () => {
    const { repo: r, send } = repo();
    send.mockResolvedValue({ Attributes: { recordType: "challenge" } });
    expect(await r.consumePasskeyChallenge("c1")).toBeUndefined();
  });

  it("rethrows unexpected errors", async () => {
    const { repo: r, send } = repo();
    send.mockRejectedValue(new Error("boom"));
    await expect(r.consumePasskeyChallenge("c1")).rejects.toThrow("boom");
  });
});
