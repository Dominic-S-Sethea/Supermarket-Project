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
  PGHOST: z.string().trim().optional(),
  PGPORT: z.string().trim().optional(),
  PGUSER: z.string().trim().optional(),
  PGPASSWORD: z.string().trim().optional(),
  PGDATABASE: z.string().trim().optional(),
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
  GEMINI_COPILOT_MODEL: z.string().trim().min(1).max(80).default("gemini-2.5-flash"),
  GEMINI_FAST_MODEL: z.string().trim().min(1).max(80).default("gemini-2.5-flash-lite"),
  GEMINI_EMBED_MODEL: z.string().trim().min(1).max(80).default("gemini-embedding-001"),
  GEMINI_DECISION_MODEL: z.string().trim().min(1).max(80).default("gemini-2.5-flash-lite"),
  GEMINI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(25_000),
  AI_MAX_PROMO_DISCOUNT_BP: z.coerce.number().int().min(500).max(8000).default(5000),
  AI_ACTION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  AI_REDACT_STAFF_PII: z.string().trim().optional(),
  ANALYTICS_WORKER_URL: z.string().trim().optional(),
  ANALYTICS_WORKER_TOKEN: z.string().trim().optional(),
  PAYMENT_WEBHOOK_SECRET: z.string().trim().optional(),
  ENABLE_SANDBOX_PAYMENT_SIMULATION: z.string().trim().optional(),
  ALLOW_SHARED_DEV_DB_TESTS: z.string().trim().optional(),
  POS_MAX_BACKDATE_HOURS: z.coerce.number().int().min(1).max(720).default(72),
  POS_MAX_FUTURE_SKEW_SEC: z.coerce.number().int().min(30).max(3600).default(300),
  STORE_TIMEZONE: z.string().trim().min(3).max(64).default("Asia/Phnom_Penh"),
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

/** Safely build a PostgreSQL connection URI from discrete PG* environment variables without shell/URI password corruption. */
export function buildDatabaseUrlFromPgEnv(pgEnv: {
  PGHOST?: string;
  PGPORT?: string;
  PGUSER?: string;
  PGPASSWORD?: string;
  PGDATABASE?: string;
}): string | null {
  const host = pgEnv.PGHOST?.trim();
  const user = pgEnv.PGUSER?.trim();
  const database = pgEnv.PGDATABASE?.trim();
  if (!host || !user || !database) return null;
  const rawPort = pgEnv.PGPORT?.trim() || "5432";
  const port = /^\d+$/.test(rawPort) ? rawPort : "5432";
  const auth =
    pgEnv.PGPASSWORD !== undefined && pgEnv.PGPASSWORD !== ""
      ? `${encodeURIComponent(user)}:${encodeURIComponent(pgEnv.PGPASSWORD)}`
      : encodeURIComponent(user);
  return `postgres://${auth}@${host}:${port}/${encodeURIComponent(database)}`;
}

const discretePgUrl = buildDatabaseUrlFromPgEnv(rawEnv);

if (isProduction && !rawEnv.DATABASE_URL && !discretePgUrl) {
  throw new Error(
    'FATAL: DATABASE_URL (or PGHOST/PGUSER/PGDATABASE) must be explicitly set when NODE_ENV="production".'
  );
}

function resolveDatabaseUrl(): string {
  if (isTest) {
    const candidate = rawEnv.DATABASE_URL_TEST || rawEnv.DATABASE_URL || discretePgUrl;
    if (!candidate) {
      throw new Error(
        "FATAL: Refusing to run tests against default dev database. Set DATABASE_URL_TEST to an isolated test database."
      );
    }
    if (!rawEnv.DATABASE_URL_TEST && rawEnv.ALLOW_SHARED_DEV_DB_TESTS !== "true") {
      let dbName = "";
      try {
        dbName = new URL(candidate).pathname.replace(/^\//, "");
      } catch {
        dbName = "";
      }
      if (!/test|ci/i.test(dbName)) {
        throw new Error(
          `FATAL: Refusing to run tests against non-test database "${dbName || "unknown"}". Set DATABASE_URL_TEST to an isolated test database.`
        );
      }
    }
    return candidate;
  }
  return (
    rawEnv.DATABASE_URL ||
    discretePgUrl ||
    "postgres://supermarket:supermarket_dev_password@localhost:5433/supermarket_os"
  );
}

const resolvedDatabaseUrl = resolveDatabaseUrl();

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

const cookieSecure =
  rawEnv.COOKIE_SECURE !== undefined ? rawEnv.COOKIE_SECURE === "true" : isProduction;
if (isProduction && !cookieSecure) {
  console.warn(
    "[config] WARNING: COOKIE_SECURE=false while NODE_ENV=production. Deploy behind HTTPS termination and set COOKIE_SECURE=true."
  );
}

export const env = {
  nodeEnv,
  isProduction,
  isTest,
  isDevelopment,
  host: rawEnv.HOST,
  port: rawEnv.PORT,
  logLevel: rawEnv.LOG_LEVEL,
  databaseUrl: resolvedDatabaseUrl,
  authSecret: configuredSecret || EPHEMERAL_DEV_SECRET,
  authSecretPrevious: rawEnv.AUTH_SECRET_PREVIOUS || null,
  corsOrigins: rawEnv.CORS_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  trustProxy: parseTrustProxy(rawEnv.TRUST_PROXY, isProduction),
  cookieSecure,
  metricsToken: rawEnv.METRICS_TOKEN || null,
  geminiApiKey: rawEnv.GEMINI_API_KEY || null,
  geminiStoreInteractions: rawEnv.GEMINI_STORE_INTERACTIONS === "true",
  geminiCopilotModel: rawEnv.GEMINI_COPILOT_MODEL,
  geminiFastModel: rawEnv.GEMINI_FAST_MODEL,
  geminiEmbedModel: rawEnv.GEMINI_EMBED_MODEL,
  geminiDecisionModel: rawEnv.GEMINI_DECISION_MODEL,
  geminiTimeoutMs: rawEnv.GEMINI_TIMEOUT_MS,
  aiMaxPromoDiscountBp: rawEnv.AI_MAX_PROMO_DISCOUNT_BP,
  aiActionTtlHours: rawEnv.AI_ACTION_TTL_HOURS,
  aiRedactStaffPii: rawEnv.AI_REDACT_STAFF_PII !== "false",
  analyticsWorkerUrl: rawEnv.ANALYTICS_WORKER_URL || null,
  analyticsWorkerToken: rawEnv.ANALYTICS_WORKER_TOKEN || null,
  paymentWebhookSecret: rawEnv.PAYMENT_WEBHOOK_SECRET || null,
  enableSandboxPaymentSimulation:
    rawEnv.ENABLE_SANDBOX_PAYMENT_SIMULATION !== undefined
      ? rawEnv.ENABLE_SANDBOX_PAYMENT_SIMULATION === "true"
      : isDevelopment || isTest,
  posMaxBackdateHours: rawEnv.POS_MAX_BACKDATE_HOURS,
  posMaxFutureSkewSec: rawEnv.POS_MAX_FUTURE_SKEW_SEC,
  storeTimezone: rawEnv.STORE_TIMEZONE,
  enableOpenApiDocs: rawEnv.ENABLE_OPENAPI_DOCS !== "false",
  pgPoolMax: rawEnv.PG_POOL_MAX,
  pgStatementTimeoutMs: rawEnv.PG_STATEMENT_TIMEOUT_MS,
};

export function hashTokenId(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
