import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Live PostgreSQL integration & security suites share seeded demo users; run files sequentially.
    fileParallelism: false,
  },
});
