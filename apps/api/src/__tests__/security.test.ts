import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { aiConversations, auditLogs, db, pool, userSessions, users } from "../db/index.js";
import { buildCsvDocument, escapeCsvCell } from "../lib/helpers.js";
import { SESSION_COOKIE_NAME } from "../plugins/auth.js";
import { resetLoginLockouts, resetRateLimits } from "../plugins/security.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let ownerToken = "";
let managerToken = "";
let accountantToken = "";
let cashierToken = "";
let clerkToken = "";
let ownerCookie = "";

function authHeaders(token = ownerToken) {
  return { authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  resetRateLimits();
  resetLoginLockouts();
  app = await buildApp(false);
  await app.ready();

  const logins = await Promise.all([
    app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "owner", pin: "1111" } }),
    app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "manager", pin: "9999" } }),
    app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "accountant", pin: "4444" } }),
    app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "cashier1", pin: "1234" } }),
    app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "clerk1", pin: "2222" } }),
  ]);
  for (const r of logins) {
    expect(r.statusCode).toBe(200);
  }
  ownerToken = (logins[0].json() as { token: string }).token;
  managerToken = (logins[1].json() as { token: string }).token;
  accountantToken = (logins[2].json() as { token: string }).token;
  cashierToken = (logins[3].json() as { token: string }).token;
  clerkToken = (logins[4].json() as { token: string }).token;

  const setCookie = logins[0].headers["set-cookie"];
  const rawCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie ?? "";
  ownerCookie = rawCookie.split(";")[0] ?? "";
  expect(ownerCookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
});

afterAll(async () => {
  resetLoginLockouts();
  await app.close();
  await pool.end();
});

