# WhatsApp Messaging MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship ADR-0023's MVP — OTP delivery over WhatsApp (SMS by choice) and an `optin_welcome` message on registration — as two deployable PR slices, everything kill-switched OFF until Meta/WABA onboarding completes.

**Architecture:** Per `docs/superpowers/specs/2026-07-02-whatsapp-messaging-design.md` (rev 2). Strict separation of concerns: `@wanthat/whatsapp` and `services/message-sender` are pure executors (send via the requested channel or throw); `app-auth` is the OTP flow controller (per-channel gates, explicit errors, no silent switching); the UI owns choice/recovery via a new public `GET /auth/config`. Notifications ride a transactional outbox (DynamoDB Streams → non-VPC dispatcher, the NAT-free bridge).

**Tech Stack:** TypeScript/Node 24, pnpm + Turborepo, Zod contracts, Hono, vitest, AWS CDK v2, `@aws-sdk/client-socialmessaging` (End User Messaging Social), `@aws-crypto/client-node` (Encryption SDK for the Cognito custom-sender code), SNS SMS.

## Global Constraints

- ADRs are locked — do not edit `adrs/*`; this plan implements ADR-0023 as specced.
- Every CDK `description` string must be ASCII-only (no em-dashes/unicode) — non-ASCII breaks deploys.
- Fix all warnings at the source; NEVER suppress without asking the user.
- All new config keys ship with WhatsApp-off defaults: `auth.whatsappEnabled=false`, `auth.defaultOtpChannel="whatsapp"`, `whatsapp.phoneNumberId=""`, `notifications.whatsappEnabled=false`.
- The runtime config table stays single-writer: only admin-api gets a write grant; all new consumers get `grantReadData` and type their config field as `RuntimeConfigReader`.
- `message-sender` / `@wanthat/whatsapp` NEVER default a channel, read kill switches, or fall back WhatsApp→SMS. Missing channel attribute, empty `phoneNumberId`, or any send error → throw.
- End User Messaging Social is NOT available in il-central-1 — its SDK client uses `WHATSAPP_SOCIAL_REGION` (deploy-time env, `eu-central-1`).
- Root commands: `pnpm build` / `pnpm typecheck` / `pnpm test` / `pnpm lint` (biome ci) / `pnpm synth`. Run `pnpm install` after adding any package.json.
- PR slices: PR 1 = tasks 1–8 (branch `whatsapp-otp`, already exists with the spec committed). PR 2 = tasks 9–14 (branch `whatsapp-welcome` off main after PR 1 merges). PRs open ready (not draft); merge to main deploys dev.
- New workspaces under `packages/*` / `services/*` are auto-picked-up by pnpm-workspace.yaml globs; no root config change needed.

---

## PR 1 — "Sign in with OTP over WhatsApp"

### Task 1: Contracts — channel/language enums, auth bodies, config keys

**Files:**
- Modify: `packages/contracts/src/identity/auth.ts`
- Modify: `packages/contracts/src/config/keys.ts`
- Test: `packages/contracts/src/identity/auth.test.ts` (create)

**Interfaces (Produces):**
- `OtpChannel` — Zod enum + type `"whatsapp" | "sms"`
- `MessageLanguage` — Zod enum + type `"he" | "en"`
- `AuthStartBody = { phone, channel: OtpChannel, locale?: MessageLanguage }` (channel REQUIRED)
- `AuthResendBody = { challengeId, channel: OtpChannel }` (channel REQUIRED)
- `AuthStartResponse` / `AuthResendResponse` gain `channel: OtpChannel`
- `AuthConfigResponse = { channels: OtpChannel[], defaultChannel: OtpChannel | null }`
- Config keys `auth.whatsappEnabled` (bool, default `false`), `auth.defaultOtpChannel` (enum, default `"whatsapp"`), `whatsapp.phoneNumberId` (string, default `""`)
- All exported from `@wanthat/contracts` via the existing `export * from "./identity"` / `"./config"` barrels.

- [ ] **Step 1: Write the failing test** — create `packages/contracts/src/identity/auth.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CONFIG_DEFAULTS, parseConfigValue } from "../config/keys";
import { AuthConfigResponse, AuthResendBody, AuthStartBody, OtpChannel } from "./auth";

describe("OTP channel contracts (ADR-0023)", () => {
  it("requires an explicit channel on /auth/start — no server-side default", () => {
    expect(AuthStartBody.safeParse({ phone: "+972541234567" }).success).toBe(false);
    expect(
      AuthStartBody.safeParse({ phone: "+972541234567", channel: "whatsapp" }).success,
    ).toBe(true);
    expect(
      AuthStartBody.safeParse({ phone: "+972541234567", channel: "email" }).success,
    ).toBe(false);
  });

  it("accepts an optional template language on /auth/start", () => {
    expect(
      AuthStartBody.safeParse({ phone: "+972541234567", channel: "sms", locale: "he" }).success,
    ).toBe(true);
    expect(
      AuthStartBody.safeParse({ phone: "+972541234567", channel: "sms", locale: "fr" }).success,
    ).toBe(false);
  });

  it("requires an explicit channel on /auth/resend", () => {
    expect(AuthResendBody.safeParse({ challengeId: "c1" }).success).toBe(false);
    expect(AuthResendBody.safeParse({ challengeId: "c1", channel: "sms" }).success).toBe(true);
  });

  it("models the /auth/config projection", () => {
    expect(
      AuthConfigResponse.parse({ channels: ["whatsapp", "sms"], defaultChannel: "whatsapp" }),
    ).toEqual({ channels: ["whatsapp", "sms"], defaultChannel: "whatsapp" });
    expect(AuthConfigResponse.parse({ channels: [], defaultChannel: null }).defaultChannel).toBe(
      null,
    );
  });

  it("ships the WhatsApp config keys kill-switched OFF", () => {
    expect(CONFIG_DEFAULTS["auth.whatsappEnabled"]).toBe(false);
    expect(CONFIG_DEFAULTS["auth.defaultOtpChannel"]).toBe("whatsapp");
    expect(CONFIG_DEFAULTS["whatsapp.phoneNumberId"]).toBe("");
    expect(parseConfigValue("auth.defaultOtpChannel", "sms")).toBe("sms");
    expect(() => parseConfigValue("auth.defaultOtpChannel", "email")).toThrow();
    expect(OtpChannel.parse("whatsapp")).toBe("whatsapp");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @wanthat/contracts test`
Expected: FAIL — `OtpChannel`/`AuthConfigResponse` not exported; `auth.whatsappEnabled` not a `ConfigKey`.

- [ ] **Step 3: Implement — `packages/contracts/src/identity/auth.ts`.** Add below the `AuthSession` block (before `AuthStartBody`) and replace the existing `AuthStartBody`/`AuthStartResponse`/`AuthResendBody`/`AuthResendResponse` definitions:

```ts
/**
 * OTP delivery channel (ADR-0023). REQUIRED in requests — the UI picks it (from GET /auth/config)
 * and states it explicitly; the server never defaults or silently switches a channel.
 */
export const OtpChannel = z.enum(["whatsapp", "sms"]);
export type OtpChannel = z.infer<typeof OtpChannel>;

/** Languages our Meta templates are approved in (ADR-0023). */
export const MessageLanguage = z.enum(["he", "en"]);
export type MessageLanguage = z.infer<typeof MessageLanguage>;

// GET /auth/config — the public projection the SPA renders the channel choice from. Advisory
// only: /auth/start re-checks the same availability predicate server-side.
export const AuthConfigResponse = z.object({
  channels: z.array(OtpChannel),
  defaultChannel: OtpChannel.nullable(),
});
export type AuthConfigResponse = z.infer<typeof AuthConfigResponse>;

// POST /auth/start — phone-only entry (login-or-register, uniform/enumeration-safe). `locale` is
// the SPA's active UI language; app-auth writes it to the Cognito `locale` attribute so the
// message-sender picks the template language (app-core is in-VPC and cannot, ADR-0021).
export const AuthStartBody = z.object({
  phone: PhoneE164,
  channel: OtpChannel,
  locale: MessageLanguage.optional(),
});
export type AuthStartBody = z.infer<typeof AuthStartBody>;

export const AuthStartResponse = z.object({
  challengeId: z.string(),
  resendAfterSec: z.number().int().nonnegative(),
  expiresInSec: z.number().int().positive(),
  /** The channel the OTP was submitted through (optimistic send — delivery is async). */
  channel: OtpChannel,
});
export type AuthStartResponse = z.infer<typeof AuthStartResponse>;

// POST /auth/resend — resend under a server-enforced cooldown. `channel` is required and MAY
// differ from the original request: "didn't get it on WhatsApp? send via SMS" is this field.
export const AuthResendBody = z.object({ challengeId: z.string(), channel: OtpChannel });
export type AuthResendBody = z.infer<typeof AuthResendBody>;

export const AuthResendResponse = z.object({
  resendAfterSec: z.number().int().nonnegative(),
  expiresInSec: z.number().int().positive(),
  channel: OtpChannel,
});
export type AuthResendResponse = z.infer<typeof AuthResendResponse>;
```

- [ ] **Step 4: Implement — `packages/contracts/src/config/keys.ts`.** Add after `AuthSmsLockoutMinutes` (line ~76):

```ts
/**
 * WhatsApp-OTP kill switch (ADR-0023). Ships `false`; flipped on after Meta/WABA onboarding.
 * Gates the `whatsapp` channel in app-auth's availability predicate + GET /auth/config.
 */
export const AuthWhatsappEnabled = z.boolean();
/** Which channel GET /auth/config tells the UI to preselect (ADR-0023: whatsapp from day 1). */
export const AuthDefaultOtpChannel = z.enum(["whatsapp", "sms"]);
/**
 * AWS End User Messaging Social origination identity ("phone-number-id-..."), unknown until
 * onboarding. Empty string = WhatsApp inert regardless of the other switches. Runtime config
 * (not SSM) so flipping it needs no redeploy — read by message-sender and whatsapp-dispatcher.
 */
export const WhatsappPhoneNumberId = z.string().max(120);
```

Then extend the three tables — `CONFIG_KEYS` entries (after `"auth.smsLockoutMinutes"`):

```ts
  "auth.whatsappEnabled",
  "auth.defaultOtpChannel",
  "whatsapp.phoneNumberId",
```

`CONFIG_SCHEMAS` entries:

```ts
  "auth.whatsappEnabled": AuthWhatsappEnabled,
  "auth.defaultOtpChannel": AuthDefaultOtpChannel,
  "whatsapp.phoneNumberId": WhatsappPhoneNumberId,
```

`CONFIG_DEFAULTS` entries:

