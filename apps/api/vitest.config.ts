import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    testTimeout: 30_000,
    env: {
      GEMINI_API_KEY: "",
      PAYMENT_WEBHOOK_SECRET: "vitest-payment-webhook-secret-32chars",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**", "src/db/seed.ts", "src/db/applyConstraints.ts", "src/server.ts"],
    },
  },
});
