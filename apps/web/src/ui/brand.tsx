import markUrl from "./assets/wanthat-mark.png";

/**
 * Brand lockups (Wanthat Design System). The mark is the real brand asset from the design
 * handoff (design/design_handoff_wanthat_app/designs/assets) — never a synthesized glyph.
 * The wordmark is always lowercase "wanthat" in Space Grotesk 700, ink, -0.03em tracking.
 */

// The brand mark image alone (nav bars, sidebar, compact headers).
export function BrandMark({ height = 30 }: { height?: number }) {
  return <img src={markUrl} alt="wanthat" style={{ height, width: "auto" }} />;
}

type LogoSize = "sm" | "md" | "lg";
// Mark heights and wordmark sizes from the mock: top nav 22–24px, app headers 26–30px.
const LOGO_SIZES: Record<LogoSize, { mark: number; text: string }> = {
  sm: { mark: 22, text: "text-[17px]" },
  md: { mark: 26, text: "text-[20px]" },
  lg: { mark: 30, text: "text-[22px]" },
};

// Mark + lowercase wordmark, with an optional small caption line (e.g. "Operations").
export function Logo({ size = "lg", caption }: { size?: LogoSize; caption?: string }) {
  const s = LOGO_SIZES[size];
  return (
    <span className="inline-flex items-center gap-2.5">
      <BrandMark height={s.mark} />
      <span className="flex flex-col">
        <span className={`font-display font-bold leading-none tracking-[-0.03em] text-ink ${s.text}`}>
          wanthat
        </span>
        {caption ? (
          <span className="mt-0.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
            {caption}
          </span>
        ) : null}
      </span>
    </span>
  );
}
