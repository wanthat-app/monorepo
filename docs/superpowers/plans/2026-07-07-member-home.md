# Member Home (Wallet Dashboard) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The signed-in member home page per the design handoff — balance card, Face ID prompt, recent activity, nav chrome — wired to new stub wallet endpoints that carry the real contract.

**Architecture:** One deployable slice: `packages/contracts` gains a nullable ILS-estimate block on `GetWalletResponse`; app-core replaces the wallet 501s with authenticated stub routes returning a fixed empty wallet; `infra` adds the two gateway routes; the SPA rebuilds `HomePage` on the PR #98 design-system components with react-query. Real ledger queries + FX math land later with the AliExpress conversion-poller slice — handlers and SPA keep their shape.

**Tech Stack:** Zod contracts, Hono on Lambda (app-core), AWS CDK (HTTP API v2), React + react-router + @tanstack/react-query + i18next, Tailwind design system, vitest.

**Spec:** `docs/superpowers/specs/2026-07-07-member-home-design.md`

## Global Constraints

- Money is integer minor units as bigint in code, decimal **string** on the JSON wire (`Money` contract); money renders LTR, tabular, symbol leading (`₪142.50`) — the DS components handle direction.
- Bilingual: every new user-facing string needs `en` + `he` keys in `apps/web/src/i18n.ts`. Hebrew copy comes from the design's `T` dictionary where it exists (noted per key below).
- All wallet routes sit behind the API Gateway JWT authorizer AND check `sub` in-handler (same defence-in-depth as `/me`).
- No new packages anywhere. No `console.log` left behind. Fix warnings at the source — never suppress.
- Infra description fields must be ASCII (deploy-breaking otherwise). This plan adds no descriptions, keep it that way.
- Work on branch `feat/member-home`; commits after every green test cycle.

---

### Task 1: Contracts — `WalletEstimate` + `GetWalletResponse.estimated`

**Files:**
- Modify: `packages/contracts/src/wallet/endpoints.ts`
- Test: `packages/contracts/src/wallet/endpoints.test.ts` (create)

**Interfaces:**
- Consumes: existing `Money`, `WalletBalance` schemas.
- Produces: `WalletEstimate` zod schema/type `{ available: Money, pending: Money }`; `GetWalletResponse` becomes `{ balances: WalletBalance[], estimated: WalletEstimate | null }`. Tasks 2 and 4–5 rely on exactly these names.

- [ ] **Step 1: Create the branch**

```bash
git checkout -b feat/member-home
```

- [ ] **Step 2: Write the failing test**

Create `packages/contracts/src/wallet/endpoints.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { GetWalletResponse } from "./endpoints";

describe("GetWalletResponse", () => {
  it("parses the empty-wallet stub shape with a zero ILS estimate", () => {
    const parsed = GetWalletResponse.parse({
      balances: [],
      estimated: {
        available: { amountMinor: "0", currency: "ILS" },
        pending: { amountMinor: "0", currency: "ILS" },
      },
    });
    expect(parsed.estimated?.available.amountMinor).toBe(0n);
    expect(parsed.estimated?.available.currency).toBe("ILS");
    expect(parsed.balances).toEqual([]);
  });

  it("accepts a null estimate (a held currency without an FX rate)", () => {
    const parsed = GetWalletResponse.parse({ balances: [], estimated: null });
    expect(parsed.estimated).toBeNull();
  });

  it("rejects a response missing the estimated field", () => {
    expect(GetWalletResponse.safeParse({ balances: [] }).success).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @wanthat/contracts test -- endpoints`
Expected: FAIL — `GetWalletResponse` has no `estimated` key (`safeParse` test passes trivially today, the first two fail on unknown key / missing field).

- [ ] **Step 4: Implement the contract change**

In `packages/contracts/src/wallet/endpoints.ts`, replace the `GetWalletResponse` block:

```ts
/**
 * Display-only ILS estimate of the whole wallet (the UI's `≈` headline — never a settled
 * amount): confirmed-available and pending totals converted at cached FX rates. `null` when a
 * held currency has no cached rate; the client then falls back to per-currency figures only.
 */
export const WalletEstimate = z.object({
  available: Money,
  pending: Money,
});
export type WalletEstimate = z.infer<typeof WalletEstimate>;

// GET /wallet — balances for the authenticated member, one entry per currency held, plus the
// display estimate.
export const GetWalletResponse = z.object({
  balances: z.array(WalletBalance),
  estimated: WalletEstimate.nullable(),
});
export type GetWalletResponse = z.infer<typeof GetWalletResponse>;
```

