import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "../config/env.js";
import * as schema from "./schema.js";

export const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  max: env.pgPoolMax,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  options: `-c statement_timeout=${env.pgStatementTimeoutMs}`,
});

// Prevent unhandled EventEmitter 'error' crashes when an idle PostgreSQL backend terminates (H-21)
pool.on("error", (err) => {
  console.error("[pg.Pool] Unexpected error on idle PostgreSQL client:", err);
});

export const db = drizzle(pool, { schema });
export * from "./schema.js";
