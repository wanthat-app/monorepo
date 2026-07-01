import { SendWhatsAppMessageCommand, type SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import type { MessageLanguage } from "@wanthat/contracts";
import { buildTemplateMessage } from "./payload";
import type { MessageType } from "./registry";

/** WhatsApp Cloud API version — End User Messaging Social supports v20 and later. */
export const META_API_VERSION = "v20.0";

/**
 * Pure executor over AWS End User Messaging Social (ADR-0023): build the approved-template
 * payload and submit it, or throw. No config reads and no fallbacks — the caller (message-sender,
 * whatsapp-dispatcher) supplies the origination identity per call and decides what a failure means.
 */
export class WhatsAppSender {
  constructor(private readonly client: SocialMessagingClient) {}

  /** Submit one template message; resolves with Meta's message id, throws on any submission error. */
  async sendTemplate(args: {
    phoneNumberId: string;
    type: MessageType;
    language: MessageLanguage;
    variables: unknown;
    to: string;
  }): Promise<{ messageId: string | undefined }> {
    const message = buildTemplateMessage(args);
    const res = await this.client.send(
      new SendWhatsAppMessageCommand({
        originationPhoneNumberId: args.phoneNumberId,
        metaApiVersion: META_API_VERSION,
        message: new TextEncoder().encode(JSON.stringify(message)),
      }),
    );
    return { messageId: res.messageId };
  }
}
