# Cold-Start Cache (wallet + activity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the last known wallet balance and activity feed from localStorage during an Aurora cold start, with a "Counting the money…" indicator (admin-configurable layout, random glyph), silently retrying until fresh data lands.

**Architecture:** A tiny per-user localStorage cache module in the member SPA; the Home balance card and the client-side activity feed read it while their queries are pending/failing and write it on every fresh success. One new public runtime-config key picks the indicator layout. Pure-CSS animations live in the design-system package (`@wanthat/ui`), keyframes in its Tailwind preset.

**Tech Stack:** React 18 + TanStack Query + Tailwind (member SPA), Zod contracts, vitest (node env, `vi.stubGlobal` for localStorage — repo has no DOM test lib, so all tests target pure logic).

**Spec:** `docs/superpowers/specs/2026-07-21-cold-start-cache-design.md`

## Global Constraints

- Cache keys: `wanthat.cache.wallet.<sub>` / `wanthat.cache.activity.<sub>`; envelope `{ v: 1, savedAt: <epoch ms>, data }`; TTL **7 days**; every storage access try/catch-wrapped; cleared on sign-out.
- Config key: `wallet.countingIndicator`, enum `"chip" | "hero"`, default `"chip"`, **public**.
- Copy (en / he): `home.counting` = "Counting the money…" / "סופרים את הכסף…"; `home.lastCounted` = "Last counted: {{amount}}" / "נספר לאחרונה: {{amount}}"; `home.estimated` **changed** to "At current FX rates" / "לפי שערי מטבע".
- No layout shift: indicator chips are exactly 26px tall, hero fills the exact 46px amount slot, glyphs animate with `transform`/`opacity` only.
- Silent retry backoff: `Math.min(30_000, 1_000 * 2 ** attempt)` ms, unbounded attempts while cache is displayed.
- Repo gates: `pnpm lint` (biome), `pnpm typecheck`, `pnpm test`, `pnpm build` must pass; branch `cold-start-cache`; PRs ready (not draft); merge to `main` deploys dev.
- `apps/admin/src/i18n.ts` `he` object is typed `typeof en` — every added `en` key needs the `he` twin or typecheck fails. Same in `apps/web/src/i18n.ts`.

---

### Task 1: Contracts — `wallet.countingIndicator` config key

**Files:**
- Modify: `packages/contracts/src/config/keys.ts`

**Interfaces:**
- Produces: config key `"wallet.countingIndicator"` (value `"chip" | "hero"`, default `"chip"`, public) — served by the existing `GET /config` batch endpoint with zero handler changes.

- [x] **Step 1: Add the schema + registry entries**

In `packages/contracts/src/config/keys.ts`, after the `HomeRecentActivityLimit` block (line ~117), add:

```ts
/**
 * How the member home shows the CACHED wallet while Aurora cold-resumes (spec
 * 2026-07-21-cold-start-cache): `chip` = a small "counting the money" pill beside the stale
 * total; `hero` = the animation replaces the total and the last known total drops to a chip.
 */
export const WalletCountingIndicator = z.enum(["chip", "hero"]);
export type WalletCountingIndicator = z.infer<typeof WalletCountingIndicator>;
```

In `CONFIG_KEYS`, after `"home.recentActivityLimit",` add:

```ts
  "wallet.countingIndicator",
```

In `CONFIG_SCHEMAS`, after the `"home.recentActivityLimit"` entry add:

```ts
  "wallet.countingIndicator": WalletCountingIndicator,
```

In `CONFIG_DEFAULTS`, after the `"home.recentActivityLimit"` entry add:

```ts
  // Cold-start indicator layout — the quiet chip is the default (spec 2026-07-21).
  "wallet.countingIndicator": "chip",
```

In `CONFIG_PUBLIC`, after the `"home.recentActivityLimit"` entry add:

```ts
  // The cold-start indicator layout — the signed-in home reads it with its other display knobs.
  "wallet.countingIndicator": true,
```

- [x] **Step 2: Verify**

Run: `pnpm --filter @wanthat/contracts build && pnpm --filter @wanthat/contracts test && pnpm --filter @wanthat/member-catalog test`
Expected: PASS (the public-config router derives everything from these registries).

- [x] **Step 3: Commit**

```bash
git add packages/contracts/src/config/keys.ts
git commit -m "feat(contracts): wallet.countingIndicator public config key (chip|hero)"
```

---

### Task 2: UI — keyframes, counting components, BalanceCard slots

**Files:**
- Modify: `packages/ui/tailwind-preset.js`
- Create: `packages/ui/src/counting.tsx`
- Create: `packages/ui/src/stories/Counting.stories.tsx`
- Modify: `packages/ui/src/index.ts`
- Modify: `packages/ui/src/wallet.tsx` (BalanceCard, lines ~219–313)

**Interfaces:**
- Produces (from `@wanthat/ui`):
  - `type CountingGlyph = "coin" | "machine"`, `pickCountingGlyph(): CountingGlyph`
  - `CountingChip({ glyph, label, tone? }: { glyph: CountingGlyph; label: string; tone?: "onInk" | "onSurface" })` — 26px pill
  - `CountingHero({ glyph, label }: { glyph: CountingGlyph; label: string })` — 46px-tall row
  - `LastCountedChip({ children }: { children: ReactNode })` — holdings-height mint chip
  - `BalanceCard` new optional props: `stale?: boolean` (amount pulses), `amountSlot?: ReactNode` (replaces the amount line), `holdingsSlot?: ReactNode` (replaces the holdings row)

- [x] **Step 1: Add keyframes + animations to the Tailwind preset**

In `packages/ui/tailwind-preset.js`, inside `theme.extend` (sibling of `boxShadow`), add:

