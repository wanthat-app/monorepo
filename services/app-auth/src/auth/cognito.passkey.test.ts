import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();
vi.mock("@aws-sdk/client-cognito-identity-provider", async (orig) => ({
  ...(await orig<typeof import("@aws-sdk/client-cognito-identity-provider")>()),
  CognitoIdentityProviderClient: vi.fn(() => ({ send })),
}));

import { Cognito } from "./cognito";

const c = new Cognito("pool", "client", "il-central-1");
beforeEach(() => vi.clearAllMocks());

describe("passkeyAdminAuth (ADR-0006 bridge — ephemeral password on ESSENTIALS)", () => {
  it("sets a fresh password then exchanges it via ADMIN_USER_PASSWORD_AUTH, returning tokens", async () => {
    send.mockResolvedValueOnce({}).mockResolvedValueOnce({
      AuthenticationResult: { AccessToken: "a", IdToken: "i", RefreshToken: "r", ExpiresIn: 3600 },
    });

    const res = await c.passkeyAdminAuth("u1");
    expect(res.AccessToken).toBe("a");

    // First call sets a permanent random password for the user (never returned to the caller).
    const setInput = send.mock.calls[0]?.[0].input;
    expect(setInput.Username).toBe("u1");
    expect(setInput.Permanent).toBe(true);
    expect(typeof setInput.Password).toBe("string");
    expect(setInput.Password.length).toBeGreaterThanOrEqual(20);

    // Second call authenticates with that same password via the admin flow.
    const authInput = send.mock.calls[1]?.[0].input;
    expect(authInput.AuthFlow).toBe("ADMIN_USER_PASSWORD_AUTH");
    expect(authInput.AuthParameters).toMatchObject({
      USERNAME: "u1",
      PASSWORD: setInput.Password,
    });
  });

  it("throws when the admin auth returns no AuthenticationResult", async () => {
    send.mockResolvedValueOnce({}).mockResolvedValueOnce({});
    await expect(c.passkeyAdminAuth("u1")).rejects.toThrow(/no AuthenticationResult/);
  });

  it("never logs or returns the ephemeral password", async () => {
    send.mockResolvedValueOnce({}).mockResolvedValueOnce({
      AuthenticationResult: { AccessToken: "a" },
    });
    const res = await c.passkeyAdminAuth("u1");
    expect(JSON.stringify(res)).not.toContain(send.mock.calls[0]?.[0].input.Password);
  });
});
