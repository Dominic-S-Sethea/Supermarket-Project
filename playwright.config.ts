import fs from "node:fs";
import { defineConfig } from "@playwright/test";

const systemChrome = "/usr/bin/google-chrome";
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
  (fs.existsSync(systemChrome) ? systemChrome : undefined);

const e2eNodeEnv = process.env.E2E_NODE_ENV ?? "production";
const e2eAuthSecret =
  process.env.AUTH_SECRET || "e2e-test-auth-secret-minimum-thirty-two-characters-long";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: {
    timeout: 12_000,
  },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "on-first-retry",
    headless: true,
    launchOptions: executablePath ? { executablePath } : undefined,
  },
  webServer: [
    {
      command: "node apps/api/dist/server.js",
      url: "http://127.0.0.1:4000/api/health",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: {
        ...process.env,
        NODE_ENV: e2eNodeEnv,
        AUTH_SECRET: e2eAuthSecret,
        COOKIE_SECURE: process.env.E2E_COOKIE_SECURE ?? "false",
        PORT: "4000",
        HOST: "127.0.0.1",
        CORS_ORIGINS: "http://localhost:5173,http://127.0.0.1:5173",
      },
    },
    {
      command: "pnpm --filter @supermarket/web preview --host 127.0.0.1 --port 5173",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
