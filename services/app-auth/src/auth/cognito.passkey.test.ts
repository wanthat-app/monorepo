import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();
vi.mock("@aws-sdk/client-cognito-identity-provider", async (orig) => ({
  ...(await orig<typeof import("@aws-sdk/client-cognito-identity-provider")>()),
  CognitoIdentityProviderClient: vi.fn(() => ({ send })),
}));

import { Cognito } from "./cognito";

const c = new Cognito("pool", "client", "il-central-1");
beforeEach(() => vi.clearAllMocks());

describe("passkeyCustomAuth (ADR-0024)", () => {
  it("initiates CUSTOM_AUTH then answers CUSTOM_CHALLENGE with the proof, returning tokens", async () => {
    send.mockResolvedValueOnce({ Session: "sess" }).mockResolvedValueOnce({
      AuthenticationResult: { AccessToken: "a", IdToken: "i", RefreshToken: "r", ExpiresIn: 3600 },
    });

    const res = await c.passkeyCustomAuth("u1", "proof-token");
    expect(res.AccessToken).toBe("a");

    const initInput = send.mock.calls[0]?.[0].input;
    expect(initInput.AuthFlow).toBe("CUSTOM_AUTH");
    expect(initInput.AuthParameters).toMatchObject({ USERNAME: "u1" });

    const respondInput = send.mock.calls[1]?.[0].input;
    expect(respondInput.ChallengeName).toBe("CUSTOM_CHALLENGE");
    expect(respondInput.Session).toBe("sess");
    expect(respondInput.ChallengeResponses).toMatchObject({
      USERNAME: "u1",
      ANSWER: "proof-token",
    });
  });

  it("throws when CUSTOM_AUTH initiate returns no session", async () => {
    send.mockResolvedValueOnce({});
    await expect(c.passkeyCustomAuth("u1", "proof-token")).rejects.toThrow(/no session/);
  });

  it("throws when the challenge response carries no AuthenticationResult", async () => {
    send.mockResolvedValueOnce({ Session: "sess" }).mockResolvedValueOnce({});
    await expect(c.passkeyCustomAuth("u1", "proof-token")).rejects.toThrow(
      /no AuthenticationResult/,
    );
  });
});
