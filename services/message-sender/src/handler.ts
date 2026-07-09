import { buildClient, CommitmentPolicy, KmsKeyringNode } from "@aws-crypto/client-node";
import { Logger } from "@aws-lambda-powertools/logger";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import { DevOtpSinkRepo, getDocClient, RuntimeConfigRepo } from "@wanthat/dynamo";
import { WhatsAppSender } from "@wanthat/whatsapp";
import { cachedConfigReader } from "./config-cache";
import { type CustomSmsSenderEvent, deliverOtp, type SendDeps } from "./send";

const logger = new Logger({ serviceName: "message-sender" });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

// Cognito encrypts the code via the AWS Encryption SDK (not a raw KMS Encrypt), so decryption
// goes through an Encryption SDK keyring over the pool's customSenderKmsKey.
const { decrypt } = buildClient(CommitmentPolicy.FORBID_ENCRYPT_ALLOW_DECRYPT);

let deps: SendDeps | undefined;

function getDeps(): SendDeps {
  if (deps) return deps;
  const region = process.env.AWS_REGION ?? "il-central-1";
  const keyring = new KmsKeyringNode({ keyIds: [requireEnv("KMS_KEY_ARN")] });
  const sns = new SNSClient({ region });
  // End User Messaging Social is not available in il-central-1; the client region is deploy-time.
  const social = new SocialMessagingClient({ region: requireEnv("WHATSAPP_SOCIAL_REGION") });
  const whatsapp = new WhatsAppSender(social);
  // The sink table is NOT provisioned in prod (no env var, no table, no grant — fail-closed).
  const sinkTable = process.env.DEV_OTP_SINK_TABLE;
  const sink = sinkTable ? new DevOtpSinkRepo(getDocClient(region), sinkTable) : undefined;
  deps = {
    // 30s per-container cache: channel resolution reads four config keys per OTP (ADR-0006
    // decision 5). A kill-switch flip still lands within the TTL on warm containers; app-auth
    // read fresh per request, but that served interactive API calls — a trigger tolerates this.
    config: cachedConfigReader(
      new RuntimeConfigRepo(getDocClient(region), requireEnv("RUNTIME_CONFIG_TABLE")),
      30_000,
    ),
    decryptCode: async (encryptedB64) => {
      const { plaintext } = await decrypt(keyring, Buffer.from(encryptedB64, "base64"));
      return plaintext.toString("utf8");
    },
    whatsapp,
    sms: {
      publish: async (toE164, message) => {
        await sns.send(
          new PublishCommand({
            PhoneNumber: toE164,
            Message: message,
            MessageAttributes: {
              "AWS.SNS.SMS.SMSType": { DataType: "String", StringValue: "Transactional" },
            },
          }),
        );
      },
    },
    devSink: {
      // Deploy-time guard: whatever the config says, the sink can never activate in prod —
      // belt (env name) and braces (the table only exists where DataStack provisioned it).
      allowed: process.env.WANTHAT_ENV !== "prod" && sink !== undefined,
      put: async (item) => {
        // Unreachable when !allowed; if a future bug ever gets here without a table, fail loudly.
        if (!sink) throw new Error("message-sender: dev OTP sink is not provisioned in this env");
        await sink.put({
          ...item,
          createdAt: new Date().toISOString(),
          ttl: Math.floor(Date.now() / 1000) + 300, // 5 minutes, matches the OTP lifetime
        });
      },
    },
    log: (msg, ctx) => logger.info(msg, ctx ?? {}),
  };
  return deps;
}

export const handler = async (event: CustomSmsSenderEvent): Promise<void> => {
  try {
    await deliverOtp(getDeps(), event);
  } catch (err) {
    // Log with routing context, then rethrow: the initiating Cognito call (SignUp / InitiateAuth
    // / ResendConfirmationCode — the SPA talks to Cognito directly, ADR-0006) MUST fail loudly.
    // `preferredChannel` is the user's raw attribute, not the resolved channel; never log the code.
    logger.error("otp_delivery_failed", {
      triggerSource: event.triggerSource,
      preferredChannel: event.request.userAttributes["custom:otpChannel"],
      sub: event.request.userAttributes.sub,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
};