Add `Money` to the import from `"../common"` (it is not imported there today; `WalletBalance` already is).

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @wanthat/contracts test -- endpoints`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/wallet/endpoints.ts packages/contracts/src/wallet/endpoints.test.ts
git commit -m "feat(contracts): GetWalletResponse carries a nullable ILS display estimate"
```

---

### Task 2: app-core — shared claims helper + stub wallet router

**Files:**
- Create: `services/app-core/src/claims.ts`
- Create: `services/app-core/src/wallet/router.ts`
- Test: `services/app-core/src/wallet/router.test.ts` (create)
- Modify: `services/app-core/src/me/router.ts` (use the shared helper)
- Modify: `services/app-core/src/handler.ts` (mount `/wallet`)

**Interfaces:**
- Consumes: `GetWalletResponse`, `ListWalletEntriesQuery`, `ListWalletEntriesResponse` from `@wanthat/contracts` (Task 1).
- Produces: `walletRouter(): Hono` mounted at `/wallet`; `subFromClaims(c)` in `src/claims.ts` (moved verbatim from `me/router.ts`). The wire shape of `GET /wallet` is `{"balances":[],"estimated":{"available":{"amountMinor":"0","currency":"ILS"},"pending":{"amountMinor":"0","currency":"ILS"}}}` — Task 4's client types mirror it.

- [ ] **Step 1: Write the failing tests**

Create `services/app-core/src/wallet/router.test.ts`. No context/db mocks — the stub touches neither. Auth claims are injected through Hono's env (third `app.request` argument), the same event shape the API Gateway JWT authorizer produces:

```ts
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { walletRouter } from "./router";

const app = new Hono();
app.route("/wallet", walletRouter());

const SUB = "11111111-1111-1111-1111-111111111111";
const authed = {
  event: { requestContext: { authorizer: { jwt: { claims: { sub: SUB } } } } },
};

const get = (path: string, env?: object) => app.request(path, { method: "GET" }, env);

describe("GET /wallet", () => {
  it("returns the empty stub wallet with a zero ILS estimate (bigint as wire string)", async () => {
    const res = await get("/wallet", authed);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({
      balances: [],
      estimated: {
        available: { amountMinor: "0", currency: "ILS" },
        pending: { amountMinor: "0", currency: "ILS" },
      },
    });
  });

  it("401s without authorizer claims", async () => {
    expect((await get("/wallet")).status).toBe(401);
  });
});

describe("GET /wallet/entries", () => {
  it("returns an empty page", async () => {
    const res = await get("/wallet/entries?limit=4", authed);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [], nextCursor: null });
  });

  it("400s on an invalid limit", async () => {
    expect((await get("/wallet/entries?limit=oops", authed)).status).toBe(400);
    expect((await get("/wallet/entries?limit=200", authed)).status).toBe(400);
  });

  it("401s without authorizer claims", async () => {
    expect((await get("/wallet/entries")).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @wanthat/app-core test -- wallet`
(Confirm the filter name against `services/app-core/package.json` `name` first; every other workspace uses the `@wanthat/` prefix.)
Expected: FAIL — `./router` does not exist.

- [ ] **Step 3: Extract the shared claims helper**

Create `services/app-core/src/claims.ts` (the function moves verbatim from `me/router.ts`):

```ts
import type { Context } from "hono";
import type { LambdaEvent } from "hono/aws-lambda";

export type Bindings = { event: LambdaEvent };

/** Pull the Cognito `sub` from the API Gateway JWT authorizer claims (HTTP API v2 shape). */
export function subFromClaims(c: Context<{ Bindings: Bindings }>): string | undefined {
  // biome-ignore lint/suspicious/noExplicitAny: the authorizer claim shape varies by event type
  const claims = (c.env?.event as any)?.requestContext?.authorizer?.jwt?.claims;
  const sub = claims?.sub;
  return typeof sub === "string" ? sub : undefined;
}
```

In `services/app-core/src/me/router.ts`: delete the local `type Bindings` and `subFromClaims` definitions and import both instead:

```ts
import { type Bindings, subFromClaims } from "../claims";
```

(`me/router.ts` keeps its own `parseBody`; the wallet router does not need it.)

- [ ] **Step 4: Implement the wallet router**

Create `services/app-core/src/wallet/router.ts`:

