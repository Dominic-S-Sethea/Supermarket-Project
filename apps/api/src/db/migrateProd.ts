import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { applyDatabaseConstraintsAndViews } from "./applyConstraints.js";
import { db, pool } from "./index.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(dirname, "../../drizzle");

/** Apply versioned Drizzle SQL migrations plus idempotent constraints and views in production containers. */
export async function runProductionMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder });
  await applyDatabaseConstraintsAndViews();
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("/migrateProd.js") ||
  process.argv[1]?.replace(/\\/g, "/").endsWith("/migrateProd.ts");

if (isMain) {
  runProductionMigrations()
    .then(async () => {
      console.log(`Applied SQL migrations from ${migrationsFolder} and database constraints cleanly.`);
      await pool.end();
    })
    .catch(async (err) => {
      console.error("Production migration failed:", err);
      await pool.end();
      process.exit(1);
    });
}
