import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The actions under test reach Cognito (cognito.ts → lib/config) and the browser WebAuthn API
// (webauthn.ts) — both are stubbed; only the flag transitions and their triggers are real.
vi.mock("../lib/config", () => ({
  getConfig: () => ({ cognitoRegion: "il-central-1", userPoolClientId: "client-123" }),
}));

const { webauthnMock } = vi.hoisted(() => ({
  webauthnMock: {
    getAssertion: vi.fn(),
    createCredential: vi.fn(),
    waitForDocumentFocus: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("./webauthn", () => webauthnMock);

import { canLoginWithPasskey, enrollPasskey, loginWithPasskey } from "./actions";
import { clearDevicePasskey, hasDevicePasskey, markDevicePasskey } from "./passkey-device";
import { completeSignIn, resetForTests } from "./store";

function fakeJwt(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `eyJhbGciOiJub25lIn0.${body}.sig`;
}

const PHONE = "+972541234567";
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

/** A WEB_AUTHN InitiateAuth answer followed by tokens on the challenge response. */
function stubCognitoWebAuthn() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
      const target = JSON.parse(init.body) as { ChallengeName?: string; AuthFlow?: string };
      if (target.AuthFlow === "USER_AUTH") {
        return {
          ok: true,
          json: async () => ({
            ChallengeName: "WEB_AUTHN",
            Session: "sess-1",
            ChallengeParameters: {
              USERNAME: PHONE,
              CREDENTIAL_REQUEST_OPTIONS: JSON.stringify({ publicKey: { challenge: "c" } }),
            },
          }),
        };
      }
      return { ok: true, json: async () => ({ AuthenticationResult: AUTH_RESULT }) };
    }),
  );
}

beforeEach(() => {
  resetForTests();
  webauthnMock.getAssertion.mockReset();
  webauthnMock.createCredential.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("per-device passkey flag", () => {
  it("starts unset, sets on mark, drops on clear (and mark is idempotent)", () => {
    stubStorage();
    expect(hasDevicePasskey()).toBe(false);
    markDevicePasskey();
    markDevicePasskey();
    expect(hasDevicePasskey()).toBe(true);
    clearDevicePasskey();
    expect(hasDevicePasskey()).toBe(false);
  });

  it("degrades to unset (without throwing) when localStorage is unavailable", () => {
    // No localStorage stub at all — the module's guards must swallow the ReferenceError.
    expect(hasDevicePasskey()).toBe(false);
    expect(() => markDevicePasskey()).not.toThrow();
    expect(() => clearDevicePasskey()).not.toThrow();
  });

  it("gates canLoginWithPasskey on flag AND remembered phone", () => {
    const store = stubStorage();
    expect(canLoginWithPasskey()).toBe(false); // neither
    store.set("wanthat.phone", PHONE);
    expect(canLoginWithPasskey()).toBe(false); // phone without flag (the reported dead button)
    markDevicePasskey();
    expect(canLoginWithPasskey()).toBe(true); // both
    store.delete("wanthat.phone");
    expect(canLoginWithPasskey()).toBe(false); // flag without phone
  });

  it("is SET by a successful passkey login", async () => {
    const store = stubStorage();
    store.set("wanthat.phone", PHONE);
    stubCognitoWebAuthn();
    webauthnMock.getAssertion.mockResolvedValue({ id: "cred" });

    await loginWithPasskey();

    expect(hasDevicePasskey()).toBe(true);
    expect(canLoginWithPasskey()).toBe(true);
  });

  it("SURVIVES a NotAllowedError ceremony failure (cancel is indistinguishable from no-credential)", async () => {
    const store = stubStorage();
    store.set("wanthat.phone", PHONE);
    markDevicePasskey();
    stubCognitoWebAuthn();
    const notAllowed = Object.assign(new Error("op not allowed"), { name: "NotAllowedError" });
    webauthnMock.getAssertion.mockRejectedValue(notAllowed);

    await expect(loginWithPasskey()).rejects.toThrow("op not allowed");

    // A member who dismisses the OS sheet must keep the biometric button — the browser raises
    // the same NotAllowedError for a cancel as for a missing credential, so clearing here
    // would strip an enrolled device's button on a single cancelled prompt.
    expect(hasDevicePasskey()).toBe(true);
    expect(canLoginWithPasskey()).toBe(true);
  });

  it("SURVIVES a non-credential ceremony failure (e.g. a network blip mid-flow)", async () => {
    const store = stubStorage();
    store.set("wanthat.phone", PHONE);
    markDevicePasskey();
    stubCognitoWebAuthn();
    webauthnMock.getAssertion.mockRejectedValue(new TypeError("network down"));

    await expect(loginWithPasskey()).rejects.toThrow("network down");

    expect(hasDevicePasskey()).toBe(true);
  });

  it("is SET by a successful enrolment", async () => {
    stubStorage();
    stubCognitoWebAuthn();
    completeSignIn(AUTH_RESULT); // enrolPasskey requires a signed-in access token
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as { AccessToken?: string; Credential?: unknown };
        return {
          ok: true,
          json: async () =>
            body.Credential ? {} : { CredentialCreationOptions: { publicKey: { challenge: "c" } } },
        };
      }),
    );
    webauthnMock.createCredential.mockResolvedValue({ id: "new-cred" });
    clearDevicePasskey();

    await enrollPasskey();

    expect(hasDevicePasskey()).toBe(true);
  });
});
