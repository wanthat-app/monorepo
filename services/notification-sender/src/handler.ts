import { Logger } from "@aws-lambda-powertools/logger";
import { SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import { getDocClient, RuntimeConfigRepo } from "@wanthat/dynamo";
import { WhatsAppSender } from "@wanthat/whatsapp";
import { type SendDeps, sendNotification } from "./send";

const logger = new Logger({ serviceName: "notification-sender" });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

let deps: SendDeps | undefined;

function getDeps(): SendDeps {
  if (deps) return deps;
  const region = process.env.AWS_REGION ?? "il-central-1";
  const newDeps: SendDeps = {
    config: new RuntimeConfigRepo(getDocClient(region), requireEnv("RUNTIME_CONFIG_TABLE")),
    // End User Messaging Social is not available in il-central-1; the client region is deploy-time.
    whatsapp: new WhatsAppSender(
      new SocialMessagingClient({ region: requireEnv("WHATSAPP_SOCIAL_REGION") }),
    ),
    log: (msg, ctx) => logger.info(msg, ctx ?? {}),
  };
  deps = newDeps;
  return newDeps;
}

/**
 * Async-invoked with a SendNotificationRequest payload (InvocationType Event). Throws on any real
 * failure so Lambda's async retry (2 attempts) → the SQS on-failure destination applies; a
 * kill-switched channel returns success (logged skip) and must never DLQ.
 */
export const handler = async (event: unknown): Promise<void> => {
  await sendNotification(getDeps(), event);
};
