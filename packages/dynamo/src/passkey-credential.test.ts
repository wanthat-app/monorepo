import { describe, expect, it, vi } from "vitest";
import { PasskeyCredentialRepo } from "./passkey-credential";

const item = {
  credentialId: "cred-1",
  customerSub: "sub-1",
  cognitoUsername: "u-1",
  publicKey: "cG9zZS1wdWJsaWMta2V5",
  signCount: 0,
  transports: ["internal"],
  createdAt: "2026-07-02T00:00:00.000Z",
};

function repo() {
  const send = vi.fn().mockResolvedValue({});
  return { repo: new PasskeyCredentialRepo({ send } as never, "passkey-credential"), send };
}

describe("PasskeyCredentialRepo", () => {
  it("puts a credential item", async () => {
    const { repo: r, send } = repo();
    await r.put(item);
    expect(send.mock.calls[0]?.[0]?.input).toMatchObject({
      TableName: "passkey-credential",
      Item: item,
    });
  });

  it("gets a credential by credentialId (undefined when absent)", async () => {
    const { repo: r, send } = repo();
    send.mockResolvedValue({ Item: item });
    expect(await r.getByCredentialId("cred-1")).toEqual(item);
    send.mockResolvedValue({});
    expect(await r.getByCredentialId("cred-2")).toBeUndefined();
  });

  it("lists a member's credentials via byCustomerSub", async () => {
    const { repo: r, send } = repo();
    send.mockResolvedValue({ Items: [item] });
    expect(await r.listByCustomer("sub-1")).toEqual([item]);
    expect(send.mock.calls[0]?.[0]?.input).toMatchObject({
      TableName: "passkey-credential",
      IndexName: "byCustomerSub",
      KeyConditionExpression: "customerSub = :s",
      ExpressionAttributeValues: { ":s": "sub-1" },
    });
  });

  it("updateSignCount SETs signCount by credentialId", async () => {
    const { repo: r, send } = repo();
    await r.updateSignCount("cred-1", 7);
    expect(send.mock.calls[0]?.[0]?.input).toMatchObject({
      Key: { credentialId: "cred-1" },
      UpdateExpression: "SET #c = :c",
      ExpressionAttributeNames: { "#c": "signCount" },
      ExpressionAttributeValues: { ":c": 7 },
    });
  });
});
