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

export interface MessageTypeSpec {
  /** Template name as registered with Meta (per-language variants share the name). */
  metaTemplateName: string;
  category: "authentication" | "utility";
  /** Variables the caller must supply — parsed strictly; a mismatch throws (no fallback). */
  variables: z.ZodTypeAny;
  components: (vars: Record<string, string>) => TemplateComponent[];
}

export const OtpCodeVariables = z.object({ code: z.string().min(4).max(12) }).strict();

export const MESSAGE_TYPES = {
  // Meta authentication templates have a fixed shape: the code as the body parameter AND as the
  // copy-code (url sub_type) button parameter.
  otp_code: {
    metaTemplateName: "otp_code",
    category: "authentication",
    variables: OtpCodeVariables,
    components: (v) => [
      { type: "body", parameters: [{ type: "text", text: v.code! }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: v.code! }] },
    ],
  },
} satisfies Record<string, MessageTypeSpec>;

export type MessageType = keyof typeof MESSAGE_TYPES;
