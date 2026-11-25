import cors from "@fastify/cors";
import { sql } from "drizzle-orm";
import Fastify from "fastify";
import { db } from "./db/index.js";
import { registerAuthHook } from "./plugins/auth.js";
import { registerMetrics } from "./plugins/metrics.js";
import { registerCsrfOriginCheck, registerSecurityHeaders } from "./plugins/security.js";
import { adminRoutes } from "./routes/admin.js";
import { aiRoutes } from "./routes/ai.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { authRoutes } from "./routes/auth.js";
import { catalogRoutes } from "./routes/catalog.js";
import { exportRoutes } from "./routes/exports.js";
import { inventoryRoutes } from "./routes/inventory.js";
import { loyaltyRoutes } from "./routes/loyalty.js";
import { operationsRoutes } from "./routes/operations.js";
import { posRoutes } from "./routes/pos.js";

declare module "fastify" {
  interface FastifyInstance {
    allowedOrigins: Set<string>;
  }
}

const DEFAULT_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

export function getPgErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  if (typeof e.code === "string") return e.code;
  if (e.cause && typeof e.cause.code === "string") return e.cause.code;
  return undefined;
}

export async function buildApp(logger = true) {
  const app = Fastify({
    logger: logger ? { level: process.env.LOG_LEVEL ?? "info" } : false,
    bodyLimit: 12 * 1024 * 1024,
  });

  const allowedOrigins = new Set(
    (process.env.CORS_ORIGINS ?? DEFAULT_ORIGINS.join(","))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
  app.decorate("allowedOrigins", allowedOrigins);

  await app.register(cors, {
    credentials: true,
    origin: (origin, cb) => {
      // Allow same-origin / server-to-server / curl without Origin header, plus whitelisted UI origins
      if (!origin || allowedOrigins.has(origin)) {
        cb(null, true);
      } else {
        const corsErr = new Error("Origin not allowed by CORS") as Error & { statusCode?: number };
        corsErr.statusCode = 403;
        cb(corsErr, false);
      }
    },
  });

  registerSecurityHeaders(app);
  registerCsrfOriginCheck(app, allowedOrigins);
  registerAuthHook(app);
  registerMetrics(app);

  app.setErrorHandler((err, req, reply) => {
    const pgCode = getPgErrorCode(err);
    if (pgCode === "22P02") {
      return reply.status(400).send({ error: "Invalid identifier or parameter format." });
    }
    if (pgCode === "23505") {
      return reply.status(409).send({ error: "A record with this unique value already exists." });
    }
    if (pgCode === "23503") {
      return reply.status(400).send({ error: "Referenced resource does not exist." });
    }
    if (pgCode === "23514") {
      return reply.status(400).send({ error: "Value violates data integrity constraints." });
    }

    const status =
      typeof (err as { statusCode?: unknown }).statusCode === "number"
        ? (err as { statusCode: number }).statusCode
        : 500;
    if (status >= 400 && status < 500) {
      return reply.status(status).send({
        error: err instanceof Error ? err.message : "Request rejected.",
      });
    }

    req.log.error({ err }, "Unhandled server error");
    return reply.status(500).send({ error: "Internal server error." });
  });

  app.get("/api/health/live", async () => ({
    status: "ok",
    service: "supermarket-os-api",
    uptimeSec: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  }));

  app.get("/api/health", async (_req, reply) => {
    const startMs = Date.now();
    try {
      await db.execute(sql`SELECT 1`);
      return {
        status: "ok",
        service: "supermarket-os-api",
        db: "connected",
        dbLatencyMs: Date.now() - startMs,
        uptimeSec: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      app.log.error({ err }, "Database readiness probe failed");
      return reply.status(503).send({
        status: "degraded",
        service: "supermarket-os-api",
        db: "disconnected",
        timestamp: new Date().toISOString(),
      });
    }
  });

  await app.register(authRoutes);
  await app.register(catalogRoutes);
  await app.register(posRoutes);
  await app.register(inventoryRoutes);
  await app.register(loyaltyRoutes);
  await app.register(operationsRoutes);
  await app.register(analyticsRoutes);
  await app.register(adminRoutes);
  await app.register(exportRoutes);
  await app.register(aiRoutes);

  // Periodic background stock ledger folding (every 5 minutes outside test runs)
  if (!process.env.VITEST) {
    const foldTimer = setInterval(async () => {
      try {
        await db.execute(sql`
          WITH batch AS (
            UPDATE stock_movements
            SET folded = true
            WHERE folded = false
            RETURNING product_id, qty_delta
          ),
          agg AS (
            SELECT product_id, SUM(qty_delta)::int AS total_delta
            FROM batch
            GROUP BY product_id
          )
          INSERT INTO stock_baselines (product_id, quantity, updated_at)
          SELECT product_id, total_delta, now() FROM agg
          ON CONFLICT (product_id)
          DO UPDATE SET
            quantity = stock_baselines.quantity + EXCLUDED.quantity,
            updated_at = now();
        `);
      } catch (err) {
        app.log.warn({ err }, "Background ledger fold skipped");
      }
    }, 5 * 60_000);
    foldTimer.unref();

    app.addHook("onClose", async () => {
      clearInterval(foldTimer);
    });
  }

  return app;
}