describe("SupermarketOS OWASP Security Hardening Suite", () => {
  it("enforces IP-independent per-username PIN brute-force lockout (5 failures -> 429 + audit log)", async () => {
    const tempUser = `sec_lock_${Date.now().toString().slice(-6)}`;
    const createRes = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: authHeaders(),
      payload: {
        username: tempUser,
        fullName: "Lockout Test Cashier",
        role: "cashier",
        pin: "8421",
      },
    });
    expect(createRes.statusCode).toBe(201);
    const createdId = (createRes.json() as { user: { id: string } }).user.id;

    try {
      // 4 bad PINs from rotating simulated remote addresses -> 401
      for (let i = 1; i <= 4; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          remoteAddress: `10.10.0.${i}`,
          payload: { username: tempUser, pin: "0000" },
        });
        expect(res.statusCode).toBe(401);
      }

      // 5th bad PIN from a 5th IP triggers lockout -> 429 + Retry-After + immutable auth_lockout audit event
      const fifth = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        remoteAddress: "10.10.0.5",
        payload: { username: tempUser, pin: "0000" },
      });
      expect(fifth.statusCode).toBe(429);
      expect(Number(fifth.headers["retry-after"])).toBeGreaterThan(60);

      // Even the CORRECT PIN is rejected while locked out (429)
      const correctWhileLocked = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        remoteAddress: "10.10.0.6",
        payload: { username: tempUser, pin: "8421" },
      });
      expect(correctWhileLocked.statusCode).toBe(429);

      // Verify immutable auth_lockout audit event was written
      const lockoutAudits = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.entityId, createdId));
      expect(lockoutAudits.some((a) => a.action === "auth_lockout")).toBe(true);
    } finally {
      resetLoginLockouts();
      await db.delete(userSessions).where(eq(userSessions.userId, createdId));
      await db.delete(auditLogs).where(eq(auditLogs.entityId, createdId));
      await db.delete(users).where(eq(users.id, createdId));
    }
  });

  it("neutralizes OWASP CSV formula injection while preserving valid signed decimal numbers", () => {
    expect(escapeCsvCell("=CMD|' /C calc'!A0")).toBe("'=CMD|' /C calc'!A0");
    expect(escapeCsvCell("+2+5+cmd|' /C calc'!A0")).toBe("'+2+5+cmd|' /C calc'!A0");
    expect(escapeCsvCell("-cmd|' /C calc'!A0")).toBe("'-cmd|' /C calc'!A0");
    expect(escapeCsvCell("@SUM(1+1)*cmd|' /C calc'!A0")).toBe("'@SUM(1+1)*cmd|' /C calc'!A0");
    expect(escapeCsvCell("\t=1+1")).toBe("'\t=1+1");
    expect(escapeCsvCell("   =HYPERLINK(\"http://evil\")")).toBe(
      "\"'   =HYPERLINK(\"\"http://evil\"\")\""
    );
    // Legitimate negative currency & percentages stay pure numbers
    expect(escapeCsvCell("-12.50")).toBe("-12.50");
    expect(escapeCsvCell(-42.75)).toBe("-42.75");

    const doc = buildCsvDocument(["SKU", "Note", "Variance"], [
      ["SKU-1", "=HYPERLINK(\"http://attacker\")", "-5.25"],
    ]);
    expect(doc).toContain("'=HYPERLINK");
    expect(doc).toContain(",-5.25");
  });

  it("blocks SQL injection payloads safely across search endpoints without DB errors", async () => {
    const payloads = [
      "' OR '1'='1'; DROP TABLE products; --",
      "%'; SELECT pg_sleep(3); --",
      "\" UNION SELECT username, pin_hash FROM users --",
    ];

    for (const p of payloads) {
      const encoded = encodeURIComponent(p);
      const [prodRes, loyRes, auditRes] = await Promise.all([
        app.inject({ method: "GET", url: `/api/products?search=${encoded}`, headers: authHeaders() }),
        app.inject({ method: "GET", url: `/api/loyalty/customers?search=${encoded}`, headers: authHeaders() }),
        app.inject({ method: "GET", url: `/api/admin/audit-logs?search=${encoded}`, headers: authHeaders() }),
      ]);
      expect(prodRes.statusCode).toBe(200);
      expect(loyRes.statusCode).toBe(200);
      expect(auditRes.statusCode).toBe(200);
    }
  });

  it("prevents IDOR across users on AI conversations and proposed HITL actions", async () => {
    // Manager creates a conversation with a staged proposed action (morning combo fix)
    const mgrChat = await app.inject({
      method: "POST",
      url: "/api/ai/chat",
      headers: authHeaders(managerToken),
      payload: {
        message: "Diagnose why morning shift sales are underperforming and propose a morning combo fix",
      },
    });
    expect(mgrChat.statusCode).toBe(200);
    const mgrData = mgrChat.json() as {
      conversationId: string;
      actions: { id: string }[];
    };
    expect(mgrData.conversationId).toBeTruthy();

    try {
      // Owner (different userId) cannot read Manager's conversation
      const readAttempt = await app.inject({
        method: "GET",
        url: `/api/ai/conversations/${mgrData.conversationId}`,
        headers: authHeaders(ownerToken),
      });
      expect(readAttempt.statusCode).toBe(404);

      // Owner cannot append into Manager's conversation
      const appendAttempt = await app.inject({
        method: "POST",
        url: "/api/ai/chat",
        headers: authHeaders(ownerToken),
        payload: {
          conversationId: mgrData.conversationId,
          message: "Injected message",
        },
      });
      expect(appendAttempt.statusCode).toBe(404);

      // Owner cannot execute or reject Manager's proposed action (IDOR fixed!)
      if (mgrData.actions.length > 0) {
        const actionId = mgrData.actions[0].id;
        const execAttempt = await app.inject({
          method: "POST",
          url: `/api/ai/actions/${actionId}/execute`,
          headers: authHeaders(ownerToken),
        });
        expect(execAttempt.statusCode).toBe(404);

        const rejectAttempt = await app.inject({
          method: "POST",
          url: `/api/ai/actions/${actionId}/reject`,
          headers: authHeaders(ownerToken),
        });
        expect(rejectAttempt.statusCode).toBe(404);
      }
    } finally {
      await db.delete(aiConversations).where(eq(aiConversations.id, mgrData.conversationId));
    }
  });

  it("emits correlation X-Request-Id, Cache-Control: no-store, security headers, and CSRF Origin guards", async () => {
    // Valid client X-Request-Id is echoed; malicious/invalid one is replaced by server UUIDv7
    const echoed = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { ...authHeaders(), "x-request-id": "trace-abc-12345" },
    });
    expect(echoed.statusCode).toBe(200);
    expect(echoed.headers["x-request-id"]).toBe("trace-abc-12345");
    expect(echoed.headers["cache-control"]).toBe("no-store, private");
    expect(echoed.headers["x-content-type-options"]).toBe("nosniff");
    expect(echoed.headers["x-frame-options"]).toBe("DENY");
    expect(echoed.headers["content-security-policy"]).toContain("frame-ancestors 'none'");

    const sanitized = await app.inject({
      method: "GET",
      url: "/api/health/live",
      headers: { "x-request-id": "bad\r\nheader-injection" },
    });
    expect(sanitized.statusCode).toBe(200);
    expect(sanitized.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/i);

    // Cookie-authenticated mutation with untrusted Origin is rejected (CSRF 403)
    const csrfBlocked = await app.inject({
      method: "POST",
      url: "/api/auth/change-pin",
      headers: {
        cookie: ownerCookie,
        origin: "https://malicious.example",
      },
      payload: { currentPin: "1111", newPin: "9876" },
    });
    expect(csrfBlocked.statusCode).toBe(403);
  });

  it("enforces strict 5-role RBAC matrix across governance, exports, purchasing, AI, and POS endpoints", async () => {
    const matrix: {
      method: "GET" | "POST";
      url: string;
      payload?: Record<string, unknown>;
      expected: Record<"owner" | "manager" | "accountant" | "cashier" | "clerk", number>;
    }[] = [
      {
        method: "GET",
        url: "/api/admin/users",
        expected: { owner: 200, manager: 403, accountant: 403, cashier: 403, clerk: 403 },
      },
      {
        method: "GET",
        url: "/api/admin/audit-logs",
        expected: { owner: 200, manager: 200, accountant: 200, cashier: 403, clerk: 403 },
      },
      {
        method: "GET",
        url: "/api/exports/inventory-valuation.csv",
        expected: { owner: 200, manager: 200, accountant: 200, cashier: 403, clerk: 403 },
      },
      {
        method: "GET",
        url: "/api/ai/status",
        expected: { owner: 200, manager: 200, accountant: 403, cashier: 403, clerk: 403 },
      },
      {
        method: "GET",
        url: "/api/pos/bootstrap",
        expected: { owner: 200, manager: 200, accountant: 403, cashier: 200, clerk: 403 },
      },
      {
        method: "GET",
        url: "/api/inventory/expiry-alerts",
        expected: { owner: 200, manager: 200, accountant: 403, cashier: 403, clerk: 200 },
      },
      {
        method: "GET",
        url: "/api/metrics",
        expected: { owner: 200, manager: 200, accountant: 403, cashier: 403, clerk: 403 },
      },
    ];

    const tokens = {
      owner: ownerToken,
      manager: managerToken,
      accountant: accountantToken,
      cashier: cashierToken,
      clerk: clerkToken,
    };

    for (const row of matrix) {
      for (const [role, expectedStatus] of Object.entries(row.expected) as [
        keyof typeof tokens,
        number,
      ][]) {
        const res = await app.inject({
          method: row.method,
          url: row.url,
          headers: authHeaders(tokens[role]),
          payload: row.payload,
        });
        expect(res.statusCode, `${row.method} ${row.url} as ${role}`).toBe(expectedStatus);
      }
    }

    // Verify Prometheus text exposition format on /api/metrics
    const metricsRes = await app.inject({
      method: "GET",
      url: "/api/metrics",
      headers: authHeaders(ownerToken),
    });
    expect(metricsRes.statusCode).toBe(200);
    expect(metricsRes.headers["content-type"]).toContain("text/plain");
    expect(metricsRes.body).toContain("http_requests_total");
    expect(metricsRes.body).toContain("pg_pool_connections");
    expect(metricsRes.body).toContain("supermarket_auth_lockouts_total");
  });
});