```js
      // Cold-start "counting the money" indicator (spec 2026-07-21). Transform/opacity only —
      // these never affect layout, so the card cannot jump while they run.
      keyframes: {
        "pulse-soft": { "0%, 100%": { opacity: "0.55" }, "50%": { opacity: "0.8" } },
        "coin-bounce": {
          "0%, 100%": { transform: "translateY(0)" },
          "35%": { transform: "translateY(-4px) rotate(-10deg)" },
          "60%": { transform: "translateY(1px)" },
        },
        "bill-riffle": {
          "0%": { opacity: "0", transform: "translateY(3px) rotate(0deg)" },
          "15%": { opacity: "1" },
          "55%": { opacity: "1", transform: "translateY(-6px) rotate(14deg)" },
          "100%": { opacity: "0", transform: "translateY(-11px) rotate(26deg)" },
        },
        "led-blink": { "0%, 100%": { opacity: "0.3" }, "50%": { opacity: "1" } },
      },
      animation: {
        "pulse-soft": "pulse-soft 2s ease-in-out infinite",
        "coin-bounce": "coin-bounce 1s ease-in-out infinite",
        "bill-riffle": "bill-riffle 0.55s linear infinite",
        "led-blink": "led-blink 0.55s linear infinite",
      },
```

- [x] **Step 2: Create `packages/ui/src/counting.tsx`**

```tsx
import type { ReactNode } from "react";

/**
 * "Counting the money" — the cold-start indicator for Aurora-backed member data (spec
 * 2026-07-21-cold-start-cache). Shown while the SPA renders CACHED wallet/activity data and
 * silently retries. Two glyphs (picked at random per page view) × two layouts (admin-config
 * `wallet.countingIndicator`): the 26px chip — the same box as the balance card's FX chip —
 * and the hero that fills the card's 46px amount slot. All movement is transform/opacity
 * keyframes (tailwind-preset), so the indicator can never reflow the card.
 */

export type CountingGlyph = "coin" | "machine";

/** One glyph per page view — both are equally cute; variety keeps the wait fresh. */
export const pickCountingGlyph = (): CountingGlyph => (Math.random() < 0.5 ? "coin" : "machine");

// Gold ₪ coin, gently bouncing with a tilt. 18px box; the bounce overflows via transform.
function CoinGlyph() {
  return (
    <span
      aria-hidden
      className="flex h-[18px] w-[18px] flex-none animate-coin-bounce items-center justify-center rounded-full border-2 border-[#a87f1f] text-[10px] font-extrabold leading-none text-[#5c430e] shadow-[0_3px_6px_rgba(0,0,0,0.35)]"
      style={{ background: "radial-gradient(circle at 35% 30%, #ffe9a8, #f2c94c 55%, #c99a2e)" }}
    >
      ₪
    </span>
  );
}

// Tiny teller machine riffling mint bills out of its slot, status LED blinking.
function MachineGlyph() {
  return (
    <span aria-hidden className="relative inline-block h-[18px] w-[22px] flex-none">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="absolute bottom-2 left-[3px] z-[2] h-[7px] w-4 animate-bill-riffle rounded-[2px] border border-[#2e8f66] opacity-0"
          style={{
            background: "linear-gradient(180deg, #9ff0c8, #7fe0b0)",
            animationDelay: `${i * 0.18}s`,
            transformOrigin: "50% 100%",
          }}
        />
      ))}
      <span className="absolute bottom-[7px] left-[2px] right-[2px] z-[3] h-[2px] rounded-[1px] bg-mint-ink" />
      <span className="absolute bottom-0 left-0 right-0 h-[9px] rounded-[3px] bg-[#2e8f66]" />
      <span className="absolute bottom-[2px] right-[2px] z-[4] h-[3px] w-[3px] animate-led-blink rounded-full bg-[#9ff0c8]" />
    </span>
  );
}

const GLYPHS: Record<CountingGlyph, () => ReactNode> = {
  coin: CoinGlyph,
  machine: MachineGlyph,
};

/**
 * The 26px counting pill — EXACTLY the estimated-chip box on the balance card, so swapping
 * counting ↔ FX chip moves nothing. `onInk` (default) sits on the dark card; `onSurface` sits
 * on white section headers (mint on white fails contrast — evergreen palette there).
 */
export function CountingChip({
  glyph,
  label,
  tone = "onInk",
}: {
  glyph: CountingGlyph;
  label: string;
  tone?: "onInk" | "onSurface";
}) {
  const Glyph = GLYPHS[glyph];
  const palette =
    tone === "onInk"
      ? "border-[rgba(127,224,176,0.25)] bg-[rgba(127,224,176,0.14)] text-mint"
      : "border-accent-border bg-accent-soft text-accent";
  return (
    <span
      className={`flex h-[26px] flex-none items-center gap-1.5 rounded-full border ps-2 pe-3 text-[11px] font-bold ${palette}`}
    >
      <Glyph />
      {label}
    </span>
  );
}

/** Center-stage variant: fills the balance card's exact 46px amount slot (layout "hero"). */
export function CountingHero({ glyph, label }: { glyph: CountingGlyph; label: string }) {
  const Glyph = GLYPHS[glyph];
  return (
    <span className="flex h-[46px] items-center gap-3.5">
      <span className="flex h-[38px] w-[42px] flex-none items-center justify-center">
        {/* Scale the 18px glyph up — transform keeps the box (and the card) untouched. */}
        <span style={{ transform: "scale(1.9)" }}>
          <Glyph />
        </span>
      </span>
      <span className="font-display text-[21px] font-bold leading-none text-mint">{label}</span>
    </span>
  );
}

/** Holdings-row chip carrying the last known total while the hero occupies the amount slot. */
export function LastCountedChip({ children }: { children: ReactNode }) {
  return (
    <span className="tabular rounded-full border border-[rgba(127,224,176,0.25)] bg-[rgba(127,224,176,0.14)] px-2.5 py-1 text-[12.5px] font-semibold text-mint">
      {children}
    </span>
  );
}
```

