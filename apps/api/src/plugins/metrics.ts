import crypto from "node:crypto";
import type { ServerResponse } from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { pool } from "../db/index.js";
import { getAuthLockoutTotal } from "./security.js";

const DURATION_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
const MAX_REQUEST_METRIC_KEYS = 500;
const MAX_HISTOGRAM_SERIES = 200;
const ANALYTICS_CACHE_TTL_MS = 30_000;

interface HistogramSeries {
  buckets: number[];
  sumMs: number;
  count: number;
}

const requestCounts = new Map<string, number>();
const globalHistogram: HistogramSeries = {
  buckets: new Array<number>(DURATION_BUCKETS_MS.length + 1).fill(0),
  sumMs: 0,
  count: 0,
};
const routeHistograms = new Map<string, HistogramSeries>();

let posSalesCommittedTotal = 0;
const posReversalsTotal: Record<"void" | "refund", number> = {
  void: 0,
  refund: 0,
};

// Active SSE stream registry & metrics (H-20, H-21)
const activeSseResponses = new Set<ServerResponse>();
const sseStreamsTotal: Record<"completed" | "error" | "aborted", number> = {
  completed: 0,
  error: 0,
  aborted: 0,
};

// Cached analytics freshness telemetry (L-08)
let analyticsFreshnessCache: {
  fetchedAtMs: number;
  ageSeconds: number;
  dqPassed: number;
} | null = null;

function createEmptyHistogram(): HistogramSeries {
  return {
    buckets: new Array<number>(DURATION_BUCKETS_MS.length + 1).fill(0),
    sumMs: 0,
    count: 0,
  };
}

function recordHistogramSample(hist: HistogramSeries, elapsedMs: number): void {
  hist.sumMs += elapsedMs;
  hist.count += 1;
  for (let i = 0; i < DURATION_BUCKETS_MS.length; i++) {
    if (elapsedMs <= DURATION_BUCKETS_MS[i]) {
      hist.buckets[i] += 1;
    }
  }
  hist.buckets[DURATION_BUCKETS_MS.length] += 1;
}

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

/**
 * Record a committed POS transaction separated by sale vs void/refund (H-20).
 */
export function recordPosSaleMetric(kind: "sale" | "void" | "refund"): void {
  if (kind === "sale") {
    posSalesCommittedTotal += 1;
  } else {
    posReversalsTotal[kind] += 1;
  }
}

/**
 * Track an active hijacked SSE response for both Prometheus gauges (H-20)
 * and graceful shutdown draining (H-21). Returns a cleanup callback.
 */
export function registerActiveSseResponse(
  res: ServerResponse
): (outcome: "completed" | "error" | "aborted") => void {
  activeSseResponses.add(res);
  let finished = false;
  return (outcome) => {
    if (finished) return;
    finished = true;
    activeSseResponses.delete(res);
    sseStreamsTotal[outcome] += 1;
  };
}

/**
 * Close all open SSE responses cleanly during SIGTERM/SIGINT so app.close() does not hang (H-21).
 */
