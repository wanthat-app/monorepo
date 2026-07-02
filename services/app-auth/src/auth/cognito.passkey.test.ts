import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();
vi.mock("@aws-sdk/client-cognito-identity-provider", async (orig) => ({
  ...(await orig<typeof import("@aws-sdk/client-cognito-identity-provider")>()),
  CognitoIdentityProviderClient: vi.fn(() => ({ send })),
}));

import { Cognito } from "./cognito";

const c = new Cognito("pool", "client", "il-central-1");
beforeEach(() => vi.clearAllMocks());

describe("startPasskeyAuth", () => {
  it("initiates USER_AUTH/WEB_AUTHN and returns the parsed request options + session", async () => {
    send.mockResolvedValue({
      Session: "sess",
      ChallengeName: "WEB_AUTHN",
      ChallengeParameters: { CREDENTIAL_REQUEST_OPTIONS: '{"challenge":"abc"}' },
    });
    const r = await c.startPasskeyAuth("u1");
    expect(r).toEqual({ session: "sess", options: { challenge: "abc" } });
    const input = send.mock.calls[0]?.[0].input;
    expect(input.AuthFlow).toBe("USER_AUTH");
    expect(input.AuthParameters).toMatchObject({
      USERNAME: "u1",
      PREFERRED_CHALLENGE: "WEB_AUTHN",
    });
  });
  it("throws when no WEB_AUTHN challenge comes back (no passkey enrolled)", async () => {
    send.mockResolvedValue({
      Session: "s",
      ChallengeName: "SELECT_CHALLENGE",
      ChallengeParameters: {},
    });
    await expect(c.startPasskeyAuth("u1")).rejects.toThrow(/WEB_AUTHN/);
  });
});

describe("respondPasskeyAuth", () => {
  it("answers WEB_AUTHN with the stringified credential and returns tokens", async () => {
    send.mockResolvedValue({
      AuthenticationResult: { AccessToken: "a", IdToken: "i", RefreshToken: "r", ExpiresIn: 3600 },
    });
    const cred = { id: "x", type: "public-key" };
    const res = await c.respondPasskeyAuth("u1", "sess", cred);
    expect(res.AccessToken).toBe("a");
    const input = send.mock.calls[0]?.[0].input;
    expect(input.ChallengeName).toBe("WEB_AUTHN");
    expect(input.ChallengeResponses).toMatchObject({
      USERNAME: "u1",
      CREDENTIAL: JSON.stringify(cred),
    });
  });
});
