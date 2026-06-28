import { defineConfig } from "vitest/config";

// Shared Vitest defaults. Individual packages run `vitest run`; integration
// suites (e.g. packages/db with Testcontainers) override timeouts locally.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
  },
});
