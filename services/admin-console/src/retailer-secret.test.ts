import { beforeEach, describe, expect, it, vi } from "vitest";

const smSend = vi.fn();
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: class {
    send = smSend;
  },
  DescribeSecretCommand: class DescribeSecretCommand {
    constructor(public input: { SecretId: string }) {}
  },
  PutSecretValueCommand: class PutSecretValueCommand {
    constructor(public input: { SecretId: string; SecretString: string }) {}
  },
}));

const { RetailerSecretWriter } = await import("./retailer-secret");
const { SecretsManagerClient } = await import("@aws-sdk/client-secrets-manager");

const ARN = "arn:aws:secretsmanager:il-central-1:1:secret:retailer";

describe("RetailerSecretWriter", () => {
  beforeEach(() => smSend.mockReset());

  it("put() writes both fields as the secret's JSON value", async () => {
    smSend.mockResolvedValueOnce({});
    const writer = new RetailerSecretWriter(new SecretsManagerClient({}), ARN);
    await writer.put({ appKey: "512345", appSecret: "s3cr3t" });

    const cmd = smSend.mock.calls[0]?.[0] as {
      input: { SecretId: string; SecretString: string };
    };
    expect(cmd.input.SecretId).toBe(ARN);
    expect(JSON.parse(cmd.input.SecretString)).toEqual({
      appKey: "512345",
      appSecret: "s3cr3t",
    });
  });

  it("status() maps LastChangedDate to configured + ISO timestamp", async () => {
    smSend.mockResolvedValueOnce({ LastChangedDate: new Date("2026-07-07T10:00:00Z") });
    const writer = new RetailerSecretWriter(new SecretsManagerClient({}), ARN);
    expect(await writer.status()).toEqual({
      configured: true,
      lastUpdatedAt: "2026-07-07T10:00:00.000Z",
    });
  });

  it("status() reports not-configured when the secret has never been written", async () => {
    smSend.mockResolvedValueOnce({});
    const writer = new RetailerSecretWriter(new SecretsManagerClient({}), ARN);
    expect(await writer.status()).toEqual({ configured: false, lastUpdatedAt: null });
  });
});