```ts
import {
  GetWalletResponse,
  ListWalletEntriesQuery,
  ListWalletEntriesResponse,
} from "@wanthat/contracts";
import type { Context } from "hono";
import { Hono } from "hono";
import { type Bindings, subFromClaims } from "../claims";

/**
 * Serialise a contract-parsed value with Money's wire rule (bigint minor units → decimal
 * string). `c.json` would throw on bigint — JSON has no bigint (see contracts/common/money.ts).
 */
function moneyJson(c: Context<{ Bindings: Bindings }>, value: unknown): Response {
  return c.body(
    JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    200,
    { "content-type": "application/json" },
  );
}

/**
 * Wallet reads for the member home (spec 2026-07-07-member-home). STUB: the contract, routes and
 * auth guard are final, but the data is a fixed empty wallet — the ledger aggregation and the FX
 * estimate land with the AliExpress conversion-poller slice (the first writer of wallet entries).
 * Only the internals of these handlers change then; the SPA and the wire shape do not.
 */
export function walletRouter(): Hono<{ Bindings: Bindings }> {
  const wallet = new Hono<{ Bindings: Bindings }>();

  // GET /wallet — per-currency balances + the display-only ILS estimate (`≈` in the UI).
  wallet.get("/", (c) => {
    const sub = subFromClaims(c);
    if (!sub) return c.json({ error: "unauthorized" }, 401);
    const zero = { amountMinor: 0n, currency: "ILS" };
    return moneyJson(
      c,
      GetWalletResponse.parse({ balances: [], estimated: { available: zero, pending: zero } }),
    );
  });

  // GET /wallet/entries — the member's ledger history, newest first (cursor-paginated).
  wallet.get("/entries", (c) => {
    const sub = subFromClaims(c);
    if (!sub) return c.json({ error: "unauthorized" }, 401);
    const query = ListWalletEntriesQuery.safeParse({
      cursor: c.req.query("cursor"),
      limit: c.req.query("limit"),
    });
    if (!query.success) return c.json({ error: "invalid_request" }, 400);
    return c.json(ListWalletEntriesResponse.parse({ items: [], nextCursor: null }));
  });

  return wallet;
}
```

- [ ] **Step 5: Mount the router**

In `services/app-core/src/handler.ts`:

```ts
import { walletRouter } from "./wallet/router";
```

after the `meRouter` import; then after `app.route("/me", meRouter());`:

```ts
app.route("/wallet", walletRouter());
```

and update the catch-all comment from
`// Links + wallet not yet implemented — a clean 501 rather than a 404.` to
`// Links not yet implemented — a clean 501 rather than a 404.`

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @wanthat/app-core test`
Expected: PASS — the 6 new wallet tests AND the existing register tests (they cover the `me/router.ts` refactor indirectly via module imports; `pnpm --filter @wanthat/app-core typecheck` must also pass).

- [ ] **Step 7: Commit**

```bash
git add services/app-core/src/claims.ts services/app-core/src/wallet/ services/app-core/src/me/router.ts services/app-core/src/handler.ts
git commit -m "feat(app-core): stub wallet endpoints with the real contract and auth guard"
```

---

### Task 3: Infra — gateway routes for `/wallet`

**Files:**
- Modify: `infra/lib/api-stack.ts` (after the `/me/{proxy+}` route block, ~line 330)

**Interfaces:**
- Consumes: existing `coreIntegration`, `authorizer`, `HttpMethod` in that file.
- Produces: `GET /wallet` and `GET /wallet/{proxy+}` routes on the app HTTP API. Nothing else changes — CORS already allows GET.

- [ ] **Step 1: Add the routes**

In `infra/lib/api-stack.ts`, directly after the `/me/{proxy+}` `addRoutes` call:

```ts
    // Wallet reads -> app-core, behind the JWT authorizer. The handlers are stubs this slice
    // (member-home spec); routes and contract are final, the poller slice fills the data in.
    this.httpApi.addRoutes({
      path: "/wallet",
      methods: [HttpMethod.GET],
      integration: coreIntegration,
      authorizer,
    });
    this.httpApi.addRoutes({
      path: "/wallet/{proxy+}",
      methods: [HttpMethod.GET],
      integration: coreIntegration,
      authorizer,
    });
