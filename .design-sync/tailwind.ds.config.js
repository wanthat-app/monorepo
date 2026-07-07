// Tailwind config for the design-sync CSS build: the app's real config, with the
// content scan widened to include the authored DS previews so their utility
// classes exist in the shipped stylesheet. Run from apps/web (pnpm --filter
// @wanthat/web exec), so content paths are relative to apps/web.
import base from "../apps/web/tailwind.config.js";

export default {
  ...base,
  content: ["./index.html", "./src/**/*.{ts,tsx}", "../../.design-sync/previews/**/*.tsx"],
};
