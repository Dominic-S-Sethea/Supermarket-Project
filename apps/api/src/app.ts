import cors from "@fastify/cors";
import { sql } from "drizzle-orm";
import Fastify from "fastify";
import { db } from "./db/index.js";
import { registerAuthHook } from "./plugins/auth.js";
import { aiRoutes } from "./routes/ai.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { authRoutes } from "./routes/auth.js";
import { catalogRoutes } from "./routes/catalog.js";
import { inventoryRoutes } from "./routes/inventory.js";
import { posRoutes } from "./routes/pos.js";

const DEFAULT_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

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

  await app.register(cors, {
    credentials: true,
    origin: (origin, cb) => {
      // Allow same-origin / server-to-server / curl without Origin header, plus whitelisted UI origins
      if (!origin || allowedOrigins.has(origin)) {
        cb(null, true);
      } else {
        cb(new Error(`Origin ${origin} not allowed by CORS`), false);
      }
    },
  });

  registerAuthHook(app);

  app.get("/api/health", async () => ({
    status: "ok",
    service: "supermarket-os-api",
    timestamp: new Date().toISOString(),
  }));

  await app.register(authRoutes);
  await app.register(catalogRoutes);
  await app.register(posRoutes);
  await app.register(inventoryRoutes);
  await app.register(analyticsRoutes);
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
