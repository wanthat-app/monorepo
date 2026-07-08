import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enrollPasskey,
  loginWithPasskey,
  loginWithPasskeyTokens,
  passkeyImmediateSupported,
} from "./passkey";

// startRegistration needs a real browser; everything else in the module under test stays real.
vi.mock("@simplewebauthn/browser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@simplewebauthn/browser")>()),
  startRegistration: vi.fn(async () => ({ id: "new-cred", type: "public-key" })),
}));

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown) => ({ ok: true, json: async () => body });

/** In-memory localStorage stub; returns the backing map for assertions. */
function stubStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  return store;
}

describe("passkeyImmediateSupported", () => {
  it("is true when the client reports the immediateGet capability", async () => {
    vi.stubGlobal("PublicKeyCredential", {
      getClientCapabilities: async () => ({ immediateGet: true }),
    });
    await expect(passkeyImmediateSupported()).resolves.toBe(true);
  });

  it("is false when the capability is absent", async () => {
    vi.stubGlobal("PublicKeyCredential", {
      getClientCapabilities: async () => ({ conditionalGet: true }),
    });
    await expect(passkeyImmediateSupported()).resolves.toBe(false);
  });

  it("is false when getClientCapabilities does not exist (pre-capability browsers)", async () => {
    vi.stubGlobal("PublicKeyCredential", {});
    await expect(passkeyImmediateSupported()).resolves.toBe(false);
  });

  it("is false when PublicKeyCredential does not exist", async () => {
    await expect(passkeyImmediateSupported()).resolves.toBe(false);
  });

  it("is false when the capability probe throws", async () => {
    vi.stubGlobal("PublicKeyCredential", {
      getClientCapabilities: async () => {
        throw new Error("boom");
      },
    });
    await expect(passkeyImmediateSupported()).resolves.toBe(false);
  });
});

describe("immediate-mode passkey login", () => {
  /** Stub the WebAuthn surface an immediate-mode get() touches. */
  function stubWebAuthn(getMock: ReturnType<typeof vi.fn>) {
    const parsed = { challenge: new Uint8Array([1, 2, 3]) };
    vi.stubGlobal("PublicKeyCredential", {
      parseRequestOptionsFromJSON: vi.fn(() => parsed),
    });
    vi.stubGlobal("navigator", {
      userActivation: { isActive: true }, // activation already live → no event wait
      credentials: { get: getMock },
    });
    return parsed;
  }

  it("passes the parsed server options with uiMode 'immediate' and resolves a session", async () => {
    const getMock = vi.fn(async () => ({ toJSON: () => ({ id: "cred-1", type: "public-key" }) }));
    const parsed = stubWebAuthn(getMock);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ challengeId: "ch-1", options: { challenge: "abc" } }))
      .mockResolvedValueOnce(json({ registrationTicket: "tick-1" }))
      .mockResolvedValueOnce(
        json({
          status: "authenticated",
          tokens: { accessToken: "at", idToken: "it", refreshToken: "rt" },
          customer: { id: "cust-1" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const session = await loginWithPasskey({ mode: "immediate" });

    expect(getMock).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledWith(
      expect.objectContaining({ publicKey: parsed, uiMode: "immediate" }),
    );
    expect((session.customer as { id: string }).id).toBe("cust-1");
    // The verify round-trip must carry the toJSON()-serialised assertion.
    const verifyCall = fetchMock.mock.calls[1] as [string, { body: string }];
    expect(verifyCall[0]).toContain("/auth/passkey/login/verify");
    expect(JSON.parse(verifyCall[1].body).credential.id).toBe("cred-1");
  });

  it("propagates the silent rejection when no local passkey exists", async () => {
    const err = Object.assign(new Error("no local credential"), { name: "NotAllowedError" });
    stubWebAuthn(
      vi.fn(async () => {
        throw err;
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ challengeId: "ch-1", options: { challenge: "abc" } })),
    );

    await expect(loginWithPasskey({ mode: "immediate" })).rejects.toThrow("no local credential");
  });

  it("marks the device flag on a successful login, however the ceremony was triggered", async () => {
    const store = stubStorage();
    stubWebAuthn(vi.fn(async () => ({ toJSON: () => ({ id: "cred-1" }) })));
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json({ challengeId: "ch-1", options: { challenge: "abc" } }))
        .mockResolvedValueOnce(json({ registrationTicket: "tick-1" }))
        .mockResolvedValueOnce(
          json({
            status: "authenticated",
            tokens: { accessToken: "at", idToken: "it", refreshToken: "rt" },
            customer: { id: "cust-1" },
          }),
        ),
    );

    await loginWithPasskey({ mode: "immediate" });
    expect(store.get("wanthat.passkeyDevice")).toBe("1");
  });

  it("does NOT mark the device flag when the ceremony fails", async () => {
    const store = stubStorage();
    stubWebAuthn(
      vi.fn(async () => {
        throw Object.assign(new Error("cancelled"), { name: "NotAllowedError" });
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ challengeId: "ch-1", options: { challenge: "abc" } })),
    );

    await expect(loginWithPasskey({ mode: "immediate" })).rejects.toThrow();
    expect(store.has("wanthat.passkeyDevice")).toBe(false);
  });

  it("marks the device flag on the tokens-only landing login too", async () => {
    const store = stubStorage();
    stubWebAuthn(vi.fn(async () => ({ toJSON: () => ({ id: "cred-1" }) })));
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json({ challengeId: "ch-1", options: { challenge: "abc" } }))
        .mockResolvedValueOnce(
          json({ tokens: { accessToken: "a", idToken: "i", refreshToken: "r" } }),
        ),
    );

    await loginWithPasskeyTokens({ mode: "immediate" });
    expect(store.get("wanthat.passkeyDevice")).toBe("1");
  });

  it("marks the device flag on a successful enrolment (e.g. the home Turn On card)", async () => {
    const store = stubStorage();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json({ challengeId: "ch-1", options: { challenge: "abc" } }))
        .mockResolvedValueOnce(
          json({ passkey: { credentialId: "new-cred", createdAt: "2026-07-08T00:00:00Z" } }),
        ),
    );

    await expect(enrollPasskey("tok-1")).resolves.toBe("new-cred");
    expect(store.get("wanthat.passkeyDevice")).toBe("1");
  });

  it("waits for a user interaction when no activation is live yet", async () => {
    const getMock = vi.fn(async () => ({ toJSON: () => ({ id: "cred-1" }) }));
    stubWebAuthn(getMock);
    const listeners: Record<string, () => void> = {};
    vi.stubGlobal("navigator", {
      userActivation: { isActive: false },
      credentials: { get: getMock },
    });
    vi.stubGlobal("window", {
      addEventListener: (ev: string, fn: () => void) => {
        listeners[ev] = fn;
      },
      removeEventListener: () => {},
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ challengeId: "ch-1", options: { challenge: "abc" } }))
      .mockResolvedValueOnce(
        json({ tokens: { accessToken: "a", idToken: "i", refreshToken: "r" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const pending = loginWithPasskeyTokens({ mode: "immediate" });
    // Nothing may fire before the first interaction — not even the challenge fetch.
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getMock).not.toHaveBeenCalled();

    listeners.pointerdown?.(); // the member's first tap
    const tokens = await pending;
    expect(getMock).toHaveBeenCalledTimes(1);
    expect((tokens as { refreshToken: string }).refreshToken).toBe("r");
  });
});
