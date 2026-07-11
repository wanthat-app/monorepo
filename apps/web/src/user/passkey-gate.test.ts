import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The actions under test reach Cognito (cognito.ts → lib/config) and the browser WebAuthn API
// (webauthn.ts) — both are stubbed; only the gating logic and flow sequencing are real.
vi.mock("../lib/config", () => ({
  getConfig: () => ({ cognitoRegion: "il-central-1", userPoolClientId: "client-123" }),
}));

const { webauthnMock } = vi.hoisted(() => ({
  webauthnMock: {
    getAssertion: vi.fn(),
    createCredential: vi.fn(),
    waitForDocumentFocus: vi.fn().mockResolvedValue(undefined),
    conditionalMediationSupported: vi.fn(),
    discoverPasskeyUser: vi.fn(),
    passkeysSupported: vi.fn().mockReturnValue(true),
    biometricLabelKey: vi.fn().mockReturnValue("generic"),
  },
}));
vi.mock("./webauthn", () => webauthnMock);

import { loginWithDiscoveredPasskey, loginWithPasskey, passkeyLoginAvailable } from "./actions";
import { getSnapshot, resetForTests } from "./store";

function fakeJwt(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `eyJhbGciOiJub25lIn0.${body}.sig`;
}

const PHONE = "+972541234567";
const USERNAME = "5a83129c-b001-7028-44b5-31302f75dc08"; // the pool's UUID username (= userHandle)
const ID_TOKEN = fakeJwt({ sub: "s-1", phone_number: PHONE });
const AUTH_RESULT = {
  AccessToken: "at",
  IdToken: ID_TOKEN,
  RefreshToken: "rt",
  ExpiresIn: 3600,
};

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

/**
 * Cognito stub: InitiateAuth WITHOUT a preferred challenge answers SELECT_CHALLENGE with the
 * given AvailableChallenges; WITH WEB_AUTHN preferred it answers the WEB_AUTHN challenge; a
 * challenge response answers tokens. Captures request bodies for assertions.
 */
function stubCognito(availableChallenges: string[]) {
  const calls: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as {
        AuthFlow?: string;
        ChallengeName?: string;
        AuthParameters?: Record<string, string>;
      };
      calls.push(body);
      if (body.AuthFlow === "USER_AUTH" && !body.AuthParameters?.PREFERRED_CHALLENGE) {
        return {
          ok: true,
          json: async () => ({
            ChallengeName: "SELECT_CHALLENGE",
            Session: "sess-select",
            AvailableChallenges: availableChallenges,
          }),
        };
      }
      if (body.AuthFlow === "USER_AUTH") {
        return {
          ok: true,
          json: async () => ({
            ChallengeName: "WEB_AUTHN",
            Session: "sess-1",
            ChallengeParameters: {
              USERNAME: body.AuthParameters?.USERNAME,
              CREDENTIAL_REQUEST_OPTIONS: JSON.stringify({ publicKey: { challenge: "c" } }),
            },
          }),
        };
      }
      return { ok: true, json: async () => ({ AuthenticationResult: AUTH_RESULT }) };
    }),
  );
  return calls;
}

beforeEach(() => {
  resetForTests();
  webauthnMock.getAssertion.mockReset();
  webauthnMock.conditionalMediationSupported.mockReset();
  webauthnMock.discoverPasskeyUser.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("passkeyLoginAvailable (Cognito AvailableChallenges gate)", () => {
  it("is true when the account lists WEB_AUTHN", async () => {
    stubStorage();
    stubCognito(["SMS_OTP", "WEB_AUTHN"]);
    await expect(passkeyLoginAvailable(PHONE)).resolves.toBe(true);
  });

  it("is false when the account has no passkey", async () => {
    stubStorage();
    stubCognito(["SMS_OTP"]);
    await expect(passkeyLoginAvailable(PHONE)).resolves.toBe(false);
  });

  it("defaults to the remembered phone, and is false without one (no network call)", async () => {
    const store = stubStorage();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(passkeyLoginAvailable()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    store.set("wanthat.phone", PHONE);
    stubCognito(["WEB_AUTHN"]);
    await expect(passkeyLoginAvailable()).resolves.toBe(true);
  });

  it("degrades to false on any failure (offline/unknown user) — OTP stays in charge", async () => {
    stubStorage();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network down")));
    await expect(passkeyLoginAvailable(PHONE)).resolves.toBe(false);
  });
});

describe("loginWithPasskey", () => {
  it("completes the sign-in and remembers the phone", async () => {
    const store = stubStorage();
    stubCognito(["WEB_AUTHN"]);
    webauthnMock.getAssertion.mockResolvedValue({ id: "cred" });

    await loginWithPasskey({ phone: PHONE });

    expect(getSnapshot().status).toBe("signedIn");
    expect(store.get("wanthat.phone")).toBe(PHONE);
  });

  it("propagates a ceremony failure without touching local state", async () => {
    const store = stubStorage();
    store.set("wanthat.phone", PHONE);
    stubCognito(["WEB_AUTHN"]);
    const notAllowed = Object.assign(new Error("op not allowed"), { name: "NotAllowedError" });
    webauthnMock.getAssertion.mockRejectedValue(notAllowed);

    await expect(loginWithPasskey()).rejects.toThrow("op not allowed");

    expect(getSnapshot().status).not.toBe("signedIn");
    expect(store.get("wanthat.phone")).toBe(PHONE); // a cancel can never cost the member state
  });
});

describe("loginWithDiscoveredPasskey (conditional-UI recovery)", () => {
  it("feeds the discovered userHandle into the real Cognito flow and signs in", async () => {
    const store = stubStorage();
    const calls = stubCognito(["WEB_AUTHN"]);
    webauthnMock.conditionalMediationSupported.mockResolvedValue(true);
    webauthnMock.discoverPasskeyUser.mockResolvedValue(USERNAME);
    webauthnMock.getAssertion.mockResolvedValue({ id: "cred" });

    await expect(loginWithDiscoveredPasskey(new AbortController().signal)).resolves.toBe(true);

    expect(getSnapshot().status).toBe("signedIn");
    // The REAL flow ran with the discovered UUID username (verified accepted by the pool).
    const webauthnInit = calls.find(
      (c) => (c as { AuthParameters?: Record<string, string> }).AuthParameters?.PREFERRED_CHALLENGE,
    ) as { AuthParameters: Record<string, string> };
    expect(webauthnInit.AuthParameters.USERNAME).toBe(USERNAME);
    // Sign-in remembered the PHONE (from the token claims) — the device graduates to the
    // single-prompt path on the next visit.
    expect(store.get("wanthat.phone")).toBe(PHONE);
  });

  it("resolves false without a ceremony when conditional mediation is unsupported", async () => {
    stubStorage();
    webauthnMock.conditionalMediationSupported.mockResolvedValue(false);
    await expect(loginWithDiscoveredPasskey(new AbortController().signal)).resolves.toBe(false);
    expect(webauthnMock.discoverPasskeyUser).not.toHaveBeenCalled();
  });

  it("resolves false when the discovery is aborted or nothing is picked", async () => {
    stubStorage();
    webauthnMock.conditionalMediationSupported.mockResolvedValue(true);
    webauthnMock.discoverPasskeyUser.mockResolvedValue(null);
    await expect(loginWithDiscoveredPasskey(new AbortController().signal)).resolves.toBe(false);
    expect(getSnapshot().status).not.toBe("signedIn");
  });
});
