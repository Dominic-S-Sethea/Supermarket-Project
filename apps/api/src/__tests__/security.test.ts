import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { aiConversations, auditLogs, db, pool, userSessions, users } from "../db/index.js";
import { buildCsvDocument, escapeCsvCell } from "../lib/helpers.js";
import { SESSION_COOKIE_NAME, verifySessionToken } from "../plugins/auth.js";
import { resetLoginLockouts, resetRateLimits } from "../plugins/security.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let ownerToken = "";
let managerToken = "";
let accountantToken = "";
let cashierToken = "";
let clerkToken = "";
let ownerCookie = "";
const createdSessionJtis: string[] = [];

function authHeaders(token = ownerToken) {
  return { authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  resetRateLimits();
  resetLoginLockouts();
  app = await buildApp(false);
  await app.ready();

  const logins = await Promise.all([
    app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "owner", pin: "1111", includeToken: true } }),
    app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "manager", pin: "9999", includeToken: true } }),
    app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "accountant", pin: "4444", includeToken: true } }),
    app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "cashier1", pin: "1234", includeToken: true } }),
    app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "clerk1", pin: "2222", includeToken: true } }),
  ]);
  for (const r of logins) {
    expect(r.statusCode).toBe(200);
  }
  ownerToken = (logins[0].json() as { token: string }).token;
  managerToken = (logins[1].json() as { token: string }).token;
  accountantToken = (logins[2].json() as { token: string }).token;
  cashierToken = (logins[3].json() as { token: string }).token;
  clerkToken = (logins[4].json() as { token: string }).token;
  for (const tok of [ownerToken, managerToken, accountantToken, cashierToken, clerkToken]) {
    const jti = verifySessionToken(tok)?.jti;
    if (jti) createdSessionJtis.push(jti);
  }

  // Versioned v1.<kid>.<payload>.<sig> session token format (L-06)
  expect(ownerToken.startsWith("v1.")).toBe(true);
  expect(ownerToken.split(".").length).toBe(4);

  const setCookie = logins[0].headers["set-cookie"];
  const rawCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie ?? "";
  ownerCookie = rawCookie.split(";")[0] ?? "";
  expect(ownerCookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
});

afterAll(async () => {
  resetLoginLockouts();
  if (createdSessionJtis.length > 0) {
    await db.delete(userSessions).where(inArray(userSessions.jti, createdSessionJtis));
  }
  await app.close();
  await pool.end();
});