```ts
  // WhatsApp ships kill-switched OFF until Meta/WABA onboarding completes (ADR-0023).
  "auth.whatsappEnabled": false,
  "auth.defaultOtpChannel": "whatsapp",
  "whatsapp.phoneNumberId": "",
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @wanthat/contracts test && pnpm --filter @wanthat/contracts typecheck`
Expected: PASS (note: `services/app-auth` will NOT typecheck yet — its router still builds `AuthStartResponse` without `channel`; that's Task 5. Do not run the full workspace typecheck at this step.)

- [ ] **Step 6: Commit**

```bash
git add packages/contracts
git commit -m "feat(contracts): OTP channel + language enums, /auth/config projection, WhatsApp config keys (ADR-0023)"
```

---

### Task 2: `@wanthat/dynamo` — `RuntimeConfigReader` + `requestedChannel` on the challenge record

**Files:**
- Modify: `packages/dynamo/src/runtime-config.ts`
- Modify: `packages/dynamo/src/auth-challenge.ts`
- Modify: `packages/dynamo/src/index.ts`

**Interfaces (Produces):**
- `RuntimeConfigReader = Pick<RuntimeConfigRepo, "get">` — every non-admin consumer types its config field as this.
- `ChallengeRecord.requestedChannel?: OtpChannel` (optional — in-flight records predate it).

- [ ] **Step 1: Add the reader type** — in `packages/dynamo/src/runtime-config.ts`, after the `RuntimeConfigRepo` class:

```ts
/**
 * Read-only view of the runtime config. The table is single-writer (admin-api holds the sole IAM
 * write grant); every other service depends on this type, so a stray `put` from a non-admin
 * service does not even compile. IAM is the enforcement; this is documentation that cannot drift.
 */
export type RuntimeConfigReader = Pick<RuntimeConfigRepo, "get">;
```

- [ ] **Step 2: Add `requestedChannel`** — in `packages/dynamo/src/auth-challenge.ts`, add the import at the top and the field to `ChallengeRecord` (after `isNewUser`):

```ts
import type { OtpChannel } from "@wanthat/contracts";
```

```ts
  /** OTP channel of the LAST send for this challenge (start or resend) — ADR-0023. Optional: records written before the channel feature lack it. */
  requestedChannel?: OtpChannel;
```

- [ ] **Step 3: Export** — in `packages/dynamo/src/index.ts` change the runtime-config export line to:

```ts
export { type RuntimeConfigReader, RuntimeConfigRepo } from "./runtime-config";
```

- [ ] **Step 4: Verify and commit**

Run: `pnpm --filter @wanthat/dynamo test && pnpm --filter @wanthat/dynamo typecheck`
Expected: PASS

```bash
git add packages/dynamo
git commit -m "feat(dynamo): RuntimeConfigReader (single-writer at the type level) + requestedChannel on ChallengeRecord"
```

---

### Task 3: `@wanthat/whatsapp` — pure library (registry, payload builder, sender)

**Files:**
- Create: `packages/whatsapp/package.json`, `packages/whatsapp/tsconfig.json`
- Create: `packages/whatsapp/src/registry.ts`, `src/payload.ts`, `src/client.ts`, `src/index.ts`
- Test: `packages/whatsapp/src/payload.test.ts`, `src/client.test.ts`

**Interfaces (Produces):**
- `MessageType` — `"otp_code"` (PR 2 adds `"optin_welcome"`)
- `buildTemplateMessage({ type, language, variables, to })` → Meta Cloud API message object; THROWS on unknown type / invalid variables (no fallbacks)
- `class WhatsAppSender { constructor(client: SocialMessagingClient); sendTemplate({ phoneNumberId, type, language, variables, to }): Promise<{ messageId: string | undefined }> }` — no config reads; `phoneNumberId` is passed in per call
- `META_API_VERSION = "v20.0"`

- [ ] **Step 1: Scaffold.** `packages/whatsapp/package.json`:

```json
{
  "name": "@wanthat/whatsapp",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@aws-sdk/client-socialmessaging": "^3.600.0",
    "@wanthat/contracts": "workspace:*",
    "zod": "^3.23.0"
  }
}
```

`packages/whatsapp/tsconfig.json` (same shape as `packages/dynamo/tsconfig.json`):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

Run: `pnpm install`

- [ ] **Step 2: Write the failing tests.** `packages/whatsapp/src/payload.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildTemplateMessage } from "./payload";

describe("buildTemplateMessage", () => {
  it("builds the otp_code authentication template (body + copy-code button params)", () => {
    const msg = buildTemplateMessage({
      type: "otp_code",
      language: "he",
      variables: { code: "12345678" },
      to: "+972541234567",
    });
    expect(msg).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "+972541234567",
      type: "template",
      template: {
        name: "otp_code",
        language: { code: "he" },
        components: [
          { type: "body", parameters: [{ type: "text", text: "12345678" }] },
          {
            type: "button",
            sub_type: "url",
            index: "0",
            parameters: [{ type: "text", text: "12345678" }],
          },
        ],
      },
    });
  });

  it("throws on invalid variables — no fallback (spec rev 2)", () => {
    expect(() =>
      buildTemplateMessage({ type: "otp_code", language: "en", variables: {}, to: "+97250" }),
    ).toThrow();
    expect(() =>
      buildTemplateMessage({
        type: "otp_code",
        language: "en",
        variables: { code: "123", extra: "x" },
        to: "+97250",
      }),
    ).toThrow();
  });

  it("throws on an unknown message type", () => {
    expect(() =>
      buildTemplateMessage({
        // @ts-expect-error deliberately outside the registry
        type: "nope",
        language: "en",
        variables: {},
        to: "+97250",
      }),
    ).toThrow(/unknown message type/);
  });
});
```

`packages/whatsapp/src/client.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { META_API_VERSION, WhatsAppSender } from "./client";

describe("WhatsAppSender", () => {
  it("submits the built payload through SendWhatsAppMessage", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "wamid.X" });
    // Structural stand-in for SocialMessagingClient — the sender only calls .send().
    const sender = new WhatsAppSender({ send } as never);

    const res = await sender.sendTemplate({
      phoneNumberId: "phone-number-id-test",
      type: "otp_code",
      language: "en",
      variables: { code: "12345678" },
      to: "+972541234567",
    });

    expect(res).toEqual({ messageId: "wamid.X" });
    const input = send.mock.calls[0][0].input;
    expect(input.originationPhoneNumberId).toBe("phone-number-id-test");
    expect(input.metaApiVersion).toBe(META_API_VERSION);
    const body = JSON.parse(new TextDecoder().decode(input.message));
    expect(body.template.name).toBe("otp_code");
    expect(body.to).toBe("+972541234567");
  });

  it("propagates submission errors — the caller decides what a failure means", async () => {
    const send = vi.fn().mockRejectedValue(new Error("ThrottledRequestException"));
    const sender = new WhatsAppSender({ send } as never);
    await expect(
      sender.sendTemplate({
        phoneNumberId: "phone-number-id-test",
        type: "otp_code",
        language: "en",
        variables: { code: "12345678" },
        to: "+972541234567",
      }),
    ).rejects.toThrow("ThrottledRequestException");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @wanthat/whatsapp test`
Expected: FAIL — modules `./payload` / `./client` don't exist.

- [ ] **Step 4: Implement.** `packages/whatsapp/src/registry.ts`:

```ts
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
      { type: "body", parameters: [{ type: "text", text: v.code }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: v.code }] },
    ],
  },
} satisfies Record<string, MessageTypeSpec>;

export type MessageType = keyof typeof MESSAGE_TYPES;
```

`packages/whatsapp/src/payload.ts`:

```ts
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
```

`packages/whatsapp/src/client.ts`:

```ts
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
```

`packages/whatsapp/src/index.ts`:

```ts
/**
 * `@wanthat/whatsapp` (ADR-0023) — a pure library over AWS End User Messaging Social: the
 * message-type registry, the template payload builder, and the sender. Consumed by
 * services/message-sender (OTP) and services/whatsapp-dispatcher (notifications).
 */
export { META_API_VERSION, WhatsAppSender } from "./client";
export { buildTemplateMessage, type TemplateMessage } from "./payload";
export {
  MESSAGE_TYPES,
  type MessageType,
  type MessageTypeSpec,
  OtpCodeVariables,
  type TemplateComponent,
} from "./registry";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @wanthat/whatsapp test && pnpm --filter @wanthat/whatsapp typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/whatsapp pnpm-lock.yaml
git commit -m "feat(whatsapp): @wanthat/whatsapp pure library — registry, payload builder, EUM Social sender (ADR-0023)"
```

---

### Task 4: `services/message-sender` — Cognito custom-sender executor

**Files:**
- Create: `services/message-sender/package.json`, `tsconfig.json`
- Create: `services/message-sender/src/send.ts` (pure, DI), `src/handler.ts` (wiring)
- Test: `services/message-sender/src/send.test.ts`

**Interfaces:**
- Consumes: `WhatsAppSender.sendTemplate` (Task 3), `RuntimeConfigReader` (Task 2), `OtpChannel`/`MessageLanguage` (Task 1)
- Produces: `deliverOtp(deps: SendDeps, event: CustomSmsSenderEvent): Promise<void>` and the Lambda `handler` bundled by IdentityStack (Task 6). Env contract: `KMS_KEY_ARN`, `RUNTIME_CONFIG_TABLE`, `WHATSAPP_SOCIAL_REGION`.

- [ ] **Step 1: Scaffold.** `services/message-sender/package.json`:

```json
{
  "name": "@wanthat/message-sender",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "dist/handler.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@aws-crypto/client-node": "^5.0.0",
    "@aws-lambda-powertools/logger": "^2.8.0",
    "@aws-sdk/client-sns": "^3.600.0",
    "@aws-sdk/client-socialmessaging": "^3.600.0",
    "@wanthat/contracts": "workspace:*",
    "@wanthat/dynamo": "workspace:*",
    "@wanthat/whatsapp": "workspace:*"
  }
}
```

`services/message-sender/tsconfig.json`: same content as `services/fx-rates/tsconfig.json` (extends base, `outDir dist`, `rootDir src`, include `src`).

Run: `pnpm install`

- [ ] **Step 2: Write the failing tests.** `services/message-sender/src/send.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type CustomSmsSenderEvent, deliverOtp, type SendDeps } from "./send";

const deps = {
  config: { get: vi.fn() },
  decryptCode: vi.fn().mockResolvedValue("12345678"),
  whatsapp: { sendTemplate: vi.fn().mockResolvedValue({ messageId: "wamid.X" }) },
  sms: { publish: vi.fn().mockResolvedValue(undefined) },
} satisfies SendDeps;

function event(attrs: Record<string, string | undefined>): CustomSmsSenderEvent {
  return {
    triggerSource: "CustomSMSSender_Authentication",
    request: { type: "customSMSSenderRequestV1", code: "ZW5jcnlwdGVk", userAttributes: attrs },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.decryptCode.mockResolvedValue("12345678");
  deps.config.get.mockResolvedValue("phone-number-id-test");
});

describe("deliverOtp — pure executor (spec rev 2: requested channel or throw)", () => {
  it("delivers via WhatsApp with the profile language", async () => {
    await deliverOtp(deps, event({ "custom:otpChannel": "whatsapp", phone_number: "+97254", locale: "he" }));
    expect(deps.whatsapp.sendTemplate).toHaveBeenCalledWith({
      phoneNumberId: "phone-number-id-test",
      type: "otp_code",
      language: "he",
      variables: { code: "12345678" },
      to: "+97254",
    });
    expect(deps.sms.publish).not.toHaveBeenCalled();
  });

  it("defaults the template language to en when the profile has none", async () => {
    await deliverOtp(deps, event({ "custom:otpChannel": "whatsapp", phone_number: "+97254" }));
    expect(deps.whatsapp.sendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ language: "en" }),
    );
  });

  it("delivers via SNS SMS with Cognito's native wording", async () => {
    await deliverOtp(deps, event({ "custom:otpChannel": "sms", phone_number: "+97254" }));
    expect(deps.sms.publish).toHaveBeenCalledWith("+97254", "Your authentication code is 12345678.");
    expect(deps.whatsapp.sendTemplate).not.toHaveBeenCalled();
    expect(deps.config.get).not.toHaveBeenCalled(); // sms needs no config at all
  });

  it("THROWS on a missing/invalid channel attribute — never assumes a default", async () => {
    await expect(deliverOtp(deps, event({ phone_number: "+97254" }))).rejects.toThrow(/otpChannel/);
    await expect(
      deliverOtp(deps, event({ "custom:otpChannel": "email", phone_number: "+97254" })),
    ).rejects.toThrow(/otpChannel/);
    expect(deps.whatsapp.sendTemplate).not.toHaveBeenCalled();
    expect(deps.sms.publish).not.toHaveBeenCalled();
  });

  it("THROWS when whatsapp.phoneNumberId is unset — never degrades to sms", async () => {
    deps.config.get.mockResolvedValue("");
    await expect(
      deliverOtp(deps, event({ "custom:otpChannel": "whatsapp", phone_number: "+97254" })),
    ).rejects.toThrow(/phoneNumberId/);
    expect(deps.sms.publish).not.toHaveBeenCalled();
  });

  it("propagates a WhatsApp submission error — NO in-Lambda SMS fallback", async () => {
    deps.whatsapp.sendTemplate.mockRejectedValue(new Error("template not approved"));
    await expect(
      deliverOtp(deps, event({ "custom:otpChannel": "whatsapp", phone_number: "+97254" })),
    ).rejects.toThrow("template not approved");
    expect(deps.sms.publish).not.toHaveBeenCalled();
  });

  it("propagates an SNS error — sms failures fail too", async () => {
    deps.sms.publish.mockRejectedValue(new Error("sns down"));
    await expect(
      deliverOtp(deps, event({ "custom:otpChannel": "sms", phone_number: "+97254" })),
    ).rejects.toThrow("sns down");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @wanthat/message-sender test`
Expected: FAIL — `./send` doesn't exist.

- [ ] **Step 4: Implement.** `services/message-sender/src/send.ts`:

```ts
import { MessageLanguage, OtpChannel } from "@wanthat/contracts";
import type { RuntimeConfigReader } from "@wanthat/dynamo";

/** The slice of Cognito's custom-SMS-sender event we consume. */
export interface CustomSmsSenderEvent {
  triggerSource: string;
  request: {
    type: string;
    /** The OTP code, encrypted by Cognito with the pool's customSenderKmsKey (AWS Encryption SDK ciphertext, base64). */
    code: string;
    userAttributes: Record<string, string | undefined>;
  };
}

export interface SendDeps {
  config: RuntimeConfigReader;
  decryptCode: (encryptedB64: string) => Promise<string>;
  whatsapp: {
    sendTemplate(args: {
      phoneNumberId: string;
      type: "otp_code";
      language: MessageLanguage;
      variables: { code: string };
      to: string;
    }): Promise<unknown>;
  };
  sms: { publish(toE164: string, message: string): Promise<void> };
}

/**
 * Pure executor (ADR-0023, spec rev 2): deliver the OTP via EXACTLY the requested channel or
 * throw. No channel defaults, no kill-switch reads, no WhatsApp->SMS fallback — a throw fails the
 * initiating AdminInitiateAuth (UnexpectedLambdaException), app-auth maps it to `send_failed`,
 * and falling back is the UI's decision, not this function's.
 */
export async function deliverOtp(deps: SendDeps, event: CustomSmsSenderEvent): Promise<void> {
  const attrs = event.request.userAttributes;

  // app-auth writes custom:otpChannel on EVERY start/resend; absence is an invariant violation.
  const channel = OtpChannel.safeParse(attrs["custom:otpChannel"]);
  if (!channel.success)
    throw new Error("message-sender: missing or invalid custom:otpChannel user attribute");

  const to = attrs.phone_number;
  if (!to) throw new Error("message-sender: event carries no phone_number");

  const code = await deps.decryptCode(event.request.code);

  if (channel.data === "whatsapp") {
    // The origination identity is a send parameter (it cannot ride the Cognito event), not flow logic.
    const phoneNumberId = await deps.config.get("whatsapp.phoneNumberId");
    if (typeof phoneNumberId !== "string" || phoneNumberId === "")
      throw new Error("message-sender: whatsapp.phoneNumberId is unset (onboarding incomplete)");
    const locale = MessageLanguage.safeParse(attrs.locale);
    await deps.whatsapp.sendTemplate({
      phoneNumberId,
      type: "otp_code",
      language: locale.success ? locale.data : "en",
      variables: { code },
      to,
    });
    return;
  }

  // sms — replicate Cognito's native wording: once the trigger is attached, Cognito sends nothing
  // itself and this function owns ALL OTP delivery (including plain SMS).
  await deps.sms.publish(to, `Your authentication code is ${code}.`);
}
```

`services/message-sender/src/handler.ts`:

```ts
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
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @wanthat/message-sender test && pnpm --filter @wanthat/message-sender typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add services/message-sender pnpm-lock.yaml
git commit -m "feat(message-sender): Cognito custom-sender executor — requested channel or throw (ADR-0023)"
```

---

### Task 5: `app-auth` — availability predicate, `GET /auth/config`, channel-aware start/resend

**Files:**
- Modify: `services/app-auth/src/auth/killswitch.ts` (replace `smsEnabled` with the predicate)
- Modify: `services/app-auth/src/auth/router.ts`
- Modify: `services/app-auth/src/auth/velocity.ts` (config param → `RuntimeConfigReader`)
- Modify: `services/app-auth/src/context.ts` (config field → `RuntimeConfigReader`)
- Test: `services/app-auth/src/auth/router.test.ts` (extend)

**Interfaces:**
- Consumes: contracts from Task 1, `RuntimeConfigReader` (Task 2), existing `Cognito.updateAttributes(username, AttributeType[])` (`services/app-auth/src/auth/cognito.ts:179` — no new Cognito method needed).
- Produces: `otpChannelAvailability(config): Promise<{ channels: OtpChannel[]; defaultChannel: OtpChannel | null }>`; routes `GET /auth/config`, channel-gated `POST /auth/start` / `/auth/resend`; error codes `channel_disabled` (503) and `send_failed` (502), both carrying `channel`.

- [ ] **Step 1: Write the failing tests.** In `services/app-auth/src/auth/router.test.ts`:

(a) Add `updateAttributes: vi.fn()` to the `fake.cognito` object (after `createUser`).

(b) Replace the `beforeEach` config mock so the WhatsApp keys resolve (WhatsApp available by default in tests):

```ts
beforeEach(() => {
  vi.clearAllMocks();
  fake.config.get.mockImplementation((key: string) => {
    switch (key) {
      case "auth.smsEnabled":
        return Promise.resolve(true);
      case "auth.whatsappEnabled":
        return Promise.resolve(true);
      case "auth.defaultOtpChannel":
        return Promise.resolve("whatsapp");
      case "whatsapp.phoneNumberId":
        return Promise.resolve("phone-number-id-test");
      case "auth.smsMaxPerWindow":
        return Promise.resolve(5);
      case "auth.smsLockoutMinutes":
        return Promise.resolve(180);
      default:
        return Promise.resolve(undefined);
    }
  });
  fake.velocity.hit.mockResolvedValue({ count: 1, ttl: 0 });
});
```

(c) Update the two existing `/auth/start` posts to include a channel — `post("/auth/start", { phone: PHONE, channel: "sms" })` — and replace the `503s when the SMS kill switch is off` test plus add the new describe blocks:

```ts
describe("GET /auth/config", () => {
  it("projects the enabled channels and the preselect", async () => {
    const res = await app.request("/auth/config");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ channels: ["whatsapp", "sms"], defaultChannel: "whatsapp" });
  });

  it("omits whatsapp when the switch is on but the phoneNumberId is unset", async () => {
    fake.config.get.mockImplementation((key: string) =>
      Promise.resolve(
        { "auth.smsEnabled": true, "auth.whatsappEnabled": true, "whatsapp.phoneNumberId": "", "auth.defaultOtpChannel": "whatsapp" }[key],
      ),
    );
    expect(await (await app.request("/auth/config")).json()).toEqual({
      channels: ["sms"],
      defaultChannel: "sms",
    });
  });

  it("returns an empty projection when everything is off", async () => {
    fake.config.get.mockResolvedValue(false);
    expect(await (await app.request("/auth/config")).json()).toEqual({
      channels: [],
      defaultChannel: null,
    });
  });
});

describe("POST /auth/start — channel handling (ADR-0023)", () => {
  beforeEach(() => {
    fake.cognito.getUserByPhone.mockResolvedValue({ username: "u", sub: SUB });
    fake.cognito.startSmsOtp.mockResolvedValue({ session: "sess" });
  });

  it("400s when channel is missing — no server-side default", async () => {
    expect((await post("/auth/start", { phone: PHONE })).status).toBe(400);
  });

  it("writes custom:otpChannel (+ locale) BEFORE initiating, stores requestedChannel, echoes channel", async () => {
    const res = await post("/auth/start", { phone: PHONE, channel: "whatsapp", locale: "he" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ channel: "whatsapp" });
    expect(fake.cognito.updateAttributes).toHaveBeenCalledWith("u", [
      { Name: "custom:otpChannel", Value: "whatsapp" },
      { Name: "locale", Value: "he" },
    ]);
    // Attribute write happens before the initiate that triggers the sender.
    expect(fake.cognito.updateAttributes.mock.invocationCallOrder[0]).toBeLessThan(
      fake.cognito.startSmsOtp.mock.invocationCallOrder[0],
    );
    expect(fake.challenges.putChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ requestedChannel: "whatsapp" }),
    );
  });

  it("503s channel_disabled for a requested-but-unavailable channel — no silent switch", async () => {
    fake.config.get.mockImplementation((key: string) =>
      Promise.resolve(
        { "auth.smsEnabled": true, "auth.whatsappEnabled": false, "whatsapp.phoneNumberId": "", "auth.defaultOtpChannel": "whatsapp", "auth.smsMaxPerWindow": 5, "auth.smsLockoutMinutes": 180 }[key],
      ),
    );
    const res = await post("/auth/start", { phone: PHONE, channel: "whatsapp" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "channel_disabled", channel: "whatsapp" });
    expect(fake.cognito.startSmsOtp).not.toHaveBeenCalled();
  });

  it("503s channel_disabled for sms when the SMS switch is off", async () => {
    fake.config.get.mockImplementation((key: string) =>
      Promise.resolve(
        { "auth.smsEnabled": false, "auth.whatsappEnabled": true, "whatsapp.phoneNumberId": "phone-number-id-test", "auth.defaultOtpChannel": "whatsapp", "auth.smsMaxPerWindow": 5, "auth.smsLockoutMinutes": 180 }[key],
      ),
    );
    const res = await post("/auth/start", { phone: PHONE, channel: "sms" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "channel_disabled", channel: "sms" });
  });

  it("502s send_failed when the custom sender throws inside AdminInitiateAuth", async () => {
    fake.cognito.startSmsOtp.mockRejectedValue(
      Object.assign(new Error("sender blew up"), { name: "UnexpectedLambdaException" }),
    );
    const res = await post("/auth/start", { phone: PHONE, channel: "whatsapp" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "send_failed", channel: "whatsapp" });
    expect(fake.challenges.putChallenge).not.toHaveBeenCalled(); // no half-created challenge
  });
});

describe("POST /auth/resend — channel switch (ADR-0023)", () => {
  const challenge = {
    challengeId: "c1",
    username: "u",
    sub: SUB,
    phone: PHONE,
    cognitoSession: "sess",
    isNewUser: false,
    requestedChannel: "whatsapp",
    resendAfterEpoch: 0,
    attempts: 0,
    ttl: 0,
  };

  it("re-sends via the explicitly requested channel (the UI's send-via-SMS path)", async () => {
    fake.challenges.getChallenge.mockResolvedValue(challenge);
    fake.cognito.startSmsOtp.mockResolvedValue({ session: "sess2" });
    const res = await post("/auth/resend", { challengeId: "c1", channel: "sms" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ channel: "sms" });
    expect(fake.cognito.updateAttributes).toHaveBeenCalledWith("u", [
      { Name: "custom:otpChannel", Value: "sms" },
    ]);
    expect(fake.challenges.putChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ requestedChannel: "sms", cognitoSession: "sess2" }),
    );
  });

  it("503s channel_disabled on resend too", async () => {
    fake.challenges.getChallenge.mockResolvedValue(challenge);
    fake.config.get.mockImplementation((key: string) =>
      Promise.resolve(
        { "auth.smsEnabled": false, "auth.whatsappEnabled": true, "whatsapp.phoneNumberId": "phone-number-id-test", "auth.defaultOtpChannel": "whatsapp", "auth.smsMaxPerWindow": 5, "auth.smsLockoutMinutes": 180 }[key],
      ),
    );
    const res = await post("/auth/resend", { challengeId: "c1", channel: "sms" });
    expect(res.status).toBe(503);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @wanthat/app-auth test`
Expected: FAIL — `/auth/config` 404s; start accepts a body without channel; no `channel_disabled`/`send_failed`.

- [ ] **Step 3: Implement — replace `services/app-auth/src/auth/killswitch.ts` entirely:**

```ts
import { OtpChannel } from "@wanthat/contracts";
import type { RuntimeConfigReader } from "@wanthat/dynamo";

export interface OtpChannelAvailability {
  channels: OtpChannel[];
  defaultChannel: OtpChannel | null;
}

/**
 * Which OTP channels are currently available (ADR-0020 sms kill switch; ADR-0023 whatsapp).
 * ONE predicate feeds both GET /auth/config (what the UI may offer) and the start/resend gates
 * (what the API accepts), so they cannot drift. WhatsApp needs its switch on AND an onboarded
 * origination identity. A requested-but-unavailable channel is an explicit 503 — never a silent
 * switch (spec rev 2); the server default is only WHICH channel /auth/config tells the UI to
 * preselect, applied here, at the flow-controlling level.
 */
export async function otpChannelAvailability(
  config: RuntimeConfigReader,
): Promise<OtpChannelAvailability> {
  const [smsOn, whatsappOn, phoneNumberId, configuredDefault] = await Promise.all([
    config.get("auth.smsEnabled"),
    config.get("auth.whatsappEnabled"),
    config.get("whatsapp.phoneNumberId"),
    config.get("auth.defaultOtpChannel"),
  ]);
  const channels: OtpChannel[] = [];
  if (whatsappOn === true && phoneNumberId !== "") channels.push("whatsapp");
  if (smsOn === true) channels.push("sms");
  const parsed = OtpChannel.safeParse(configuredDefault);
  const defaultChannel =
    parsed.success && channels.includes(parsed.data) ? parsed.data : (channels[0] ?? null);
  return { channels, defaultChannel };
}
```

- [ ] **Step 4: Implement — `services/app-auth/src/auth/router.ts`.**

(a) Imports: add `AuthConfigResponse`, `AuthResendResponse`, `type OtpChannel` to the `@wanthat/contracts` import; replace `import { smsEnabled } from "./killswitch";` with `import { otpChannelAvailability } from "./killswitch";`.

(b) Add the sender-failure helper after `parseBody`:

```ts
/**
 * Cognito surfaces a custom-sender (message-sender) throw on AdminInitiateAuth as these error
 * names. app-auth maps them to `send_failed` so the UI can offer the other channel (spec rev 2).
 */
const SENDER_FAILURE_ERRORS = new Set(["UnexpectedLambdaException", "UserLambdaValidationException"]);
const isSenderFailure = (err: unknown): boolean =>
  err instanceof Error && SENDER_FAILURE_ERRORS.has(err.name);
```

(c) Add the config route as the first route inside `authRouter()`:

```ts
  // GET /auth/config — public projection of the channel availability (ADR-0023). Advisory only:
  // start/resend re-check the same predicate. no-store so no intermediary caches a stale list.
  auth.get("/config", async (c) => {
    const avail = await otpChannelAvailability(getContext().config);
    c.header("cache-control", "no-store");
    return c.json(AuthConfigResponse.parse(avail));
  });
```

(d) Replace the body of `POST /auth/start` (keep phone normalization; the kill-switch line and everything from there changes):

```ts
  auth.post("/start", async (c) => {
    const body = await parseBody(c, AuthStartBody);
    if (!body) return c.json({ error: "invalid_request" }, 400);
    const ctx = getContext();

    // Re-normalize + validate at the boundary (the SPA can be bypassed, and the E.164 regex alone still
    // accepts a doubled country code Cognito would reject) so every downstream call sees one form.
    const phone = normalizePhone(body.phone);
    if (!phone) return c.json({ error: "invalid_request" }, 400);

    // Per-channel gate (ADR-0023): the requested channel must be available. Explicit 503 — the UI
    // decides what to offer instead; the server never silently switches.
    const avail = await otpChannelAvailability(ctx.config);
    if (!avail.channels.includes(body.channel))
      return c.json({ error: "channel_disabled", channel: body.channel }, 503);

    const gate = await withinVelocity(ctx.config, ctx.velocity, phone, nowEpoch());
    if (!gate.allowed)
      return c.json({ error: "rate_limited", retryAfterSec: gate.retryAfterSec }, 429);

    const existing = await ctx.cognito.getUserByPhone(phone);
    const user = existing ?? (await ctx.cognito.createUser(phone));

    // Channel (+ template language) ride user attributes: Cognito forwards NO ClientMetadata from
    // AdminInitiateAuth to custom sender triggers, so this write IS the request's channel.
    await ctx.cognito.updateAttributes(user.username, [
      { Name: "custom:otpChannel", Value: body.channel },
      ...(body.locale ? [{ Name: "locale", Value: body.locale }] : []),
    ]);

    let session: string;
    try {
      ({ session } = await ctx.cognito.startSmsOtp(user.username));
    } catch (err) {
      if (isSenderFailure(err))
        return c.json({ error: "send_failed", channel: body.channel }, 502);
      throw err;
    }

    const challengeId = randomUUID();
    const now = nowEpoch();
    await ctx.challenges.putChallenge({
      challengeId,
      username: user.username,
      sub: user.sub,
      phone,
      cognitoSession: session,
      isNewUser: existing === null,
      requestedChannel: body.channel,
      resendAfterEpoch: now + RESEND_COOLDOWN_SEC,
      attempts: 0,
      ttl: now + CHALLENGE_TTL_SEC,
    });

    return c.json(
      AuthStartResponse.parse({
        challengeId,
        resendAfterSec: RESEND_COOLDOWN_SEC,
        expiresInSec: OTP_EXPIRES_SEC,
        channel: body.channel,
      }),
    );
  });
```

(e) Replace the body of `POST /auth/resend`:

```ts
  // POST /auth/resend — re-issue the OTP under a server-enforced cooldown. `channel` is required
  // and may switch (the UI's "didn't get it on WhatsApp? send via SMS" — an explicit user
  // decision, not a server fallback).
  auth.post("/resend", async (c) => {
    const body = await parseBody(c, AuthResendBody);
    if (!body) return c.json({ error: "invalid_request" }, 400);
    const ctx = getContext();

    const challenge = await ctx.challenges.getChallenge(body.challengeId);
    if (!challenge) return c.json({ error: "challenge_not_found" }, 404);

    const now = nowEpoch();
    if (now < challenge.resendAfterEpoch) return c.json({ error: "rate_limited" }, 429);

    const avail = await otpChannelAvailability(ctx.config);
    if (!avail.channels.includes(body.channel))
      return c.json({ error: "channel_disabled", channel: body.channel }, 503);

    // The 30s cooldown caps burst; the velocity gate caps total sends per phone (ADR-0006).
    const gate = await withinVelocity(ctx.config, ctx.velocity, challenge.phone, now);
    if (!gate.allowed)
      return c.json({ error: "rate_limited", retryAfterSec: gate.retryAfterSec }, 429);

    await ctx.cognito.updateAttributes(challenge.username, [
      { Name: "custom:otpChannel", Value: body.channel },
    ]);

    let session: string;
    try {
      ({ session } = await ctx.cognito.startSmsOtp(challenge.username));
    } catch (err) {
      if (isSenderFailure(err))
        return c.json({ error: "send_failed", channel: body.channel }, 502);
      throw err;
    }

    await ctx.challenges.putChallenge({
      ...challenge,
      cognitoSession: session,
      requestedChannel: body.channel,
      resendAfterEpoch: now + RESEND_COOLDOWN_SEC,
      ttl: now + CHALLENGE_TTL_SEC,
    });
    return c.json(
      AuthResendResponse.parse({
        resendAfterSec: RESEND_COOLDOWN_SEC,
        expiresInSec: OTP_EXPIRES_SEC,
        channel: body.channel,
      }),
    );
  });
```

- [ ] **Step 5: Reader typing (single-writer at the type level, per spec).**

In `services/app-auth/src/auth/velocity.ts`, change the import and param type:

```ts
import type { PhoneVelocityRepo, RuntimeConfigReader } from "@wanthat/dynamo";
```

```ts
export async function withinVelocity(
  config: RuntimeConfigReader,
```

In `services/app-auth/src/context.ts`, change the dynamo import to bring in `type RuntimeConfigReader` and type the interface field as the reader (the constructed `RuntimeConfigRepo` still satisfies it):

```ts
export interface AuthContext {
  region: string;
  /** Read-only by design: the config table is single-writer (admin-api) — ADR-0023 spec. */
  config: RuntimeConfigReader;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @wanthat/app-auth test && pnpm --filter @wanthat/app-auth typecheck`
Expected: PASS (fix any pre-existing test that still posts a channel-less body).

- [ ] **Step 7: Commit**

```bash
git add services/app-auth
git commit -m "feat(app-auth): per-channel OTP gates, GET /auth/config, explicit channel_disabled/send_failed (ADR-0023)"
```

---

### Task 6: Infra — IdentityStack trigger + KMS + custom attribute, `/auth/config` route, wiring

**Files:**
- Modify: `infra/lib/identity-stack.ts`
- Modify: `infra/lib/api-stack.ts` (one route)
- Modify: `infra/bin/wanthat.ts` (identity props + observability entry)

**Interfaces:**
- Consumes: `services/message-sender` handler (Task 4), `data.runtimeConfigTable`.
- Produces: `IdentityStack` gains prop `runtimeConfigTable: dynamodb.ITable` and field `readonly messageSenderFn: lambda.Function`; env contract for message-sender (`KMS_KEY_ARN`, `RUNTIME_CONFIG_TABLE`, `WHATSAPP_SOCIAL_REGION`, `WANTHAT_ENV`).

- [ ] **Step 1: IdentityStack.** In `infra/lib/identity-stack.ts`:

(a) Add imports (merge with existing ones — `Duration`, `iam`, `cognito` already exist there):

```ts
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
```

and extend the `./config` import with `LAMBDA_RUNTIME, serviceEntry, serviceLogGroup`.

(b) Add to `IdentityStackProps`:

```ts
  /** From DataStack — message-sender reads whatsapp.phoneNumberId at send time (ADR-0023). */
  readonly runtimeConfigTable: dynamodb.ITable;
```

(c) Add the class field next to the other `readonly` fields:

```ts
  /** ADR-0023: the Cognito custom-SMS-sender executor — observed by ObservabilityStack. */
  readonly messageSenderFn: lambda.Function;
```

(d) Before `this.userPool = new cognito.UserPool(...)`:

```ts
    // ADR-0023: Cognito encrypts the OTP code for the custom sender trigger with this key (via
    // the AWS Encryption SDK); message-sender holds the decrypt grant. Fixed cost ~1 USD/month.
    const customSenderKey = new kms.Key(this, "CustomSenderKey", {
      enableKeyRotation: true,
      description: `wanthat-${wanthatEnv.name} Cognito custom-sender OTP code encryption (ADR-0023)`,
    });
```

(e) Inside the `new cognito.UserPool(...)` props, after `standardAttributes`:

```ts
      // ADR-0023: the OTP delivery channel for the message-sender trigger. Written by app-auth on
      // every /auth/start + /auth/resend; the sender FAILS if it is missing (never defaults).
      customAttributes: {
        otpChannel: new cognito.StringAttribute({ mutable: true, minLen: 3, maxLen: 8 }),
      },
      customSenderKmsKey: customSenderKey,
```

(f) After the user pool groups block (i.e. after the `UserGroup` construct), add the function + trigger:

```ts
    // ADR-0023: pure OTP executor. IMPORTANT: once this trigger is attached, Cognito sends NO SMS
    // natively - this function owns ALL OTP delivery (WhatsApp via End User Messaging Social, SMS
    // via SNS Publish), routed ONLY by the custom:otpChannel attribute. It reads no kill switches
    // and never falls back across channels; a throw fails the callers AdminInitiateAuth, which
    // app-auth maps to send_failed (spec rev 2).
    const messageSenderFn = new NodejsFunction(this, "MessageSender", {
      functionName: `wanthat-${wanthatEnv.name}-message-sender`,
      entry: serviceEntry("message-sender"),
      handler: "handler",
      runtime: LAMBDA_RUNTIME,
      memorySize: 256,
      timeout: Duration.seconds(10),
      tracing: lambda.Tracing.ACTIVE,
      logGroup: serviceLogGroup(this, "MessageSenderLogs", wanthatEnv),
      // Non-VPC: Cognito-invoked; reaches KMS, DynamoDB, SNS and the End User Messaging Social
      // endpoint over public AWS endpoints (ADR-0004 NAT-free).
      environment: {
        WANTHAT_ENV: wanthatEnv.name,
        RUNTIME_CONFIG_TABLE: props.runtimeConfigTable.tableName,
        KMS_KEY_ARN: customSenderKey.keyArn,
        // End User Messaging Social is not available in il-central-1; Frankfurt is the closest
        // supported endpoint. Deploy-time by design (moving regions is a redeploy either way).
        WHATSAPP_SOCIAL_REGION: "eu-central-1",
      },
      bundling: { minify: true, sourceMap: true },
    });
    this.messageSenderFn = messageSenderFn;
    customSenderKey.grantDecrypt(messageSenderFn);
    props.runtimeConfigTable.grantReadData(messageSenderFn);
    // sns:Publish scoped away from every topic ARN = direct-to-phone SMS only.
    messageSenderFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["sns:Publish"],
        notResources: ["arn:aws:sns:*:*:*"],
      }),
    );
    // The phone-number-id resource exists only after onboarding, hence "*".
    messageSenderFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["social-messaging:SendWhatsAppMessage"],
        resources: ["*"],
      }),
    );
    this.userPool.addTrigger(cognito.UserPoolOperation.CUSTOM_SMS_SENDER, messageSenderFn);
```

- [ ] **Step 2: ApiStack route.** In `infra/lib/api-stack.ts`, after the `/auth/*` POST route loop:

```ts
    // Public channel-availability projection (ADR-0023) -> app-auth. GET, no authorizer.
    this.httpApi.addRoutes({
      path: "/auth/config",
      methods: [HttpMethod.GET],
      integration: authIntegration,
    });
```

- [ ] **Step 3: Wire in `infra/bin/wanthat.ts`.** Identity instantiation gains the table:

```ts
const identity = new IdentityStack(app, stackName(wanthatEnv, "identity"), {
  ...common,
  crossRegionReferences: true,
  runtimeConfigTable: data.runtimeConfigTable,
});
```

and the ObservabilityStack `functions` array gains:

```ts
    { label: "message-sender", fn: identity.messageSenderFn },
```

- [ ] **Step 4: Synth to verify**

Run: `pnpm build && pnpm synth`
Expected: synth succeeds; the identity template contains the `CustomSMSSender` lambda config, the KMS key, and the `custom:otpChannel` schema attribute. (Adding a custom attribute is additive; it cannot be removed later.)

- [ ] **Step 5: Commit**

```bash
git add infra
git commit -m "feat(infra): message-sender custom-SMS-sender trigger + KMS + custom:otpChannel; GET /auth/config route (ADR-0023)"
```

---

### Task 7: SPA — channel toggle, sent-via caption, send-via-SMS recovery

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/features/auth/AuthPage.tsx`
- Modify: `apps/web/src/i18n.ts` (en + he — `he` is `typeof en`, so both or neither)

**Interfaces:**
- Consumes: `GET /auth/config`, `channel` on start/resend (Tasks 1+5).
- Produces: `authApi.config()`, `authApi.start(phone, channel, locale?)`, `authApi.resend(challengeId, channel)`.

- [ ] **Step 1: api.ts.** Add `AuthConfigResponse`, `MessageLanguage`, `OtpChannel` to the type imports and replace the `start`/`resend` entries; add `config`:

```ts
  // Channel availability projection (ADR-0023) — fetched pre-login to render the channel choice.
  config: () => request<AuthConfigResponse>("/auth/config"),
  start: (phone: string, channel: OtpChannel, locale?: MessageLanguage) =>
    request<AuthStartResponse>("/auth/start", {
      method: "POST",
      body: { phone, channel, ...(locale ? { locale } : {}) },
    }),
  resend: (challengeId: string, channel: OtpChannel) =>
    request<AuthResendResponse>("/auth/resend", { method: "POST", body: { challengeId, channel } }),
```

- [ ] **Step 2: AuthPage.tsx.**

(a) Imports: add `useEffect` to the react import; add `type OtpChannel` (and keep `normalizePhone`) to the `@wanthat/contracts` import.

(b) State + config fetch (after the existing `useState` block):

```ts
  // Channel choice (ADR-0023): the UI owns the default and the recovery path. Availability comes
  // from /auth/config; until (or unless) it loads, sms-only keeps the flow working.
  const [channels, setChannels] = useState<OtpChannel[]>(["sms"]);
  const [channel, setChannel] = useState<OtpChannel>("sms");
  const [errorCode, setErrorCode] = useState<string | undefined>();

  useEffect(() => {
    void authApi
      .config()
      .then((cfg) => {
        setChannels(cfg.channels);
        if (cfg.defaultChannel) setChannel(cfg.defaultChannel);
      })
      .catch(() => {}); // advisory only — the server re-checks on /auth/start
  }, []);
```

(c) In `run`'s catch, record the code (and clear it in the try path): change `setError(...)` handling to:

```ts
    setBusy(true);
    setError(undefined);
    setErrorCode(undefined);
    try {
      await fn();
    } catch (err) {
      setErrorCode(err instanceof ApiError ? err.code : undefined);
      setError(
        err instanceof ApiError
          ? t(`auth.errors.${err.code}`, t("auth.errors.generic"))
          : t("auth.errors.generic"),
      );
    } finally {
      setBusy(false);
    }
```

(d) `onStart` takes an optional channel override (avoids a stale-state closure on the recovery button) and adopts the echoed channel:

```ts
  const onStart = (ch: OtpChannel = channel) =>
    run(async () => {
      if (!e164) return; // guarded by the disabled button, but narrows the type
      const res = await authApi.start(e164, ch, lang);
      setChannel(res.channel);
      setChallengeId(res.challengeId);
      setStep("otp");
    });
```

(e) Phone screen: add the toggle above the submit button (render only when there is a real choice), and the WhatsApp-failure recovery under the error:

```tsx
            {channels.length > 1 && (
              <div>
                <span className="mb-1.5 block text-sm font-medium text-muted">
                  {t("auth.channelLabel")}
                </span>
                <Segmented
                  value={channel}
                  onChange={(value) => setChannel(value as OtpChannel)}
                  options={channels.map((ch) => ({ value: ch, label: t(`auth.channel.${ch}`) }))}
                />
              </div>
            )}
```

```tsx
            {errorCode &&
              ["send_failed", "channel_disabled"].includes(errorCode) &&
              channel === "whatsapp" &&
              channels.includes("sms") && (
                <Button variant="ghost" onClick={() => onStart("sms")}>
                  {t("auth.trySms")}
                </Button>
              )}
```

Also change the existing submit `onClick={onStart}` to `onClick={() => onStart()}`.

(f) OTP screen: caption + channel-aware resend + explicit send-via-SMS:

```tsx
            <p className="text-[15px] leading-normal text-muted">{t(`auth.sentVia.${channel}`)}</p>
```

Change the resend button and add the SMS one:

```tsx
            <Button
              variant="ghost"
              onClick={() =>
                run(async () => {
                  const r = await authApi.resend(challengeId, channel);
                  setChannel(r.channel);
                })
              }
            >
              {t("auth.resend")}
            </Button>
            {channel === "whatsapp" && channels.includes("sms") && (
              <Button
                variant="ghost"
                onClick={() =>
                  run(async () => {
                    const r = await authApi.resend(challengeId, "sms");
                    setChannel(r.channel);
                  })
                }
              >
                {t("auth.resendSms")}
              </Button>
            )}
```

- [ ] **Step 3: i18n.** In `apps/web/src/i18n.ts` add to `en.auth` (near `resend`):

```ts
    channelLabel: "Send the code via",
    channel: { whatsapp: "WhatsApp", sms: "SMS" },
    sentVia: {
      whatsapp: "We sent a code to your WhatsApp.",
      sms: "We sent a code by SMS.",
    },
    resendSms: "Didn't get it? Send via SMS",
    trySms: "Try SMS instead",
```

and to `en.auth.errors`:

```ts
      channel_disabled: "That sign-in method isn't available right now.",
      send_failed: "We couldn't send the code. Please try again.",
```

Mirror in `he.auth` (the `he: typeof en` type enforces it):

```ts
    channelLabel: "לאן לשלוח את הקוד",
    channel: { whatsapp: "וואטסאפ", sms: "SMS" },
    sentVia: {
      whatsapp: "שלחנו קוד לוואטסאפ שלך.",
      sms: "שלחנו קוד ב-SMS.",
    },
    resendSms: "לא הגיע? שליחה ב-SMS",
    trySms: "לנסות ב-SMS",
```

and to `he.auth.errors`:

```ts
      channel_disabled: "שיטת הכניסה הזו אינה זמינה כרגע.",
      send_failed: "לא הצלחנו לשלוח את הקוד. נסו שוב.",
```

- [ ] **Step 4: Verify and commit**

Run: `pnpm --filter @wanthat/web typecheck && pnpm --filter @wanthat/web test && pnpm --filter @wanthat/web build`
Expected: PASS

```bash
git add apps/web
git commit -m "feat(web): OTP channel toggle from /auth/config, sent-via caption, send-via-SMS recovery (ADR-0023)"
```

---

### Task 8: PR 1 finalize — onboarding runbook, full verification, PR

**Files:**
- Create: `docs/whatsapp-onboarding.md`

- [ ] **Step 1: Write `docs/whatsapp-onboarding.md`:**

```markdown
# WhatsApp onboarding runbook (ADR-0023)

The code ships kill-switched OFF; this out-of-band onboarding is the critical path to flipping it
on. No redeploys anywhere below.

## 1. Meta Business verification (longest lead time — start first)
- In Meta Business Manager (business.facebook.com): Business settings -> Security centre -> Start
  verification for the Wanthat legal entity. Requires business documents; approval can take days
  to weeks.

## 2. Link a WhatsApp Business Account (WABA) to AWS
- AWS console -> AWS End User Messaging -> Social (region **eu-central-1** — il-central-1 is not
  supported; the Lambdas' `WHATSAPP_SOCIAL_REGION` env matches).
- "Sign up through Facebook" (embedded signup): create/link the WABA, register the business phone
  number, and set the display name ("Wanthat").
- Note the **phone number ID** (`phone-number-id-...`) from the console/`GetLinkedWhatsAppBusinessAccount`.
- Dev can use a Meta test number instead of a real one.

## 3. Create the message templates (Meta approval per language)
- `otp_code` — category **Authentication**, languages **he** and **en**. Meta supplies the fixed
  authentication-template text; enable the **copy-code button** and the security recommendation.
  The code registry sends: body param = the code, button param = the code.
- `optin_welcome` — category **Utility**, languages **he** and **en** (used by PR 2):
  - en: `Hi {{1}}, welcome to Wanthat! Start earning cashback: {{2}}`
  - he: `היי {{1}}, ברוכים הבאים ל-Wanthat! מתחילים להרוויח קאשבק: {{2}}`
  - `{{1}}` = first name, `{{2}}` = app URL. MUST match `packages/whatsapp/src/registry.ts`.

## 4. Flip the switches (admin config, per env)
1. `PUT /admin/config/whatsapp.phoneNumberId` -> the `phone-number-id-...` value.
2. `PUT /admin/config/auth.whatsappEnabled` -> `true`. The SPA offers WhatsApp on the next
   /auth/config fetch; smoke-test a login.
3. After PR 2: `PUT /admin/config/notifications.whatsappEnabled` -> `true`; register a test user
   and confirm the welcome message.

Rollback at any point = flip the keys back. Costs: ~0.0103 USD per OTP to Israel; KMS key ~1 USD/mo.
```

- [ ] **Step 2: Full verification**

Run: `pnpm install && pnpm build && pnpm typecheck && pnpm test && pnpm lint && pnpm synth`
Expected: all PASS. If `pnpm lint` (biome) flags formatting, run `pnpm format` and re-run.

- [ ] **Step 3: Commit, push, open PR 1 (ready, not draft)**

```bash
git add docs/whatsapp-onboarding.md
git commit -m "docs: WhatsApp onboarding runbook (ADR-0023)"
git push -u origin whatsapp-otp
gh pr create --title "feat: OTP over WhatsApp — channel choice, message-sender trigger, kill-switched off (ADR-0023)" --body "$(cat <<'EOF'
Slice 1 of ADR-0023 (spec: docs/superpowers/specs/2026-07-02-whatsapp-messaging-design.md).

- `GET /auth/config` + required `channel` on start/resend; explicit `channel_disabled`/`send_failed` (no silent switching)
- `@wanthat/whatsapp` pure library (registry, payload builder, EUM Social sender)
- `services/message-sender`: Cognito Custom SMS Sender — requested channel or throw
- IdentityStack: KMS key + `custom:otpChannel` + trigger; SPA channel toggle + send-via-SMS recovery
- All kill-switched OFF (`auth.whatsappEnabled=false`, `whatsapp.phoneNumberId=""`); runbook in docs/whatsapp-onboarding.md

**Deploy note / risk:** once the trigger attaches, our Lambda owns ALL OTP delivery including
plain SMS (same SNS transactional publish + wording). Dev smoke test after deploy: one SMS login
(~2 sends left under the July sandbox cap), and one forced sender failure to confirm
`send_failed` surfaces.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01TjkamzCAy4WuLNzQwTiR7d
EOF
)"
```

- [ ] **Step 4: Post-merge dev verification (after CI deploys dev)**
  1. `curl https://<dev-app-api>/auth/config` → `{"channels":["sms"],"defaultChannel":"sms"}` (WhatsApp off).
  2. One full SMS login on dev.wanthat.app — code arrives, message reads "Your authentication code is NNNNNNNN." (this proves the message-sender SMS path end to end).
  3. Temporarily set `auth.whatsappEnabled=true` while `whatsapp.phoneNumberId` stays `""` via admin config — confirm `/auth/config` still omits whatsapp (predicate needs both), then flip back.

---

## PR 2 — "Welcome message on registration"

Branch off fresh main after PR 1 merges: `git checkout main && git pull --ff-only && git checkout -b whatsapp-welcome`

### Task 9: Contracts + registry — `notifications.whatsappEnabled`, `optin_welcome`

**Files:**
- Modify: `packages/contracts/src/config/keys.ts`
- Modify: `packages/whatsapp/src/registry.ts`, `src/index.ts`
- Test: `packages/whatsapp/src/payload.test.ts` (extend), `packages/contracts/src/identity/auth.test.ts` (extend)

**Interfaces (Produces):** config key `notifications.whatsappEnabled` (bool, default `false`); `MessageType` widens to `"otp_code" | "optin_welcome"`; `OptinWelcomeVariables = { firstName, appUrl }`.

- [ ] **Step 1: Failing tests.** Append to `packages/whatsapp/src/payload.test.ts`:

```ts
  it("builds the optin_welcome utility template (firstName + appUrl body params)", () => {
    const msg = buildTemplateMessage({
      type: "optin_welcome",
      language: "he",
      variables: { firstName: "Dana", appUrl: "https://dev.wanthat.app" },
      to: "+972541234567",
    });
    expect(msg.template).toEqual({
      name: "optin_welcome",
      language: { code: "he" },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: "Dana" },
            { type: "text", text: "https://dev.wanthat.app" },
          ],
        },
      ],
    });
  });
```

Append to the config test in `packages/contracts/src/identity/auth.test.ts`:

```ts
  it("ships notifications.whatsappEnabled OFF", () => {
    expect(CONFIG_DEFAULTS["notifications.whatsappEnabled"]).toBe(false);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @wanthat/whatsapp test && pnpm --filter @wanthat/contracts test`
Expected: FAIL (unknown type / unknown key).

- [ ] **Step 3: Implement.** `packages/contracts/src/config/keys.ts` — add schema after `WhatsappPhoneNumberId`:

```ts
/** Kill switch for the outbox-driven WhatsApp notifications (optin_welcome) — ADR-0023. */
export const NotificationsWhatsappEnabled = z.boolean();
```

plus `"notifications.whatsappEnabled"` in `CONFIG_KEYS`, `CONFIG_SCHEMAS` (`NotificationsWhatsappEnabled`), and `CONFIG_DEFAULTS` (`false`).

`packages/whatsapp/src/registry.ts` — add after `OtpCodeVariables`:

```ts
export const OptinWelcomeVariables = z
  .object({ firstName: z.string().min(1).max(100), appUrl: z.string().url() })
  .strict();
```

and the registry entry after `otp_code`:

```ts
  // Utility template: welcome message in the member's language with a link to the app. Text as
  // submitted to Meta lives in docs/whatsapp-onboarding.md ({{1}} firstName, {{2}} appUrl).
  optin_welcome: {
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
  },
```

Export `OptinWelcomeVariables` from `packages/whatsapp/src/index.ts`.

- [ ] **Step 4: Run to verify pass, then commit**

Run: `pnpm --filter @wanthat/whatsapp test && pnpm --filter @wanthat/contracts test`
Expected: PASS

```bash
git add packages/contracts packages/whatsapp
git commit -m "feat(whatsapp,contracts): optin_welcome template + notifications.whatsappEnabled kill switch (ADR-0023)"
```

---

### Task 10: `@wanthat/dynamo` — `NotificationOutboxRepo`

**Files:**
- Create: `packages/dynamo/src/notification-outbox.ts`
- Modify: `packages/dynamo/src/index.ts`
- Test: `packages/dynamo/src/notification-outbox.test.ts`

**Interfaces (Produces):**
- `NotificationOutboxItem { outboxId, customerId, phone, messageType: "optin_welcome", language: MessageLanguage, variables: Record<string,string>, status: "pending"|"sent"|"failed", createdAt, ttl }`
- `NotificationOutboxRepo { put, get, markSent, markFailed }`

- [ ] **Step 1: Failing test.** `packages/dynamo/src/notification-outbox.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { NotificationOutboxRepo } from "./notification-outbox";

const item = {
  outboxId: "ob-1",
  customerId: "sub-1",
  phone: "+972541234567",
  messageType: "optin_welcome" as const,
  language: "he" as const,
  variables: { firstName: "Dana", appUrl: "https://dev.wanthat.app" },
  status: "pending" as const,
  createdAt: "2026-07-02T00:00:00.000Z",
  ttl: 1754000000,
};

function repo() {
  const send = vi.fn().mockResolvedValue({});
  return { repo: new NotificationOutboxRepo({ send } as never, "outbox"), send };
}

describe("NotificationOutboxRepo", () => {
  it("puts a pending item", async () => {
    const { repo: r, send } = repo();
    await r.put(item);
    expect(send.mock.calls[0][0].input).toMatchObject({ TableName: "outbox", Item: item });
  });

  it("gets an item back (undefined when absent)", async () => {
    const { repo: r, send } = repo();
    send.mockResolvedValue({ Item: item });
    expect(await r.get("ob-1")).toEqual(item);
    send.mockResolvedValue({});
    expect(await r.get("ob-2")).toBeUndefined();
  });

  it("markSent / markFailed update status (+ error) by outboxId", async () => {
    const { repo: r, send } = repo();
    await r.markSent("ob-1");
    expect(send.mock.calls[0][0].input).toMatchObject({
      Key: { outboxId: "ob-1" },
      ExpressionAttributeValues: expect.objectContaining({ ":status": "sent" }),
    });
    await r.markFailed("ob-1", "template not approved");
    expect(send.mock.calls[1][0].input.ExpressionAttributeValues).toMatchObject({
      ":status": "failed",
      ":error": "template not approved",
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @wanthat/dynamo test`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement.** `packages/dynamo/src/notification-outbox.ts`:

```ts
import {
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { MessageLanguage } from "@wanthat/contracts";

/**
 * Repository over the `notification_outbox` table (ADR-0023) — the transactional outbox bridging
 * in-VPC producers (app-core writes over the DynamoDB gateway endpoint) to the non-VPC
 * whatsapp-dispatcher (via the table's Stream). At-least-once: the dispatcher is idempotent on
 * `status` ("pending" is the only sendable state). TTL self-cleans (~30 days), so items skipped
 * while the notifications kill switch is off simply age out — intended pre-launch behaviour.
 */

export type NotificationStatus = "pending" | "sent" | "failed";

export interface NotificationOutboxItem {
  outboxId: string;
  /** Cognito sub of the recipient. */
  customerId: string;
  /** E.164 destination. */
  phone: string;
  messageType: "optin_welcome";
  language: MessageLanguage;
  variables: Record<string, string>;
  status: NotificationStatus;
  createdAt: string;
  ttl: number;
}

export class NotificationOutboxRepo {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async put(item: NotificationOutboxItem): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.tableName, Item: item }));
  }

  async get(outboxId: string): Promise<NotificationOutboxItem | undefined> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { outboxId } }),
    );
    return res.Item as NotificationOutboxItem | undefined;
  }

  async markSent(outboxId: string): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { outboxId },
        UpdateExpression: "SET #status = :status",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":status": "sent" },
      }),
    );
  }

  async markFailed(outboxId: string, error: string): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { outboxId },
        UpdateExpression: "SET #status = :status, #error = :error",
        ExpressionAttributeNames: { "#status": "status", "#error": "error" },
        ExpressionAttributeValues: { ":status": "failed", ":error": error },
      }),
    );
  }
}
```

Add to `packages/dynamo/src/index.ts`:

```ts
export {
  type NotificationOutboxItem,
  NotificationOutboxRepo,
  type NotificationStatus,
} from "./notification-outbox";
```

- [ ] **Step 4: Run to verify pass, then commit**

Run: `pnpm --filter @wanthat/dynamo test && pnpm --filter @wanthat/dynamo typecheck`
Expected: PASS

```bash
git add packages/dynamo
git commit -m "feat(dynamo): NotificationOutboxRepo — transactional outbox for WhatsApp notifications (ADR-0023)"
```

---

### Task 11: `app-core` — enqueue `optin_welcome` on registration

**Files:**
- Modify: `services/app-core/src/context.ts`
- Modify: `services/app-core/src/auth/register.ts`
- Test: `services/app-core/src/auth/register.test.ts` (extend)

**Interfaces:**
- Consumes: `NotificationOutboxRepo` (Task 10).
- Produces: `CoreContext.outbox: NotificationOutboxRepo` + `CoreContext.appUrl: string`; env contract `NOTIFICATION_OUTBOX_TABLE`, `APP_URL` (Task 13 wires them).

- [ ] **Step 1: Failing tests.** In `register.test.ts`: add to `fake`: `appUrl: "https://dev.wanthat.app"` and `outbox: { put: vi.fn() }`. Then append to the `POST /auth/register` describe:

```ts
  it("enqueues the optin_welcome outbox item after provisioning (ADR-0023)", async () => {
    fake.tickets.verify.mockResolvedValue(ticket);
    dbMock.findByCognitoSub.mockResolvedValue(undefined);
    dbMock.insertCustomer.mockResolvedValue(customer);

    const res = await post("/auth/register", {
      registrationTicket: "payload.mac",
      firstName: "Dana",
      lastName: "Levi",
      locale: "he-IL",
    });
    expect(res.status).toBe(200);
    expect(fake.outbox.put).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: SUB,
        phone: PHONE,
        messageType: "optin_welcome",
        language: "he",
        variables: { firstName: "Dana", appUrl: "https://dev.wanthat.app" },
        status: "pending",
      }),
    );
  });

  it("registration still succeeds when the outbox write fails (best-effort)", async () => {
    fake.tickets.verify.mockResolvedValue(ticket);
    dbMock.findByCognitoSub.mockResolvedValue(undefined);
    dbMock.insertCustomer.mockResolvedValue(customer);
    fake.outbox.put.mockRejectedValue(new Error("dynamo down"));

    const res = await post("/auth/register", {
      registrationTicket: "payload.mac",
      firstName: "Dana",
      lastName: "Levi",
    });
    expect(res.status).toBe(200);
  });

  it("does NOT enqueue on an idempotent re-register of an existing customer", async () => {
    fake.tickets.verify.mockResolvedValue(ticket);
    dbMock.findByCognitoSub.mockResolvedValue(customer);
    await post("/auth/register", { registrationTicket: "payload.mac", firstName: "D", lastName: "L" });
    expect(fake.outbox.put).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @wanthat/app-core test`
Expected: FAIL — `outbox.put` never called.

- [ ] **Step 3: Implement.** `services/app-core/src/context.ts`: extend the dynamo import with `NotificationOutboxRepo`, add to `CoreContext`:

```ts
  outbox: NotificationOutboxRepo;
  /** Canonical SPA origin for links in outbound messages (env APP_URL). */
  appUrl: string;
```

and to the `cached = { ... }` literal:

```ts
    outbox: new NotificationOutboxRepo(doc, requireEnv("NOTIFICATION_OUTBOX_TABLE")),
    appUrl: requireEnv("APP_URL"),
```

`services/app-core/src/auth/register.ts`: add `import { randomUUID } from "node:crypto";` at the top, then insert between `insertCustomer` and the final `return`:

```ts
    // ADR-0023: queue the optin_welcome WhatsApp message through the transactional outbox (a
    // DynamoDB write over the gateway endpoint; the NON-VPC dispatcher does the egress). The
    // producer owns WHAT to send and in which language; best-effort — a failed enqueue is logged,
    // never fails registration. No Cognito call here (in-VPC, ADR-0021).
    try {
      await ctx.outbox.put({
        outboxId: randomUUID(),
        customerId: ticket.sub,
        phone: ticket.phone,
        messageType: "optin_welcome",
        language: locale.startsWith("he") ? "he" : "en",
        variables: { firstName: body.firstName, appUrl: ctx.appUrl },
        status: "pending",
        createdAt: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
      });
    } catch (err) {
      console.error("optin_welcome enqueue failed", err);
    }
```

- [ ] **Step 4: Run to verify pass, then commit**

Run: `pnpm --filter @wanthat/app-core test && pnpm --filter @wanthat/app-core typecheck`
Expected: PASS

```bash
git add services/app-core
git commit -m "feat(app-core): enqueue optin_welcome via notification outbox on registration (ADR-0023)"
```

---

### Task 12: `services/whatsapp-dispatcher` — stream consumer

**Files:**
- Create: `services/whatsapp-dispatcher/package.json`, `tsconfig.json`
- Create: `services/whatsapp-dispatcher/src/dispatch.ts` (pure, DI), `src/handler.ts`
- Test: `services/whatsapp-dispatcher/src/dispatch.test.ts`

**Interfaces:**
- Consumes: `WhatsAppSender` (Task 3), `NotificationOutboxRepo.markSent/markFailed` (Task 10), `RuntimeConfigReader`.
- Produces: Lambda `handler` for the DynamoDB event source (Task 13). Env: `RUNTIME_CONFIG_TABLE`, `NOTIFICATION_OUTBOX_TABLE`, `WHATSAPP_SOCIAL_REGION`.
- Failure semantics: infrastructure errors (config/unmarshal) THROW → event-source retry/bisect → DLQ; send-submission failures `markFailed` and do NOT throw (best-effort message; retrying a rejected template is pointless). Disabled config → skip, item stays `pending` (ages out via TTL — intended pre-launch).

- [ ] **Step 1: Scaffold.** `services/whatsapp-dispatcher/package.json`:

```json
{
  "name": "@wanthat/whatsapp-dispatcher",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "dist/handler.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@aws-lambda-powertools/logger": "^2.8.0",
    "@aws-sdk/client-socialmessaging": "^3.600.0",
    "@aws-sdk/util-dynamodb": "^3.600.0",
    "@wanthat/contracts": "workspace:*",
    "@wanthat/dynamo": "workspace:*",
    "@wanthat/whatsapp": "workspace:*"
  }
}
```

`tsconfig.json`: same as the other services. Run `pnpm install`.

- [ ] **Step 2: Failing tests.** `services/whatsapp-dispatcher/src/dispatch.test.ts`:

```ts
import { marshall } from "@aws-sdk/util-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type DispatchDeps, dispatchRecord } from "./dispatch";

const item = {
  outboxId: "ob-1",
  customerId: "sub-1",
  phone: "+972541234567",
  messageType: "optin_welcome",
  language: "he",
  variables: { firstName: "Dana", appUrl: "https://dev.wanthat.app" },
  status: "pending",
  createdAt: "2026-07-02T00:00:00.000Z",
  ttl: 1754000000,
};

const record = (overrides: Record<string, unknown> = {}, eventName = "INSERT") => ({
  eventName,
  dynamodb: { NewImage: marshall({ ...item, ...overrides }) },
});

const deps = {
  config: { get: vi.fn() },
  outbox: { markSent: vi.fn(), markFailed: vi.fn() },
  whatsapp: { sendTemplate: vi.fn().mockResolvedValue({ messageId: "wamid.X" }) },
  log: vi.fn(),
} satisfies DispatchDeps;

beforeEach(() => {
  vi.clearAllMocks();
  deps.whatsapp.sendTemplate.mockResolvedValue({ messageId: "wamid.X" });
  deps.config.get.mockImplementation((key: string) =>
    Promise.resolve(
      { "notifications.whatsappEnabled": true, "whatsapp.phoneNumberId": "phone-number-id-test" }[key],
    ),
  );
});

describe("dispatchRecord", () => {
  it("sends a pending item and marks it sent", async () => {
    await dispatchRecord(deps, record());
    expect(deps.whatsapp.sendTemplate).toHaveBeenCalledWith({
      phoneNumberId: "phone-number-id-test",
      type: "optin_welcome",
      language: "he",
      variables: item.variables,
      to: item.phone,
    });
    expect(deps.outbox.markSent).toHaveBeenCalledWith("ob-1");
  });

  it("skips non-INSERT events and non-pending items (idempotent at-least-once)", async () => {
    await dispatchRecord(deps, record({}, "MODIFY"));
    await dispatchRecord(deps, record({ status: "sent" }));
    expect(deps.whatsapp.sendTemplate).not.toHaveBeenCalled();
  });

  it("skips (leaves pending) when notifications are disabled or the phoneNumberId is unset", async () => {
    deps.config.get.mockImplementation((key: string) =>
      Promise.resolve({ "notifications.whatsappEnabled": false, "whatsapp.phoneNumberId": "x" }[key]),
    );
    await dispatchRecord(deps, record());
    deps.config.get.mockImplementation((key: string) =>
      Promise.resolve({ "notifications.whatsappEnabled": true, "whatsapp.phoneNumberId": "" }[key]),
    );
    await dispatchRecord(deps, record());
    expect(deps.whatsapp.sendTemplate).not.toHaveBeenCalled();
    expect(deps.outbox.markSent).not.toHaveBeenCalled();
    expect(deps.outbox.markFailed).not.toHaveBeenCalled();
  });

  it("marks failed (and does NOT throw) on a send-submission error", async () => {
    deps.whatsapp.sendTemplate.mockRejectedValue(new Error("template not approved"));
    await dispatchRecord(deps, record());
    expect(deps.outbox.markFailed).toHaveBeenCalledWith("ob-1", "template not approved");
  });

  it("THROWS on an infrastructure error so the event source retries/bisects to the DLQ", async () => {
    deps.config.get.mockRejectedValue(new Error("dynamo down"));
    await expect(dispatchRecord(deps, record())).rejects.toThrow("dynamo down");
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @wanthat/whatsapp-dispatcher test`
Expected: FAIL — `./dispatch` missing.

- [ ] **Step 4: Implement.** `services/whatsapp-dispatcher/src/dispatch.ts`:

```ts
import { type AttributeValue, unmarshall } from "@aws-sdk/util-dynamodb";
import type { MessageLanguage } from "@wanthat/contracts";
import type { NotificationOutboxItem, RuntimeConfigReader } from "@wanthat/dynamo";

/** The slice of a DynamoDB stream record we consume. */
export interface OutboxStreamRecord {
  eventName?: string;
  dynamodb?: { NewImage?: Record<string, AttributeValue> };
}

export interface DispatchDeps {
  config: RuntimeConfigReader;
  outbox: { markSent(outboxId: string): Promise<void>; markFailed(outboxId: string, error: string): Promise<void> };
  whatsapp: {
    sendTemplate(args: {
      phoneNumberId: string;
      type: "optin_welcome";
      language: MessageLanguage;
      variables: Record<string, string>;
      to: string;
    }): Promise<unknown>;
  };
  log: (msg: string, ctx?: Record<string, unknown>) => void;
}

/**
 * The flow controller of the async notification flow (ADR-0023) — the only place a
 * skip-when-disabled legitimately lives (no user is present to decide). Per INSERT record:
 * pending items get sent + markSent; kill-switched items stay `pending` and age out via TTL
 * (intended pre-launch); a send-submission failure is markFailed WITHOUT rethrow (best-effort
 * message — a rejected template will not pass on retry). Infrastructure errors DO throw so the
 * event source retries/bisects and eventually parks the batch in the DLQ.
 */
export async function dispatchRecord(deps: DispatchDeps, record: OutboxStreamRecord): Promise<void> {
  if (record.eventName !== "INSERT") return;
  const image = record.dynamodb?.NewImage;
  if (!image) return;
  const item = unmarshall(image) as NotificationOutboxItem;
  if (item.status !== "pending") return; // at-least-once: a replayed record is a no-op

  const [enabled, phoneNumberId] = await Promise.all([
    deps.config.get("notifications.whatsappEnabled"),
    deps.config.get("whatsapp.phoneNumberId"),
  ]);
  if (enabled !== true || typeof phoneNumberId !== "string" || phoneNumberId === "") {
    deps.log("notification_skipped_disabled", { outboxId: item.outboxId });
    return;
  }

  try {
    await deps.whatsapp.sendTemplate({
      phoneNumberId,
      type: item.messageType,
      language: item.language,
      variables: item.variables,
      to: item.phone,
    });
  } catch (err) {
    await deps.outbox.markFailed(item.outboxId, err instanceof Error ? err.message : String(err));
    deps.log("notification_send_failed", { outboxId: item.outboxId });
    return;
  }
  await deps.outbox.markSent(item.outboxId);
}
```

`services/whatsapp-dispatcher/src/handler.ts`:

```ts
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
  deps = {
    config: new RuntimeConfigRepo(doc, requireEnv("RUNTIME_CONFIG_TABLE")),
    outbox: new NotificationOutboxRepo(doc, requireEnv("NOTIFICATION_OUTBOX_TABLE")),
    // End User Messaging Social is not available in il-central-1; the client region is deploy-time.
    whatsapp: new WhatsAppSender(
      new SocialMessagingClient({ region: requireEnv("WHATSAPP_SOCIAL_REGION") }),
    ),
    log: (msg, ctx) => logger.info(msg, ctx ?? {}),
  };
  return deps;
}

export const handler = async (event: { Records: OutboxStreamRecord[] }): Promise<void> => {
  const d = getDeps();
  for (const record of event.Records) await dispatchRecord(d, record);
};
```

- [ ] **Step 5: Run to verify pass, then commit**

Run: `pnpm --filter @wanthat/whatsapp-dispatcher test && pnpm --filter @wanthat/whatsapp-dispatcher typecheck`
Expected: PASS

```bash
git add services/whatsapp-dispatcher pnpm-lock.yaml
git commit -m "feat(whatsapp-dispatcher): outbox stream consumer — send, markSent/markFailed, kill-switch skip (ADR-0023)"
```

---

### Task 13: Infra — outbox table + Streams, `WhatsAppStack`, app-core wiring

**Files:**
- Modify: `infra/lib/data-stack.ts`
- Create: `infra/lib/whatsapp-stack.ts`
- Modify: `infra/lib/api-stack.ts`
- Modify: `infra/bin/wanthat.ts`

- [ ] **Step 1: DataStack.** Add field `readonly notificationOutboxTable: dynamodb.Table;` and, after `phoneVelocityTable`:

```ts
    // ADR-0023: transactional outbox for WhatsApp notifications. In-VPC producers (app-core)
    // write over the free DynamoDB gateway endpoint; the Stream triggers the NON-VPC
    // whatsapp-dispatcher (the NAT-free bridge - no SQS interface endpoint). TTL ~30 days:
    // items skipped while the kill switch is off age out by design.
    this.notificationOutboxTable = new dynamodb.Table(this, "NotificationOutbox", {
      partitionKey: { name: "outboxId", type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: "ttl",
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      ...common,
    });
```

- [ ] **Step 2: Create `infra/lib/whatsapp-stack.ts`:**

```ts
import { Duration, Stack, type StackProps } from "aws-cdk-lib";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { DynamoEventSource, SqsDlq } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as sqs from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import { LAMBDA_RUNTIME, serviceEntry, serviceLogGroup, type WanthatEnv } from "./config";

export interface WhatsAppStackProps extends StackProps {
  readonly wanthatEnv: WanthatEnv;
  readonly notificationOutboxTable: dynamodb.ITable;
  readonly runtimeConfigTable: dynamodb.ITable;
}

/**
 * WhatsAppStack (ADR-0023) - the notification side of the WhatsApp capability: the NON-VPC
 * whatsapp-dispatcher consuming the notification_outbox Stream, plus its on-failure DLQ. The OTP
 * side (message-sender) lives in IdentityStack with the pool trigger. Depends only on DataStack.
 */
export class WhatsAppStack extends Stack {
  /** Observed by ObservabilityStack (errors/throttles/duration). */
  readonly dispatcherFn: lambda.Function;

  constructor(scope: Construct, id: string, props: WhatsAppStackProps) {
    super(scope, id, props);
    const { wanthatEnv } = props;

    // Batches that still fail after the event-source retries land here (14 days to inspect/redrive).
    const dlq = new sqs.Queue(this, "DispatcherDlq", {
      queueName: `wanthat-${wanthatEnv.name}-whatsapp-dispatcher-dlq`,
      retentionPeriod: Duration.days(14),
    });

    const dispatcherFn = new NodejsFunction(this, "Dispatcher", {
      functionName: `wanthat-${wanthatEnv.name}-whatsapp-dispatcher`,
      entry: serviceEntry("whatsapp-dispatcher"),
      handler: "handler",
      runtime: LAMBDA_RUNTIME,
      memorySize: 256,
      timeout: Duration.seconds(30),
      tracing: lambda.Tracing.ACTIVE,
      logGroup: serviceLogGroup(this, "DispatcherLogs", wanthatEnv),
      // Non-VPC by design: this is ADR-0023's NAT-free bridge to the public End User Messaging
      // Social endpoint. It must NOT be placed in the VPC.
      environment: {
        WANTHAT_ENV: wanthatEnv.name,
        RUNTIME_CONFIG_TABLE: props.runtimeConfigTable.tableName,
        NOTIFICATION_OUTBOX_TABLE: props.notificationOutboxTable.tableName,
        // End User Messaging Social is not in il-central-1; matches IdentityStack's message-sender.
        WHATSAPP_SOCIAL_REGION: "eu-central-1",
      },
      bundling: { minify: true, sourceMap: true },
    });
    this.dispatcherFn = dispatcherFn;

    dispatcherFn.addEventSource(
      new DynamoEventSource(props.notificationOutboxTable, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
        retryAttempts: 3,
        bisectBatchOnError: true,
        onFailure: new SqsDlq(dlq),
      }),
    );
    // markSent/markFailed need item updates; reads for completeness. Stream read is granted by
    // the event source itself. Config stays read-only (single-writer: admin-api).
    props.notificationOutboxTable.grantReadWriteData(dispatcherFn);
    props.runtimeConfigTable.grantReadData(dispatcherFn);
    // The phone-number-id resource exists only after onboarding, hence "*".
    dispatcherFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["social-messaging:SendWhatsAppMessage"],
        resources: ["*"],
      }),
    );
  }
}
```

- [ ] **Step 3: ApiStack (app-core wiring).** Add to `ApiStackProps`:

```ts
  readonly notificationOutboxTable: dynamodb.ITable;
```

In the app-core `environment` block add:

```ts
        NOTIFICATION_OUTBOX_TABLE: props.notificationOutboxTable.tableName,
        // Canonical SPA origin for links in outbound messages (first CORS origin = the site).
        APP_URL: webOrigins(wanthatEnv)[0],
```

After the app-core grants add:

```ts
    // Outbox producer: PutItem only (ADR-0023) - the dispatcher owns updates.
    props.notificationOutboxTable.grantWriteData(appCoreFn);
```

- [ ] **Step 4: `infra/bin/wanthat.ts`.** Import `WhatsAppStack`; pass `notificationOutboxTable: data.notificationOutboxTable` to `ApiStack`; after `edgeServices` add:

```ts
// WhatsAppStack (ADR-0023): the notification dispatcher. Depends only on DataStack; deploys
// before Observability (which watches its Lambda).
const whatsapp = new WhatsAppStack(app, stackName(wanthatEnv, "whatsapp"), {
  ...common,
  notificationOutboxTable: data.notificationOutboxTable,
  runtimeConfigTable: data.runtimeConfigTable,
});
```

and add to the ObservabilityStack `functions` array:

```ts
    { label: "whatsapp-dispatcher", fn: whatsapp.dispatcherFn },
```

Update the stack-order comments in the file header (`Order: ... Api / Admin / EdgeServices / WhatsApp -> Edge -> Observability`).

- [ ] **Step 5: Synth to verify**

Run: `pnpm build && pnpm synth`
Expected: synth succeeds; the data template shows the outbox table with `StreamSpecification: NEW_IMAGE`; a `wanthat-dev-whatsapp` stack exists with the event source mapping + DLQ.

- [ ] **Step 6: Commit**

```bash
git add infra
git commit -m "feat(infra): notification_outbox table + Streams, WhatsAppStack dispatcher + DLQ, app-core outbox wiring (ADR-0023)"
```

---

### Task 14: PR 2 finalize

- [ ] **Step 1: Full verification**

Run: `pnpm install && pnpm build && pnpm typecheck && pnpm test && pnpm lint && pnpm synth`
Expected: all PASS.

- [ ] **Step 2: Commit, push, open PR 2 (ready, not draft)**

```bash
git push -u origin whatsapp-welcome
gh pr create --title "feat: optin_welcome WhatsApp message via transactional outbox — kill-switched off (ADR-0023)" --body "$(cat <<'EOF'
Slice 2 of ADR-0023 (spec: docs/superpowers/specs/2026-07-02-whatsapp-messaging-design.md).

- `notification_outbox` DynamoDB table (TTL, Streams NEW_IMAGE) + `NotificationOutboxRepo`
- app-core enqueues `optin_welcome` on registration (best-effort, gateway endpoint, no Cognito)
- New `WhatsAppStack`: NON-VPC `whatsapp-dispatcher` on the outbox stream (the ADR-0023 NAT-free
  bridge) with retry/bisect + SQS DLQ; `optin_welcome` registry template (he/en)
- Kill-switched OFF (`notifications.whatsappEnabled=false`); flipped post-onboarding per
  docs/whatsapp-onboarding.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01TjkamzCAy4WuLNzQwTiR7d
EOF
)"
```

- [ ] **Step 3: Post-merge dev verification**
  1. Register a fresh test user on dev → confirm an outbox item appears with `status: "pending"` and the dispatcher logs `notification_skipped_disabled` (kill switch off — the intended pre-launch state).
  2. Confirm the DLQ is empty and registration latency is unchanged.
