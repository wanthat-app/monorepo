import { buildClient, CommitmentPolicy, KmsKeyringNode } from "@aws-crypto/client-node";
import { Logger } from "@aws-lambda-powertools/logger";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import { getDocClient, RuntimeConfigRepo } from "@wanthat/dynamo";
import { WhatsAppSender } from "@wanthat/whatsapp";
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
  deps = {
    config: new RuntimeConfigRepo(getDocClient(region), requireEnv("RUNTIME_CONFIG_TABLE")),
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
    log: (msg, ctx) => logger.info(msg, ctx ?? {}),
  };
  return deps;
}

export const handler = async (event: CustomSmsSenderEvent): Promise<void> => {
  try {
    await deliverOtp(getDeps(), event);
  } catch (err) {
    // Log with routing context, then rethrow: the initiating Cognito call MUST fail loudly
    // (spec rev 2) so app-auth can return `send_failed`. Never log the code itself.
    logger.error("otp_delivery_failed", {
      triggerSource: event.triggerSource,
      channel: event.request.userAttributes["custom:otpChannel"],
      sub: event.request.userAttributes.sub,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
};