- [x] **Step 3: Export from the package entry**

In `packages/ui/src/index.ts`, after `export * from "./components";` add:

```ts
export * from "./counting";
```

- [x] **Step 4: Extend BalanceCard with the three slots**

In `packages/ui/src/wallet.tsx`:

4a. Extend the props (after `loading = false,` in the destructuring and after `loading?: boolean;` in the type):

```tsx
  /** Cold-start: cached data is showing — the amount breathes at reduced opacity. */
  stale = false,
  /** Cold-start "hero": rendered in the exact 46px amount slot instead of the amount. */
  amountSlot,
  /** Cold-start "hero": rendered in the holdings row instead of the holdings chips. */
  holdingsSlot,
```

```tsx
  stale?: boolean;
  amountSlot?: ReactNode;
  holdingsSlot?: ReactNode;
```

4b. Header row: change `className="mb-3.5 flex items-center justify-between"` to

```tsx
      <div className="mb-3.5 flex min-h-[26px] items-center justify-between">
```

(min-height = chip height, so the row cannot collapse in a state with no chip.)

4c. Amount line — replace the current amount `<div>` with:

```tsx
      {amountSlot ? (
        <div className="mb-3 h-[46px]">{amountSlot}</div>
      ) : (
        <div
          className={`tabular mb-3 font-display text-[46px] font-bold leading-none tracking-[-0.03em]${stale ? " animate-pulse-soft" : ""}`}
          dir="ltr"
        >
          {approx ? <span className="text-2xl font-semibold text-onink-muted">≈</span> : null}
          {amount}
          {fraction ? <span className="text-[28px] text-onink-muted">{fraction}</span> : null}
        </div>
      )}
```

4d. Holdings row — replace the current `{holdings?.length ? (...) : null}` block with:

```tsx
      {holdingsSlot ? (
        <div className="mb-3.5 flex min-h-[26px] flex-wrap items-center gap-1.5">{holdingsSlot}</div>
      ) : holdings?.length ? (
        <div className="mb-3.5 flex flex-wrap items-center gap-1.5" dir="ltr">
          {holdings.map((h) => (
            <span
              key={h}
              className="tabular rounded-full bg-white/10 px-2.5 py-1 text-[12.5px] font-semibold text-onink"
            >
              {h}
            </span>
          ))}
          {holdingsNote ? (
            <span className="text-[11.5px] text-onink-faint">{holdingsNote}</span>
          ) : null}
        </div>
      ) : null}
```

- [x] **Step 5: Storybook story (design-system parity)**

Create `packages/ui/src/stories/Counting.stories.tsx`:

```tsx
import type { Meta, StoryObj } from "@storybook/react";
import { CountingChip, CountingHero, LastCountedChip } from "../counting";
import { BalanceCard } from "../wallet";

const meta: Meta<typeof BalanceCard> = {
  title: "Wallet/Counting",
  component: BalanceCard,
  decorators: [
    (S) => (
      <div className="w-[400px]">
        <S />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof BalanceCard>;

// Cold start, layout "chip": counting pill in the header, stale amount breathing.
export const ChipCoin: Story = {
  args: {
    label: "Available cashback",
    chip: <CountingChip glyph="coin" label="Counting the money…" />,
    stale: true,
    approx: true,
    amount: "₪142",
    fraction: ".50",
    holdings: ["$36.20", "€2.14"],
    cta: "Withdraw cash",
  },
};

// Cold start, layout "hero": the machine takes the amount slot; last total drops to a chip.
export const HeroMachine: Story = {
  args: {
    label: "Available cashback",
    amountSlot: <CountingHero glyph="machine" label="Counting the money…" />,
    holdingsSlot: <LastCountedChip>Last counted: ≈₪142.50</LastCountedChip>,
    cta: "Withdraw cash",
  },
};

// The on-surface chip used on activity section headers (white background).
export const SurfaceChip: Story = {
  render: () => <CountingChip glyph="machine" label="Counting the money…" tone="onSurface" />,
};
```

- [x] **Step 6: Verify**

Run: `pnpm --filter @wanthat/ui build && pnpm --filter @wanthat/ui test && pnpm lint`
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add packages/ui
git commit -m "feat(ui): counting-the-money indicator (chip/hero, coin/machine glyphs) + BalanceCard stale slots"
```

---

### Task 3: Web — stale-cache module (TDD)

**Files:**
- Create: `apps/web/src/lib/stale-cache.ts`
- Test: `apps/web/src/lib/stale-cache.test.ts`

**Interfaces:**
- Produces:
  - `readCache<T>(kind: "wallet" | "activity", sub: string): T | null`
  - `writeCache<T>(kind: "wallet" | "activity", sub: string, data: T): void`
  - `clearAllCaches(): void` — removes every `wanthat.cache.*` key
  - `CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000`

- [x] **Step 1: Write the failing tests**

Create `apps/web/src/lib/stale-cache.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { CACHE_TTL_MS, clearAllCaches, readCache, writeCache } from "./stale-cache";

