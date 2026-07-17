import { Logger } from "@aws-lambda-powertools/logger";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  CustomerCounterRepo,
  GuestAttributionRepo,
  getDocClient,
  OpsMetricsRepo,
} from "@wanthat/dynamo";
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
  const lambda = new LambdaClient({ region });
  // Fire-and-forget: InvocationType Event queues the invoke (HTTP 202) and returns — delivery
  // failures are the TARGET's concern (its async retry + on-failure SQS DLQ), never this trigger's.
  const invokeAsync = async (functionName: string, payload: unknown): Promise<void> => {
    await lambda.send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify(payload)),
      }),
    );
  };
  const notificationSenderFn = requireEnv("NOTIFICATION_SENDER_FUNCTION");
  const auditWriterFn = requireEnv("AUDIT_WRITER_FUNCTION");
  deps = {
    notifications: { send: (request) => invokeAsync(notificationSenderFn, request) },
    audit: { write: (request) => invokeAsync(auditWriterFn, request) },
    guests: new GuestAttributionRepo(doc, requireEnv("GUEST_ATTRIBUTION_TABLE")),
    counter: new CustomerCounterRepo(doc, requireEnv("OPS_COUNTERS_TABLE")),
    metrics: new OpsMetricsRepo(doc, requireEnv("OPS_COUNTERS_TABLE")),
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
 * never throws — a thrown error here would fail the user's ConfirmSignUp, and no welcome-message,
 * audit or attribution write is worth blocking a confirmation over. Always returns the event, as
 * the trigger contract requires.
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
