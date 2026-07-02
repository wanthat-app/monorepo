import { z } from "zod";

/**
 * Message-type registry (ADR-0023): logical type -> Meta template name, category, and variable
 * schema. Code is the source of truth for WHAT we send; Meta is the approval authority — the
 * template text submitted for approval lives in docs/whatsapp-onboarding.md and must stay in sync
 * with the components built here.
 */

/** A Meta Cloud API template component (the subset we use). */
export interface TemplateComponent {
  type: "body" | "button";
  sub_type?: "url";
  index?: string;
  parameters: Array<{ type: "text"; text: string }>;
}

export interface MessageTypeSpec<V = unknown> {
  /** Template name as registered with Meta (per-language variants share the name). */
  metaTemplateName: string;
  category: "authentication" | "utility";
  /** Variables the caller must supply — parsed strictly; a mismatch throws (no fallback). */
  variables: z.ZodType<V>;
  components: (vars: V) => TemplateComponent[];
}

/** Identity helper that pins V per entry, so components() is fully typed at the definition site. */
function defineMessageType<V>(spec: MessageTypeSpec<V>): MessageTypeSpec<V> {
  return spec;
}

export const OtpCodeVariables = z.object({ code: z.string().min(4).max(12) }).strict();

export const OptinWelcomeVariables = z
  .object({ firstName: z.string().min(1).max(100), appUrl: z.string().url() })
  .strict();

export const MESSAGE_TYPES = {
  // Meta authentication templates have a fixed shape: the code as the body parameter AND as the
  // copy-code (url sub_type) button parameter.
  otp_code: defineMessageType({
    metaTemplateName: "otp_code",
    category: "authentication",
    variables: OtpCodeVariables,
    components: (v) => [
      { type: "body", parameters: [{ type: "text", text: v.code }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: v.code }] },
    ],
  }),
  // Utility template: welcome message in the member's language with a link to the app. Text as
  // submitted to Meta lives in docs/whatsapp-onboarding.md ({{1}} firstName, {{2}} appUrl).
  optin_welcome: defineMessageType({
    metaTemplateName: "optin_welcome",
    category: "utility",
    variables: OptinWelcomeVariables,
    components: (v) => [
      {
        type: "body",
        parameters: [
          { type: "text", text: v.firstName },
          { type: "text", text: v.appUrl },
        ],
      },
    ],
  }),
};

export type MessageType = keyof typeof MESSAGE_TYPES;