/** Map-backed localStorage stub with the iteration API clearAllCaches needs. */
function stubStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("stale-cache", () => {
  it("round-trips per user and per kind", () => {
    stubStorage();
    writeCache("wallet", "sub-a", { n: 1 });
    writeCache("wallet", "sub-b", { n: 2 });
    writeCache("activity", "sub-a", [{ id: "x" }]);
    expect(readCache("wallet", "sub-a")).toEqual({ n: 1 });
    expect(readCache("wallet", "sub-b")).toEqual({ n: 2 });
    expect(readCache("activity", "sub-a")).toEqual([{ id: "x" }]);
    expect(readCache("wallet", "sub-c")).toBeNull();
  });

  it("expires entries older than the 7-day TTL", () => {
    stubStorage();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    writeCache("wallet", "s", { n: 1 });
    now.mockReturnValue(1_000_000 + CACHE_TTL_MS - 1);
    expect(readCache("wallet", "s")).toEqual({ n: 1 });
    now.mockReturnValue(1_000_000 + CACHE_TTL_MS + 1);
    expect(readCache("wallet", "s")).toBeNull();
  });

  it("treats a version mismatch and corrupt JSON as a miss", () => {
    const store = stubStorage();
    store.set("wanthat.cache.wallet.s", JSON.stringify({ v: 99, savedAt: Date.now(), data: 1 }));
    expect(readCache("wallet", "s")).toBeNull();
    store.set("wanthat.cache.wallet.s", "{not json");
    expect(readCache("wallet", "s")).toBeNull();
  });

  it("survives a throwing storage (private mode) as miss / silent no-write", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    expect(readCache("wallet", "s")).toBeNull();
    expect(() => writeCache("wallet", "s", { n: 1 })).not.toThrow();
    expect(() => clearAllCaches()).not.toThrow();
  });

  it("clearAllCaches removes only wanthat.cache.* keys", () => {
    const store = stubStorage();
    writeCache("wallet", "s", { n: 1 });
    writeCache("activity", "s", []);
    store.set("wanthat.refreshToken", "keep-me");
    clearAllCaches();
    expect(store.has("wanthat.refreshToken")).toBe(true);
    expect([...store.keys()].filter((k) => k.startsWith("wanthat.cache."))).toEqual([]);
  });
});
```

- [x] **Step 2: Run to verify failure**

Run: `pnpm --filter @wanthat/web test -- stale-cache`
Expected: FAIL — module `./stale-cache` not found.

- [x] **Step 3: Implement `apps/web/src/lib/stale-cache.ts`**

```ts
/**
 * Per-user localStorage cache for Aurora-backed member data (spec 2026-07-21-cold-start-cache):
 * the last wallet response and the first page of the merged activity feed, shown — clearly
 * marked as "counting" — while Aurora cold-resumes. Keys carry the Cognito `sub` (ADR-0020),
 * so a shared device never shows another member's numbers; sign-out clears everything.
 * Storage can be absent or throwing (Safari private mode) — every access degrades to a miss.
 */
const PREFIX = "wanthat.cache.";
const VERSION = 1;

/** Older than this reads as a miss — a week-old balance presented as "counting" would mislead. */
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type CacheKind = "wallet" | "activity";

interface Envelope<T> {
  v: number;
  savedAt: number;
  data: T;
}

export function readCache<T>(kind: CacheKind, sub: string): T | null {
  try {
    const raw = localStorage.getItem(`${PREFIX}${kind}.${sub}`);
    if (!raw) return null;
    const env = JSON.parse(raw) as Envelope<T>;
    if (env.v !== VERSION || typeof env.savedAt !== "number") return null;
    if (Date.now() - env.savedAt > CACHE_TTL_MS) return null;
    return env.data ?? null;
  } catch {
    return null;
  }
}

export function writeCache<T>(kind: CacheKind, sub: string, data: T): void {
  try {
    const env: Envelope<T> = { v: VERSION, savedAt: Date.now(), data };
    localStorage.setItem(`${PREFIX}${kind}.${sub}`, JSON.stringify(env));
  } catch {
    // Storage unavailable — cold starts on this device just show skeletons.
  }
}

/** Remove every cached entry (all kinds, all subs) — called on sign-out. */
export function clearAllCaches(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    // ignore
  }
}
```

- [x] **Step 4: Run to verify pass**

Run: `pnpm --filter @wanthat/web test -- stale-cache`
Expected: PASS (5 tests).

- [x] **Step 5: Commit**

```bash
git add apps/web/src/lib/stale-cache.ts apps/web/src/lib/stale-cache.test.ts
git commit -m "feat(web): per-user localStorage stale-cache (7d TTL, versioned, throw-safe)"
```

---

### Task 4: Web — i18n strings

**Files:**
- Modify: `apps/web/src/i18n.ts` (en `home` block ~line 99, he `home` block ~line 329)

**Interfaces:**
- Produces i18n keys: `home.counting`, `home.lastCounted` (param `amount`); changed copy for `home.estimated`.

- [x] **Step 1: English block**

In the `en` `home:` block, change

```ts
    estimated: "Estimated", // (design)
```

to

```ts
    estimated: "At current FX rates", // 2026-07-21: honest label — the ≈ILS figure moves with rates
```

and after the `pendingNote` line add:

```ts
    counting: "Counting the money…", // cold-start indicator (spec 2026-07-21-cold-start-cache)
    lastCounted: "Last counted: {{amount}}", // hero layout: last known total chip
```

- [x] **Step 2: Hebrew block**

In the `he` `home:` block, change

```ts
    estimated: "משוער",
```

to

```ts
    estimated: "לפי שערי מטבע",
```

and after the `pendingNote` line add:

```ts
    counting: "סופרים את הכסף…",
    lastCounted: "נספר לאחרונה: {{amount}}",
