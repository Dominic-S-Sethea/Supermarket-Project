import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { pool } from "./db/index.js";

const app = await buildApp(true);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "Graceful shutdown initiated");
  try {
    await app.close();
    await pool.end();
    app.log.info("HTTP server and PostgreSQL pool closed cleanly");
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, "Error during graceful shutdown");
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  await app.listen({ port: env.port, host: env.host });
  app.log.info(`SupermarketOS API listening on http://${env.host}:${env.port} (${env.nodeEnv})`);
} catch (err) {
  app.log.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
}
