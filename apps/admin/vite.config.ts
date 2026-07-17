/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Static SPA → S3/CloudFront EdgeStack (ADR-0016), served on its OWN origin (admin.{domain}) so
// employee-pool tokens are storage-isolated from the member app. Dev port 5174 coexists with web's 5173.
export default defineConfig({
  plugins: [react()],
  server: { port: 5174 },
  preview: { port: 5174 },
  build: { outDir: "dist", sourcemap: true },
  test: { environment: "node", passWithNoTests: true },
});
