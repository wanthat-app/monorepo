import { beforeEach, describe, expect, it, vi } from "vitest";

const smSend = vi.fn();
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: class {
    send = smSend;
  },
  GetSecretValueCommand: class GetSecretValueCommand {
    constructor(public input: unknown) {}
  },
  PutSecretValueCommand: class PutSecretValueCommand {
    constructor(public input: { SecretId: string; SecretString: string }) {}
  },
}));

const { handler } = await import("./handler");
const ARN = "arn:aws:secretsmanager:il-central-1:1:secret:ticket";

describe("ticket-keygen custom resource", () => {
  beforeEach(() => smSend.mockReset());

  it("Create on an unprovisioned secret: generates a pair, stores it, returns the public key", async () => {
    smSend
      .mockResolvedValueOnce({ SecretString: "cdk-generated-random-password" }) // Get → not material
      .mockResolvedValueOnce({}); // Put
    const res = await handler({ RequestType: "Create", ResourceProperties: { secretArn: ARN } });

    const put = smSend.mock.calls[1]?.[0].input as { SecretString: string };
    const stored = JSON.parse(put.SecretString);
    expect(stored.privateKeyPem).toContain("BEGIN PRIVATE KEY");
    expect(stored.publicKeys).toHaveLength(1);
    expect(JSON.parse(res.Data?.publicKeys ?? "[]")).toEqual(stored.publicKeys);
  });

  it("IDEMPOTENT: Update on a provisioned secret returns the EXISTING keys, writes nothing", async () => {
    const material = { privateKeyPem: "-----BEGIN PRIVATE KEY-----x", publicKeys: ["pub1"] };
    smSend.mockResolvedValueOnce({ SecretString: JSON.stringify(material) });
    const res = await handler({
      RequestType: "Update",
      ResourceProperties: { secretArn: ARN },
      PhysicalResourceId: `ticket-keygen:${ARN}`,
    });
    expect(res.Data?.publicKeys).toBe(JSON.stringify(["pub1"]));
    expect(smSend).toHaveBeenCalledTimes(1); // Get only — no Put, no regeneration
    expect(res.PhysicalResourceId).toBe(`ticket-keygen:${ARN}`); // stable → no CFN replacement
  });

  it("Delete is a no-op (never destroys key material)", async () => {
    const res = await handler({
      RequestType: "Delete",
      ResourceProperties: { secretArn: ARN },
      PhysicalResourceId: `ticket-keygen:${ARN}`,
    });
    expect(smSend).not.toHaveBeenCalled();
    expect(res.PhysicalResourceId).toBe(`ticket-keygen:${ARN}`);
  });

  it("the generated public key actually verifies a signature from the stored private key", async () => {
    smSend.mockResolvedValueOnce({}).mockResolvedValueOnce({});
    smSend.mockReset();
    smSend.mockResolvedValueOnce({ SecretString: "" }).mockResolvedValueOnce({});
    await handler({ RequestType: "Create", ResourceProperties: { secretArn: ARN } });
    const put = smSend.mock.calls[1]?.[0].input as { SecretString: string };
    const stored = JSON.parse(put.SecretString);

    const { createPublicKey, sign, verify } = await import("node:crypto");
    const sig = sign(null, Buffer.from("payload"), stored.privateKeyPem);
    const pub = createPublicKey({
      key: Buffer.from(stored.publicKeys[0], "base64"),
      format: "der",
      type: "spki",
    });
    expect(verify(null, Buffer.from("payload"), pub, sig)).toBe(true);
  });
});
