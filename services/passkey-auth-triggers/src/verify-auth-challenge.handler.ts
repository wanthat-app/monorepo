import { Logger } from "@aws-lambda-powertools/logger";
import { PasskeyProofSigner } from "@wanthat/auth";
import { type VerifyAuthChallengeEvent, verifyAuthChallenge } from "./verify-auth-challenge";

const logger = new Logger({ serviceName: "passkey-auth-triggers" });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

// Module-scope cached signer (warm-invocation reuse, same pattern as app-auth's getContext()):
// PasskeyProofSigner itself lazily fetches + caches the secret value on first verify.
let signer: PasskeyProofSigner | undefined;

function getSigner(): PasskeyProofSigner {
  if (!signer) {
    const region = process.env.AWS_REGION ?? "il-central-1";
    signer = new PasskeyProofSigner(requireEnv("PASSKEY_PROOF_SECRET_ARN"), region);
  }
  return signer;
}

export const handler = async (event: VerifyAuthChallengeEvent): Promise<VerifyAuthChallengeEvent> =>
  verifyAuthChallenge(event, getSigner(), (msg, ctx) => logger.info(msg, ctx ?? {}));
