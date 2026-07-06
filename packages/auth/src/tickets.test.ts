import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegistrationTicket, TicketKeyMaterial } from "./tickets";
import { TicketSigner, TicketVerifier } from "./tickets";

// A real Ed25519 pair per run — the signer reads it from a mocked Secrets Manager response, the
// verifier gets the public half exactly as prod does: base64 DER (SPKI) via a JSON-array env string.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const material: TicketKeyMaterial = {
  privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  publicKeys: [publicKey.export({ format: "der", type: "spki" }).toString("base64")],
};

const smSend = vi.fn();
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: class {
    send = smSend;
  },
  GetSecretValueCommand: class {},
}));

const ticket: RegistrationTicket = {
  sub: "sub-1",
  phone: "+972541234567",
  accessToken: "a",
  idToken: "i",
  refreshToken: "r",
  expiresIn: 3600,
  exp: Math.floor(Date.now() / 1000) + 60,
};

describe("TicketSigner + TicketVerifier (Ed25519)", () => {
  beforeEach(() => {
    smSend.mockReset();
    smSend.mockResolvedValue({ SecretString: JSON.stringify(material) });
  });

  it("round-trips: sign → verify returns the ticket; the secret is read once per container", async () => {
    const signer = new TicketSigner("arn:secret");
    const verifier = new TicketVerifier(JSON.stringify(material.publicKeys));
    const token = await signer.sign(ticket);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/); // <payload>.<signature>
    expect(await verifier.verify(token)).toEqual(ticket);

    await signer.sign(ticket);
    expect(smSend).toHaveBeenCalledTimes(1); // cached key material
  });

  it("rejects a tampered payload (sub swapped) and a truncated signature", async () => {
    const signer = new TicketSigner("arn:secret");
    const verifier = new TicketVerifier(JSON.stringify(material.publicKeys));
    const token = await signer.sign(ticket);
    const dot = token.lastIndexOf(".");
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);

    const forged = Buffer.from(JSON.stringify({ ...ticket, sub: "attacker" })).toString(
      "base64url",
    );
    expect(await verifier.verify(`${forged}.${sig}`)).toBeNull();
    expect(await verifier.verify(`${payload}.${sig.slice(0, -4)}`)).toBeNull();
    expect(await verifier.verify("garbage")).toBeNull();
  });

  it("rejects a ticket signed by a DIFFERENT key (forged issuer)", async () => {
    const evil = generateKeyPairSync("ed25519");
    smSend.mockResolvedValue({
      SecretString: JSON.stringify({
        privateKeyPem: evil.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
        publicKeys: [],
      }),
    });
    const evilSigner = new TicketSigner("arn:evil");
    const verifier = new TicketVerifier(JSON.stringify(material.publicKeys));
    expect(await verifier.verify(await evilSigner.sign(ticket))).toBeNull();
  });

  it("rejects an expired ticket", async () => {
    const signer = new TicketSigner("arn:secret");
    const verifier = new TicketVerifier(JSON.stringify(material.publicKeys));
    const token = await signer.sign({ ...ticket, exp: Math.floor(Date.now() / 1000) - 1 });
    expect(await verifier.verify(token)).toBeNull();
  });

  it("rotation: a verifier holding [old, new] keys accepts tickets from either signer", async () => {
    const next = generateKeyPairSync("ed25519");
    const verifier = new TicketVerifier(
      JSON.stringify([
        material.publicKeys[0],
        next.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      ]),
    );
    const oldSigner = new TicketSigner("arn:secret"); // mocked → original private key
    expect(await verifier.verify(await oldSigner.sign(ticket))).toEqual(ticket);

    smSend.mockResolvedValue({
      SecretString: JSON.stringify({
        privateKeyPem: next.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
        publicKeys: [],
      }),
    });
    const newSigner = new TicketSigner("arn:next");
    expect(await verifier.verify(await newSigner.sign(ticket))).toEqual(ticket);
  });

  it("verifier refuses an empty key list", () => {
    expect(() => new TicketVerifier("[]")).toThrow(/non-empty/);
  });
});
