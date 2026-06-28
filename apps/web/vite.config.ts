/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Static SPA → S3/CloudFront EdgeStack (ADR-0016).
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", sourcemap: true },
  test: { environment: "node", passWithNoTests: true },
});
