/** @type {import('tailwindcss').Config} */
// Design tokens from the Wanthat Design System (evergreen palette, Space Grotesk display + Heebo/
// Hanken body). Money is always rendered LTR with tabular numerals (see the .tabular utility in
// each app's index.css). Values come verbatim from design/design_handoff_wanthat_app (README
// "Design Tokens" + the Design System .dc.html) — that handoff is the design source of truth.
// Consumed as a Tailwind preset by every app that renders @wanthat/ui components; each app's own
// tailwind.config.js contributes only its content globs (which must include packages/ui/src).
export default {
  theme: {
    extend: {
      colors: {
        base: "#f4f6f5",
        page: "#e9edeb",
        surface: "#ffffff",
        line: "#e6ebe8",
        edge: "#e0e6e3",
        divider: "#e2e7e4",
        hairrow: "#eef2f0",
        ink: "#15201c",
        muted: "#6b7b73",
        secondary: "#5c6b64",
        subtle: "#8a968f",
        placeholder: "#a6b2ac",
        accent: { DEFAULT: "#1f7a57", soft: "#e7f1ec", border: "#d2e3d9", deep: "#3f6b57" },
        mint: { DEFAULT: "#7fe0b0", ink: "#0e1a14" },
        pending: { DEFAULT: "#b07a1e", soft: "#faf3e6" },
        rejected: { DEFAULT: "#b0473a", soft: "#f7ecea" },
        // On-ink (dark surface) text scale — balance card, sidebar, invite card.
        onink: { DEFAULT: "#eaf2ee", muted: "#9db6ab", soft: "#b9ccc3", faint: "#7e978b" },
        // Admin dark sidebar surfaces.
        inkborder: "#1e2c26",
        inkhair: "#243530",
        inkcard: "#1b2924",
        inkmuted: "#7e9389",
        inknav: "#b6c7bf",
        // Status-bar swatches (admin stacked bar).
        barpending: "#d9a23e",
        barrejected: "#c16a5c",
        // Payout-method logo tile accents (generic glyphs before details are saved).
        bank: { DEFAULT: "#2f5bd9", soft: "#eaf1fb" },
        cardpay: { DEFAULT: "#6b4fd0", soft: "#f0ecfb" },
        bit: { DEFAULT: "#00b3a4", soft: "#e2f6f3" },
        paybox: { DEFAULT: "#e07a3a", soft: "#fbeee6" },
      },
      fontFamily: {
        display: ['"Space Grotesk"', '"Heebo"', "system-ui", "sans-serif"],
        body: ['"Hanken Grotesk"', '"Heebo"', "system-ui", "sans-serif"],
      },
      borderRadius: {
        input: "12px",
        field: "14px",
        button: "15px",
        chip: "16px",
        card: "20px",
        feature: "24px",
        tile: "11px",
        thumb: "13px",
      },
      boxShadow: {
        card: "0 1px 2px rgba(0, 0, 0, 0.04), 0 18px 36px -22px rgba(20, 40, 30, 0.4)",
        segment: "0 1px 2px rgba(0, 0, 0, 0.08)",
        fab: "0 8px 18px -6px rgba(31, 122, 87, 0.6)",
      },
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
    },
  },
  plugins: [],
};
