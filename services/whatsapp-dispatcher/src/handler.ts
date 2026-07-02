import { Logger } from "@aws-lambda-powertools/logger";
import { SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import { getDocClient, NotificationOutboxRepo, RuntimeConfigRepo } from "@wanthat/dynamo";
import { WhatsAppSender } from "@wanthat/whatsapp";
import { type DispatchDeps, dispatchRecord, type OutboxStreamRecord } from "./dispatch";

const logger = new Logger({ serviceName: "whatsapp-dispatcher" });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

let deps: DispatchDeps | undefined;

function getDeps(): DispatchDeps {
  if (deps) return deps;
  const region = process.env.AWS_REGION ?? "il-central-1";
  const doc = getDocClient(region);
  const newDeps: DispatchDeps = {
    config: new RuntimeConfigRepo(doc, requireEnv("RUNTIME_CONFIG_TABLE")),
    outbox: new NotificationOutboxRepo(doc, requireEnv("NOTIFICATION_OUTBOX_TABLE")),
    // End User Messaging Social is not available in il-central-1; the client region is deploy-time.
    whatsapp: new WhatsAppSender(
      new SocialMessagingClient({ region: requireEnv("WHATSAPP_SOCIAL_REGION") }),
    ),
    log: (msg, ctx) => logger.info(msg, ctx ?? {}),
  };
  deps = newDeps;
  return newDeps;
}

export const handler = async (event: { Records: OutboxStreamRecord[] }): Promise<void> => {
  const d = getDeps();
  for (const record of event.Records) await dispatchRecord(d, record);
};
