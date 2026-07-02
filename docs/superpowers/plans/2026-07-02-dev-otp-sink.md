# Dev OTP Sink Implementation Plan

> **For agentic workers:** single-task plan; execute with one implementer + one reviewer. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Unblock end-to-end user creation on dev while both OTP channels are blocked (SMS sandbox cap, Meta onboarding): a config-gated branch in `message-sender` parks the decrypted code in a TTL'd DynamoDB table for CLI pickup, instead of delivering it. Prod can never activate it (deploy-time env guard).

**Architecture:** New runtime-config key `auth.otpSink` (`"delivery"` default / `"devSink"`). `message-sender` checks it ONLY when `WANTHAT_ENV !== "prod"` (the `allowed` flag wired in the handler — config alone can never flip prod). In sink mode the code is written to the new `DevOtpSink` table (PK `phone`, 5-min TTL) and delivery is skipped. Developer reads the code with one AWS CLI command. Everything else (Cognito, challenge, verify, register) stays the real production path.

**Tech Stack:** existing patterns only — Zod config keys (`packages/contracts/src/config/keys.ts`), per-table repo (`packages/dynamo`), pure-executor deps injection (`services/message-sender/src/send.ts`), CDK DataStack/IdentityStack wiring.

## Global Constraints

- Branch: `dev-otp-sink` (stacked on `logging-chain`, PR #59 — its `log` dep on SendDeps and `otp_delivered` lines already exist; build on them, do not re-add).
- The config read for `auth.otpSink` MUST be gated behind the `allowed` flag: prod and the existing sms fast path make ZERO additional config reads (an existing test asserts `config.get` is never called on the sms branch when the sink is off).
- Never log the code. The sink item itself holds it (dev-only, 5-min TTL) — that is the point.
- Config table single-writer stands; message-sender gets `grantWriteData` on the SINK table only (read path is the developer's CLI, not the app).
- ASCII-only CDK description strings. Fix warnings at source; `pnpm lint` (biome ci) must stay exit 0.
- Verification: `pnpm build && pnpm typecheck && pnpm test && pnpm lint && pnpm synth` all green; plus focused suites per step.

---

### Task 1: Dev OTP sink (contracts key, repo, sender branch, infra, doc)

**Files:**
- Modify: `packages/contracts/src/config/keys.ts`, `packages/contracts/src/identity/auth.test.ts`
- Create: `packages/dynamo/src/dev-otp-sink.ts`, `packages/dynamo/src/dev-otp-sink.test.ts`
- Modify: `packages/dynamo/src/index.ts`
- Modify: `services/message-sender/src/send.ts`, `src/handler.ts`, `src/send.test.ts`
- Modify: `infra/lib/data-stack.ts`, `infra/lib/identity-stack.ts`, `infra/bin/wanthat.ts`
- Create: `docs/dev-otp-sink.md`

**Interfaces (Produces):**
- Config key `auth.otpSink`: `z.enum(["delivery", "devSink"])`, default `"delivery"`.
- `DevOtpSinkRepo { put(item: DevOtpSinkItem), get(phone): Promise<DevOtpSinkItem | undefined> }`, `DevOtpSinkItem { phone, code, channel: OtpChannel, triggerSource, createdAt, ttl }` — exported from `@wanthat/dynamo`.
- `SendDeps.devSink: { allowed: boolean; put(item: { phone: string; code: string; channel: OtpChannel; triggerSource: string }): Promise<void> }` (handler wiring adds `createdAt`/`ttl`).
- New log event `otp_sunk_dev { channel, sub }` (no code).
- Env contract addition for message-sender: `DEV_OTP_SINK_TABLE`.

- [ ] **Step 1: Failing tests — contracts.** Append to the config describe block in `packages/contracts/src/identity/auth.test.ts`:

```ts
  it("ships auth.otpSink as real delivery by default", () => {
    expect(CONFIG_DEFAULTS["auth.otpSink"]).toBe("delivery");
    expect(parseConfigValue("auth.otpSink", "devSink")).toBe("devSink");
    expect(() => parseConfigValue("auth.otpSink", "log")).toThrow();
  });
```

- [ ] **Step 2: Failing tests — dynamo.** Create `packages/dynamo/src/dev-otp-sink.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { DevOtpSinkRepo } from "./dev-otp-sink";

const item = {
  phone: "+972541234567",
  code: "12345678",
  channel: "sms" as const,
  triggerSource: "CustomSMSSender_Authentication",
  createdAt: "2026-07-02T00:00:00.000Z",
  ttl: 1782996300,
};

describe("DevOtpSinkRepo", () => {
  it("puts and gets a sink item by phone", async () => {
    const send = vi.fn().mockResolvedValue({});
    const repo = new DevOtpSinkRepo({ send } as never, "sink");
    await repo.put(item);
    expect(send.mock.calls[0]?.[0]?.input).toMatchObject({ TableName: "sink", Item: item });
    send.mockResolvedValue({ Item: item });
    expect(await repo.get("+972541234567")).toEqual(item);
    send.mockResolvedValue({});
    expect(await repo.get("+972000000000")).toBeUndefined();
  });
});
```

- [ ] **Step 3: Failing tests — sender.** In `services/message-sender/src/send.test.ts`: add `devSink: { allowed: false, put: vi.fn() }` to the `deps` object (satisfies the new SendDeps member; `allowed: false` keeps every existing test's behavior identical). Add a new describe:

```ts
describe("dev OTP sink (auth.otpSink = devSink, never in prod)", () => {
  it("parks the code instead of delivering when allowed AND configured", async () => {
    deps.devSink.allowed = true;
    deps.config.get.mockImplementation((key: string) =>
      Promise.resolve(key === "auth.otpSink" ? "devSink" : "phone-number-id-test"),
    );
    await deliverOtp(deps, event({ "custom:otpChannel": "sms", phone_number: "+97254" }));
    expect(deps.devSink.put).toHaveBeenCalledWith({
      phone: "+97254",
      code: "12345678",
      channel: "sms",
      triggerSource: "CustomSMSSender_Authentication",
    });
    expect(deps.sms.publish).not.toHaveBeenCalled();
    expect(deps.whatsapp.sendTemplate).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith("otp_sunk_dev", { channel: "sms", sub: undefined });
    deps.devSink.allowed = false;
  });

  it("sinks the whatsapp channel too, before any phoneNumberId read", async () => {
    deps.devSink.allowed = true;
    deps.config.get.mockImplementation((key: string) =>
      Promise.resolve(key === "auth.otpSink" ? "devSink" : ""),
    );
    await deliverOtp(deps, event({ "custom:otpChannel": "whatsapp", phone_number: "+97254" }));
    expect(deps.devSink.put).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "whatsapp", code: "12345678" }),
    );
    expect(deps.whatsapp.sendTemplate).not.toHaveBeenCalled();
    deps.devSink.allowed = false;
  });

  it("ignores the config entirely when not allowed (the prod guard)", async () => {
    // allowed stays false; even a poisoned config value cannot activate the sink.
    deps.config.get.mockResolvedValue("devSink");
    await deliverOtp(deps, event({ "custom:otpChannel": "sms", phone_number: "+97254" }));
    expect(deps.devSink.put).not.toHaveBeenCalled();
    expect(deps.sms.publish).toHaveBeenCalledWith("+97254", "Your authentication code is 12345678.");
    expect(deps.config.get).not.toHaveBeenCalled(); // guard short-circuits before any read
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `pnpm --filter @wanthat/contracts test && pnpm --filter @wanthat/dynamo test && pnpm --filter @wanthat/message-sender test`
Expected: FAIL (unknown key / missing module / missing deps member).

- [ ] **Step 5: Implement — contracts.** In `packages/contracts/src/config/keys.ts` add after `NotificationsWhatsappEnabled`:

```ts
/**
 * Where message-sender routes decrypted OTP codes. `delivery` = the real channel (WhatsApp/SMS).
 * `devSink` = a TTL'd DynamoDB item a developer reads via the CLI — unblocks end-to-end user
 * creation while both real channels are blocked (SMS sandbox cap / Meta onboarding). The sender
 * honours `devSink` ONLY outside prod (deploy-time env guard); flipping this key in prod is inert.
 */
export const AuthOtpSink = z.enum(["delivery", "devSink"]);
```

and register `"auth.otpSink"` in `CONFIG_KEYS` (after `"notifications.whatsappEnabled"`), `CONFIG_SCHEMAS` (`AuthOtpSink`), `CONFIG_DEFAULTS` (`"delivery"` with comment `// real delivery by default; dev flips to devSink while SMS/WhatsApp are blocked`).

- [ ] **Step 6: Implement — dynamo.** Create `packages/dynamo/src/dev-otp-sink.ts`:

```ts
import { type DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { OtpChannel } from "@wanthat/contracts";

/**
 * Dev-only OTP sink (`auth.otpSink = "devSink"`): message-sender parks decrypted codes here
 * instead of delivering, so a developer can complete login without SMS/WhatsApp (both blocked:
 * sandbox cap / Meta onboarding). NEVER active in prod — the sender honours the config key only
 * when WANTHAT_ENV !== "prod", so the prod table exists but stays empty. Items self-expire
 * (5-minute TTL). The read path is the AWS CLI (docs/dev-otp-sink.md), not the app.
 */
export interface DevOtpSinkItem {
  /** E.164 destination — the lookup key the developer knows. */
  phone: string;
  code: string;
  channel: OtpChannel;
  triggerSource: string;
  createdAt: string;
  ttl: number;
}

export class DevOtpSinkRepo {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async put(item: DevOtpSinkItem): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.tableName, Item: item }));
  }

  async get(phone: string): Promise<DevOtpSinkItem | undefined> {
    const res = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: { phone } }));
    return res.Item as DevOtpSinkItem | undefined;
  }
}
```

Export from `packages/dynamo/src/index.ts` (alphabetical): `export { type DevOtpSinkItem, DevOtpSinkRepo } from "./dev-otp-sink";`

- [ ] **Step 7: Implement — sender.** In `services/message-sender/src/send.ts`, add to `SendDeps` (after `sms`):

```ts
  /**
   * Dev-only sink: when `allowed` (deploy-time: WANTHAT_ENV !== "prod") AND `auth.otpSink` is
   * "devSink", the code is parked for CLI pickup instead of delivered. `allowed` gates the config
   * read itself, so prod and the sms fast path make zero extra reads.
   */
  devSink: {
    allowed: boolean;
    put(item: { phone: string; code: string; channel: OtpChannel; triggerSource: string }): Promise<void>;
  };
```

(`OtpChannel` type is already imported.) In `deliverOtp`, immediately after `const code = await deps.decryptCode(...)`:

```ts
  // Dev-only sink (docs/dev-otp-sink.md): park the code instead of delivering. Checked before the
  // channel dispatch so BOTH channels sink; the code itself is never logged.
  if (deps.devSink.allowed && (await deps.config.get("auth.otpSink")) === "devSink") {
    await deps.devSink.put({
      phone: to,
      code,
      channel: channel.data,
      triggerSource: event.triggerSource,
    });
    deps.log("otp_sunk_dev", { channel: channel.data, sub: attrs.sub });
    return;
  }
```

In `services/message-sender/src/handler.ts`: import `DevOtpSinkRepo` from `@wanthat/dynamo`; in `getDeps()` create `const sink = new DevOtpSinkRepo(getDocClient(region), requireEnv("DEV_OTP_SINK_TABLE"));` — reuse the existing doc client if the code already shares one, otherwise construct as shown — and add to the deps literal:

```ts
    devSink: {
      // Deploy-time guard: whatever the config says, the sink can never activate in prod.
      allowed: process.env.WANTHAT_ENV !== "prod",
      put: async (item) => {
        await sink.put({
          ...item,
          createdAt: new Date().toISOString(),
          ttl: Math.floor(Date.now() / 1000) + 300, // 5 minutes, matches the OTP lifetime
        });
      },
    },
```

- [ ] **Step 8: Run to verify pass**

Run: `pnpm --filter @wanthat/contracts test && pnpm --filter @wanthat/dynamo test && pnpm --filter @wanthat/message-sender test && pnpm --filter @wanthat/message-sender typecheck`
Expected: PASS (message-sender: 11 tests).

- [ ] **Step 9: Infra.** `infra/lib/data-stack.ts` — field `readonly devOtpSinkTable: dynamodb.Table;` and after `notificationOutboxTable`:

```ts
    // Dev OTP sink (auth.otpSink = "devSink", docs/dev-otp-sink.md): message-sender parks codes
    // here for CLI pickup while both delivery channels are blocked. Exists in every env; the
    // sender's deploy-time env guard keeps it permanently empty in prod. 5-minute TTL.
    this.devOtpSinkTable = new dynamodb.Table(this, "DevOtpSink", {
      partitionKey: { name: "phone", type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: "ttl",
      ...common,
    });
```

`infra/lib/identity-stack.ts` — props gain `readonly devOtpSinkTable: dynamodb.ITable;`; MessageSender env gains `DEV_OTP_SINK_TABLE: props.devOtpSinkTable.tableName,`; grants gain `props.devOtpSinkTable.grantWriteData(messageSenderFn);` (write-only — the read path is the developer CLI).

`infra/bin/wanthat.ts` — identity props gain `devOtpSinkTable: data.devOtpSinkTable,`.

- [ ] **Step 10: Doc.** Create `docs/dev-otp-sink.md`:

```markdown
# Dev OTP sink — log in on dev without SMS/WhatsApp

While the SMS sandbox cap and Meta onboarding block real OTP delivery, dev can park codes in
DynamoDB instead (`auth.otpSink = "devSink"`). Prod is immune: message-sender honours the key
only when `WANTHAT_ENV !== "prod"` (deploy-time guard, not config).

## Flip it on (dev)
Set `auth.otpSink` to `devSink` via the admin config panel (or `PUT /admin/config/auth.otpSink`).
Flip back to `delivery` when a real channel is unblocked.

## Read a code (after tapping Continue on the login screen)
    aws dynamodb get-item \
      --table-name "$(aws dynamodb list-tables --query 'TableNames[?contains(@, `DevOtpSink`) && contains(@, `dev`)] | [0]' --output text)" \
      --key '{"phone":{"S":"+972541234567"}}' \
      --query 'Item.code.S' --output text

Items expire after 5 minutes (the OTP lifetime). The code is never logged; the sink item is the
only copy outside Cognito. `otp_sunk_dev` in the message-sender logs confirms the park.
```

- [ ] **Step 11: Full verification**

Run: `pnpm build && pnpm typecheck && pnpm test && pnpm lint && pnpm synth`
Expected: all PASS; the synthesized identity template shows `DEV_OTP_SINK_TABLE` in the MessageSender env and the data template a `DevOtpSink` table with TTL.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat(dev): OTP sink — park codes in DynamoDB on dev while SMS/WhatsApp are blocked (prod env-guarded)"
```
