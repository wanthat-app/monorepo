/** @type {import('tailwindcss').Config} */
// Design tokens live in the @wanthat/ui preset (packages/ui/tailwind-preset.js) — the design
// system's single source of truth. This config contributes only the landing app's content globs;
// packages/ui/src is scanned too so the DS components' classes are generated.
import preset from "@wanthat/ui/tailwind-preset";

export default {
  presets: [preset],
  content: ["./landing.html", "./src/**/*.{ts,tsx}", "../../packages/ui/src/**/*.{ts,tsx}"],
};
