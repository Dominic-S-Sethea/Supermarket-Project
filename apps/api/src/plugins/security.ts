import { generateUuidV7 } from "@supermarket/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { env } from "../config/env.js";
import { SESSION_COOKIE_NAME } from "./auth.js";

declare module "fastify" {
  interface FastifyRequest {
    correlationId: string;
  }
}

const VALID_REQUEST_ID = /^[a-zA-Z0-9._-]{4,64}$/;

export function registerSecurityHeaders(app: FastifyInstance) {
  app.decorateRequest("correlationId", "");

  app.addHook("onRequest", async (req) => {
    const incoming = req.headers["x-request-id"];
    const raw = Array.isArray(incoming) ? incoming[0] : incoming;
    req.correlationId = raw && VALID_REQUEST_ID.test(raw.trim()) ? raw.trim() : generateUuidV7();
  });

  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("X-Request-Id", req.correlationId || generateUuidV7());
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (!reply.hasHeader("Content-Security-Policy")) {
      reply.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    }
    if (env.isProduction || req.protocol === "https") {
      reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    if (
      req.url.startsWith("/api/") &&
      req.authUser &&
      !reply.hasHeader("Cache-Control")
    ) {
      reply.header("Cache-Control", "no-store, private");
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

// =========================================================================
// PER-USERNAME SLIDING-WINDOW BRUTE-FORCE PIN LOCKOUT (IP-INDEPENDENT)
// =========================================================================
interface LockoutRecord {
  failures: number[];
  lockedUntil: number;
}

const LOCKOUT_WINDOW_MS = 15 * 60_000;
const LOCKOUT_DURATION_MS = 15 * 60_000;
const MAX_FAILED_PIN_ATTEMPTS = 5;

const loginLockouts = new Map<string, LockoutRecord>();
let authLockoutsTotal = 0;

export function resetLoginLockouts() {
  loginLockouts.clear();
}

export function getAuthLockoutTotal(): number {
  return authLockoutsTotal;
}

export function checkLoginLockout(username: string): { locked: boolean; retryAfterSec: number } {
  const key = username.trim().toLowerCase();
  const now = Date.now();
  const rec = loginLockouts.get(key);
  if (!rec) return { locked: false, retryAfterSec: 0 };
  if (rec.lockedUntil > now) {
    return {
      locked: true,
      retryAfterSec: Math.max(1, Math.ceil((rec.lockedUntil - now) / 1000)),
    };
  }
  return { locked: false, retryAfterSec: 0 };
}

export function recordFailedLogin(username: string): {
  locked: boolean;
  newlyLocked: boolean;
  retryAfterSec: number;
  failures: number;
} {
  const key = username.trim().toLowerCase();
  const now = Date.now();

  if (loginLockouts.size > 5000) {
    for (const [k, v] of loginLockouts) {
      if (v.lockedUntil <= now && v.failures.every((ts) => now - ts > LOCKOUT_WINDOW_MS)) {
        loginLockouts.delete(k);
      }
    }
  }

  const rec = loginLockouts.get(key) ?? { failures: [], lockedUntil: 0 };
  if (rec.lockedUntil > now) {
    return {
      locked: true,
      newlyLocked: false,
      retryAfterSec: Math.max(1, Math.ceil((rec.lockedUntil - now) / 1000)),
      failures: rec.failures.length,
    };
  }

  const recent = rec.failures.filter((ts) => now - ts <= LOCKOUT_WINDOW_MS);
  recent.push(now);
  rec.failures = recent;

  if (recent.length >= MAX_FAILED_PIN_ATTEMPTS) {
    rec.lockedUntil = now + LOCKOUT_DURATION_MS;
    loginLockouts.set(key, rec);
    authLockoutsTotal += 1;
    return {
      locked: true,
      newlyLocked: true,
      retryAfterSec: Math.ceil(LOCKOUT_DURATION_MS / 1000),
      failures: recent.length,
    };
  }

  loginLockouts.set(key, rec);
  return {
    locked: false,
    newlyLocked: false,
    retryAfterSec: 0,
    failures: recent.length,
  };
}

export function clearLoginFailures(username: string): void {
  loginLockouts.delete(username.trim().toLowerCase());
}
