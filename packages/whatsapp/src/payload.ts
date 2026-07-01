import type { MessageLanguage } from "@wanthat/contracts";
import { MESSAGE_TYPES, type MessageType, type MessageTypeSpec, type TemplateComponent } from "./registry";

/** The Meta Cloud API `messages` object submitted through SendWhatsAppMessage. */
export interface TemplateMessage {
  messaging_product: "whatsapp";
  recipient_type: "individual";
  to: string;
  type: "template";
  template: {
    name: string;
    language: { code: MessageLanguage };
    components: TemplateComponent[];
  };
}

/**
 * Build a template message or THROW (unknown type, invalid variables). A pure function — no
 * fallbacks, no config: ambiguity is the caller's problem to resolve, not this library's to absorb.
 */
export function buildTemplateMessage(args: {
  type: MessageType;
  language: MessageLanguage;
  variables: unknown;
  to: string;
}): TemplateMessage {
  const spec: MessageTypeSpec | undefined = MESSAGE_TYPES[args.type];
  if (!spec) throw new Error(`unknown message type: ${String(args.type)}`);
  const vars = spec.variables.parse(args.variables) as Record<string, string>;
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: args.to,
    type: "template",
    template: {
      name: spec.metaTemplateName,
      language: { code: args.language },
      components: spec.components(vars),
    },
  };
}
