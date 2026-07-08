/**
 * ticket-keygen — CloudFormation custom resource (via CDK's `cr.Provider`) that provisions the
 * Ed25519 keypair signing the auth registration tickets (ADR-0006, asymmetric).
 *
 * On Create it generates the pair and writes `{privateKeyPem, publicKeys}` into the AuthTicketSecret
 * (the PRIVATE key never leaves Secrets Manager; only non-VPC app-auth reads it, over the free
 * public endpoint). It returns the PUBLIC keys as the `publicKeys` attribute — a JSON string array —
 * which the api-stack wires into app-core's `AUTH_TICKET_PUBLIC_KEYS` env var, so the in-VPC
 * verifier needs no Secrets Manager access at all.
 *
 * IDEMPOTENT BY DESIGN: if the secret already holds keypair material, Create/Update return the
 * EXISTING public keys and generate nothing — a redeploy must never silently rotate the signing key
 * (in-flight tickets would break and the signer's cached key would go stale). Rotation, when ever
 * needed, is an explicit out-of-band act. Delete is a no-op (the secret's lifecycle belongs to the
 * api-stack, and CloudFormation may roll back the CR without meaning "destroy the key").
 */
import { generateKeyPairSync } from "node:crypto";
import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

interface KeygenEvent {
  RequestType: "Create" | "Update" | "Delete";
  ResourceProperties?: { secretArn?: string };
  PhysicalResourceId?: string;
}

interface KeygenResult {
  PhysicalResourceId: string;
  Data?: { publicKeys: string };
}

interface KeyMaterial {
  privateKeyPem: string;
  publicKeys: string[];
}

const sm = new SecretsManagerClient({});

async function readExisting(secretArn: string): Promise<KeyMaterial | undefined> {
  try {
    const res = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
    if (!res.SecretString) return undefined;
    const parsed = JSON.parse(res.SecretString) as KeyMaterial;
    // The CDK-created secret starts life holding a generated random password (or, historically, the
    // HMAC key) — anything that isn't keypair material means "not provisioned yet".
    if (parsed.privateKeyPem && Array.isArray(parsed.publicKeys) && parsed.publicKeys.length > 0)
      return parsed;
    return undefined;
  } catch {
    return undefined; // empty / non-JSON / unreadable → treat as not provisioned
  }
}

export const handler = async (event: KeygenEvent): Promise<KeygenResult> => {
  const secretArn = event.ResourceProperties?.secretArn;
  if (!secretArn) throw new Error("secretArn resource property is required");
  // Stable physical id keyed to the secret: updates never look like replacements.
  const physicalId = `ticket-keygen:${secretArn}`;

  if (event.RequestType === "Delete") return { PhysicalResourceId: physicalId };

  const existing = await readExisting(secretArn);
  if (existing) {
    console.log(
      JSON.stringify({ event: "ticket_keygen_reused", keys: existing.publicKeys.length }),
    );
    return {
      PhysicalResourceId: physicalId,
      Data: { publicKeys: JSON.stringify(existing.publicKeys) },
    };
  }

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const material: KeyMaterial = {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeys: [publicKey.export({ format: "der", type: "spki" }).toString("base64")],
  };
  await sm.send(
    new PutSecretValueCommand({ SecretId: secretArn, SecretString: JSON.stringify(material) }),
  );
  console.log(JSON.stringify({ event: "ticket_keygen_generated" })); // never log key material
  return {
    PhysicalResourceId: physicalId,
    Data: { publicKeys: JSON.stringify(material.publicKeys) },
  };
};