export function closeAllActiveSseResponses(): number {
  let closed = 0;
  for (const res of Array.from(activeSseResponses)) {
    activeSseResponses.delete(res);
    sseStreamsTotal.aborted += 1;
    try {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: "error", error: "Server shutting down." })}\n\n`);
        res.end();
      }
      closed += 1;
    } catch {
      // ignore socket write errors during shutdown
    }
  }
  return closed;
}

async function getAnalyticsFreshness(): Promise<{ ageSeconds: number; dqPassed: number }> {
  const now = Date.now();
  if (analyticsFreshnessCache && now - analyticsFreshnessCache.fetchedAtMs < ANALYTICS_CACHE_TTL_MS) {
    return {
      ageSeconds: analyticsFreshnessCache.ageSeconds,
      dqPassed: analyticsFreshnessCache.dqPassed,
    };
  }
  try {
    const res = await pool.query<{ finished_at: Date; dq_passed: boolean }>(
      "SELECT finished_at, dq_passed FROM analytics_pipeline_runs ORDER BY finished_at DESC LIMIT 1"
    );
    if (res.rows.length === 0) {
      analyticsFreshnessCache = { fetchedAtMs: now, ageSeconds: -1, dqPassed: 0 };
    } else {
      const row = res.rows[0];
      const finishedMs = new Date(row.finished_at).getTime();
      const ageSeconds = Number.isFinite(finishedMs)
        ? Math.max(0, Math.round((now - finishedMs) / 1000))
        : -1;
      analyticsFreshnessCache = {
        fetchedAtMs: now,
        ageSeconds,
        dqPassed: row.dq_passed ? 1 : 0,
      };
    }
  } catch {
    return analyticsFreshnessCache
      ? { ageSeconds: analyticsFreshnessCache.ageSeconds, dqPassed: analyticsFreshnessCache.dqPassed }
      : { ageSeconds: -1, dqPassed: 0 };
  }
  return {
    ageSeconds: analyticsFreshnessCache.ageSeconds,
    dqPassed: analyticsFreshnessCache.dqPassed,
  };
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
    // Collapse unmatched 404/probe URLs to prevent unbounded cardinality OOM (H-20)
    const route = req.routeOptions?.url || "__unmatched__";
    const statusClass = `${Math.floor(reply.statusCode / 100)}xx`;
    const rawKey = `${req.method}|${route}|${statusClass}`;
    const key =
      requestCounts.has(rawKey) || requestCounts.size < MAX_REQUEST_METRIC_KEYS
        ? rawKey
        : `OTHER|__overflow__|${statusClass}`;
    requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);

    if (req.metricsStartNs !== undefined) {
      const elapsedMs = Number(process.hrtime.bigint() - req.metricsStartNs) / 1e6;
      recordHistogramSample(globalHistogram, elapsedMs);

      const rawHistKey = `${route}|${statusClass}`;
      const histKey =
        routeHistograms.has(rawHistKey) || routeHistograms.size < MAX_HISTOGRAM_SERIES
          ? rawHistKey
          : `__overflow__|${statusClass}`;
      let series = routeHistograms.get(histKey);
      if (!series) {
        series = createEmptyHistogram();
        routeHistograms.set(histKey, series);
      }
      recordHistogramSample(series, elapsedMs);
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
    const analyticsFreshness = await getAnalyticsFreshness();

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
      lines.push(
        `http_request_duration_ms_bucket{le="${DURATION_BUCKETS_MS[i]}"} ${globalHistogram.buckets[i]}`
      );
    }
    lines.push(
      `http_request_duration_ms_bucket{le="+Inf"} ${globalHistogram.buckets[DURATION_BUCKETS_MS.length]}`
    );
    lines.push(`http_request_duration_ms_sum ${globalHistogram.sumMs.toFixed(3)}`);
    lines.push(`http_request_duration_ms_count ${globalHistogram.count}`);

    lines.push(
      "# HELP http_route_request_duration_ms Per-route HTTP request duration histogram in milliseconds",
      "# TYPE http_route_request_duration_ms histogram"
    );
    for (const [k, series] of routeHistograms.entries()) {
      const [route, statusClass] = k.split("|");
      const labels = `route="${escapeLabel(route)}",status_class="${escapeLabel(statusClass)}"`;
      for (let i = 0; i < DURATION_BUCKETS_MS.length; i++) {
        lines.push(
          `http_route_request_duration_ms_bucket{${labels},le="${DURATION_BUCKETS_MS[i]}"} ${series.buckets[i]}`
        );
      }
      lines.push(
        `http_route_request_duration_ms_bucket{${labels},le="+Inf"} ${series.buckets[DURATION_BUCKETS_MS.length]}`
      );
      lines.push(`http_route_request_duration_ms_sum{${labels}} ${series.sumMs.toFixed(3)}`);
      lines.push(`http_route_request_duration_ms_count{${labels}} ${series.count}`);
    }

    lines.push(
      "# HELP supermarket_pos_sales_total Total POS sales (kind=sale) committed since process start",
      "# TYPE supermarket_pos_sales_total counter",
      `supermarket_pos_sales_total ${posSalesCommittedTotal}`,
      "# HELP supermarket_pos_reversals_total Total POS void and refund reversals committed since process start",
      "# TYPE supermarket_pos_reversals_total counter",
      `supermarket_pos_reversals_total{kind="void"} ${posReversalsTotal.void}`,
      `supermarket_pos_reversals_total{kind="refund"} ${posReversalsTotal.refund}`,
      "# HELP supermarket_sse_active_streams Currently open AI Copilot SSE streams",
      "# TYPE supermarket_sse_active_streams gauge",
      `supermarket_sse_active_streams ${activeSseResponses.size}`,
      "# HELP supermarket_sse_streams_total Total AI Copilot SSE streams by terminal status",
      "# TYPE supermarket_sse_streams_total counter",
      `supermarket_sse_streams_total{status="completed"} ${sseStreamsTotal.completed}`,
      `supermarket_sse_streams_total{status="error"} ${sseStreamsTotal.error}`,
      `supermarket_sse_streams_total{status="aborted"} ${sseStreamsTotal.aborted}`,
      "# HELP supermarket_analytics_last_run_age_seconds Seconds since the latest analytics pipeline run completed (-1 if never run)",
      "# TYPE supermarket_analytics_last_run_age_seconds gauge",
      `supermarket_analytics_last_run_age_seconds ${analyticsFreshness.ageSeconds}`,
      "# HELP supermarket_analytics_dq_passed Whether the latest analytics pipeline run passed all data quality contracts (1=pass, 0=fail)",
      "# TYPE supermarket_analytics_dq_passed gauge",
      `supermarket_analytics_dq_passed ${analyticsFreshness.dqPassed}`,
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