```

- [ ] **Step 2: Synth + diff**

Run: `pnpm synth` — expected: success.
Run: `cd infra && npx cdk diff wanthat-dev-api` — expected: exactly two new `AWS::ApiGatewayV2::Route` resources (`GET /wallet`, `GET /wallet/{proxy+}`) and nothing else (version-tag noise aside).

- [ ] **Step 3: Commit**

```bash
git add infra/lib/api-stack.ts
git commit -m "feat(infra): authorized GET routes for /wallet on the app API"
```

---

### Task 4: SPA — wallet API client + minor-units money formatting

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Create: `apps/web/src/lib/money.ts`
- Test: `apps/web/src/lib/money.test.ts` (create)

**Interfaces:**
- Consumes: the wire shape from Task 2; existing `request<T>` helper in `api.ts`.
- Produces (Task 5 relies on exactly these):
  - `walletApi.get(token): Promise<GetWalletWire>` and `walletApi.entries(token, limit): Promise<ListWalletEntriesWire>` with the wire types below.
  - `formatMoneyMinor(amountMinor: string, currency: string): string` → `"₪123.45"`, `"$36.20"`, `"-₪4.00"`.
  - `splitMoneyMinor(amountMinor: string, currency: string): [string, string]` → `["₪123", ".45"]` (BalanceCard takes amount + fraction separately).

- [ ] **Step 1: Write the failing money tests**

Create `apps/web/src/lib/money.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatMoneyMinor, splitMoneyMinor } from "./money";

describe("formatMoneyMinor", () => {
  it("formats zero", () => {
    expect(formatMoneyMinor("0", "ILS")).toBe("₪0.00");
  });
  it("formats sub-unit and grouped amounts", () => {
    expect(formatMoneyMinor("5", "ILS")).toBe("₪0.05");
    expect(formatMoneyMinor("14250", "ILS")).toBe("₪142.50");
    expect(formatMoneyMinor("123456789", "ILS")).toBe("₪1,234,567.89");
  });
  it("uses known symbols and falls back to the code", () => {
    expect(formatMoneyMinor("3620", "USD")).toBe("$36.20");
    expect(formatMoneyMinor("214", "EUR")).toBe("€2.14");
    expect(formatMoneyMinor("100", "JPY")).toBe("JPY 1.00");
  });
  it("keeps the sign ahead of the symbol", () => {
    expect(formatMoneyMinor("-400", "ILS")).toBe("-₪4.00");
  });
});

