import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { pool } from "../db/index.js";
import { getAuthLockoutTotal } from "./security.js";

const DURATION_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

const requestCounts = new Map<string, number>();
const bucketCounts = new Array<number>(DURATION_BUCKETS_MS.length + 1).fill(0);
let durationSumMs = 0;
let durationCount = 0;
let posSalesCommittedTotal = 0;

function escapeLabel(val: string): string {
  return val.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}

function timingSafeBearerMatch(authHeader: string | undefined, expectedToken: string): boolean {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return false;
  const presented = authHeader.slice(7).trim();
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expectedToken, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

declare module "fastify" {
  interface FastifyRequest {
    metricsStartNs?: bigint;
  }
}

export function registerMetrics(app: FastifyInstance) {
  app.addHook("onRequest", async (req) => {
    req.metricsStartNs = process.hrtime.bigint();
  });

  app.addHook("onResponse", async (req: FastifyRequest, reply: FastifyReply) => {
    const route = req.routeOptions?.url || req.url.split("?")[0] || "unknown";
    const statusClass = `${Math.floor(reply.statusCode / 100)}xx`;
    const key = `${req.method}|${route}|${statusClass}`;
    requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);

    if (route === "/api/pos/sales" && req.method === "POST" && reply.statusCode === 201) {
      posSalesCommittedTotal += 1;
    }

    if (req.metricsStartNs !== undefined) {
      const elapsedMs = Number(process.hrtime.bigint() - req.metricsStartNs) / 1e6;
      durationSumMs += elapsedMs;
      durationCount += 1;
      for (let i = 0; i < DURATION_BUCKETS_MS.length; i++) {
        if (elapsedMs <= DURATION_BUCKETS_MS[i]) {
          bucketCounts[i] += 1;
        }
      }
      bucketCounts[DURATION_BUCKETS_MS.length] += 1;
    }
  });

  app.get("/api/metrics", async (req, reply) => {
    const configuredMetricsToken = process.env.METRICS_TOKEN?.trim();
    const hasMetricsToken = Boolean(
      configuredMetricsToken &&
        timingSafeBearerMatch(req.headers.authorization, configuredMetricsToken)
    );
    const isAuthorizedRole =
      req.authUser && (req.authUser.role === "owner" || req.authUser.role === "manager");

    if (!hasMetricsToken && !isAuthorizedRole) {
      return reply
        .status(req.authUser ? 403 : 401)
        .send({ error: "Prometheus metrics require owner/manager role or METRICS_TOKEN." });
    }

    const mem = process.memoryUsage();
    const lines: string[] = [
      "# HELP http_requests_total Total HTTP requests handled by SupermarketOS API",
      "# TYPE http_requests_total counter",
    ];

    for (const [k, count] of requestCounts.entries()) {
      const [method, route, statusClass] = k.split("|");
      lines.push(
        `http_requests_total{method="${escapeLabel(method)}",route="${escapeLabel(route)}",status_class="${escapeLabel(statusClass)}"} ${count}`
      );
    }

    lines.push(
      "# HELP http_request_duration_ms HTTP request duration histogram in milliseconds",
      "# TYPE http_request_duration_ms histogram"
    );
    for (let i = 0; i < DURATION_BUCKETS_MS.length; i++) {
      lines.push(`http_request_duration_ms_bucket{le="${DURATION_BUCKETS_MS[i]}"} ${bucketCounts[i]}`);
    }
    lines.push(`http_request_duration_ms_bucket{le="+Inf"} ${bucketCounts[DURATION_BUCKETS_MS.length]}`);
    lines.push(`http_request_duration_ms_sum ${durationSumMs.toFixed(3)}`);
    lines.push(`http_request_duration_ms_count ${durationCount}`);

    lines.push(
      "# HELP supermarket_pos_sales_total Total POS sales committed since process start",
      "# TYPE supermarket_pos_sales_total counter",
      `supermarket_pos_sales_total ${posSalesCommittedTotal}`,
      "# HELP supermarket_auth_lockouts_total Total brute-force PIN lockouts triggered",
      "# TYPE supermarket_auth_lockouts_total counter",
      `supermarket_auth_lockouts_total ${getAuthLockoutTotal()}`,
      "# HELP pg_pool_connections PostgreSQL connection pool counts by state",
      "# TYPE pg_pool_connections gauge",
      `pg_pool_connections{state="total"} ${pool.totalCount}`,
      `pg_pool_connections{state="idle"} ${pool.idleCount}`,
      `pg_pool_connections{state="waiting"} ${pool.waitingCount}`,
      "# HELP process_resident_memory_bytes Resident set size in bytes",
      "# TYPE process_resident_memory_bytes gauge",
      `process_resident_memory_bytes ${mem.rss}`,
      "# HELP nodejs_heap_used_bytes Node.js V8 heap used in bytes",
      "# TYPE nodejs_heap_used_bytes gauge",
      `nodejs_heap_used_bytes ${mem.heapUsed}`,
      "# HELP process_uptime_seconds Process uptime in seconds",
      "# TYPE process_uptime_seconds gauge",
      `process_uptime_seconds ${Math.round(process.uptime())}`
    );

    reply.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    reply.header("Cache-Control", "no-store");
    return `${lines.join("\n")}\n`;
  });
}
