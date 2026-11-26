import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { pool } from "./db/index.js";
import { closeAllActiveSseResponses } from "./plugins/metrics.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;
const app = await buildApp(true);

let shuttingDown = false;
async function shutdown(signal: string, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "Graceful shutdown initiated");

  const watchdog = setTimeout(() => {
    app.log.error(
      { signal, timeoutMs: SHUTDOWN_TIMEOUT_MS },
      "Graceful shutdown timed out; forcing process exit"
    );
    process.exit(exitCode === 0 ? 1 : exitCode);
  }, SHUTDOWN_TIMEOUT_MS);
  watchdog.unref();

  try {
    const closedSse = closeAllActiveSseResponses();
    if (closedSse > 0) {
      app.log.info({ closedSse }, "Closed active SSE streams before draining HTTP server");
    }
    await app.close();
    await pool.end();
    clearTimeout(watchdog);
    app.log.info("HTTP server and PostgreSQL pool closed cleanly");
    process.exit(exitCode);
  } catch (err) {
    clearTimeout(watchdog);
    app.log.error({ err }, "Error during graceful shutdown");
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
process.on("SIGINT", () => void shutdown("SIGINT", 0));

process.on("unhandledRejection", (reason) => {
  app.log.fatal({ err: reason }, "Unhandled promise rejection; initiating shutdown");
  void shutdown("unhandledRejection", 1);
});

process.on("uncaughtException", (err) => {
  app.log.fatal({ err }, "Uncaught exception; initiating shutdown");
  void shutdown("uncaughtException", 1);
});

try {
  await app.listen({ port: env.port, host: env.host });
  app.log.info(`SupermarketOS API listening on http://${env.host}:${env.port} (${env.nodeEnv})`);
} catch (err) {
  app.log.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
}
