/// <reference types="vitest/config" />
import * as path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The LEAN guest landing app for the viral `/p/*` page — served by the landing Lambda, which
// fetches this build's `landing.html` shell and injects OG tags + the snapshot (ADR-0007).
// It shares the member site's bucket + origin, so the build shape is load-bearing:
// - the entry html is `landing.html`, NEVER index.html (that name belongs to the member SPA);
// - assets live under `landing-assets/` so no file can ever collide with the member `assets/`.
// Dev port 5175 coexists with web's 5173 and admin's 5174.
export default defineConfig({
  plugins: [react()],
  server: { port: 5175 },
  preview: { port: 5175 },
  build: {
    outDir: "dist",
    sourcemap: true,
    assetsDir: "landing-assets",
    rollupOptions: { input: path.resolve(import.meta.dirname, "landing.html") },
  },
  test: { environment: "node", passWithNoTests: true },
});