```

- [x] **Step 3: Verify + commit**

Run: `pnpm --filter @wanthat/web typecheck && pnpm --filter @wanthat/web test`
Expected: PASS (`he: typeof en` keeps parity honest).

```bash
git add apps/web/src/i18n.ts
git commit -m "feat(web): counting/last-counted strings; estimated chip reads 'At current FX rates'"
```

---

### Task 5: Web — wallet render selection (TDD) + Home balance card wiring

**Files:**
- Create: `apps/web/src/features/home/walletView.ts`
- Test: `apps/web/src/features/home/walletView.test.ts`
- Modify: `apps/web/src/features/home/HomePage.tsx`

**Interfaces:**
- Consumes: `readCache`/`writeCache` (Task 3), `CountingChip`/`CountingHero`/`LastCountedChip`/`pickCountingGlyph` (Task 2), i18n keys (Task 4), config key (Task 1).
- Produces: `selectWalletRender(q, cached): WalletRender` and type `WalletWire` — reused mentally by Task 6's symmetry but not imported elsewhere.

- [x] **Step 1: Write the failing test**

Create `apps/web/src/features/home/walletView.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { selectWalletRender, type WalletWire } from "./walletView";

const wire: WalletWire = { balances: [], estimated: null };
const cached: WalletWire = { balances: [], estimated: null };

describe("selectWalletRender — the spec's five-row state table", () => {
  it("fresh data wins regardless of cache", () => {
    expect(selectWalletRender({ data: wire, isError: false }, cached)).toEqual({
      kind: "fresh",
      data: wire,
    });
  });
  it("pending + cache → stale", () => {
    expect(selectWalletRender({ data: undefined, isError: false }, cached)).toEqual({
      kind: "stale",
      data: cached,
    });
  });
  it("pending + no cache → skeleton", () => {
    expect(selectWalletRender({ data: undefined, isError: false }, null)).toEqual({
      kind: "skeleton",
    });
  });
  it("error + cache → stale (silent retry keeps running)", () => {
    expect(selectWalletRender({ data: undefined, isError: true }, cached)).toEqual({
      kind: "stale",
      data: cached,
    });
  });
  it("error + no cache → error card", () => {
    expect(selectWalletRender({ data: undefined, isError: true }, null)).toEqual({
      kind: "error",
    });
  });
});
```

- [x] **Step 2: Run to verify failure**

Run: `pnpm --filter @wanthat/web test -- walletView`
Expected: FAIL — module not found.

- [x] **Step 3: Implement `apps/web/src/features/home/walletView.ts`**

```ts
import type { WalletBalanceWire, WalletEstimateWire } from "../../lib/api";

/** The GET /wallet response shape — also what the stale-cache stores for kind "wallet". */
export interface WalletWire {
  balances: WalletBalanceWire[];
  estimated: WalletEstimateWire | null;
}

export type WalletRender =
  | { kind: "fresh"; data: WalletWire }
  | { kind: "stale"; data: WalletWire }
  | { kind: "skeleton" }
  | { kind: "error" };

/**
 * The balance card's state table (spec 2026-07-21-cold-start-cache): fresh data always wins;
 * a cache hit covers BOTH pending and error (the query keeps retrying silently underneath);
 * without a cache the card behaves exactly as before this feature.
 */
export function selectWalletRender(
  q: { data: WalletWire | undefined; isError: boolean },
  cached: WalletWire | null,
): WalletRender {
  if (q.data) return { kind: "fresh", data: q.data };
  if (cached) return { kind: "stale", data: cached };
  return q.isError ? { kind: "error" } : { kind: "skeleton" };
}
```

- [x] **Step 4: Run to verify pass**

Run: `pnpm --filter @wanthat/web test -- walletView`
Expected: PASS (5 tests).

- [x] **Step 5: Wire HomePage**

In `apps/web/src/features/home/HomePage.tsx`:

5a. Imports — extend the `@wanthat/ui` import with `CountingChip, CountingHero, LastCountedChip, pickCountingGlyph`; add:

```tsx
import { useEffect, useMemo, useState } from "react";
import { readCache, writeCache } from "../../lib/stale-cache";
import { selectWalletRender, type WalletWire } from "./walletView";
```

(`useState` is already imported — merge, don't duplicate.)

5b. Inside `HomePage()`, after `const token = accessToken();` add the glyph + cache read, and replace the wallet query:

```tsx
  // One glyph per page view — coin or bill machine, both from the approved mockup.
  const [glyph] = useState(pickCountingGlyph);
  const sub = profile?.sub ?? null;
  const cachedWallet = useMemo(() => (sub ? readCache<WalletWire>("wallet", sub) : null), [sub]);
  const wallet = useQuery({
    queryKey: ["wallet", profile?.sub],
    queryFn: () => walletApi.get(token as string),
    enabled: !!token && !!profile,
    // Aurora cold start: the first call can die at API Gateway's 30s while the DB resumes.
    // With a cached balance on screen we retry for as long as the page is open (capped
    // backoff); without one, a few tries and then the retry card as before.
    retry: (failureCount) => (cachedWallet ? true : failureCount < 3),
    retryDelay: (attempt) => Math.min(30_000, 1_000 * 2 ** attempt),
  });
  useEffect(() => {
    if (wallet.data && sub) writeCache("wallet", sub, wallet.data);
  }, [wallet.data, sub]);
```

5c. Batch the new config key into the existing public-config query (replace the `stripLimit` query and add the layout parse):

```tsx
  // Both display knobs ride ONE public-config call (the endpoint batches up to 20 keys).
  const displayConfig = useQuery({
    queryKey: ["config", "home"],
    queryFn: () => configApi.getPublic(["home.recentActivityLimit", "wallet.countingIndicator"]),
  });
  const rawLimit = displayConfig.data?.values["home.recentActivityLimit"];
  // Junk or a failed read falls back to the quiet chip — never a broken hero.
  const countingLayout =
    displayConfig.data?.values["wallet.countingIndicator"] === "hero" ? "hero" : "chip";
