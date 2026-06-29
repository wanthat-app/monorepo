/** @type {import('tailwindcss').Config} */
// Design tokens from the Wanthat Design System (evergreen palette, Space Grotesk display + Heebo/
// Hanken body). Money is always rendered LTR with tabular numerals (see the .tabular utility).
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        base: "#f4f6f5",
        surface: "#ffffff",
        line: "#e6ebe8",
        ink: "#15201c",
        muted: "#6b7b73",
        subtle: "#8a968f",
        accent: { DEFAULT: "#1f7a57", soft: "#e7f1ec" },
        mint: "#7fe0b0",
        pending: "#b07a1e",
        rejected: "#b0473a",
      },
      fontFamily: {
        display: ['"Space Grotesk"', '"Heebo"', "system-ui", "sans-serif"],
        body: ['"Hanken Grotesk"', '"Heebo"', "system-ui", "sans-serif"],
      },
      borderRadius: {
        input: "12px",
        button: "15px",
        card: "20px",
      },
      boxShadow: {
        card: "0 1px 2px rgba(21, 32, 28, 0.04), 0 8px 24px rgba(21, 32, 28, 0.06)",
      },
    },
  },
  plugins: [],
};
