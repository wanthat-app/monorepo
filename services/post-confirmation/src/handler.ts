import { Logger } from "@aws-lambda-powertools/logger";
import { GuestAttributionRepo, getDocClient, NotificationOutboxRepo } from "@wanthat/dynamo";
import { type ConfirmDeps, handleConfirmation, type PostConfirmationEvent } from "./confirm";

const logger = new Logger({ serviceName: "post-confirmation" });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

let deps: ConfirmDeps | undefined;

function getDeps(): ConfirmDeps {
  if (deps) return deps;
  const region = process.env.AWS_REGION ?? "il-central-1";
  const doc = getDocClient(region);
  deps = {
    outbox: new NotificationOutboxRepo(doc, requireEnv("NOTIFICATION_OUTBOX_TABLE")),
    guests: new GuestAttributionRepo(doc, requireEnv("GUEST_ATTRIBUTION_TABLE")),
    appUrl: requireEnv("APP_URL"),
    log: {
      info: (msg, ctx) => logger.info(msg, ctx ?? {}),
      error: (msg, ctx) => logger.error(msg, ctx ?? {}),
    },
  };
  return deps;
}

/**
 * Cognito Post-Confirmation trigger (ADR-0006 decision 7). Best-effort in its entirety: unlike
 * message-sender (which MUST fail loudly so a dead OTP fails the initiating call), this handler
 * never throws — a thrown error here would fail the user's ConfirmSignUp, and no welcome-message
 * or attribution write is worth blocking a confirmation over. Always returns the event, as the
 * trigger contract requires.
 */
export const handler = async (event: PostConfirmationEvent): Promise<PostConfirmationEvent> => {
  try {
    await handleConfirmation(getDeps(), event);
  } catch (err) {
    // Belt: handleConfirmation swallows its own step failures; this catches everything else
    // (e.g. a missing env var in getDeps) so confirmation still succeeds.
    logger.error("post_confirmation_failed", {
      triggerSource: event.triggerSource,
      sub: event.request?.userAttributes?.sub,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return event;
};