describe("splitMoneyMinor", () => {
  it("splits integer and fraction for the balance headline", () => {
    expect(splitMoneyMinor("14250", "ILS")).toEqual(["₪142", ".50"]);
    expect(splitMoneyMinor("0", "ILS")).toEqual(["₪0", ".00"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @wanthat/web test -- money`
(Confirm the workspace name in `apps/web/package.json` first.)
Expected: FAIL — `./money` does not exist.

- [ ] **Step 3: Implement `money.ts`**

Create `apps/web/src/lib/money.ts`:

```ts
/**
 * Display formatting for wire `Money` (integer minor units as a decimal string — see
 * contracts/common/money.ts). String/bigint math only: minor-unit amounts must never pass
 * through floats. All output is symbol-leading (`₪142.50`); the caller (DS components) pins
 * LTR + tabular numerals.
 */

const SYMBOLS: Record<string, string> = { ILS: "₪", USD: "$", EUR: "€", GBP: "£" };

function parts(amountMinor: string, currency: string): { sign: string; int: string; frac: string; symbol: string } {
  const neg = amountMinor.startsWith("-");
  const digits = (neg ? amountMinor.slice(1) : amountMinor).padStart(3, "0");
  const int = digits
    .slice(0, -2)
    .replace(/^0+(?=\d)/, "")
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return {
    sign: neg ? "-" : "",
    int,
    frac: digits.slice(-2),
    symbol: SYMBOLS[currency] ?? `${currency} `,
  };
}

/** "14250" + ILS → "₪142.50"; unknown currency falls back to "JPY 1.00". */
export function formatMoneyMinor(amountMinor: string, currency: string): string {
  const p = parts(amountMinor, currency);
  return `${p.sign}${p.symbol}${p.int}.${p.frac}`;
}

/** "14250" + ILS → ["₪142", ".50"] — BalanceCard renders amount and fraction separately. */
export function splitMoneyMinor(amountMinor: string, currency: string): [string, string] {
  const p = parts(amountMinor, currency);
  return [`${p.sign}${p.symbol}${p.int}`, `.${p.frac}`];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @wanthat/web test -- money`
Expected: PASS (6 tests).

- [ ] **Step 5: Add the wallet API client**

In `apps/web/src/lib/api.ts`, after `meApi`:

```ts
/**
 * Wire types for the wallet surface: `Money.amountMinor` travels as a decimal string (JSON has
 * no bigint). Formatting stays in lib/money.ts; nothing here converts to floats.
 */
export interface MoneyWire {
  amountMinor: string;
  currency: string;
}
export interface WalletEarningsWire {
  confirmed: MoneyWire;
  pending: MoneyWire;
}
export interface WalletBalanceWire {
  asRecommender: WalletEarningsWire;
  asBuyer: WalletEarningsWire;
  available: MoneyWire;
}
export interface WalletEstimateWire {
  available: MoneyWire;
  pending: MoneyWire;
}
export interface WalletEntryWire {
  id: string;
  kind: "referrer_cashback" | "consumer_reward" | "adjustment" | "withdrawal";
  amount: MoneyWire;
  status: "pending" | "confirmed" | "clawback";
  recommendationId: string | null;
  createdAt: string;
}

export const walletApi = {
  get: (token: string) =>
    request<{ balances: WalletBalanceWire[]; estimated: WalletEstimateWire | null }>("/wallet", {
      token,
    }),
  entries: (token: string, limit: number) =>
    request<{ items: WalletEntryWire[]; nextCursor: string | null }>(
      `/wallet/entries?limit=${limit}`,
      { token },
    ),
};
```

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm --filter @wanthat/web typecheck`
Expected: PASS.

```bash
git add apps/web/src/lib/money.ts apps/web/src/lib/money.test.ts apps/web/src/lib/api.ts
git commit -m "feat(web): wallet API client + minor-units money formatting"
```

---

### Task 5: SPA — i18n copy for the home page

**Files:**
- Modify: `apps/web/src/i18n.ts` (both `home:` blocks — `en` around line 66, `he` around line 283)

**Interfaces:**
- Produces: the `home.*` keys Task 6's `HomePage.tsx` consumes. Keys marked *(design)* are lifted verbatim from the design `T` dictionary; the rest are new copy in the same voice.

- [ ] **Step 1: Replace the `en` `home:` block**

```ts
  home: {
    availableCashback: "Available cashback", // (design)
    estimated: "Estimated", // (design)
    heldNote: "held in original currencies", // (design)
    pendingNote: "≈{{amount}} pending confirmation", // (design, parameterised)
    withdrawCash: "Withdraw cash", // (design: withdrawToBank)
    recentActivity: "Recent activity", // (design)
    seeAll: "See all", // (design)
    noActivity: "No activity yet — cashback from your links will show up here.",
    createLink: "Create link",
    navHome: "Home", // (design)
    navActivity: "Activity", // (design)
    setupFaceId: "Set up Face ID", // (design)
    setupFaceIdSub: "Skip SMS codes — log in instantly next time.", // (design)
    turnOn: "Turn on", // (design)
    passkeyDone: "Passkey added.",
    signOut: "Sign out",
    loadFailed: "Couldn't load your wallet.",
    retry: "Retry",
    status: {
      confirmed: "Confirmed", // (design)
      pending: "Pending", // (design)
      clawback: "Returned", // (design: returned)
    },
    kind: {
      referrer_cashback: "Recommendation cashback",
      consumer_reward: "Your cashback",
      adjustment: "Adjustment",
      withdrawal: "Withdrawal",
    },
  },
```

- [ ] **Step 2: Replace the `he` `home:` block**

```ts
  home: {
    availableCashback: "קאשבק זמין",
    estimated: "משוער",
    heldNote: "מוחזק במטבע המקורי",
    pendingNote: "≈{{amount}} ממתין לאישור",
    withdrawCash: "משיכת מזומן",
    recentActivity: "פעילות אחרונה",
    seeAll: "הצג הכל",
    noActivity: "אין פעילות עדיין — קאשבק מהקישורים שלכם יופיע כאן.",
    createLink: "יצירת קישור",
    navHome: "בית",
    navActivity: "פעילות",
    setupFaceId: "הגדרת Face ID",
    setupFaceIdSub: "דלגו על קודי SMS — התחברו מיד בפעם הבאה.",
    turnOn: "הפעלה",
    passkeyDone: "מפתח הגישה נוסף.",
    signOut: "התנתקות",
    loadFailed: "לא הצלחנו לטעון את הארנק.",
    retry: "נסו שוב",
    status: {
      confirmed: "אושר",
      pending: "ממתין",
      clawback: "הוחזר",
    },
    kind: {
      referrer_cashback: "קאשבק מהמלצה",
      consumer_reward: "הקאשבק שלכם",
      adjustment: "התאמה",
      withdrawal: "משיכה",
    },
  },
```

The old keys `greeting`, `placeholder`, `enrollPasskey` are removed in BOTH locales — Task 6 removes their only consumer. `grep -rn "home\.greeting\|home\.placeholder\|home\.enrollPasskey" apps/web/src` must come back empty after Task 6; check again there.

- [ ] **Step 3: Typecheck and commit**

Run: `pnpm --filter @wanthat/web typecheck`
Expected: PASS (i18n dictionaries are plain objects; HomePage still referencing removed keys does not typecheck-fail — that's fine, Task 6 replaces it. The dev build may warn; do not ship between Tasks 5 and 6.)

```bash
git add apps/web/src/i18n.ts
git commit -m "feat(web): home page copy, EN + HE, lifted from the design handoff"
```

---

### Task 6: SPA — HomePage rebuild on the design system

**Files:**
- Rewrite: `apps/web/src/features/home/HomePage.tsx`

**Interfaces:**
- Consumes: `walletApi`, `formatMoneyMinor`, `splitMoneyMinor` (Task 4); `home.*` i18n keys (Task 5); DS components `BalanceCard`, `ActivityRow`, `PromptCard`, `TabBar`, `TopNav`, `ProfileChip` from `../../ui/wallet`, `Logo` from `../../ui/brand`, `Button` from `../../ui/components`; `useSession`, `enrollPasskey`, `passkeysSupported` (existing libs); `useQuery` from `@tanstack/react-query` (provider already mounted in `main.tsx`).
- Produces: the `/home` route content. No new exports beyond `HomePage`.

- [ ] **Step 1: Rewrite `HomePage.tsx`**

Replace the whole file:

```tsx
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { walletApi, type WalletEntryWire } from "../../lib/api";
import { formatMoneyMinor, splitMoneyMinor } from "../../lib/money";
import { enrollPasskey, passkeysSupported } from "../../lib/passkey";
import { useSession } from "../../lib/session";
import { Logo } from "../../ui/brand";
import { Button } from "../../ui/components";
import {
  ActivityRow,
  BalanceCard,
  ProfileChip,
  PromptCard,
  TabBar,
  TopNav,
} from "../../ui/wallet";

const RECENT_LIMIT = 4;
const ROW_STATUS = { confirmed: "confirmed", pending: "pending", clawback: "rejected" } as const;

const FACE_ICON = (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M7 3H5a2 2 0 0 0-2 2v2M17 3h2a2 2 0 0 1 2 2v2M7 21H5a2 2 0 0 1-2-2v-2M17 21h2a2 2 0 0 0 2-2v-2" />
    <path d="M9 9h.01M15 9h.01M9.5 15a3.5 3.5 0 0 0 5 0" />
  </svg>
);

/**
 * Member home — the wallet dashboard (design handoff: Wallet flow, Home). Balance + activity come
 * from the wallet endpoints (stubbed empty until the poller slice writes the ledger). Create link,
 * Activity, Profile, See all and Withdraw are visible per the design but inert this slice; the
 * Face ID prompt card is live. Sign-out stays reachable via the avatar menu meanwhile.
 */
export function HomePage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { customer, accessToken, signOut } = useSession();
  const [passkeyState, setPasskeyState] = useState<"idle" | "enrolling" | "done" | "error">("idle");
  const [menuOpen, setMenuOpen] = useState(false);

  const token = accessToken();
  const wallet = useQuery({
    queryKey: ["wallet"],
    queryFn: () => walletApi.get(token as string),
    enabled: !!token,
  });
  const entries = useQuery({
    queryKey: ["wallet-entries", RECENT_LIMIT],
    queryFn: () => walletApi.entries(token as string, RECENT_LIMIT),
    enabled: !!token,
  });

  if (!customer) {
    navigate("/auth", { replace: true });
    return null;
  }

  const onEnrollPasskey = async () => {
    if (!token) return;
    setPasskeyState("enrolling");
    try {
      await enrollPasskey(token);
      setPasskeyState("done");
    } catch {
      setPasskeyState("error");
    }
  };

  const onSignOut = async () => {
    await signOut();
    navigate("/auth", { replace: true });
  };

  const est = wallet.data?.estimated ?? null;
  const [amount, fraction] = est ? splitMoneyMinor(est.available.amountMinor, "ILS") : ["", ""];
  const holdings = (wallet.data?.balances ?? []).map((b) =>
    formatMoneyMinor(b.available.amountMinor, b.available.currency),
  );
  // Computed inline (not a boolean flag) so TS keeps the `est` narrowing at the usage site.
  const pendingNote =
    est && BigInt(est.pending.amountMinor) > 0n
      ? t("home.pendingNote", { amount: formatMoneyMinor(est.pending.amountMinor, "ILS") })
      : undefined;
  const dateLocale = i18n.language.startsWith("he") ? "he-IL" : "en-US";
  const entryMeta = (e: WalletEntryWire) =>
    new Date(e.createdAt).toLocaleDateString(dateLocale, { day: "numeric", month: "short" });

  const profileMenu = menuOpen ? (
    <div className="absolute end-6 top-16 z-20 min-w-36 rounded-input border border-line bg-surface p-1.5 shadow-[0_1px_2px_rgba(0,0,0,.08)]">
      <button
        type="button"
        onClick={() => void onSignOut()}
        className="w-full rounded-[9px] px-3 py-2 text-start text-sm font-semibold text-ink transition hover:bg-page"
      >
        {t("home.signOut")}
      </button>
    </div>
  ) : null;

  return (
    <div className="relative flex min-h-screen flex-col bg-page">
      {/* Desktop chrome: top nav. Activity / Create link / avatar-menu-open are the slice's inert edges. */}
      <div className="hidden md:block">
        <TopNav
          links={[
            { key: "home", label: t("home.navHome"), active: true },
            { key: "activity", label: t("home.navActivity") },
          ]}
          createLabel={t("home.createLink")}
          profileInitial={customer.firstName.charAt(0).toUpperCase()}
          onProfile={() => setMenuOpen((v) => !v)}
        />
      </div>
      {/* Mobile chrome: brand + avatar header. */}
      <header className="flex items-center justify-between px-6 pt-5 md:hidden">
        <Logo size="sm" />
        <ProfileChip
          initial={customer.firstName.charAt(0).toUpperCase()}
          onClick={() => setMenuOpen((v) => !v)}
          size={36}
        />
      </header>
      {profileMenu}

      <main className="mx-auto flex w-full max-w-[430px] flex-1 flex-col gap-4 px-6 pb-32 pt-5 md:max-w-[640px] md:pb-12 md:pt-8">
        {wallet.isError ? (
          <div className="flex flex-col items-center gap-3 rounded-card bg-surface p-6">
            <p className="text-sm text-muted">{t("home.loadFailed")}</p>
            <Button variant="ghost" onClick={() => void wallet.refetch()}>
              {t("home.retry")}
            </Button>
          </div>
        ) : (
          <BalanceCard
            loading={wallet.isPending}
            label={t("home.availableCashback")}
            chip={
              est ? (
                <span className="rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-bold text-onink">
                  {t("home.estimated")}
                </span>
              ) : undefined
            }
            approx={est !== null}
            amount={est ? amount : undefined}
            fraction={est ? fraction : undefined}
            holdings={holdings.length ? holdings : undefined}
            holdingsNote={holdings.length ? t("home.heldNote") : undefined}
            pendingNote={pendingNote}
            cta={t("home.withdrawCash")}
          />
        )}

        {passkeysSupported() && passkeyState !== "done" && (
          <PromptCard
            icon={FACE_ICON}
            title={t("home.setupFaceId")}
            subtitle={
              passkeyState === "error" ? t("auth.errors.generic") : t("home.setupFaceIdSub")
            }
            actionLabel={passkeyState === "enrolling" ? "…" : t("home.turnOn")}
            onAction={() => void onEnrollPasskey()}
          />
        )}
        {passkeyState === "done" && <p className="text-sm text-accent">{t("home.passkeyDone")}</p>}

        <section className="rounded-card bg-surface p-5">
          <div className="mb-1 flex items-center justify-between">
            <h2 className="text-[15px] font-bold text-ink">{t("home.recentActivity")}</h2>
            <button type="button" className="text-[13px] font-bold text-accent">
              {t("home.seeAll")}
            </button>
          </div>
          {entries.isPending || entries.isError ? (
            [0, 1, 2].map((i) => <ActivityRow key={i} loading />)
          ) : entries.data.items.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">{t("home.noActivity")}</p>
          ) : (
            entries.data.items.map((e) => (
              <ActivityRow
                key={e.id}
                title={t(`home.kind.${e.kind}`)}
                status={ROW_STATUS[e.status]}
                statusLabel={t(`home.status.${e.status}`)}
                meta={entryMeta(e)}
                amount={formatMoneyMinor(e.amount.amountMinor, e.amount.currency)}
              />
            ))
          )}
        </section>
      </main>

      {/* Mobile chrome: bottom tabs + create FAB (inert this slice). */}
      <nav className="fixed inset-x-0 bottom-0 md:hidden">
        <TabBar
          homeLabel={t("home.navHome")}
          activityLabel={t("home.navActivity")}
          active="home"
          createLabel={t("home.createLink")}
        />
      </nav>
    </div>
  );
}
```

Notes for the implementer:
- `rounded-card` is the DS card radius token; if the Tailwind theme names it differently (check `apps/web/tailwind.config.*` / `index.css` `@theme`), use the token the admin cards use — do not hardcode a px radius.
- If `Logo` has no `size="sm"` prop, use it the way `TopNav` in `ui/wallet.tsx` does (it renders `<Logo size="sm" />` internally — mirror that call).
- `entries.isError` intentionally renders skeletons, not a second error block: the balance error block already owns the retry affordance and both queries hit the same API.

- [ ] **Step 2: Typecheck + full web tests + lint**

Run: `pnpm --filter @wanthat/web typecheck && pnpm --filter @wanthat/web test`
Expected: PASS. Then `grep -rn "home\.greeting\|home\.placeholder\|home\.enrollPasskey" apps/web/src` — expected: no matches.

- [ ] **Step 3: See it render**

Run: `pnpm --filter @wanthat/web dev` and open `http://localhost:5173/home` signed out — it must bounce to `/auth`. A full signed-in check happens in Task 7 against dev; locally the wallet calls 401 without a real token, which exercises the error/retry state — verify the retry card renders and the layout (nav chrome, RTL toggle via the language on the auth page) holds in both `en` and `he`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/features/home/HomePage.tsx
git commit -m "feat(web): member home rebuilt on the design system - balance, activity, chrome"
```

---

### Task 7: Verification, PR, deploy check

**Files:** none new.

- [ ] **Step 1: Full workspace verification**

```bash
pnpm typecheck && pnpm test && pnpm build && pnpm synth
```
Expected: all green.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/member-home
gh pr create --title "feat(app): member home - wallet dashboard over stub wallet endpoints" --body "$(cat <<'EOF'
## What

The signed-in member home per the design handoff (Wallet flow → Home): dark balance card
(estimated-ILS headline + Estimated chip, holdings chips, pending note, mint Withdraw CTA),
Face ID prompt card (live enrolment), recent-activity list, desktop top nav + mobile tab bar.

Spec: docs/superpowers/specs/2026-07-07-member-home-design.md

## Real vs stubbed

- **Real:** GetWalletResponse contract (+ nullable ILS estimate block), JWT-authorized
  /wallet + /wallet/entries routes (gateway + in-handler sub check), PageQuery validation,
  SPA wiring (react-query), EN+HE copy, loading/error/empty states.
- **Stubbed:** the wallet data — GET /wallet returns a fixed empty wallet (₪0.00 estimate),
  /wallet/entries an empty page. Ledger aggregation + FX estimate land with the AliExpress
  conversion-poller slice; handlers and SPA keep their shape.
- **Inert by design this slice:** Create link, Activity, Profile, See all, Withdraw.
EOF
)"
```
PRs open ready (not draft). CI + check-deploy must both pass; a red check-deploy is blocking.

- [ ] **Step 3: After merge — watch the deploy, then verify on dev**

```bash
gh run list --workflow Deploy --branch main --limit 1   # grab the run id
gh run watch <run-id> --exit-status
```
Then sign in on https://dev.wanthat.app → Home must show the ₪0.00 balance card (Estimated chip, `≈` prefix), the Face ID prompt (if no passkey on the device), the empty activity state, and the inert Create link / Activity / See all / Withdraw affordances; the network tab shows `GET /wallet` and `GET /wallet/entries?limit=4` both 200 with the stub bodies. Check both locales (RTL layout in Hebrew: chrome mirrors, money stays LTR).