```

Update the `activity` feed's `enabled` to use `!displayConfig.isPending` (was `!stripLimit.isPending`).

5d. Replace the derived render values (current lines ~95–104) with:

```tsx
  const view = selectWalletRender(wallet, cachedWallet);
  const stale = view.kind === "stale";
  const shown = view.kind === "fresh" || view.kind === "stale" ? view.data : null;
  const est = shown?.estimated ?? null;
  const [amount, fraction] = est ? splitMoneyMinor(est.available.amountMinor, "ILS") : ["", ""];
  const holdings = (shown?.balances ?? []).map((b) =>
    formatMoneyMinor(b.available.amountMinor, b.available.currency),
  );
  const heroStale = stale && countingLayout === "hero";
  // Computed inline (not a boolean flag) so TS keeps the `est` narrowing at the usage site.
  const pendingNote =
    est && BigInt(est.pending.amountMinor) > 0n
      ? t("home.pendingNote", { amount: formatMoneyMinor(est.pending.amountMinor, "ILS") })
      : undefined;
```

5e. Replace the `wallet.isError ? (...) : (<BalanceCard ... />)` block with:

```tsx
        {view.kind === "error" ? (
          <div className="flex flex-col items-center gap-3 rounded-card bg-surface p-6">
            <p className="text-sm text-muted">{t("home.loadFailed")}</p>
            <Button variant="ghost" onClick={() => void wallet.refetch()}>
              {t("home.retry")}
            </Button>
          </div>
        ) : (
          <BalanceCard
            loading={view.kind === "skeleton"}
            stale={stale}
            label={t("home.availableCashback")}
            chip={
              stale && countingLayout === "chip" ? (
                <CountingChip glyph={glyph} label={t("home.counting")} />
              ) : est && !heroStale ? (
                <span className="rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-bold text-onink">
                  {t("home.estimated")}
                </span>
              ) : undefined
            }
            approx={est !== null && !heroStale}
            amount={est && !heroStale ? amount : undefined}
            fraction={est && !heroStale ? fraction : undefined}
            amountSlot={heroStale ? <CountingHero glyph={glyph} label={t("home.counting")} /> : undefined}
            holdingsSlot={
              heroStale && est ? (
                <LastCountedChip>
                  {t("home.lastCounted", {
                    amount: `≈${formatMoneyMinor(est.available.amountMinor, "ILS")}`,
                  })}
                </LastCountedChip>
              ) : undefined
            }
            holdings={!heroStale && holdings.length ? holdings : undefined}
            holdingsNote={!heroStale && holdings.length ? t("home.heldNote") : undefined}
            pendingNote={heroStale ? undefined : pendingNote}
            cta={t("home.withdrawCash")}
            ctaDisabled
          />
        )}
```

- [x] **Step 6: Verify**

Run: `pnpm --filter @wanthat/web typecheck && pnpm --filter @wanthat/web test && pnpm lint`
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add apps/web/src/features/home
git commit -m "feat(web): balance card shows cached wallet during cold start with counting indicator"
```

---

### Task 6: Web — activity feed cache + section-header chips

**Files:**
- Modify: `apps/web/src/features/activity/useActivityFeed.ts`
- Modify: `apps/web/src/features/activity/ActivityPage.tsx`
- Modify: `apps/web/src/features/home/HomePage.tsx` (strip header + hook args)

**Interfaces:**
- Consumes: `readCache`/`writeCache` (Task 3), `CountingChip` (Task 2).
- Produces: `useActivityFeed({ token, sub, pageSize, enabled })` now returns `{ items, stale, failed, busy, hasMore, loadMore }` — `stale: boolean` added, `sub: string | null` added to the args.

- [x] **Step 1: Rework `useActivityFeed`**

Replace the body of `apps/web/src/features/activity/useActivityFeed.ts` with:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { type ActivityItemWire, linksApi, walletApi } from "../../lib/api";
import { readCache, writeCache } from "../../lib/stale-cache";
import {
  type FeedState,
  fillPage,
  hasMoreItems,
  newFeedState,
  recToFeedItem,
  walletToFeedItem,
} from "./feed";

/**
 * React state around the pure client-side activity merge (`./feed`): the member's wallet ledger
 * + recommendations composed into one newest-first stream, one `pageSize` page per `loadMore`.
 * The FIRST page is persisted per user (lib/stale-cache) and replayed as `stale` items on the
 * next mount, so an Aurora cold start shows the last known feed under a "counting" chip instead
 * of skeletons (spec 2026-07-21-cold-start-cache); the real first page replaces it wholesale.
 * While stale items are showing, a failed fetch retries silently with capped backoff — `failed`
 * only ever fires with nothing cached. Pagination state stays in-memory; a refresh restarts it.
 */
