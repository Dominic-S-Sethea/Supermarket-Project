import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SESSION_COOKIE_NAME } from "./auth.js";

export function registerSecurityHeaders(app: FastifyInstance) {
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (!reply.hasHeader("Content-Security-Policy")) {
      reply.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    }
    return payload;
  });
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

/**
 * Mitigates CSRF for cookie-authenticated browsers on mutating methods.
 * Explicit Bearer tokens are immune to ambient browser cookie CSRF.
 */
export function registerCsrfOriginCheck(app: FastifyInstance, allowedOrigins: Set<string>) {
  const mutating = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  app.addHook("onRequest", async (req, reply) => {
    if (!mutating.has(req.method)) return;
    if (req.headers.authorization?.toLowerCase().startsWith("bearer ")) return;

    const cookies = parseCookies(req.headers.cookie);
    if (!cookies[SESSION_COOKIE_NAME]) return;

    const originHeader = req.headers.origin;
    const refererHeader = req.headers.referer;
    let sourceOrigin: string | null = null;
    if (originHeader) {
      sourceOrigin = originHeader;
    } else if (refererHeader) {
      try {
        sourceOrigin = new URL(refererHeader).origin;
      } catch {
        sourceOrigin = null;
      }
    }

    if (!sourceOrigin || !allowedOrigins.has(sourceOrigin)) {
      return reply.status(403).send({ error: "CSRF validation failed: untrusted Origin." });
    }
  });
}

interface RateBucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, RateBucket>();

export function resetRateLimits() {
  buckets.clear();
}

export function createRateLimiter(opts: { keyPrefix: string; windowMs: number; max: number }) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const now = Date.now();
    // Periodically sweep expired buckets to stay memory-bounded
    if (buckets.size > 5000) {
      for (const [k, b] of buckets) {
        if (b.resetAt <= now) buckets.delete(k);
      }
    }
    const key = `${opts.keyPrefix}:${req.ip ?? "local"}`;
    const cur = buckets.get(key);
    if (!cur || cur.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
      return;
    }
    cur.count += 1;
    if (cur.count > opts.max) {
      const retrySec = Math.max(1, Math.ceil((cur.resetAt - now) / 1000));
      reply.header("Retry-After", String(retrySec));
      return reply.status(429).send({
        error: `Too many requests. Please retry in ${retrySec}s.`,
      });
    }
  };
}
