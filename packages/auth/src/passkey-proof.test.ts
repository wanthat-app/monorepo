import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "test-secret";
const send = vi.fn().mockResolvedValue({ SecretString: SECRET });
vi.mock("@aws-sdk/client-secrets-manager", async (orig) => ({
  ...(await orig<typeof import("@aws-sdk/client-secrets-manager")>()),
  SecretsManagerClient: vi.fn(() => ({ send })),
}));

import { PasskeyProofSigner } from "./passkey-proof";

beforeEach(() => vi.clearAllMocks());

describe("PasskeyProofSigner", () => {
  it("round-trips: sign then verify returns the sub", async () => {
    const signer = new PasskeyProofSigner("arn:secret", "il-central-1");
    const token = await signer.sign("sub-123");
    expect(await signer.verify(token)).toEqual({ sub: "sub-123" });
  });

  it("rejects a tampered token", async () => {
    const signer = new PasskeyProofSigner("arn:secret", "il-central-1");
    const token = await signer.sign("sub-123");
    const [payload, hmac] = token.split(".");
    // Flip the payload but keep the original hmac — the compare must fail.
    const tampered = `${payload}x.${hmac}`;
    expect(await signer.verify(tampered)).toBeNull();
  });

  it("rejects an expired token signed with the same key", async () => {
    const signer = new PasskeyProofSigner("arn:secret", "il-central-1");
    const expiredPayload = {
      sub: "sub-123",
      exp: Math.floor(Date.now() / 1000) - 10,
      nonce: "fixed-nonce",
    };
    const encoded = Buffer.from(JSON.stringify(expiredPayload)).toString("base64url");
    const hmac = createHmac("sha256", SECRET).update(encoded).digest("base64url");
    expect(await signer.verify(`${encoded}.${hmac}`)).toBeNull();
  });

  it("rejects garbage input", async () => {
    const signer = new PasskeyProofSigner("arn:secret", "il-central-1");
    expect(await signer.verify("not-a-token")).toBeNull();
    expect(await signer.verify("")).toBeNull();
  });
});
