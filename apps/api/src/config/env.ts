import crypto from "node:crypto";
import { z } from "zod";

const LEGACY_INSECURE_SECRET = "supermarket-os-dev-secret-2026";
const EPHEMERAL_DEV_SECRET = crypto.randomBytes(32).toString("hex");

const EnvSchema = z.object({
  NODE_ENV: z.string().trim().default("development"),
  HOST: z.string().trim().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  DATABASE_URL: z.string().trim().optional(),
  DATABASE_URL_TEST: z.string().trim().optional(),
  AUTH_SECRET: z.string().trim().optional(),
  AUTH_SECRET_PREVIOUS: z.string().trim().optional(),
  CORS_ORIGINS: z
    .string()
    .trim()
    .default("http://localhost:5173,http://127.0.0.1:5173"),
  TRUST_PROXY: z.string().trim().optional(),
  COOKIE_SECURE: z.string().trim().optional(),
  METRICS_TOKEN: z.string().trim().optional(),
  GEMINI_API_KEY: z.string().trim().optional(),
  GEMINI_STORE_INTERACTIONS: z.string().trim().optional(),
  ANALYTICS_WORKER_URL: z.string().trim().optional(),
  ENABLE_OPENAPI_DOCS: z.string().trim().optional(),
  PG_POOL_MAX: z.coerce.number().int().min(2).max(100).default(20),
  PG_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),
});

const rawEnv = EnvSchema.parse(process.env);
const nodeEnv = rawEnv.NODE_ENV;
const isProduction = nodeEnv === "production";
const isTest = Boolean(process.env.VITEST || nodeEnv === "test");
const isDevelopment = nodeEnv === "development";
const strictSecretRequired = !isDevelopment && !isTest;

const configuredSecret = rawEnv.AUTH_SECRET || undefined;
if (strictSecretRequired) {
  if (
    !configuredSecret ||
    configuredSecret.length < 32 ||
    configuredSecret === LEGACY_INSECURE_SECRET
  ) {
    throw new Error(
      `FATAL: AUTH_SECRET must be set to a unique random string (>= 32 chars) when NODE_ENV="${nodeEnv}".`
    );
  }
} else if (!configuredSecret && !isTest) {
  console.warn(
    "[config] AUTH_SECRET is not set; using ephemeral per-process development secret (sessions reset on restart)."
  );
}

type TrustProxyOption = boolean | string | ((address: string, hop: number) => boolean);

function parseTrustProxy(val: string | undefined, prod: boolean): TrustProxyOption {
  if (!val) return prod ? "loopback, linklocal, uniquelocal" : true;
  const lower = val.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  if (/^\d+$/.test(lower)) {
    const maxHops = Number(lower);
    return (_address: string, hop: number) => hop < maxHops;
  }
  return val;
}

export const env = {
  nodeEnv,
  isProduction,
  isTest,
  isDevelopment,
  host: rawEnv.HOST,
  port: rawEnv.PORT,
  logLevel: rawEnv.LOG_LEVEL,
  databaseUrl:
    (isTest && rawEnv.DATABASE_URL_TEST) ||
    rawEnv.DATABASE_URL ||
    "postgres://supermarket:supermarket_dev_password@localhost:5433/supermarket_os",
  authSecret: configuredSecret || EPHEMERAL_DEV_SECRET,
  authSecretPrevious: rawEnv.AUTH_SECRET_PREVIOUS || null,
  corsOrigins: rawEnv.CORS_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  trustProxy: parseTrustProxy(rawEnv.TRUST_PROXY, isProduction),
  cookieSecure: rawEnv.COOKIE_SECURE === "true" || isProduction,
  metricsToken: rawEnv.METRICS_TOKEN || null,
  geminiApiKey: rawEnv.GEMINI_API_KEY || null,
  geminiStoreInteractions: rawEnv.GEMINI_STORE_INTERACTIONS === "true",
  analyticsWorkerUrl: rawEnv.ANALYTICS_WORKER_URL || null,
  enableOpenApiDocs: rawEnv.ENABLE_OPENAPI_DOCS !== "false",
  pgPoolMax: rawEnv.PG_POOL_MAX,
  pgStatementTimeoutMs: rawEnv.PG_STATEMENT_TIMEOUT_MS,
};

export function hashTokenId(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
