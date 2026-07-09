# Real `/p/` Landing Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-07-09-landing-p-page-design.md` — read it first.

**Goal:** Replace the mock `/p/{recommendationId}` landing with the real ADR-0007/0008 flow — server-rendered product content + OG tags + snapshot, client-driven attributed resolve (`ref` + `c`/`g`), guest consent, referrer first name — and land the deferred funnel-analytics pipeline (CloudWatch Logs -> Firehose -> S3 -> Athena).

**Architecture:** Four independently deployable PRs. PR A denormalizes `referrerFirstName` onto the recommendation projection and stabilizes the funnel-event contracts. PR B makes the landing Lambda read DynamoDB and server-render the real page + `window.__WANTHAT_LANDING__` snapshot the SPA hydrates from. PR C adds `POST /p/{id}/resolve` (offline JWT verify, guest consent, click event) and the SPA redirect flows. PR D builds the analytics pipeline in infra.

**Tech Stack:** TypeScript/Node 24, pnpm + Turborepo, Zod contracts, Hono (app-links), DynamoDB (`@aws-sdk/lib-dynamodb`), `aws-jwt-verify`, React + react-router + i18next (SPA), AWS CDK v2.

## Global Constraints

- Monorepo commands run at the repo root: `pnpm lint` (biome — CI fails without it), `pnpm typecheck`, `pnpm test`, `pnpm synth` (infra changes; no AWS creds needed), `pnpm diff` before any deploy.
- Per-workspace test runs: `pnpm --filter <pkg> test` (e.g. `@wanthat/dynamo`, `@wanthat/landing`, `@wanthat/web`).
- PRs are opened **ready** (not draft), one per section below, in order A -> B -> C -> D (D only needs A). Merge to main deploys.
- Money is **bigint minor units** in code, **decimal string** on any JSON wire (`contracts/common/money.ts`). `JSON.stringify` throws on bigint — always use a replacer (`(_, v) => typeof v === "bigint" ? v.toString() : v`).
- Any new AWS `description` field: ASCII only, **no parentheses**.
- Any new `packages/*` import bundled into a Lambda must also appear in `infra/package.json` devDependencies (filtered turbo Deploy-build trap; red Check Deploy is blocking).
- ADRs are locked — this plan changes no decisions, it implements ADR-0007/0008/0009.
- Never edit a cross-stack SG description; never remove a cross-stack export without the consumers-first deploy dance.
- The landing hot path must never call Cognito synchronously (JWKS is fetched lazily and cached by `aws-jwt-verify`).

---

## PR A — referrer name denormalization + funnel-event contracts

### Task 1: Contracts — `LandingView.referrerFirstName` + `ConversionEvent`

**Files:**
- Modify: `packages/contracts/src/landing/landing.ts`
- Modify: `packages/contracts/src/landing/events.ts`
- Test: `packages/contracts/src/landing/events.test.ts` (create)

**Interfaces:**
- Produces: `LandingView` gains `referrerFirstName: string | null`. NOTE (found during execution): a funnel `ConversionEvent` already exists at `packages/contracts/src/conversion/event.ts` (type/orderId/recommendationId/consumer/amount/status/at) — reuse it; do NOT add a second one (it cannot join the landing `FunnelEvent` union without an import cycle — `conversion` imports `ConsumerKind` from `landing`). Lock its wire shape with a test instead.

- [ ] **Step 1: Write the failing test**

```ts
// packages/contracts/src/landing/events.test.ts
import { describe, expect, it } from "vitest";
import { ConversionEvent, FunnelEvent } from "./events";

describe("ConversionEvent", () => {
  const base = {
    type: "conversion",
    recommendationId: "abc123DEF45",
    consumer: "guest",
    orderId: "8123456789",
    commission: { amountMinor: "1240", currency: "USD" },
    at: "2026-07-09T10:00:00.000Z",
  };

  it("parses and is JSON-safe (string minor units, no bigint)", () => {
    const parsed = ConversionEvent.parse(base);
    expect(() => JSON.stringify(parsed)).not.toThrow();
    expect(parsed.commission?.amountMinor).toBe("1240");
  });

  it("allows a null commission and discriminates in FunnelEvent", () => {
    const parsed = FunnelEvent.parse({ ...base, commission: null });
    expect(parsed.type).toBe("conversion");
  });

  it("rejects a non-integer amount", () => {
    expect(() =>
      ConversionEvent.parse({ ...base, commission: { amountMinor: "12.40", currency: "USD" } }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`ConversionEvent` not exported): `pnpm --filter @wanthat/contracts test -- events`

- [ ] **Step 3: Implement.** In `events.ts`, after `ClickEvent`:

```ts
/**
 * Money as it appears in LOG events: the JSON-wire form (decimal-string minor units), because
 * funnel events are `JSON.stringify`-ed console.log lines and bigint would throw.
 */