describe("SupermarketOS OWASP Security Hardening Suite", () => {
  it("enforces dual-tier per-(username,ip) + global PIN lockout (without cross-IP DoS) and supports owner unlock", async () => {
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
      // 4 bad PINs from IP 10.10.0.1 -> 401
      for (let i = 1; i <= 4; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          remoteAddress: "10.10.0.1",
          payload: { username: tempUser, pin: "0000" },
        });
        expect(res.statusCode).toBe(401);
      }

      // 5th bad PIN from IP 10.10.0.1 locks (tempUser, 10.10.0.1) -> 429
      const fifth = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        remoteAddress: "10.10.0.1",
        payload: { username: tempUser, pin: "0000" },
      });
      expect(fifth.statusCode).toBe(429);
      expect(Number(fifth.headers["retry-after"])).toBeGreaterThan(60);

      // Legitimate POS lane on a different IP (10.10.0.99) is NOT DoS-blocked
      const legitimateLane = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        remoteAddress: "10.10.0.99",
        payload: { username: tempUser, pin: "8421" },
      });
      expect(legitimateLane.statusCode).toBe(200);

      // Distributed rotating-IP attack (reaching 15 total failures) triggers global lock
      for (let i = 2; i <= 11; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          remoteAddress: `10.10.0.${i}`,
          payload: { username: tempUser, pin: "0000" },
        });
        expect([401, 429]).toContain(res.statusCode);
      }
      const blockedGlobally = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        remoteAddress: "10.10.0.88",
        payload: { username: tempUser, pin: "8421" },
      });
      expect(blockedGlobally.statusCode).toBe(429);

      // Owner unlocks account via POST /api/admin/users/:id/unlock -> succeeds immediately
      const unlockRes = await app.inject({
        method: "POST",
        url: `/api/admin/users/${createdId}/unlock`,
        headers: authHeaders(),
        payload: {},
      });
      expect(unlockRes.statusCode).toBe(200);

      const afterUnlock = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        remoteAddress: "10.10.0.1",
        payload: { username: tempUser, pin: "8421" },
      });
      expect(afterUnlock.statusCode).toBe(200);

      // Verify immutable auth_lockout & auth_unlock audit events were written
      const lockoutAudits = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.entityId, createdId));
      expect(lockoutAudits.some((a) => a.action === "auth_lockout")).toBe(true);
      expect(lockoutAudits.some((a) => a.action === "auth_unlock")).toBe(true);
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

  it("enforces Wave 2A hardening: cookie-only default login, change-pin lockout, credential policy, RBAC DTO scoping, generic 403s, and role-change session revocation", async () => {
    // 1. Default browser login omits raw token from JSON body (cookie-only isolation — H-13)
    const webLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "owner", pin: "1111" },
    });
    expect(webLogin.statusCode).toBe(200);
    expect((webLogin.json() as { token?: string }).token).toBeUndefined();
    expect(String(webLogin.headers["set-cookie"] ?? "")).toContain(`${SESSION_COOKIE_NAME}=`);

    // 2. Generic 403 does not enumerate internal allowed roles & /api/openapi.json requires auth (M-16)
    const forbidden = await app.inject({
      method: "GET",
      url: "/api/admin/users",
      headers: authHeaders(cashierToken),
    });
    expect(forbidden.statusCode).toBe(403);
    expect(JSON.stringify(forbidden.json())).not.toContain("Allowed:");

    const unauthOpenApi = await app.inject({ method: "GET", url: "/api/openapi.json" });
    expect(unauthOpenApi.statusCode).toBe(401);
    const cashierOpenApi = await app.inject({
      method: "GET",
      url: "/api/openapi.json",
      headers: authHeaders(cashierToken),
    });
    expect(cashierOpenApi.statusCode).toBe(403);

    // 3. RBAC sensitive-data DTO scoping (H-15)
    const [cashierMeta, cashierProds, cashierBoot, cashierRecent, cashierSemantic, clerkSemantic] =
      await Promise.all([
        app.inject({ method: "GET", url: "/api/meta", headers: authHeaders(cashierToken) }),
        app.inject({ method: "GET", url: "/api/products?page=1&pageSize=10", headers: authHeaders(cashierToken) }),
        app.inject({ method: "GET", url: "/api/pos/bootstrap", headers: authHeaders(cashierToken) }),
        app.inject({ method: "GET", url: "/api/pos/recent-sales", headers: authHeaders(cashierToken) }),
        app.inject({ method: "GET", url: "/api/ai/search/semantic?q=beer", headers: authHeaders(cashierToken) }),
        app.inject({ method: "GET", url: "/api/ai/search/semantic?q=beer", headers: authHeaders(clerkToken) }),
      ]);
    expect(cashierMeta.statusCode).toBe(200);
    expect(cashierMeta.json().suppliers).toEqual([]);
    expect(cashierProds.statusCode).toBe(200);
    expect(cashierProds.json().items[0].avgCostCents).toBeUndefined();
    expect(cashierProds.json().items[0].marginBp).toBeUndefined();
    expect(cashierBoot.statusCode).toBe(200);
    expect(cashierBoot.json().products[0].avgCostCents).toBeUndefined();
    expect(cashierRecent.statusCode).toBe(200);
    for (const s of cashierRecent.json().sales as { totalCostCents?: number; lines: { unitCostCents?: number }[] }[]) {
      expect(s.totalCostCents).toBeUndefined();
      for (const l of s.lines) expect(l.unitCostCents).toBeUndefined();
    }
    expect(cashierSemantic.statusCode).toBe(403);
    expect(clerkSemantic.statusCode).toBe(200);
    if (clerkSemantic.json().items.length > 0) {
      expect(clerkSemantic.json().items[0].avgCostCents).toBeUndefined();
    }

    // 3b. Uniform cost redaction from stock_clerk, cashier coupon/PII lock & manager settlement restriction (AUD-014)
    const [
      ownerBoot,
      clerkExpiry,
      clerkPhantom,
      clerkMarkdowns,
      clerkRecipes,
      cashierCoupons,
      cashierCustEmpty,
      cashierCustWildcard,
      mgrSettlementPatch,
    ] = await Promise.all([
      app.inject({ method: "GET", url: "/api/pos/bootstrap", headers: authHeaders(ownerToken) }),
      app.inject({ method: "GET", url: "/api/inventory/expiry-alerts", headers: authHeaders(clerkToken) }),
      app.inject({ method: "GET", url: "/api/inventory/phantom-stock", headers: authHeaders(clerkToken) }),
      app.inject({ method: "GET", url: "/api/inventory/dynamic-markdowns", headers: authHeaders(clerkToken) }),
      app.inject({ method: "GET", url: "/api/operations/recipes", headers: authHeaders(clerkToken) }),
      app.inject({ method: "GET", url: "/api/loyalty/coupons", headers: authHeaders(cashierToken) }),
      app.inject({ method: "GET", url: "/api/loyalty/customers", headers: authHeaders(cashierToken) }),
      app.inject({ method: "GET", url: "/api/loyalty/customers?search=%25%25%25", headers: authHeaders(cashierToken) }),
      app.inject({
        method: "PATCH",
        url: "/api/store-settings",
        headers: authHeaders(managerToken),
        payload: { khqrAccountId: "hijack@evilbank" },
      }),
    ]);
    expect(ownerBoot.statusCode).toBe(200);
    expect(ownerBoot.json().products[0].avgCostCents).toBeUndefined();
    expect(clerkExpiry.statusCode).toBe(200);
    for (const item of clerkExpiry.json().items as { unitCostCents?: number; atRiskCostCents?: number }[]) {
      expect(item.unitCostCents).toBeUndefined();
      expect(item.atRiskCostCents).toBeUndefined();
    }
    expect(clerkPhantom.statusCode).toBe(200);
    expect(clerkPhantom.json().summary.openAtRiskCents).toBeUndefined();
    for (const item of clerkPhantom.json().items as { avgCostCents?: number; estimatedValueAtRiskCents?: number }[]) {
      expect(item.avgCostCents).toBeUndefined();
      expect(item.estimatedValueAtRiskCents).toBeUndefined();
    }
    expect(clerkMarkdowns.statusCode).toBe(200);
    for (const item of clerkMarkdowns.json().items as { unitCostCents?: number }[]) {
      expect(item.unitCostCents).toBeUndefined();
    }
    expect(clerkRecipes.statusCode).toBe(200);
    for (const rec of clerkRecipes.json().recipes as { estimatedBatchCostCents?: number; ingredients: { avgCostCents?: number; estimatedLineCostCents?: number }[] }[]) {
      expect(rec.estimatedBatchCostCents).toBeUndefined();
      for (const ing of rec.ingredients) {
        expect(ing.avgCostCents).toBeUndefined();
        expect(ing.estimatedLineCostCents).toBeUndefined();
      }
    }
    expect(cashierCoupons.statusCode).toBe(403);
    expect(cashierCustEmpty.statusCode).toBe(200);
    expect(cashierCustEmpty.json().customers).toEqual([]);
    expect(cashierCustWildcard.statusCode).toBe(200);
    expect(cashierCustWildcard.json().customers).toEqual([]);
    expect(mgrSettlementPatch.statusCode).toBe(403);

    // 4. Weak PIN denylist & privileged 8+ char credential policy (H-13)
    const weakPinRes = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: authHeaders(),
      payload: { username: "weak_pin_test", fullName: "Weak Pin", role: "cashier", pin: "5555" },
    });
    expect(weakPinRes.statusCode).toBe(400);

    const shortMgrPinRes = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: authHeaders(),
      payload: { username: "short_mgr_test", fullName: "Short Mgr", role: "manager", pin: "7392" },
    });
    expect(shortMgrPinRes.statusCode).toBe(400);

    // 5. Versioned scrypt hash, role-change session revocation (M-15), and change-pin lockout (H-12)
    const tempUser = `sec_w2a_${Date.now().toString().slice(-6)}`;
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: authHeaders(),
      payload: { username: tempUser, fullName: "Wave2A Tester", role: "cashier", pin: "7392" },
    });
    expect(created.statusCode).toBe(201);
    const createdId = (created.json() as { user: { id: string } }).user.id;

    try {
      const [dbUser] = await db.select().from(users).where(eq(users.id, createdId));
      expect(dbUser.pinHash.startsWith("scrypt$N=32768")).toBe(true);

      const login1 = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: tempUser, pin: "7392", includeToken: true },
      });
      expect(login1.statusCode).toBe(200);
      const tok1 = (login1.json() as { token: string }).token;

      // Role change must revoke existing session immediately (M-15)
      const rolePatch = await app.inject({
        method: "PATCH",
        url: `/api/admin/users/${createdId}`,
        headers: authHeaders(),
        payload: { role: "stock_clerk" },
      });
      expect(rolePatch.statusCode).toBe(200);
      expect(rolePatch.json().sessionsRevoked).toBeGreaterThanOrEqual(1);

      const afterRoleCheck = await app.inject({
        method: "GET",
        url: "/api/products?page=1&pageSize=10",
        headers: authHeaders(tok1),
      });
      expect(afterRoleCheck.statusCode).toBe(401);

      // Re-login and brute-force change-pin -> 5th bad currentPin triggers 429 lockout & revokes session (H-12)
      const login2 = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: tempUser, pin: "7392", includeToken: true },
      });
      const tok2 = (login2.json() as { token: string }).token;

      for (let i = 0; i < 4; i++) {
        const bad = await app.inject({
          method: "POST",
          url: "/api/auth/change-pin",
          headers: authHeaders(tok2),
          payload: { currentPin: "9871", newPin: "4826" },
        });
        expect(bad.statusCode).toBe(401);
      }
      const locked = await app.inject({
        method: "POST",
        url: "/api/auth/change-pin",
        headers: authHeaders(tok2),
        payload: { currentPin: "9871", newPin: "4826" },
      });
      expect(locked.statusCode).toBe(429);

      // Active session revoked upon lockout
      const afterLockout = await app.inject({
        method: "GET",
        url: "/api/products?page=1&pageSize=10",
        headers: authHeaders(tok2),
      });
      expect(afterLockout.statusCode).toBe(401);
    } finally {
      resetLoginLockouts();
      await db.delete(userSessions).where(eq(userSessions.userId, createdId));
      await db.delete(auditLogs).where(eq(auditLogs.entityId, createdId));
      await db.delete(users).where(eq(users.id, createdId));
    }
  });
});
