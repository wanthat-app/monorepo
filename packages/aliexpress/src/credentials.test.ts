import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { describe, expect, it } from "vitest";
import { RetailerCredentialsReader } from "./credentials";

function smStub(values: Array<string | undefined>) {
  let sends = 0;
  const sm = {
    send: async () => ({ SecretString: values[Math.min(sends++, values.length - 1)] }),
  } as unknown as SecretsManagerClient;
  return { sm, sends: () => sends };
}

describe("RetailerCredentialsReader", () => {
  it("parses a populated credential and memoizes it", async () => {
    const { sm, sends } = smStub([JSON.stringify({ appKey: "512345", appSecret: "s3cret" })]);
    const reader = new RetailerCredentialsReader("arn:secret", sm);
    expect(await reader.get()).toEqual({ appKey: "512345", appSecret: "s3cret" });
    await reader.get();
    expect(sends()).toBe(1);
  });

  it("treats the deploy-time placeholder as not configured and retries next call", async () => {
    const { sm, sends } = smStub([
      "not-json-placeholder",
      JSON.stringify({ appKey: "512345", appSecret: "s3cret" }),
    ]);
    const reader = new RetailerCredentialsReader("arn:secret", sm);
    expect(await reader.get()).toBeNull();
    // A later invoke after the admin drop picks the credential up without a redeploy.
    expect(await reader.get()).toEqual({ appKey: "512345", appSecret: "s3cret" });
    expect(sends()).toBe(2);
  });

  it("treats a wrong-shape JSON secret as not configured", async () => {
    const { sm } = smStub([JSON.stringify({ user: "x" })]);
    expect(await new RetailerCredentialsReader("arn:secret", sm).get()).toBeNull();
  });
});