export function useActivityFeed({
  token,
  sub,
  pageSize,
  enabled,
}: {
  token: string | null;
  /** Cognito sub — the cache key; null (pre-session) disables the cache. */
  sub: string | null;
  pageSize: number;
  enabled: boolean;
}): {
  /** null until cache or first page lands (render skeletons); then the items so far. */
  items: ActivityItemWire[] | null;
  /** True while `items` is the replayed cache — hide pagination, show the counting chip. */
  stale: boolean;
  failed: boolean;
  busy: boolean;
  hasMore: boolean;
  loadMore: () => void;
} {
  const [items, setItems] = useState<ActivityItemWire[] | null>(null);
  const [stale, setStale] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const stateRef = useRef<FeedState>(newFeedState());
  const busyRef = useRef(false); // re-entrancy guard ahead of the async setState
  const startedRef = useRef(false);
  const firstPageDoneRef = useRef(false);
  const staleRef = useRef(false); // mirrors `stale` for the async catch below
  const retryAttemptRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const loadMore = useCallback(() => {
    if (!token || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFailed(false);
    void (async () => {
      try {
        const result = await fillPage(
          stateRef.current,
          {
            wallet: (cursor, limit) =>
              walletApi.entries(token, { limit, cursor }).then((page) => ({
                items: page.items.map(walletToFeedItem),
                nextCursor: page.nextCursor,
              })),
            recs: (cursor, limit) =>
              linksApi.list(token, { limit, cursor }).then((page) => ({
                items: page.items.map(recToFeedItem),
                nextCursor: page.nextCursor,
              })),
          },
          pageSize,
        );
        stateRef.current = result.state;
        retryAttemptRef.current = 0;
        const firstPage = !firstPageDoneRef.current;
        firstPageDoneRef.current = true;
        staleRef.current = false;
        setStale(false);
        // The first fresh page REPLACES whatever is showing (the replayed cache); later
        // pages append as before.
        setItems((prev) => (firstPage ? result.items : [...(prev ?? []), ...result.items]));
        setHasMore(hasMoreItems(result.state));
        if (firstPage && sub) writeCache("activity", sub, result.items);
      } catch {
        if (staleRef.current) {
          // Cold start with cached rows on screen — retry silently, capped backoff (spec).
          retryAttemptRef.current += 1;
          retryTimerRef.current = setTimeout(
            loadMore,
            Math.min(30_000, 1_000 * 2 ** retryAttemptRef.current),
          );
        } else {
          setFailed(true);
        }
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    })();
  }, [token, sub, pageSize]);

  // First page: once, as soon as the caller enables the feed. Replay the cached page first —
  // it renders instantly while the real fetch races Aurora's resume.
  useEffect(() => {
    if (!enabled || startedRef.current) return;
    startedRef.current = true;
    if (sub) {
      const cached = readCache<ActivityItemWire[]>("activity", sub);
      if (cached && cached.length > 0) {
        staleRef.current = true;
        setStale(true);
        setItems(cached);
      }
    }
    loadMore();
  }, [enabled, sub, loadMore]);

  // A pending silent retry must not fire into an unmounted page.
  useEffect(() => () => clearTimeout(retryTimerRef.current), []);

  return { items, stale, failed, busy, hasMore, loadMore };
}
```

- [x] **Step 2: ActivityPage — pass `sub`, chip in the header, no pagination while stale**

In `apps/web/src/features/activity/ActivityPage.tsx`:

2a. Import `CountingChip, pickCountingGlyph` from `@wanthat/ui` (extend the existing import) and `useState` from react.

2b. Hook call + glyph:

```tsx
  const [glyph] = useState(pickCountingGlyph);
  const { items, stale, failed, busy, hasMore, loadMore } = useActivityFeed({
    token,
    sub: profile?.sub ?? null,
    pageSize: PAGE_SIZE,
    enabled: !!token && !!profile,
  });
```

2c. Section header — replace the `<h1>` line with a row that carries the chip while stale:

```tsx
          <div className="mb-1 flex min-h-[26px] items-center justify-between">
            <h1 className="text-[15px] font-bold text-ink">{t("memberActivity.title")}</h1>
            {stale ? (
              <CountingChip glyph={glyph} label={t("home.counting")} tone="onSurface" />
            ) : null}
          </div>
```

(The old `<h1 className="mb-1 …">` margin moves to the wrapper.)

2d. Load-more gate — change `{hasMore ? (` to `{hasMore && !stale ? (`.

- [x] **Step 3: HomePage strip — pass `sub`, chip on the strip header**

In `apps/web/src/features/home/HomePage.tsx`:

3a. Add `sub` to the feed call:

```tsx
  const activity = useActivityFeed({
    token,
    sub,
    pageSize: typeof rawLimit === "number" ? rawLimit : 10,
    enabled: !!token && !!profile && !displayConfig.isPending,
  });
```

3b. In the recent-activity section header (the `mb-1 flex items-center justify-between` div), before the "see all" button add:

```tsx
            {activity.stale ? (
              <CountingChip glyph={glyph} label={t("home.counting")} tone="onSurface" />
            ) : null}
```

and add `min-h-[26px]` to that header div's className.

- [x] **Step 4: Verify**

Run: `pnpm --filter @wanthat/web typecheck && pnpm --filter @wanthat/web test && pnpm lint`
Expected: PASS (feed.test.ts untouched — the pure merge is unchanged).

- [x] **Step 5: Commit**

```bash
git add apps/web/src/features/activity apps/web/src/features/home
git commit -m "feat(web): activity feed replays cached first page during cold start, counting chip on headers"
```

---

### Task 7: Web — sign-out clears the cache (TDD)

**Files:**
- Modify: `apps/web/src/user/store.ts` (`clearSession`, line ~121)
- Test: `apps/web/src/user/store.test.ts` (append one test)

**Interfaces:**
- Consumes: `clearAllCaches` (Task 3).

- [x] **Step 1: Write the failing test**

In `apps/web/src/user/store.test.ts`, append (mirror the file's existing localStorage stub helper — reuse it if one exists):

```ts
it("clearSession also drops the stale-cache entries (wallet/activity stay private)", () => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  });
  store.set("wanthat.cache.wallet.sub-1", "{}");
  store.set("wanthat.cache.activity.sub-1", "[]");
  store.set("wanthat.phone", "+972500000000");
  clearSession();
  expect([...store.keys()].filter((k) => k.startsWith("wanthat.cache."))).toEqual([]);
  expect(store.get("wanthat.phone")).toBe("+972500000000"); // remembered phone survives
  vi.unstubAllGlobals();
});
```

(Import `clearSession` if the test file doesn't already; check its existing imports/stub pattern first and follow them.)

- [x] **Step 2: Run to verify failure**

Run: `pnpm --filter @wanthat/web test -- store`
Expected: FAIL — cache keys still present.

- [x] **Step 3: Implement**

In `apps/web/src/user/store.ts`, add the import and extend `clearSession`:

```ts
import { clearAllCaches } from "../lib/stale-cache";
```

```ts
export function clearSession(): void {
  storageRemove(REFRESH_KEY);
  // Cached wallet/activity snapshots are per-sub but still this member's money on a shared
  // device — sign-out forgets them (the remembered phone deliberately survives, see above).
  clearAllCaches();
  setState({ status: "signedOut", tokens: null, profile: null });
}
```

- [x] **Step 4: Run to verify pass**

Run: `pnpm --filter @wanthat/web test -- store`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add apps/web/src/user/store.ts apps/web/src/user/store.test.ts
git commit -m "feat(web): sign-out clears cached wallet/activity snapshots"
```

---

### Task 8: Admin — `wallet.countingIndicator` editor field

**Files:**
- Modify: `apps/admin/src/features/AdminPage.tsx` (Control type ~line 577, FIELDS ~line 592, FieldControl ~line 1166)
- Modify: `apps/admin/src/i18n.ts` (en ~line 209 + keys block ~line 245; he twins)

**Interfaces:**
- Consumes: the key from Task 1 (`/admin/config` lists every `CONFIG_KEYS` entry automatically — only the curated `FIELDS` gate + labels are needed).

- [x] **Step 1: Control type + FIELDS entry**

Change line ~577 to:

```ts
type Control = "percent" | "number" | "fxProvider" | "switch" | "otpChannel" | "text" | "countingIndicator";
```

In `FIELDS`, after the two `site.notice*` entries add:

```ts
  // Member-app presentation: how the wallet shows cached data while Aurora cold-resumes.
  { key: "wallet.countingIndicator", section: "site", control: "countingIndicator" },
```

- [x] **Step 2: FieldControl branch**

In `FieldControl`, after the `otpChannel` branch add:

```tsx
  if (field.control === "countingIndicator") {
    return (
      <div className="flex sm:justify-end">
        <Segmented
          value={String(value)}
          onChange={onChange}
          options={[
            { value: "chip", label: t("admin.countingIndicator.chip") },
            { value: "hero", label: t("admin.countingIndicator.hero") },
          ]}
        />
      </div>
    );
  }
```

- [x] **Step 3: i18n labels (en + he — `he` is `typeof en`, both required)**

In `apps/admin/src/i18n.ts` `en.admin`, after the `otpChannel` line add:

```ts
    countingIndicator: { chip: "Corner chip", hero: "Full takeover" },
```

In `en.admin.keys`, after the `site_noticeHe` entry add:

```ts
      wallet_countingIndicator: {
        title: "Wallet cold-start indicator",
        desc: "How the member wallet shows the cached balance while the database wakes up: a small counting chip beside the total, or the animation replacing it.",
      },
```

In `he.admin` (same relative positions):

```ts
    countingIndicator: { chip: "תג פינתי", hero: "החלפת הסכום" },
```

```ts
      wallet_countingIndicator: {
        title: "מחוון ארנק בהתעוררות",
        desc: "איך ארנק החבר מציג את היתרה השמורה בזמן שמסד הנתונים מתעורר: תג ספירה קטן ליד הסכום, או אנימציה שמחליפה אותו.",
      },
```

- [x] **Step 4: Verify + commit**

Run: `pnpm --filter @wanthat/admin typecheck && pnpm --filter @wanthat/admin test && pnpm lint`
Expected: PASS.

```bash
git add apps/admin/src/features/AdminPage.tsx apps/admin/src/i18n.ts
git commit -m "feat(admin): wallet.countingIndicator segmented editor (chip / hero)"
```

---

### Task 9: Full verification, PR, merge, dev deploy

- [x] **Step 1: Full gates**

Run from the repo root:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Expected: all PASS. (No infra change in this feature — `pnpm synth` optional sanity only.)

- [x] **Step 2: Push + PR (ready, not draft)**

```bash
git push -u origin cold-start-cache
gh pr create --title "feat: cold-start cache — last wallet + activity with counting-the-money indicator" --body "…spec + summary…"
```

PR body summarizes the spec, links `docs/superpowers/specs/2026-07-21-cold-start-cache-design.md`, and ends with the standard generated-with footer.

- [x] **Step 3: Wait for CI + Check Deploy**

Watch `gh pr checks` — CI (lint/typecheck/test/build) and Check Deploy (dry run) must both be green. A red Check Deploy is blocking (memory: infra-must-declare-bundled-workspace-deps — not expected here, no new workspace package).

- [x] **Step 4: Merge → dev deploys**

Merge the PR (squash per repo habit), then watch the Deploy workflow on `main` until the dev deploy succeeds.

- [x] **Step 5: Smoke-check dev**

Open the dev member app: confirm the FX chip copy changed; with DevTools → Application, verify `wanthat.cache.wallet.<sub>` and `wanthat.cache.activity.<sub>` appear after the home screen loads; reload and confirm the cached balance renders instantly (counting chip flashes until the fetch lands). Flip `wallet.countingIndicator` to `hero` in the dev admin console and reload the member home to see the takeover layout.
