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