export const EventMoney = z.object({
  amountMinor: z.string().regex(/^-?\d+$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
});
export type EventMoney = z.infer<typeof EventMoney>;

/**
 * Emitted by the conversion poller (ADR-0009) when an order lands. Defined NOW so the Athena
 * schema (PR D) is stable before the poller slice starts emitting it. `consumer` is the
 * attribution outcome resolved from `c`/`g`/`ref` (ADR-0008); `none` = untracked.
 */
export const ConversionEvent = z.object({
  type: z.literal("conversion"),
  recommendationId: RecommendationId,
  consumer: ConsumerKind,
  orderId: z.string().min(1),
  commission: EventMoney.nullable(),
  at: IsoDateTime,
});
export type ConversionEvent = z.infer<typeof ConversionEvent>;
```

and change the union: `export const FunnelEvent = z.discriminatedUnion("type", [ImpressionEvent, ClickEvent, ConversionEvent]);`

In `landing.ts`, add to `LandingView` (after `estimate`):

```ts
  // Denormalized at link creation for landing display; null on links created before the field existed.
  referrerFirstName: z.string().nullable(),
```

- [ ] **Step 4: Run tests — expect PASS**: `pnpm --filter @wanthat/contracts test`
- [ ] **Step 5: Commit**: `git add packages/contracts && git commit -m "feat(contracts): ConversionEvent + LandingView.referrerFirstName"`

### Task 2: Dynamo — `RecommendationItem.referrerFirstName` (backward-compatible)

**Files:**
- Modify: `packages/dynamo/src/recommendation.ts` (the `RecommendationItem` schema, line ~39)
- Test: `packages/dynamo/src/recommendation.test.ts`

**Interfaces:**
- Produces: `RecommendationItem.referrerFirstName: string | null` with `.default(null)` — **existing stored items have no attribute and must still parse** (repo methods `parse` on every read). Consumed by Tasks 3, 5.

- [ ] **Step 1: Write the failing test.** In `recommendation.test.ts`, add (mirroring the file's existing fixture style — reuse its valid-item fixture and spread-delete the field):

```ts
it("parses a pre-referrerFirstName stored item to null (backward compat)", () => {
  const { referrerFirstName: _drop, ...legacy } = validItem; // the file's existing fixture
  const parsed = RecommendationItem.parse(legacy);
  expect(parsed.referrerFirstName).toBeNull();
});

it("round-trips an explicit referrerFirstName", () => {
  expect(RecommendationItem.parse({ ...validItem, referrerFirstName: "Dana" }).referrerFirstName).toBe("Dana");
});
```

(If the test file's fixture is named differently, adapt the two tests to it; also add `referrerFirstName: null` to the fixture itself once the schema lands.)

- [ ] **Step 2: Run — expect FAIL**: `pnpm --filter @wanthat/dynamo test -- recommendation`
- [ ] **Step 3: Implement.** In the `RecommendationItem` schema, after `review`:

```ts
  // Landing display (spec 2026-07-09). Default null: rows written before this field must parse.
  referrerFirstName: z.string().nullable().default(null),
```

- [ ] **Step 4: Run — expect PASS**: `pnpm --filter @wanthat/dynamo test`
- [ ] **Step 5: Commit.**

### Task 3: app-links — write `referrerFirstName` at creation

**Files:**
- Create: `services/app-links/src/links/referrer-name.ts`
- Test: `services/app-links/src/links/referrer-name.test.ts` (create)
- Modify: `services/app-links/src/links/router.ts` (POST `/recommendations`, line ~226)
- Modify: `services/app-links/package.json` (add `@aws-sdk/client-cognito-identity-provider`)
- Modify: `services/app-links/src/links/router.test.ts` (create-route expectations)

**Interfaces:**
- Consumes: Task 2's `referrerFirstName` item field.
- Produces: `referrerFirstName(accessToken: string | undefined, deps?): Promise<string | null>`.
- Context: the SPA sends the **access token** (`apps/web/src/lib/api.ts` — "the access token is passed as a Bearer header"), so `given_name` is NOT in the authorizer claims. app-links is **non-VPC**, so a creation-time Cognito `GetUser` (self-serve, authorized by the token itself — no IAM grant) is allowed; the redirect hot path is untouched. Verify the access token carries the `aws.cognito.signin.user.admin` scope (Cognito InitiateAuth-issued tokens do); if a real token lacks it, `GetUser` fails and the function returns null — the fallback copy renders, nothing breaks.

- [ ] **Step 1: Write the failing test**

```ts
// services/app-links/src/links/referrer-name.test.ts
import { describe, expect, it, vi } from "vitest";
import { referrerFirstName } from "./referrer-name";

const clientWith = (attrs: { Name: string; Value?: string }[] | Error) => ({
  send: vi.fn(async () => {
    if (attrs instanceof Error) throw attrs;
    return { UserAttributes: attrs };
  }),
});

describe("referrerFirstName", () => {
  it("returns the trimmed given_name", async () => {
    const client = clientWith([{ Name: "given_name", Value: "  Dana " }]);
    await expect(referrerFirstName("tok", { client } as never)).resolves.toBe("Dana");
  });
  it("returns null without a token, without the attribute, or on error", async () => {
    await expect(referrerFirstName(undefined)).resolves.toBeNull();
    await expect(referrerFirstName("tok", { client: clientWith([]) } as never)).resolves.toBeNull();
    await expect(
      referrerFirstName("tok", { client: clientWith(new Error("denied")) } as never),
    ).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing): `pnpm --filter @wanthat/app-links test -- referrer-name`
- [ ] **Step 3: Implement**

```ts
// services/app-links/src/links/referrer-name.ts
import {
  CognitoIdentityProviderClient,
  GetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const defaultClient = new CognitoIdentityProviderClient({});

/**
 * The creator's given_name, denormalized onto the recommendation for landing display
 * (spec 2026-07-09 §3). The SPA authenticates with an ACCESS token whose claims carry no
 * profile, so this is a one-off self-serve Cognito GetUser with the caller's own token —
 * link creation only, NEVER the redirect hot path (ADR-0007). Best-effort: any failure → null
 * and the landing renders generic copy.
 */
export async function referrerFirstName(
  accessToken: string | undefined,
  deps: { client: { send: CognitoIdentityProviderClient["send"] } } = { client: defaultClient },
): Promise<string | null> {
  if (!accessToken) return null;
  try {
    const res = await deps.client.send(new GetUserCommand({ AccessToken: accessToken }));
    const given = res.UserAttributes?.find((a) => a.Name === "given_name")?.Value?.trim();
    return given || null;
  } catch {
    return null;
  }
}
```

Add the SDK dep: `pnpm --filter @wanthat/app-links add @aws-sdk/client-cognito-identity-provider`.

In `router.ts` POST `/recommendations`, after the `split` lookup and before `ctx.recommendations.create`:

```ts
const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
const firstName = await referrerFirstName(bearer);
```

and add `referrerFirstName: firstName,` to the `create({...})` item literal (import `referrerFirstName` from `./referrer-name`).

- [ ] **Step 4: Update `router.test.ts`.** The create test's expected stored item now includes `referrerFirstName`. Mock the name lookup at module level so the test needs no Cognito:

```ts
vi.mock("./referrer-name", () => ({ referrerFirstName: vi.fn(async () => "Dana") }));
```

and assert the repo received `referrerFirstName: "Dana"` (match the file's existing create-assertions style). Also add `referrerFirstName: null` to any `RecommendationItem` fixtures that now fail parsing (they won't — the default covers them — but keep new fixtures explicit).

- [ ] **Step 5: Run — expect PASS**: `pnpm --filter @wanthat/app-links test`
- [ ] **Step 6: Full gate + PR**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm synth
git add -A && git commit -m "feat(links): denormalize referrerFirstName onto the recommendation projection"
# open PR A (ready): contracts + dynamo + app-links; base main
```

Check Deploy note: `@aws-sdk/client-cognito-identity-provider` is an npm dep (not workspace), so no `infra/package.json` change is needed — but confirm Check Deploy is green before merge.

---

## PR B — real landing render (DynamoDB read, OG, server card, snapshot)

### Task 4: Contracts — `LandingSnapshot` + move `buildEstimate` into `@wanthat/domain`

**Files:**
- Modify: `packages/contracts/src/landing/landing.ts` (add `LandingSnapshot`)
- Modify: `packages/domain/src/index.ts` (add `buildEstimate`)
- Create: `packages/domain/src/estimate.test.ts` (or extend the existing domain test file if one exists)
- Modify: `services/app-links/src/links/router.ts` (delete local `buildEstimate`, import from `@wanthat/domain`)

**Interfaces:**
- Produces:
  - `LandingSnapshot` (contracts) — discriminated union on `status`:
    `{ status: "ok", landing: LandingView, countdownSeconds: number, displayFx: DisplayFx | null }` | `{ status: "notFound" }`
  - `buildEstimate(price: { amountMinor: string; currency: string } | null, commissionBps: number, split: CashbackSplit): CashbackEstimate` (domain) — the exact function currently at `services/app-links/src/links/router.ts:83-106`, moved verbatim.
- Consumed by Tasks 5, 6, 7 (landing + SPA both parse `LandingSnapshot`; landing builds the estimate).

- [ ] **Step 1: Failing domain test**

```ts
// packages/domain/src/estimate.test.ts
import { describe, expect, it } from "vitest";
import { buildEstimate } from "./index";

describe("buildEstimate", () => {
  it("splits price x commission into per-side estimates in the origin currency", () => {
    const e = buildEstimate({ amountMinor: "10000", currency: "USD" }, 800, {
      referrerBps: 5000,
      consumerBps: 2500,
    });
    // gross = 10000 * 800 / 10000 = 800 minor; referrer 400, consumer 200
    expect(e.referrer.estimated).toEqual({ amountMinor: 400n, currency: "USD" });
    expect(e.consumer.estimated).toEqual({ amountMinor: 200n, currency: "USD" });
  });
  it("returns null estimates for an unpriced product", () => {
    const e = buildEstimate(null, 800, { referrerBps: 5000, consumerBps: 2500 });
    expect(e.referrer.estimated).toBeNull();
    expect(e.consumer.rateBps).toBe(2500);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**: `pnpm --filter @wanthat/domain test`
- [ ] **Step 3: Move the function.** Cut `buildEstimate` (with its doc comment) from `router.ts` into `packages/domain/src/index.ts`, importing `type { CashbackEstimate, CashbackSplit } from "@wanthat/contracts"` (domain already depends on contracts). In `router.ts`, import it from `@wanthat/domain` alongside `splitCommission`. No behavior change.
- [ ] **Step 4: Add `LandingSnapshot`** to `packages/contracts/src/landing/landing.ts`:

```ts
import { DisplayFx } from "../recommendations"; // add to existing import block

/**
 * The payload the landing service embeds into the HTML shell as `window.__WANTHAT_LANDING__` —
 * the HTML-embedded form of GET /p/{id} (ADR-0007), so the SPA renders the identical card with
 * zero extra round trips. The server ALWAYS injects one (even on not-found / read failure); a
 * missing snapshot therefore means client-side navigation and the SPA must hard-reload /p/{id}.
 * Money travels in wire form (decimal-string minor units) and parses back through `Money`.
 */
export const LandingSnapshot = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    landing: LandingView,
    countdownSeconds: LandingCountdownSeconds,
    displayFx: DisplayFx.nullable(),
  }),
  z.object({ status: z.literal("notFound") }),
]);
export type LandingSnapshot = z.infer<typeof LandingSnapshot>;
```

- [ ] **Step 5: Run — expect PASS**: `pnpm --filter @wanthat/domain test && pnpm --filter @wanthat/contracts test && pnpm --filter @wanthat/app-links test && pnpm typecheck`
- [ ] **Step 6: Commit**: `"refactor(domain): share buildEstimate; feat(contracts): LandingSnapshot"`

### Task 5: Landing service — DynamoDB context + real render

**Files:**
- Create: `services/landing/src/context.ts`
- Rewrite: `services/landing/src/landing-page.ts`
- Modify: `services/landing/src/handler.ts`
- Modify: `services/landing/package.json` (add `@wanthat/dynamo`, `@wanthat/domain`, `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`)
- Modify: `infra/package.json` (devDependencies: ensure `@wanthat/dynamo` + `@wanthat/domain` are listed — the landing bundle now imports them)
- Test: `services/landing/src/handler.test.ts`, `services/landing/src/landing-page.test.ts` (create)

**Interfaces:**
- Consumes: `RecommendationRepo.get(id)` (Task 2 item shape), `FxRateRepo.get(base, quote)`, `RuntimeConfigRepo.get(key)` (follow `services/app-links/src/context.ts` for exact constructor/usage precedent), `buildEstimate` + `convertMinor` (domain), `LandingSnapshot`/`ImpressionEvent` (contracts).
- Produces:
  - `getContext(): LandingContext` / `setContext(c)` (test seam) where `LandingContext = { recommendations: RecommendationRepo; config: RuntimeConfigRepo; fx: FxRateRepo }`.
  - `buildRender(item: RecommendationItem, fxRate: string | null, fxCommissionBps: number, locale: Locale): LandingRender` and `injectLanding(shell, render: LandingRender | null, snapshotJson: string, origin, recId, locale): string` — Task 7's SPA renders from the same snapshot, so figures must match.
- Env consumed (wired in Task 6): `RECOMMENDATION_TABLE`, `RUNTIME_CONFIG_TABLE`, `FX_RATE_TABLE`, existing `SITE_ORIGIN`.

- [ ] **Step 1: `context.ts`** (model on `services/app-links/src/context.ts` — lazy singleton over `DynamoDBDocumentClient`, env-var table names above, plus a `setContext` test override).

- [ ] **Step 2: Failing render tests**

```ts
// services/landing/src/landing-page.test.ts (key cases; extend as listed below)
import { describe, expect, it } from "vitest";
import { buildRender, injectLanding, ogHead } from "./landing-page";

const item = {
  recommendationId: "abc123DEF45", ownerId: "sub-1", storeId: "aliexpress",
  storeProductId: "100500", affiliateUrl: "https://s.click.aliexpress.com/e/_x",
  title: 'Fish "Feeder" <Pro>', imageUrl: "https://ae01.alicdn.com/x.jpg",
  price: { amountMinor: "2500", currency: "USD" }, commissionBps: 800,
  cashback: { referrerBps: 5000, consumerBps: 2500 }, review: { text: "Great!" },
  referrerFirstName: "Dana", clicks: 0, conversions: 0,
  createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
};

it("converts price and consumer cashback to ILS display strings", () => {
  const r = buildRender(item as never, "3.5000", 0, "en");
  expect(r.priceDisplay).toBe("₪87.50");      // 2500 USD-minor * 3.5
  expect(r.cashbackDisplay).toBe("₪1.75");    // gross 200 * 25% = 50 USD-minor * 3.5
});

it("falls back to origin currency when no fx rate is cached", () => {
  const r = buildRender(item as never, null, 0, "en");
  expect(r.priceDisplay).toBe("$25.00");
});

it("HTML-escapes everything user-controlled in the OG head and server card", () => {
  const html = injectLanding(SHELL, buildRender(item as never, "3.5000", 0, "en"), "{}", "https://dev.wanthat.app", item.recommendationId, "en");
  expect(html).not.toContain("<Pro>");
  expect(html).toContain("&lt;Pro&gt;");
});

it("escapes </script> in the injected snapshot JSON", () => {
  const html = injectLanding(SHELL, null, JSON.stringify({ s: "</script><script>alert(1)</script>" }).replace(/</g, "\\u003c"), "https://dev.wanthat.app", "x", "en");
  expect(html).not.toContain("</script><script>alert(1)");
});
```

Also cover: `og:image` uses the stored absolute `imageUrl` (not `origin`-prefixed); null-image render omits `og:image`; review text becomes the OG description; null review falls back to the disclosure line; server card includes referrer name when present and the generic line when null.

- [ ] **Step 3: Run — expect FAIL**, then rewrite `landing-page.ts`:
  - Replace `LandingProduct`/`MOCK_PRODUCT` with:

```ts
export interface LandingRender {
  title: string;
  merchant: string;               // storeId → display name ("aliexpress" → "AliExpress")
  imageUrl: string | null;        // stored absolute https URL
  priceDisplay: string | null;    // "₪87.50" (fx-converted) or origin-currency fallback "$25.00"
  cashbackDisplay: string | null; // consumer-side estimate, same conversion
  reviewText: string | null;
  referrerFirstName: string | null;
}
```

  - `buildRender` computes the consumer estimate via `buildEstimate(item.price, item.commissionBps, item.cashback)`, converts both figures with `convertMinor(amountMinor, rate, commissionBps)` when a rate exists and currency !== "ILS", and formats with a local `formatMinor(amountMinor: bigint, currency: string): string` (minor-units decimal string with symbol map `{ILS:"₪",USD:"$"}` — a ~10-line sibling of `apps/web/src/lib/money.ts` `formatMoneyMinor`; do NOT import from apps/web).
  - `ogHead(render, origin, recId, locale)`: same tag set as today, but `og:image`/`twitter:image` come from `render.imageUrl` (already absolute; omit both tags when null), description = `reviewText` else the existing `OG_DESC` disclosure with the converted cashback.
  - Server card: a `serverCard(render, locale)` string mirroring the SPA card markup and Tailwind classes from `SharedProductPage.tsx:139-167` (same classes, so they exist in the compiled CSS — **only use classes that appear in SPA source**), plus an `AttributionChip`-style line: `referrerFirstName` present → "Dana recommends this" / null → the generic line; review text in a quote block when present.
  - `injectLanding(shell, render | null, snapshotJson, origin, recId, locale)`: as today, but seeds `#root` with `serverCard` (or a minimal generic block when `render` is null) and inserts `<script>window.__WANTHAT_LANDING__ = ${snapshotJson};</script>` immediately before the OG head block in `</head>`.
  - Keep `pickLocale` and `esc` as-is; `esc` every interpolated value.

- [ ] **Step 4: Handler tests** (extend `handler.test.ts`, mocking `setContext` repos and `global.fetch` for the shell): found item → 200 with real OG title + snapshot `status:"ok"` + impression line matching the `ImpressionEvent` contract; missing item → 200 with generic OG + `status:"notFound"` snapshot; repo throw → 200 + `status:"notFound"` (log the error); countdown value flows from the mocked config repo into the snapshot.

- [ ] **Step 5: Rewire `handler.ts`:**
  - Impression emission becomes the contract shape (PR D's filter pattern keys on `$.type`):

```ts
console.log(JSON.stringify(ImpressionEvent.parse({
  type: "impression", recommendationId: recId, at: new Date().toISOString(),
})));
```

  - Fetch in parallel: `recommendations.get(recId)`, countdown (`config.get("landing.countdownSeconds")`, cached in-module ~30s like the shell), fx rate for the item's price currency → ILS (skip when unpriced/ILS), `fx.conversionCommissionBps` config.
  - Snapshot: `status:"ok"` with `landing` (build via `LandingView.parse` from the item + `buildEstimate` + `referrerFirstName`), `countdownSeconds`, `displayFx` (rate + commission when a rate exists, else null); serialize with the bigint replacer + `.replace(/</g, "\\u003c")`. Not-found or read error → `status:"notFound"` snapshot, `render = null`. Emit the impression only when the item exists.
  - Keep the mock-product 404-for-non-/p/-paths, SITE_ORIGIN guard, and shell-error 502 behavior unchanged.

- [ ] **Step 6: Deps + gate**

```bash
pnpm --filter @wanthat/landing add @wanthat/dynamo @wanthat/domain @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb
# infra/package.json devDependencies: add "@wanthat/dynamo" and "@wanthat/domain" if absent
pnpm lint && pnpm typecheck && pnpm test && pnpm synth
```

- [ ] **Step 7: Commit**: `"feat(landing): resolve the recommendation from DynamoDB — real OG tags, server-rendered card, SPA snapshot"`

### Task 6: Infra — landing env vars

**Files:**
- Modify: `infra/lib/edge-services-stack.ts` (landing fn block, line ~74)

**Interfaces:** Produces env consumed by Task 5's `context.ts`. Grants already exist (`grantReadData` x3) — only names are missing.

- [ ] **Step 1:** After the `SITE_ORIGIN` block add (mirroring `api-stack.ts:93-99` naming):

```ts
landing.addEnvironment("RECOMMENDATION_TABLE", props.recommendationTable.tableName);
landing.addEnvironment("RUNTIME_CONFIG_TABLE", props.runtimeConfigTable.tableName);
landing.addEnvironment("FX_RATE_TABLE", props.fxRateTable.tableName);
```

- [ ] **Step 2:** `pnpm synth` — expect success; `git add infra && git commit -m "feat(infra): landing table env vars"`

### Task 7: SPA — hydrate `SharedProductPage` from the snapshot

**Files:**
- Create: `apps/web/src/features/landing/snapshot.ts`
- Test: `apps/web/src/features/landing/snapshot.test.ts`
- Modify: `apps/web/src/features/landing/SharedProductPage.tsx`
- Modify: `apps/web/src/i18n.ts` (new keys)

**Interfaces:**
- Consumes: `LandingSnapshot` (Task 4); snapshot injected by Task 5.
- Produces: `readLandingSnapshot(recommendationId: string): LandingSnapshot | null` (null = absent/invalid/id-mismatch → the page hard-reloads). Task 10 builds the redirect flows on this page.

- [ ] **Step 1: Failing snapshot tests**

```ts
// apps/web/src/features/landing/snapshot.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { readLandingSnapshot } from "./snapshot";

const OK = {
  status: "ok",
  landing: {
    recommendationId: "abc123DEF45",
    product: { storeId: "aliexpress", storeProductId: "100500", title: "Feeder", imageUrl: null,
      price: { amountMinor: "2500", currency: "USD" }, commissionBps: 800,
      createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" },
    review: null,
    estimate: { referrer: { rateBps: 5000, estimated: null }, consumer: { rateBps: 2500, estimated: null } },
    referrerFirstName: "Dana",
  },
  countdownSeconds: 3,
  displayFx: null,
};

afterEach(() => { delete (window as { __WANTHAT_LANDING__?: unknown }).__WANTHAT_LANDING__; });

describe("readLandingSnapshot", () => {
  it("parses a valid ok snapshot for the routed id", () => {
    (window as { __WANTHAT_LANDING__?: unknown }).__WANTHAT_LANDING__ = OK;
    expect(readLandingSnapshot("abc123DEF45")?.status).toBe("ok");
  });
  it("returns null when absent, invalid, or for another id", () => {
    expect(readLandingSnapshot("abc123DEF45")).toBeNull();
    (window as { __WANTHAT_LANDING__?: unknown }).__WANTHAT_LANDING__ = { status: "weird" };
    expect(readLandingSnapshot("abc123DEF45")).toBeNull();
    (window as { __WANTHAT_LANDING__?: unknown }).__WANTHAT_LANDING__ = OK;
    expect(readLandingSnapshot("otherId0001")).toBeNull();
  });
  it("passes notFound through regardless of id", () => {
    (window as { __WANTHAT_LANDING__?: unknown }).__WANTHAT_LANDING__ = { status: "notFound" };
    expect(readLandingSnapshot("abc123DEF45")?.status).toBe("notFound");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**, then implement `snapshot.ts` exactly per the interface (Zod `safeParse`, id check on the ok variant only).
- [ ] **Step 3: Rework `SharedProductPage.tsx`** (keep ALL existing auth logic — session, passkey arming, verifying/authed states — untouched this PR):
  - `const snapshot = readLandingSnapshot(id)`; `if (!snapshot) { window.location.reload(); return null; }` guarded so it fires once (`useRef`) — the reload goes through the landing Lambda, which always injects one.
  - `status === "notFound"` → render the wanthat wordmark + `t("shared.notFoundTitle")` / `t("shared.notFoundBody")`, no CTAs.
  - `status === "ok"` → replace the `PRODUCT` constant: title/image from `landing.product`; price + consumer-cashback figures via the same `displayFx` conversion CreateLinkPage uses (`convertMinor`-equivalent client logic + `formatMoneyMinor` from `apps/web/src/lib/money.ts`), falling back to origin-currency formatting when `displayFx` is null; attribution line from `referrerFirstName` (generic key when null); review quote when `landing.review` is set. Interpolate the converted cashback into `shared.signupCta`/`shared.earnLabel` copy the way the design dictionary does (`design/design_handoff_wanthat_app/designs/Wanthat Shared Product - Flow.dc.html:723-796` — copy the exact EN/HE strings).
  - Redirect targets stay `MOCK_STORE_URL` this PR (Task 10 replaces them).
  - New i18n keys (EN + HE, from the handoff dictionary): `shared.recommendsThis`, `shared.sentYouLink` (generic), `shared.notFoundTitle`, `shared.notFoundBody`.
- [ ] **Step 4: Gate + PR B**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm synth
git add -A && git commit -m "feat(web): SharedProductPage hydrates the real landing snapshot"
# open PR B (ready), base main (after A merges)
```

Post-merge verification on dev: open a real share link — real product/OG in a link-preview debugger, real card before JS, admin countdown change visible in the snapshot within ~30s.

---

## PR C — attributed redirect (resolve endpoint + SPA flows)

### Task 8: Domain — `withAttribution` URL helper

**Files:**
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/src/attribution.test.ts` (create)

**Interfaces:**
- Produces (consumed by Task 9):

```ts
export type ResolvedConsumer =
  | { kind: "member"; sub: string }
  | { kind: "guest"; guestId: string };
export function withAttribution(affiliateUrl: string, recommendationId: string, consumer: ResolvedConsumer): string
```

- [ ] **Step 1: Failing tests**

```ts
// packages/domain/src/attribution.test.ts
import { describe, expect, it } from "vitest";
import { withAttribution } from "./index";

describe("withAttribution", () => {
  it("appends ref + c for a member, preserving existing query params", () => {
    const url = withAttribution("https://s.click.aliexpress.com/e/_x?aff=1", "rec1", {
      kind: "member", sub: "11111111-1111-1111-1111-111111111111",
    });
    const u = new URL(url);
    expect(u.searchParams.get("aff")).toBe("1");
    expect(u.searchParams.get("ref")).toBe("rec1");
    expect(u.searchParams.get("c")).toBe("11111111-1111-1111-1111-111111111111");
    expect(u.searchParams.get("g")).toBeNull();
  });
  it("appends ref + g for a guest and URL-encodes values", () => {
    const u = new URL(withAttribution("https://s.click.aliexpress.com/e/_x", "rec 1", { kind: "guest", guestId: "g&1" }));
    expect(u.searchParams.get("ref")).toBe("rec 1");
    expect(u.searchParams.get("g")).toBe("g&1");
  });
  it("throws on a malformed stored URL rather than emitting garbage", () => {
    expect(() => withAttribution("not-a-url", "r", { kind: "guest", guestId: "g" })).toThrow();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**, implement:

```ts
/**
 * Attribution at click-through (ADR-0008): append `custom_parameters` onto the PRODUCT-level
 * affiliate URL — `ref` always, plus the consumer key (`c` member sub / `g` guest id). Opaque
 * ids only. The input URL comes ONLY from the stored recommendation projection (open-redirect
 * safety, ADR-0007); `new URL` throws on malformed storage. Integration caveat (ADR-0008): the
 * retailer must round-trip redirect-appended params — confirmed on first real dev conversion.
 */
export function withAttribution(
  affiliateUrl: string,
  recommendationId: string,
  consumer: ResolvedConsumer,
): string {
  const url = new URL(affiliateUrl);
  url.searchParams.set("ref", recommendationId);
  if (consumer.kind === "member") url.searchParams.set("c", consumer.sub);
  else url.searchParams.set("g", consumer.guestId);
  return url.toString();
}
```

- [ ] **Step 3: PASS + commit.**

### Task 9: Landing — `POST /p/{id}/resolve`

**Files:**
- Create: `services/landing/src/resolve.ts`
- Test: `services/landing/src/resolve.test.ts`
- Modify: `services/landing/src/handler.ts` (method/path routing)
- Modify: `services/landing/package.json` (add `aws-jwt-verify`)
- Modify: `infra/lib/edge-services-stack.ts` (+ its props and the call site in `infra/bin/wanthat.ts`): pass the Identity stack's user-pool id + SPA client id; `landing.addEnvironment("USER_POOL_ID", ...)`, `landing.addEnvironment("USER_POOL_CLIENT_ID", ...)` — reuse however `api-stack.ts` receives them for its JWT authorizer.

**Interfaces:**
- Consumes: `withAttribution` (Task 8), `RecommendationRepo.get`, contracts `ResolveBody`/`ResolveResponse`/`ClickEvent`.
- Produces: `resolve(event, recId, deps): Promise<LandingResult>` where `deps = { recommendations, verifyBearer: (auth: string | undefined) => Promise<string | null> }` (verifyBearer returns the sub or null — injectable for tests). Handler wires the real `aws-jwt-verify` verifier:

```ts
import { CognitoJwtVerifier } from "aws-jwt-verify";
let verifier: ReturnType<typeof CognitoJwtVerifier.create> | undefined;
async function verifyBearer(auth: string | undefined): Promise<string | null> {
  if (!auth?.toLowerCase().startsWith("bearer ")) return null;
  verifier ??= CognitoJwtVerifier.create({
    userPoolId: requireEnv("USER_POOL_ID"),
    tokenUse: "access",
    clientId: requireEnv("USER_POOL_CLIENT_ID"),
  });
  try {
    return String((await verifier.verify(auth.slice(7))).sub);
  } catch {
    return null; // invalid/expired → spec: authRequired, never 401 (the SPA re-auths and re-resolves)
  }
}
```

- [ ] **Step 1: Failing tests** — with a stubbed repo (`get` returns the Task 5 test item) and stubbed `verifyBearer`, plus a `vi.spyOn(console, "log")` to capture events:
  - Bearer verifies → 200 `{outcome:"redirect"}`, URL has `ref` + `c`, click event line parses as `ClickEvent` with `consumer:"member"`.
  - No token, body `{guestId:"g-1"}` → redirect with `ref` + `g`, click `consumer:"guest"`.
  - No token, empty body `{}` → `{outcome:"authRequired"}`, click `consumer:"none"` (the contract says resolve ALWAYS emits click).
  - Invalid token, body has guestId → guest redirect (graceful downgrade).
  - Malformed body JSON / guestId failing `ResolveBody` → 400 `{error:"invalid_request"}`, no click.
  - Unknown recommendationId → 404 `{error:"not_found"}`, no click.
  - The response body parses with `ResolveResponse`.
- [ ] **Step 2: Run — expect FAIL**, implement `resolve.ts` to that behavior: parse body with `ResolveBody.safeParse(JSON.parse(event.body ?? "{}"))` (isBase64Encoded-aware), member first, guest fallback, `withAttribution(rec.affiliateUrl, recId, consumer)`, emit `ClickEvent.parse({type:"click", recommendationId: recId, consumer, at: new Date().toISOString()})` via `console.log(JSON.stringify(...))`, respond `content-type: application/json`, `cache-control: no-store`.
- [ ] **Step 3: Route it in `handler.ts`:**

```ts
const method = event.requestContext?.http?.method ?? "GET";
const resolveMatch = path.match(/^\/p\/([^/?#]+)\/resolve$/);
if (resolveMatch?.[1]) {
  if (method !== "POST") return json(405, { error: "method_not_allowed" });
  return resolve(event, decodeURIComponent(resolveMatch[1]), realDeps);
}
```

(and make the page regex reject the `/resolve` suffix so GET `/p/x/resolve` doesn't render a page: the existing `^\/p\/([^/?#]+)` already stops at `/`, so `recIdFromPath("/p/x/resolve")` returns `"x"` — add an explicit `if (path.endsWith("/resolve"))` guard BEFORE the page branch).
- [ ] **Step 4: Infra env + deps:** `pnpm --filter @wanthat/landing add aws-jwt-verify`; wire `USER_POOL_ID`/`USER_POOL_CLIENT_ID` through `EdgeServicesStackProps` from the identity stack outputs in `infra/bin/wanthat.ts`. No CORS change: the SPA calls same-origin through CloudFront `/p/*` (which already forwards all methods — verify the `/p/*` behavior's `allowedMethods` includes POST; if it's GET/HEAD-only today, set `cloudfront.AllowedMethods.ALLOW_ALL` on that behavior in `infra/lib/edge-stack.ts:135-179`).
- [ ] **Step 5: Gate:** `pnpm lint && pnpm typecheck && pnpm test && pnpm synth` → commit `"feat(landing): client-driven resolve with ref/c/g attribution + click event"`.

### Task 10: SPA — real redirect flows (member countdown, guest consent)

**Files:**
- Create: `apps/web/src/lib/landing-api.ts`
- Test: `apps/web/src/lib/landing-api.test.ts`
- Modify: `apps/web/src/features/landing/SharedProductPage.tsx`
- Modify: `apps/web/src/i18n.ts`

**Interfaces:**
- Consumes: Task 9's endpoint; `accessToken()` from `apps/web/src/user` (`store.ts:128`); `countdownSeconds` from the Task 7 snapshot.
- Produces:

```ts
export function getOrMintGuestId(): string;            // localStorage "wanthat.guestId"; mints crypto.randomUUID()
export async function resolveRedirect(recommendationId: string, opts: { token?: string; guestId?: string }): Promise<ResolveResponse>;
```

- [ ] **Step 1: Failing `landing-api` tests** (mock `global.fetch`, stub `localStorage` per the pattern in `apps/web/src/user/store.test.ts`):
  - `resolveRedirect` POSTs to `/p/{id}/resolve` with the Bearer header when a token is given, `{guestId}` body when given, parses `{outcome:"redirect",url}` and `{outcome:"authRequired"}`, throws on non-2xx.
  - `getOrMintGuestId` returns the stored id when present; otherwise mints a UUID, stores it, and returns the same id on the second call.
- [ ] **Step 2: Implement** (fetch wrapper mirroring `apps/web/src/lib/api.ts` conventions; `ResolveResponse.parse` on the JSON).
- [ ] **Step 3: Rework the page flows** in `SharedProductPage.tsx` (mock URL deleted):
  - **Member** (`signedIn`): replace the immediate `toStore()` effect with the handoff interstitial — card stays, module shows `t("shared.redirectingStore")` + `t("shared.earnOnThis")` (converted cashback interpolated) + a countdown from `snapshot.countdownSeconds` + a `t("shared.continueToStore")` button. On mount of this state call `resolveRedirect(id, { token: accessToken() ?? undefined })` once; when the countdown elapses (or the button is clicked) navigate `window.location.assign(url)`. `countdownSeconds === 0` → navigate as soon as the URL arrives. `authRequired` (stale session) → fall back to the signed-out CTAs. Resolve failure → the button shows `t("shared.retry")` and re-resolves on click.
  - **Guest:** the guest link gains a one-line consent note under it (`t("shared.guestConsent")` — functional-storage consent, ADR-0008); clicking the CTA IS the consent: `getOrMintGuestId()` → `resolveRedirect(id, { guestId })` → navigate. Failure → same retry affordance. No localStorage write before the click.
  - **Anonymous:** no auto-redirect, unchanged CTAs otherwise; passkey auto-login leads into the member state above.
  - New i18n keys (EN/HE from the handoff dictionary; write HE for the new consent/retry lines matching its tone): `shared.redirectingStore`, `shared.earnOnThis`, `shared.continueToStore`, `shared.guestConsent`, `shared.retry`.
- [ ] **Step 4: Gate + PR C:** `pnpm lint && pnpm typecheck && pnpm test` → commit `"feat(web): attributed store redirect — member countdown + consent-gated guest"` → open PR C (ready).

Post-merge verification on dev: signed-in click lands on AliExpress with `ref`+`c` in the URL; guest flow mints one stable guestId and lands with `ref`+`g`; CloudWatch shows contract-shaped `click` lines; admin countdown change alters the interstitial within ~30s.

---

## PR D — funnel analytics pipeline (Firehose -> S3 -> Athena)

### Task 11: `FunnelAnalytics` construct

**Files:**
- Create: `infra/lib/funnel-analytics.ts`
- Modify: `infra/lib/observability-stack.ts` (props + instantiate)
- Modify: `infra/bin/wanthat.ts` (pass log groups)

**Interfaces:**
- Consumes: `edgeServices.landingFn.logGroup` and `edgeServices.conversionPollerFn.logGroup` (both fns already expose explicit log groups via `serviceLogGroup`).
- Produces: construct `new FunnelAnalytics(this, "Funnel", { wanthatEnv, logGroups })` owning bucket + stream + subscription filters + Glue database/table.

- [ ] **Step 1: Write the construct** (`aws-cdk-lib` `aws_s3`, `aws_iam`, `aws_kinesisfirehose.CfnDeliveryStream`, `aws_logs.CfnSubscriptionFilter`, `aws_glue.CfnDatabase/CfnTable`):
  - **Bucket:** `wanthat-${env}-funnel-${this.account}` (dev+prod share the account — env in the name), BLOCK_ALL public access, S3-managed encryption, lifecycle: IA at 90 days, abort incomplete multipart at 7 days. No description fields anywhere with non-ASCII or parentheses.
  - **Stream** (`DirectPut`, name `wanthat-${env}-funnel`) with `extendedS3DestinationConfiguration`:
    - `prefix: "funnel/date=!{partitionKeyFromQuery:date}/"`, `errorOutputPrefix: "funnel-errors/!{firehose:error-output-type}/"`, buffering 300s / 64MB, `dynamicPartitioningConfiguration: { enabled: true }`.
    - `processingConfiguration.processors`, in order: `{ type: "Decompression" }` (gunzips the CloudWatch Logs envelope), `{ type: "CloudWatchLogProcessing", parameters: [{ parameterName: "DataMessageExtraction", parameterValue: "true" }] }` (unwraps `logEvents[].message` — one record per event, no processor Lambda needed), `{ type: "MetadataExtraction", parameters: [{ parameterName: "MetadataExtractionQuery", parameterValue: "{date: .at[0:10]}" }, { parameterName: "JsonParsingEngine", parameterValue: "JQ-1.6" }] }`, `{ type: "AppendDelimiterToRecord", parameters: [{ parameterName: "Delimiter", parameterValue: "\\n" }] }`.
    - Verify the two processor type names against the current CfnDeliveryStream docs at implementation time (`Decompression` + `CloudWatchLogProcessing` are the documented names for the CW-Logs message-extraction feature); `pnpm synth` + a dev deploy prove them.
    - Role: `firehose.amazonaws.com` principal with `bucket.grantReadWrite(role)`.
  - **Subscription filters:** one `logs.CfnSubscriptionFilter` per input log group, `filterPattern: '{ $.type = "impression" || $.type = "click" || $.type = "conversion" }'`, `destinationArn: stream.attrArn`, role assumed by `logs.${region}.amazonaws.com` with `firehose:PutRecord`/`PutRecordBatch` on the stream ARN.
  - **Glue:** database `wanthat_${env}_analytics`; table `funnel_events`, external, `org.openx.data.jsonserde.JsonSerDe`, location `s3://<bucket>/funnel/`, columns `type string, recommendationid string, consumer string, orderid string, amount struct<amountminor:string,currency:string>, status string, at string` (matches `conversion/event.ts`; JsonSerDe is case-insensitive on JSON keys), partition key `date string` with partition projection: `projection.enabled=true`, `projection.date.type=date`, `projection.date.format=yyyy-MM-dd`, `projection.date.range=2026-07-01,NOW`, `storage.location.template=s3://<bucket>/funnel/date=${date}/`.
- [ ] **Step 2: Wire it:** `ObservabilityStackProps` gains `readonly funnelLogGroups: logs.ILogGroup[];`; the stack body instantiates `FunnelAnalytics`; `wanthat.ts` passes `[edgeServices.landingFn.logGroup, edgeServices.conversionPollerFn.logGroup]`. Observability deploys LAST already, so the new cross-stack log-group references respect the existing order (removing them later = consumers-first dance).
- [ ] **Step 3: Gate:** `pnpm lint && pnpm typecheck && pnpm synth` — inspect the synthesized template for the stream + two subscription filters + Glue table. Commit `"feat(infra): funnel analytics pipeline — CloudWatch Logs to Firehose to S3 with Athena projection"`.

### Task 12: PR D + end-to-end verification

- [ ] **Step 1:** `pnpm diff` (review: additive only — no replacements of existing resources), open PR D (ready), base main.
- [ ] **Step 2 (post-merge, dev):** open a share link + click through, then within ~10 minutes check `s3://wanthat-dev-funnel-<acct>/funnel/date=<today>/` for NDJSON events, and run in Athena: `SELECT type, count(*) FROM wanthat_dev_analytics.funnel_events WHERE date = '<today>' GROUP BY 1` — expect impression + click rows. If Firehose writes `funnel-errors/`, read one object: a processor mis-config shows up there, not in the happy path.

---

## Self-review notes (already applied)

- Impression emission is switched to the contract shape in PR B (Task 5) — required by PR D's `$.type` filter pattern; the old `landing_impression` key would silently never match.
- `RecommendationItem.referrerFirstName` uses `.default(null)` because every repo read `parse`s stored items (backward compat with existing rows).
- The server always injects a snapshot (ok or notFound) so the SPA's reload-on-missing-snapshot can't loop (spec §7).
- Server-rendered card uses only Tailwind classes that appear in SPA source — the compiled CSS contains nothing else.
- Resolve returns `authRequired` (never 401) on bad tokens per the contract docstring; a guest downgrade with a valid guestId still redirects.
- CloudFront `/p/*` must allow POST for resolve (Task 9 Step 4) — checked at implementation, fixed in `edge-stack.ts` if needed.
