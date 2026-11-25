import crypto from "node:crypto";

const DEV_FALLBACK_SECRET = "supermarket-os-dev-secret-2026";
const nodeEnv = process.env.NODE_ENV ?? "development";
const isProduction = nodeEnv === "production";
const isTest = Boolean(process.env.VITEST || nodeEnv === "test");

const configuredSecret = process.env.AUTH_SECRET?.trim();
if (isProduction) {
  if (!configuredSecret || configuredSecret.length < 32 || configuredSecret === DEV_FALLBACK_SECRET) {
    throw new Error(
      "FATAL: AUTH_SECRET must be set to a unique random string (>= 32 chars) in production."
    );
  }
} else if (!configuredSecret && !isTest) {
  console.warn("[config] AUTH_SECRET is not set; using development fallback secret.");
}

export const env = {
  nodeEnv,
  isProduction,
  isTest,
  host: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 4000),
  logLevel: process.env.LOG_LEVEL ?? "info",
  databaseUrl:
    (isTest && process.env.DATABASE_URL_TEST) ||
    process.env.DATABASE_URL ||
    "postgres://supermarket:supermarket_dev_password@localhost:5433/supermarket_os",
  authSecret: configuredSecret || DEV_FALLBACK_SECRET,
  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  geminiApiKey: process.env.GEMINI_API_KEY?.trim() || null,
};

export function hashTokenId(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
