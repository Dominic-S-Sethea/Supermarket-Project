import { buildValidEan13, generateUuidV7 } from "@supermarket/shared";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeCopilotTool } from "../ai/tools.js";
import { buildApp } from "../app.js";
import {
  aiBriefings,
  aiConversations,
  aiProposedActions,
  analyticsDynamicMarkdowns,
  analyticsPhantomStock,
  auditLogs,
  customers,
  db,
  goodsReceipts,
  grnVariances,
  hourlyStockSnapshots,
  inventoryBatches,
  loyaltyLedger,
  marginAlerts,
  pool,
  posShifts,
  productBarcodes,
  products,
  promotions,
  purchaseOrderLines,
  purchaseOrders,
  sales,
  shelfTagQueue,
  shiftExperiments,
  shiftRosters,
  stockMovements,
  storeFootfall,
  storeTasks,
  targetedCoupons,
  users,
} from "../db/index.js";
import { SESSION_COOKIE_NAME } from "../plugins/auth.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let ownerToken = "";
let cashierToken = "";
let ownerCookie = "";

beforeAll(async () => {
  app = await buildApp(false);
  await app.ready();

  const [ownerLogin, cashierLogin] = await Promise.all([
    app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "owner", pin: "1111" },
    }),
    app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "cashier1", pin: "1234" },
    }),
  ]);
  expect(ownerLogin.statusCode).toBe(200);
  expect(cashierLogin.statusCode).toBe(200);
  ownerToken = (ownerLogin.json() as { token: string }).token;
  cashierToken = (cashierLogin.json() as { token: string }).token;
  const setCookie = ownerLogin.headers["set-cookie"];
  const rawCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie ?? "";
  ownerCookie = rawCookie.split(";")[0] ?? `${SESSION_COOKIE_NAME}=${encodeURIComponent(ownerToken)}`;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

const authHeaders = (token = ownerToken) => ({ authorization: `Bearer ${token}` });

describe("SupermarketOS API integration (against live PostgreSQL 3,120-SKU DB)", () => {
  it("enforces authentication and RBAC role boundaries", async () => {
    const unauth = await app.inject({ method: "GET", url: "/api/products" });
    expect(unauth.statusCode).toBe(401);

    const cashierForbiddenLp = await app.inject({
      method: "GET",
      url: "/api/analytics/loss-prevention",
      headers: authHeaders(cashierToken),
    });
    expect(cashierForbiddenLp.statusCode).toBe(403);

    const cashierForbiddenAi = await app.inject({
      method: "POST",
      url: "/api/ai/chat",
      headers: authHeaders(cashierToken),
      payload: { message: "hello" },
    });
    expect(cashierForbiddenAi.statusCode).toBe(403);

    // Cashiers must also be blocked from executive financial analytics & briefing (which contains LP flags)
    for (const url of [
      "/api/analytics/overview",
      "/api/analytics/departments",
      "/api/analytics/abc-xyz",
      "/api/analytics/forecasts",
      "/api/analytics/shift-diagnostics",
      "/api/ai/briefing",
    ]) {
      const res = await app.inject({
        method: "GET",
        url,
        headers: authHeaders(cashierToken),
      });
      expect(res.statusCode).toBe(403);
    }

    // GET /api/meta returns staff roster only for owner/manager, empty array for cashier
    const [ownerMeta, cashierMeta] = await Promise.all([
      app.inject({ method: "GET", url: "/api/meta", headers: authHeaders(ownerToken) }),
      app.inject({ method: "GET", url: "/api/meta", headers: authHeaders(cashierToken) }),
    ]);
    expect(ownerMeta.statusCode).toBe(200);
    expect(ownerMeta.json().staff.length).toBeGreaterThanOrEqual(5);
    expect(cashierMeta.statusCode).toBe(200);
    expect(cashierMeta.json().staff).toEqual([]);
  });

  it("enforces security headers, CSRF origin checks, safe cookie parsing, and live user deactivation", async () => {
    // 1. Security headers present on responses
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.headers["x-content-type-options"]).toBe("nosniff");
    expect(health.headers["x-frame-options"]).toBe("DENY");
    expect(health.headers["content-security-policy"]).toContain("frame-ancestors 'none'");

    // 2. Malformed percent-encoded Cookie header must not throw 500 URIError
    const malformedCookie = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: "broken=%E0%A4%A; smos_session=bad" },
    });
    expect(malformedCookie.statusCode).toBe(200);
    expect(malformedCookie.json().user).toBeNull();

    // 3. CSRF origin check blocks cookie-authenticated POST from untrusted or missing Origin
    const csrfBadOrigin = await app.inject({
      method: "POST",
      url: "/api/pos/shifts/open",
      headers: {
        cookie: ownerCookie,
        origin: "https://evil.example",
      },
      payload: { registerCode: "REG-CSRF" },
    });
    expect(csrfBadOrigin.statusCode).toBe(403);

    const csrfMissingOrigin = await app.inject({
      method: "POST",
      url: "/api/pos/shifts/open",
      headers: { cookie: ownerCookie },
      payload: { registerCode: "REG-CSRF" },
    });
    expect(csrfMissingOrigin.statusCode).toBe(403);

    // 4. Untrusted CORS origin returns 403 (not 500)
    const badCors = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { origin: "https://evil.example" },
    });
    expect(badCors.statusCode).toBe(403);

    // 5. Repaired cashier4 & cashier5 seed accounts can authenticate cleanly
    const c4Login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "cashier4", pin: "4567" },
    });
    expect(c4Login.statusCode).toBe(200);
    const c4Token = (c4Login.json() as { token: string }).token;
    const c4User = (c4Login.json() as { user: { id: string } }).user;

    // 6. Deactivating user in DB immediately invalidates active session token
    await db.update(users).set({ active: false }).where(eq(users.id, c4User.id));
    try {
      const revokedMe = await app.inject({
        method: "GET",
        url: "/api/products?page=1&pageSize=10",
        headers: authHeaders(c4Token),
      });
      expect(revokedMe.statusCode).toBe(401);
    } finally {
      await db.update(users).set({ active: true }).where(eq(users.id, c4User.id));
    }

    // 7. Invalid UUID and NaN query parameters return clean 400/200 without 500 error leakage
    const badUuid = await app.inject({
      method: "GET",
      url: "/api/products?categoryId=not-a-uuid",
      headers: authHeaders(),
    });
    expect(badUuid.statusCode).toBe(400);

    const nanDaysExpiry = await app.inject({
      method: "GET",
      url: "/api/inventory/expiry-alerts?days=abc",
      headers: authHeaders(),
    });
    expect(nanDaysExpiry.statusCode).toBe(200);
    expect(nanDaysExpiry.json().horizonDays).toBe(60);

    const nanDaysOverview = await app.inject({
      method: "GET",
      url: "/api/analytics/overview?days=abc",
      headers: authHeaders(),
    });
    expect(nanDaysOverview.statusCode).toBe(200);
    expect(nanDaysOverview.json().days).toBe(30);
  });

  it("returns 3,000+ packaged products and resolves a multi-UOM pack barcode", async () => {
    const listRes = await app.inject({
      method: "GET",
      url: "/api/products?page=1&pageSize=10",
      headers: authHeaders(),
    });
    expect(listRes.statusCode).toBe(200);
    const list = listRes.json() as {
      total: number;
      items: { id: string; barcodes: { barcode: string; packQty: number }[] }[];
    };
    expect(list.total).toBeGreaterThanOrEqual(3000);

    const sampleBarcode = list.items[0].barcodes[0].barcode;
    const scanRes = await app.inject({
      method: "GET",
      url: `/api/products/scan/${sampleBarcode}`,
      headers: authHeaders(cashierToken),
    });
    expect(scanRes.statusCode).toBe(200);
    const scanned = scanRes.json() as { productId: string; packQty: number };
    expect(scanned.productId).toBe(list.items[0].id);
    expect(scanned.packQty).toBeGreaterThanOrEqual(1);
  });

  it("enforces offline-first POS sale idempotency, pricing/age guards, duplicate receipt 409, and concurrent FEFO batch depletion", async () => {
    const listRes = await app.inject({
      method: "GET",
      url: "/api/products?page=1&pageSize=1",
      headers: authHeaders(),
    });
    const prod = listRes.json().items[0];
    const bc = prod.barcodes[0];

    const [firstBatch] = await db
      .select()
      .from(inventoryBatches)
      .where(and(eq(inventoryBatches.productId, prod.id), eq(inventoryBatches.status, "active")))
      .orderBy(inventoryBatches.bestBeforeDate, inventoryBatches.id)
      .limit(1);
    const origQty = firstBatch?.qtyRemaining ?? 0;

    const saleId = generateUuidV7();
    const receiptNo = `TEST-IDEMP-${saleId.slice(-8)}`;
    const basePayload = {
      id: saleId,
      registerCode: "REG-TEST",
      receiptNo,
      kind: "sale",
      soldAt: new Date().toISOString(),
      ageVerified: Boolean(prod.requiresAgeCheck),
      lines: [
        {
          id: generateUuidV7(),
          productId: prod.id,
          scannedBarcode: bc.barcode,
          packLabel: bc.packLabel,
          packQty: bc.packQty,
          qtyPacks: 1,
          unitPriceCents: bc.sellPriceCents,
          unitCostCents: prod.avgCostCents,
          discountCents: 0,
          taxRateBp: 0,
          taxCents: 0,
          lineTotalCents: bc.sellPriceCents,
        },
      ],
      payments: [
        {
          id: generateUuidV7(),
          method: "cash",
          amountCents: bc.sellPriceCents,
        },
      ],
    };

    // Unverified age-restricted sale -> 400 rejected
    if (prod.requiresAgeCheck) {
      const unverifiedAge = await app.inject({
        method: "POST",
        url: "/api/pos/sales",
        headers: authHeaders(cashierToken),
        payload: { ...basePayload, ageVerified: false },
      });
      expect(unverifiedAge.statusCode).toBe(400);
    }

    // Tampered lineTotalCents (paying 1c for full-price item with 0 discount) -> 400 rejected
    const tamperedTotal = await app.inject({
      method: "POST",
      url: "/api/pos/sales",
      headers: authHeaders(cashierToken),
      payload: {
        ...basePayload,
        lines: [{ ...basePayload.lines[0], lineTotalCents: 1 }],
        payments: [{ id: generateUuidV7(), method: "cash", amountCents: 1 }],
      },
    });
    expect(tamperedTotal.statusCode).toBe(400);

    // Underpaid sale -> 400 rejected
    const underpaid = await app.inject({
      method: "POST",
      url: "/api/pos/sales",
      headers: authHeaders(cashierToken),
      payload: {
        ...basePayload,
        payments: [{ id: generateUuidV7(), method: "cash", amountCents: 1 }],
      },
    });
    expect(underpaid.statusCode).toBe(400);

    // First upload -> 201 Created
    const first = await app.inject({
      method: "POST",
      url: "/api/pos/sales",
      headers: authHeaders(cashierToken),
      payload: basePayload,
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().duplicate).toBe(false);

    // Retry upload with identical client UUIDv7 -> 200 duplicate: true
    const retry = await app.inject({
      method: "POST",
      url: "/api/pos/sales",
      headers: authHeaders(cashierToken),
      payload: basePayload,
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().duplicate).toBe(true);

    // Duplicate receiptNo with a DIFFERENT sale UUID -> 409 Conflict (not 500)
    const dupReceipt = await app.inject({
      method: "POST",
      url: "/api/pos/sales",
      headers: authHeaders(cashierToken),
      payload: {
        ...basePayload,
        id: generateUuidV7(),
        lines: [{ ...basePayload.lines[0], id: generateUuidV7() }],
        payments: [{ ...basePayload.payments[0], id: generateUuidV7() }],
      },
    });
    expect(dupReceipt.statusCode).toBe(409);

    // Concurrent checkouts on the same FEFO batch do not lose decrements
    const concAId = generateUuidV7();
    const concBId = generateUuidV7();
    const makeConcSale = (id: string, suffix: string) => ({
      ...basePayload,
      id,
      receiptNo: `TEST-CONC-${suffix}-${id.slice(-6)}`,
      lines: [{ ...basePayload.lines[0], id: generateUuidV7() }],
      payments: [{ ...basePayload.payments[0], id: generateUuidV7() }],
    });
    const [concA, concB] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/pos/sales",
        headers: authHeaders(cashierToken),
        payload: makeConcSale(concAId, "A"),
      }),
      app.inject({
        method: "POST",
        url: "/api/pos/sales",
        headers: authHeaders(cashierToken),
        payload: makeConcSale(concBId, "B"),
      }),
    ]);
    expect(concA.statusCode).toBe(201);
    expect(concB.statusCode).toBe(201);

    if (firstBatch && origQty >= bc.packQty * 3) {
      const [afterBatch] = await db
        .select()
        .from(inventoryBatches)
        .where(eq(inventoryBatches.id, firstBatch.id));
      expect(afterBatch.qtyRemaining).toBe(origQty - bc.packQty * 3);
      await db
        .update(inventoryBatches)
        .set({ qtyRemaining: origQty, status: firstBatch.status })
        .where(eq(inventoryBatches.id, firstBatch.id));
    }

    // Void once succeeds for manager/owner, second void for same originalSaleId -> 409 Conflict
    const void1Id = generateUuidV7();
    const void1 = await app.inject({
      method: "POST",
      url: "/api/pos/sales",
      headers: authHeaders(ownerToken),
      payload: {
        ...basePayload,
        id: void1Id,
        receiptNo: `TEST-VOID1-${void1Id.slice(-6)}`,
        kind: "void",
        originalSaleId: saleId,
        lines: [{ ...basePayload.lines[0], id: generateUuidV7() }],
        payments: [{ ...basePayload.payments[0], id: generateUuidV7() }],
      },
    });
    expect(void1.statusCode).toBe(201);

    const void2Id = generateUuidV7();
    const void2 = await app.inject({
      method: "POST",
      url: "/api/pos/sales",
      headers: authHeaders(ownerToken),
      payload: {
        ...basePayload,
        id: void2Id,
        receiptNo: `TEST-VOID2-${void2Id.slice(-6)}`,
        kind: "void",
        originalSaleId: saleId,
        lines: [{ ...basePayload.lines[0], id: generateUuidV7() }],
        payments: [{ ...basePayload.payments[0], id: generateUuidV7() }],
      },
    });
    expect(void2.statusCode).toBe(409);

    const cleanupSaleIds = [saleId, concAId, concBId, void1Id];
    await db.delete(stockMovements).where(inArray(stockMovements.refId, cleanupSaleIds));
    await db.delete(sales).where(inArray(sales.id, cleanupSaleIds));
  });

  it("handles GRN bonus cases, partial->full PO receipt tracking, tax-aware margin alerts, multi-pack scaling, and persistent POs", async () => {
    const metaRes = await app.inject({
      method: "GET",
      url: "/api/meta",
      headers: authHeaders(),
    });
    expect(metaRes.statusCode).toBe(200);
    const meta = metaRes.json() as { suppliers: { id: string }[] };
    const prodRes = await app.inject({
      method: "GET",
      url: "/api/products?page=1&pageSize=1",
      headers: authHeaders(),
    });
    const prod = prodRes.json().items[0] as {
      id: string;
      avgCostCents: number;
      barcodes: { id: string; isPrimary: boolean; sellPriceCents: number }[];
    };
    const origAvgCost = prod.avgCostCents;
    const origPrices = prod.barcodes.map((b) => ({ id: b.id, sellPriceCents: b.sellPriceCents }));

    // 1. Create a persistent PO for 3 cases
    const poRes = await app.inject({
      method: "POST",
      url: "/api/purchasing/orders",
      headers: authHeaders(),
      payload: {
        supplierId: meta.suppliers[0].id,
        notes: "Test PO",
        lines: [
          {
            productId: prod.id,
            caseQty: 24,
            orderedCases: 3,
            unitCostCents: origAvgCost,
          },
        ],
      },
    });
    expect(poRes.statusCode).toBe(201);
    const po = poRes.json() as { id: string; status: string };
    expect(po.status).toBe("approved");

    // 1b. Zero-case GRN rejected with 400
    const badGrn = await app.inject({
      method: "POST",
      url: "/api/purchasing/grn",
      headers: authHeaders(),
      payload: {
        supplierId: meta.suppliers[0].id,
        poId: po.id,
        invoiceNumber: `TEST-ZERO-${Date.now()}`,
        lines: [
          {
            productId: prod.id,
            caseQty: 24,
            paidCases: 0,
            freeBonusCases: 0,
            invoiceLineTotalCents: 0,
          },
        ],
      },
    });
    expect(badGrn.statusCode).toBe(400);

    // 2. Receive partial GRN (1 paid + 1 bonus = 2 of 3 cases) with high invoice cost to trigger margin alert
    const inv1 = `TEST-GRN-${Date.now()}`;
    const grnRes = await app.inject({
      method: "POST",
      url: "/api/purchasing/grn",
      headers: authHeaders(),
      payload: {
        supplierId: meta.suppliers[0].id,
        poId: po.id,
        invoiceNumber: inv1,
        lines: [
          {
            productId: prod.id,
            caseQty: 24,
            paidCases: 1,
            freeBonusCases: 1,
            invoiceLineTotalCents: 24 * 2 * Math.max(500, origAvgCost * 4),
            bestBeforeDate: "2027-06-01",
          },
        ],
      },
    });
    expect(grnRes.statusCode).toBe(201);
    const grnBody = grnRes.json() as { grnId: string; marginAlertsTriggered: number };
    expect(grnBody.marginAlertsTriggered).toBeGreaterThanOrEqual(1);

    // Verify PO moved to partially_received and PO line receivedCases incremented to 2
    const [poAfterPartial] = await db
      .select()
      .from(purchaseOrders)
      .where(eq(purchaseOrders.id, po.id));
    expect(poAfterPartial.status).toBe("partially_received");
    const [poLineAfterPartial] = await db
      .select()
      .from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.poId, po.id));
    expect(poLineAfterPartial.receivedCases).toBe(2);

    // 3. Apply suggested price -> rejects negative customPriceCents, then resolves alert and scales multi-pack barcodes
    const [createdAlert] = await db
      .select()
      .from(marginAlerts)
      .where(and(eq(marginAlerts.grnId, grnBody.grnId), eq(marginAlerts.resolved, false)))
      .limit(1);
    expect(createdAlert).toBeDefined();

    const badPrice = await app.inject({
      method: "POST",
      url: `/api/inventory/margin-alerts/${createdAlert.id}/apply-price`,
      headers: authHeaders(),
      payload: { customPriceCents: -100 },
    });
    expect(badPrice.statusCode).toBe(400);

    const applyRes = await app.inject({
      method: "POST",
      url: `/api/inventory/margin-alerts/${createdAlert.id}/apply-price`,
      headers: authHeaders(),
      payload: {},
    });
    expect(applyRes.statusCode).toBe(200);
    expect(applyRes.json().updatedPackTiers).toBeGreaterThanOrEqual(1);

    // Clean up test GRN, PO, alerts, movements, batches, shelf tags & restore original prices/cost
    await db.delete(marginAlerts).where(eq(marginAlerts.grnId, grnBody.grnId));
    await db.delete(stockMovements).where(eq(stockMovements.refId, grnBody.grnId));
    await db.delete(inventoryBatches).where(eq(inventoryBatches.lotCode, `GRN-${inv1}`));
    await db.delete(goodsReceipts).where(eq(goodsReceipts.id, grnBody.grnId));
    await db.delete(purchaseOrders).where(eq(purchaseOrders.id, po.id));
    await db
      .delete(shelfTagQueue)
      .where(and(eq(shelfTagQueue.productId, prod.id), eq(shelfTagQueue.reason, "cost_change")));
    await db
      .update(products)
      .set({ avgCostCents: origAvgCost })
      .where(eq(products.id, prod.id));
    for (const op of origPrices) {
      await db
        .update(productBarcodes)
        .set({ sellPriceCents: op.sellPriceCents })
        .where(eq(productBarcodes.id, op.id));
    }
  });

  it("supports blind shift open/close, quoted CSV preview, empty PATCH rejection, and sanitized ZPL generation", async () => {
    const openRes = await app.inject({
      method: "POST",
      url: "/api/pos/shifts/open",
      headers: authHeaders(cashierToken),
      payload: { registerCode: "REG-TEST-SHIFT", openingFloatCents: 25000 },
    });
    expect([200, 201]).toContain(openRes.statusCode);
    const shiftId = (openRes.json() as { id: string }).id;

    const closeRes = await app.inject({
      method: "POST",
      url: "/api/pos/shifts/close",
      headers: authHeaders(cashierToken),
      payload: { registerCode: "REG-TEST-SHIFT", blindCountedCashCents: 25000 },
    });
    expect(closeRes.statusCode).toBe(200);
    expect(closeRes.json().expectedCashCents).toBe(25000);
    expect(closeRes.json().varianceCents).toBe(0);

    await db.delete(posShifts).where(eq(posShifts.id, shiftId));

    const validEan = buildValidEan13("885", 991122);
    const csvRes = await app.inject({
      method: "POST",
      url: "/api/import/preview",
      headers: authHeaders(),
      payload: {
        csvText: `sku,name,brand,barcode,pack_qty,pack_label,unit_cost,sell_price,category\nTST-1,"Chips, Salted & Lime",BrandX,${validEan},1,Single,1.00,2.50,Potato Chips`,
      },
    });
    expect(csvRes.statusCode).toBe(200);
    expect(csvRes.json().readyCount).toBe(1);
    expect(csvRes.json().rows[0].name).toBe("Chips, Salted & Lime");

    const listRes = await app.inject({
      method: "GET",
      url: "/api/products?page=1&pageSize=1",
      headers: authHeaders(),
    });
    const firstProd = listRes.json().items[0] as { id: string; barcodes: { id: string }[] };
    const emptyPatch = await app.inject({
      method: "PATCH",
      url: `/api/products/${firstProd.id}/barcodes/${firstProd.barcodes[0].id}`,
      headers: authHeaders(),
      payload: {},
    });
    expect(emptyPatch.statusCode).toBe(400);

    const zplRes = await app.inject({
      method: "POST",
      url: "/api/labels/zpl",
      headers: authHeaders(),
      payload: { productIds: [firstProd.id] },
    });
    expect(zplRes.statusCode).toBe(200);
    expect(zplRes.json().zpl).toContain("^XA");
    expect(zplRes.json().zpl).toContain("^BEN");
  });

  it("runs Embedded AI Copilot chat + atomic HITL proposal execution with double-execute protection and tool input validation", async () => {
    const chatRes = await app.inject({
      method: "POST",
      url: "/api/ai/chat",
      headers: authHeaders(),
      payload: {
        message: "Draft an urgent supplier Purchase Order for critical stockouts",
      },
    });
    expect(chatRes.statusCode).toBe(200);
    const chatData = chatRes.json() as {
      conversationId: string;
      message: { content: string };
      actions: { id: string; actionType: string; status: string }[];
    };
    expect(chatData.message.content.length).toBeGreaterThan(20);
    expect(chatData.actions.length).toBeGreaterThanOrEqual(1);
    const pendingPo = chatData.actions.find(
      (a) => a.actionType === "create_po" && a.status === "pending"
    );
    expect(pendingPo).toBeDefined();

    // Concurrent double-execution must execute exactly once (200 + 409)
    const [exec1, exec2] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/ai/actions/${pendingPo!.id}/execute`,
        headers: authHeaders(),
        payload: {},
      }),
      app.inject({
        method: "POST",
        url: `/api/ai/actions/${pendingPo!.id}/execute`,
        headers: authHeaders(),
        payload: {},
      }),
    ]);
    const statuses = [exec1.statusCode, exec2.statusCode].sort();
    expect(statuses).toEqual([200, 409]);
    const winner = exec1.statusCode === 200 ? exec1 : exec2;
    expect(winner.json().action.status).toBe("executed");
    const createdPoId = winner.json().result.poId as string;
    expect(createdPoId).toBeTruthy();

    // Direct Copilot tool validation against malformed LLM inputs (must return { error }, never throw)
    const [ownerRow] = await db.select().from(users).where(eq(users.username, "owner")).limit(1);
    const toolCtx = {
      conversationId: chatData.conversationId,
      user: {
        id: ownerRow.id,
        username: ownerRow.username,
        fullName: ownerRow.fullName,
        role: "owner" as const,
      },
    };
    const badPromoTool = await executeCopilotTool(
      "propose_promotion",
      {
        name: "Bad Promo",
        promoType: "clearance",
        productIds: ["not-a-uuid-at-all"],
      },
      toolCtx
    );
    expect(badPromoTool.error).toBeTruthy();

    const badUrgencyTool = await executeCopilotTool(
      "get_reorder_alerts",
      { urgency: "invalid_enum" },
      toolCtx
    );
    expect(badUrgencyTool.error).toBeTruthy();

    const emptySearchTool = await executeCopilotTool("search_catalog", { query: "   " }, toolCtx);
    expect(emptySearchTool.error).toBeTruthy();

    // Clean up AI test conversation, PO, proposed actions & audit log
    await db.delete(purchaseOrders).where(eq(purchaseOrders.id, createdPoId));
    await db.delete(aiProposedActions).where(eq(aiProposedActions.conversationId, chatData.conversationId));
    await db.delete(aiConversations).where(eq(aiConversations.id, chatData.conversationId));
    await db.delete(auditLogs).where(eq(auditLogs.entityId, createdPoId));
  });

  it("supports Morning Briefing, Semantic Search, Invoice GRN Scanner, Calibrated Triage (incl. NaN safety) & SSE Streaming CORS guard", async () => {
    // 1. Daily Morning Briefing
    const brRes = await app.inject({
      method: "POST",
      url: "/api/ai/briefing/refresh",
      headers: authHeaders(),
      payload: {},
    });
    expect(brRes.statusCode).toBe(200);
    expect(brRes.json().bullets).toHaveLength(4);
    expect(brRes.json().headline.length).toBeGreaterThan(10);
    await db.delete(aiBriefings).where(eq(aiBriefings.briefingDate, brRes.json().briefingDate));

    // 2. Semantic Catalog Search (sync + query "alcohol free beer")
    const syncRes = await app.inject({
      method: "POST",
      url: "/api/ai/embeddings/sync",
      headers: authHeaders(),
      payload: {},
    });
    expect(syncRes.statusCode).toBe(200);
    expect(syncRes.json().indexedCount).toBeGreaterThanOrEqual(3000);

    const semRes = await app.inject({
      method: "GET",
      url: "/api/ai/search/semantic?q=alcohol+free+beer&limit=10",
      headers: authHeaders(),
    });
    expect(semRes.statusCode).toBe(200);
    const semItems = semRes.json().items as { name: string; similarityScore: number }[];
    expect(semItems.length).toBeGreaterThan(0);
    expect(semItems.some((i) => /0\.0|alcohol-free/i.test(i.name))).toBe(true);

    // 3. Supplier Invoice -> GRN Scanner (including base64 text/plain offline fallback)
    const invText =
      "Supplier: Summit Brewing & Beer Supply\nInvoice: INV-TEST-888\nBEER-0001 Heineken Original | 24 | 10 | 1 | 310.00 | 2027-06-01";
    const invRes = await app.inject({
      method: "POST",
      url: "/api/ai/grn/parse-invoice",
      headers: authHeaders(),
      payload: {
        fileName: "test-invoice.txt",
        mimeType: "text/plain",
        base64Data: Buffer.from(invText, "utf8").toString("base64"),
      },
    });
    expect(invRes.statusCode).toBe(200);
    expect(invRes.json().lines).toHaveLength(1);
    expect(invRes.json().lines[0].freeBonusCases).toBe(1);
    expect(invRes.json().lines[0].matchedSku).toBe("BEER-0001");
    expect(invRes.json().triage.questions.length).toBeGreaterThanOrEqual(2);

    // 4. Calibrated Cashier Triage (valid + malformed NaN metrics safety)
    const triageHigh = await app.inject({
      method: "POST",
      url: "/api/ai/triage",
      headers: authHeaders(),
      payload: {
        targetType: "cashier_anomaly",
        metrics: {
          cashierName: "Jordan Brooks",
          totalSalesCount: 2400,
          voidCount: 165,
          refundCount: 14,
          noSaleDrawerCount: 57,
          voidRatePct: 6.88,
          zScore: 5.5,
        },
      },
    });
    expect(triageHigh.statusCode).toBe(200);
    expect(triageHigh.json().questions[0].verdict).toBe("yes");
    expect(triageHigh.json().questions[0].probability).toBeGreaterThan(0.7);

    const triageNan = await app.inject({
      method: "POST",
      url: "/api/ai/triage",
      headers: authHeaders(),
      payload: {
        targetType: "cashier_anomaly",
        metrics: {
          voidRatePct: "not-a-number",
          zScore: "NaN",
          totalSalesCount: 0,
        },
      },
    });
    expect(triageNan.statusCode).toBe(200);
    for (const q of triageNan.json().questions as { probability: number; confidence: number }[]) {
      expect(Number.isFinite(q.probability)).toBe(true);
      expect(Number.isFinite(q.confidence)).toBe(true);
    }

    // 5. SSE Streaming Copilot Chat (verifies allowed Origin gets ACAO while evil Origin is blocked by CORS 403)
    const liveUrl = await app.listen({ port: 0, host: "127.0.0.1" });
    const badSseRes = await fetch(`${liveUrl}/api/ai/chat/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.example",
        ...authHeaders(),
      },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(badSseRes.status).toBe(403);
    expect(badSseRes.headers.get("access-control-allow-origin")).toBeNull();

    const sseRes = await fetch(`${liveUrl}/api/ai/chat/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:5173",
        ...authHeaders(),
      },
      body: JSON.stringify({ message: "Give me today morning risk briefing" }),
    });
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(sseRes.headers.get("x-content-type-options")).toBe("nosniff");
    const bodyText = await sseRes.text();
    expect(bodyText).toContain('"type":"tool_call"');
    expect(bodyText).toContain('"type":"delta"');
    expect(bodyText).toContain('"type":"done"');
    const convMatch = bodyText.match(/"conversationId":"([^"]+)"/);
    if (convMatch?.[1]) {
      await db.delete(aiConversations).where(eq(aiConversations.id, convMatch[1]));
    }
  });

  it("serves populated Python analytics tables and date-filtered accounting CSV", async () => {
    const [ov, abc, fc, br, lp, csv] = await Promise.all([
      app.inject({
        method: "GET",
        url: "/api/analytics/overview?days=30",
        headers: authHeaders(),
      }),
      app.inject({
        method: "GET",
        url: "/api/analytics/abc-xyz",
        headers: authHeaders(),
      }),
      app.inject({
        method: "GET",
        url: "/api/analytics/forecasts",
        headers: authHeaders(),
      }),
      app.inject({
        method: "GET",
        url: "/api/analytics/basket-rules",
        headers: authHeaders(),
      }),
      app.inject({
        method: "GET",
        url: "/api/analytics/loss-prevention",
        headers: authHeaders(),
      }),
      app.inject({
        method: "GET",
        url: "/api/exports/accounting.csv?days=30",
        headers: authHeaders(),
      }),
    ]);

    expect(ov.statusCode).toBe(200);
    expect(ov.json().kpis.totalSkus).toBeGreaterThanOrEqual(3000);
    expect(ov.json().kpis.grossSalesCents).toBeGreaterThan(0);

    expect(abc.statusCode).toBe(200);
    expect(abc.json().matrix.length).toBeGreaterThanOrEqual(6);

    expect(fc.statusCode).toBe(200);
    expect(fc.json().items.length).toBeGreaterThan(0);
    expect(fc.json().supplierDraftPos.length).toBeGreaterThan(0);

    expect(br.statusCode).toBe(200);
    expect(br.json().rules.length).toBeGreaterThan(0);
    expect(br.json().rules[0].lift).toBeGreaterThan(1.5);

    expect(lp.statusCode).toBe(200);
    expect(lp.json().cashierAnomalies.length).toBe(5);
    expect(lp.json().cashierAnomalies[0].riskLevel).toBe("high");

    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain("Date,Receipts,GrossSalesUSD");
    // Ensure clean audit log state for any unused test IDs
    await db.delete(auditLogs).where(inArray(auditLogs.actor, ["Integration Tester"]));
  });

  it("supports Morning Shift Diagnostics, Footfall Ingestion, Stock Snapshots, DiD Experiments & Copilot Shift Fix", async () => {
    // 1. Read precomputed Shift Diagnostics payload
    const sdRes = await app.inject({
      method: "GET",
      url: "/api/analytics/shift-diagnostics",
      headers: authHeaders(),
    });
    expect(sdRes.statusCode).toBe(200);
    const sd = sdRes.json();
    expect(sd.diagnostics).toBeTruthy();
    expect(sd.diagnostics.shiftComparison.shifts.length).toBeGreaterThanOrEqual(3);
    expect(sd.diagnostics.hourlyProfile.length).toBeGreaterThanOrEqual(10);
    expect(sd.diagnostics.oosRootCauses.length).toBeGreaterThan(0);
    expect(sd.diagnostics.driverAttribution.drivers.length).toBeGreaterThan(0);
    expect(sd.diagnostics.shopperMissions.clusters.length).toBeGreaterThanOrEqual(3);
    expect(sd.morningBasketRules.length).toBeGreaterThan(0);

    // 2. Footfall upsert endpoint
    const testBucket = new Date(Date.now() + 14 * 86400_000);
    testBucket.setMinutes(0, 0, 0);
    const ffRes = await app.inject({
      method: "POST",
      url: "/api/analytics/footfall",
      headers: authHeaders(),
      payload: {
        buckets: [
          {
            bucketStart: testBucket.toISOString(),
            entries: 19,
            exits: 18,
            avgDwellSec: 210,
            openLanes: 1,
            weatherRain: false,
          },
        ],
      },
    });
    expect(ffRes.statusCode).toBe(201);
    expect(ffRes.json().ingestedCount).toBe(1);
    await db.delete(storeFootfall).where(eq(storeFootfall.bucketStart, testBucket));

    // 3. Stock availability snapshot capture
    const snapRes = await app.inject({
      method: "POST",
      url: "/api/analytics/stock-snapshots/capture",
      headers: authHeaders(),
      payload: {},
    });
    expect(snapRes.statusCode).toBe(201);
    expect(snapRes.json().capturedSkus).toBeGreaterThan(0);
    await db
      .delete(hourlyStockSnapshots)
      .where(
        and(
          eq(hourlyStockSnapshots.snapshotDate, snapRes.json().snapshotDate),
          eq(hourlyStockSnapshots.snapshotHour, snapRes.json().snapshotHour)
        )
      );

    // 4. Create & evaluate Difference-in-Differences Shift Experiment
    const fmtAgo = (d: number) => new Date(Date.now() - d * 86400_000).toISOString().slice(0, 10);
    const expRes = await app.inject({
      method: "POST",
      url: "/api/analytics/shift-experiments",
      headers: authHeaders(),
      payload: {
        name: "Integration Test Morning Trial",
        hypothesis: "Testing DiD math against afternoon shift control",
        interventionType: "morning_daypart_promo",
        preStartDate: fmtAgo(35),
        preEndDate: fmtAgo(16),
        postStartDate: fmtAgo(15),
        postEndDate: fmtAgo(2),
      },
    });
    expect(expRes.statusCode).toBe(201);
    expect(expRes.json().resultsJson).toBeTruthy();
    expect(typeof expRes.json().resultsJson.didLiftUsdPerDay).toBe("number");
    await db.delete(shiftExperiments).where(eq(shiftExperiments.id, expRes.json().id));

    // 5. Copilot shift-diagnosis + staged 08:00-12:00 daypart combo promo
    const chatRes = await app.inject({
      method: "POST",
      url: "/api/ai/chat",
      headers: authHeaders(),
      payload: {
        message: "Diagnose why morning shift sales are underperforming and propose a morning combo fix",
      },
    });
    expect(chatRes.statusCode).toBe(200);
    const chatData = chatRes.json() as {
      conversationId: string;
      toolTraces: { tool: string }[];
      actions: { actionType: string; previewJson: { daypartWindow?: string } }[];
    };
    expect(chatData.toolTraces.some((t) => t.tool === "diagnose_shift_performance")).toBe(true);
    const promoAction = chatData.actions.find((a) => a.actionType === "create_promo");
    expect(promoAction).toBeDefined();
    expect(promoAction?.previewJson.daypartWindow).toBe("08:00-12:00");
    await db.delete(aiConversations).where(eq(aiConversations.id, chatData.conversationId));
  });

  it("Milestone 1: serves Supplier OTIF scorecards, auto-detects PO vs GRN short/cost variances, and resolves them with RBAC", async () => {
    // 1. Cashier blocked from scorecards & variances
    const cashierSc = await app.inject({
      method: "GET",
      url: "/api/purchasing/supplier-scorecards",
      headers: authHeaders(cashierToken),
    });
    expect(cashierSc.statusCode).toBe(403);

    const cashierVar = await app.inject({
      method: "GET",
      url: "/api/purchasing/variances",
      headers: authHeaders(cashierToken),
    });
    expect(cashierVar.statusCode).toBe(403);

    // 2. Owner reads seeded Supplier OTIF Scorecards
    const scRes = await app.inject({
      method: "GET",
      url: "/api/purchasing/supplier-scorecards",
      headers: authHeaders(),
    });
    expect(scRes.statusCode).toBe(200);
    const scBody = scRes.json() as {
      summary: { supplierCount: number; avgOtifPct: number };
      scorecards: { supplierId: string; grade: string; otifRatePct: number }[];
    };
    expect(scBody.summary.supplierCount).toBeGreaterThanOrEqual(5);
    expect(scBody.scorecards.length).toBeGreaterThanOrEqual(5);

    // 3. Create PO (4 cases @ origAvgCost) and receive short (2 cases) at +20% unit cost overcharge
    const prodRes = await app.inject({
      method: "GET",
      url: "/api/products?page=1&pageSize=1",
      headers: authHeaders(),
    });
    const prod = prodRes.json().items[0] as { id: string; avgCostCents: number };
    const origAvgCost = prod.avgCostCents;
    const supplierId = scBody.scorecards[0].supplierId;

    const poRes = await app.inject({
      method: "POST",
      url: "/api/purchasing/orders",
      headers: authHeaders(),
      payload: {
        supplierId,
        notes: "M1 3-way variance test PO",
        lines: [
          {
            productId: prod.id,
            caseQty: 10,
            orderedCases: 4,
            unitCostCents: Math.max(100, origAvgCost),
          },
        ],
      },
    });
    expect(poRes.statusCode).toBe(201);
    const po = poRes.json() as { id: string };

    const poUnitCost = Math.max(100, origAvgCost);
    const overchargedUnitCost = Math.round(poUnitCost * 1.25);
    const invNo = `TEST-M1-VAR-${Date.now()}`;
    const grnRes = await app.inject({
      method: "POST",
      url: "/api/purchasing/grn",
      headers: authHeaders(),
      payload: {
        supplierId,
        poId: po.id,
        invoiceNumber: invNo,
        lines: [
          {
            productId: prod.id,
            caseQty: 10,
            paidCases: 2,
            freeBonusCases: 0,
            invoiceLineTotalCents: 20 * overchargedUnitCost,
          },
        ],
      },
    });
    expect(grnRes.statusCode).toBe(201);
    const grnBody = grnRes.json() as { grnId: string; variancesCreated: number };
    expect(grnBody.variancesCreated).toBe(2); // short_delivery + cost_overcharge

    // 4. Query variances endpoint and verify both variance types exist
    const varListRes = await app.inject({
      method: "GET",
      url: `/api/purchasing/variances?status=open&supplierId=${supplierId}`,
      headers: authHeaders(),
    });
    expect(varListRes.statusCode).toBe(200);
    const createdVars = (
      varListRes.json().variances as { id: string; grnId: string; varianceType: string }[]
    ).filter((v) => v.grnId === grnBody.grnId);
    expect(createdVars.map((v) => v.varianceType).sort()).toEqual([
      "cost_overcharge",
      "short_delivery",
    ]);

    // 5. Resolve one variance via PATCH (credit note), verify resolvedAt & audit; cashier blocked
    const targetVar = createdVars[0];
    const cashierPatch = await app.inject({
      method: "PATCH",
      url: `/api/purchasing/variances/${targetVar.id}`,
      headers: authHeaders(cashierToken),
      payload: { status: "disputed" },
    });
    expect(cashierPatch.statusCode).toBe(403);

    const resolveRes = await app.inject({
      method: "PATCH",
      url: `/api/purchasing/variances/${targetVar.id}`,
      headers: authHeaders(),
      payload: {
        status: "resolved_credit_note",
        resolutionNote: "Credit memo CN-9921 issued by distributor",
      },
    });
    expect(resolveRes.statusCode).toBe(200);
    expect(resolveRes.json().variance.status).toBe("resolved_credit_note");
    expect(resolveRes.json().variance.resolvedAt).toBeTruthy();

    // Cleanup test rows and restore avgCostCents
    await db.delete(marginAlerts).where(eq(marginAlerts.grnId, grnBody.grnId));
    await db.delete(stockMovements).where(eq(stockMovements.refId, grnBody.grnId));
    await db.delete(grnVariances).where(eq(grnVariances.grnId, grnBody.grnId));
    await db.delete(goodsReceipts).where(eq(goodsReceipts.id, grnBody.grnId));
    await db.delete(purchaseOrders).where(eq(purchaseOrders.id, po.id));
    await db.update(products).set({ avgCostCents: origAvgCost }).where(eq(products.id, prod.id));
  });

  it("Milestone 2: supports Phantom Stock verification, Dynamic Markdown application (promo + tag), and 07:30 Shelf Tag ZPL print queue with RBAC", async () => {
    const clerkLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "clerk1", pin: "2222" },
    });
    expect(clerkLogin.statusCode).toBe(200);
    const clerkToken = (clerkLogin.json() as { token: string }).token;

    // 1. Phantom stock listing: cashier blocked, clerk allowed
    const cashierPh = await app.inject({
      method: "GET",
      url: "/api/inventory/phantom-stock",
      headers: authHeaders(cashierToken),
    });
    expect(cashierPh.statusCode).toBe(403);

    const phRes = await app.inject({
      method: "GET",
      url: "/api/inventory/phantom-stock",
      headers: authHeaders(clerkToken),
    });
    expect(phRes.statusCode).toBe(200);
    const phBody = phRes.json() as {
      summary: { totalFlagged: number };
      items: {
        productId: string;
        status: string;
        bookStockUnits: number;
        estimatedValueAtRiskCents: number;
      }[];
    };
    expect(phBody.summary.totalFlagged).toBeGreaterThan(0);
    const samplePh = phBody.items[0];

    // Clerk verifies phantom stock OK (non-destructive check, restored right after)
    const verifyRes = await app.inject({
      method: "POST",
      url: `/api/inventory/phantom-stock/${samplePh.productId}/verify`,
      headers: authHeaders(clerkToken),
      payload: { markVerifiedOk: true, note: "Integration test shelf spot-check" },
    });
    expect(verifyRes.statusCode).toBe(200);
    expect(verifyRes.json().status).toBe("verified_ok");

    // Restore original phantom row state
    await db
      .update(analyticsPhantomStock)
      .set({
        status: samplePh.status,
        bookStockUnits: samplePh.bookStockUnits,
        estimatedValueAtRiskCents: samplePh.estimatedValueAtRiskCents,
      })
      .where(eq(analyticsPhantomStock.productId, samplePh.productId));

    // 2. Dynamic markdowns: clerk can view, clerk CANNOT apply (403), owner CAN apply (201)
    const mdRes = await app.inject({
      method: "GET",
      url: "/api/inventory/dynamic-markdowns",
      headers: authHeaders(clerkToken),
    });
    expect(mdRes.statusCode).toBe(200);
    const mdBody = mdRes.json() as {
      items: { batchId: string; recommendedDiscountBp: number; status: string }[];
    };
    expect(mdBody.items.length).toBeGreaterThan(0);
    const sampleMd = mdBody.items[0];
    const [origBatch] = await db
      .select({ status: inventoryBatches.status })
      .from(inventoryBatches)
      .where(eq(inventoryBatches.id, sampleMd.batchId));

    const clerkApply = await app.inject({
      method: "POST",
      url: `/api/inventory/dynamic-markdowns/${sampleMd.batchId}/apply`,
      headers: authHeaders(clerkToken),
      payload: { discountBp: sampleMd.recommendedDiscountBp },
    });
    expect(clerkApply.statusCode).toBe(403);

    const ownerApply = await app.inject({
      method: "POST",
      url: `/api/inventory/dynamic-markdowns/${sampleMd.batchId}/apply`,
      headers: authHeaders(),
      payload: { discountBp: sampleMd.recommendedDiscountBp, minMarginGuardBp: 0 },
    });
    expect(ownerApply.statusCode).toBe(201);
    const applied = ownerApply.json() as {
      promotionId: string;
      shelfTagId: string | null;
      status: string;
    };
    expect(applied.status).toBe("applied");
    expect(applied.shelfTagId).toBeTruthy();

    // 3. 07:30 Shelf Tag Queue: clerk lists pending & prints the newly queued clearance tag -> ZPL
    const queueRes = await app.inject({
      method: "GET",
      url: "/api/labels/queue?status=pending",
      headers: authHeaders(clerkToken),
    });
    expect(queueRes.statusCode).toBe(200);
    const queuedTags = queueRes.json().tags as { id: string }[];
    expect(queuedTags.some((t) => t.id === applied.shelfTagId)).toBe(true);

    const printRes = await app.inject({
      method: "POST",
      url: "/api/labels/queue/print",
      headers: authHeaders(clerkToken),
      payload: { tagIds: [applied.shelfTagId] },
    });
    expect(printRes.statusCode).toBe(200);
    const printed = printRes.json() as { printedCount: number; zpl: string };
    expect(printed.printedCount).toBe(1);
    expect(printed.zpl).toContain("^XA");
    expect(printed.zpl).toContain("CLEARANCE");
    expect(printed.zpl).toContain("^XZ");

    // Cleanup M2 test mutations
    if (applied.shelfTagId) {
      await db.delete(shelfTagQueue).where(eq(shelfTagQueue.id, applied.shelfTagId));
    }
    await db.delete(promotions).where(eq(promotions.id, applied.promotionId));
    await db
      .update(analyticsDynamicMarkdowns)
      .set({ status: sampleMd.status })
      .where(eq(analyticsDynamicMarkdowns.batchId, sampleMd.batchId));
    if (origBatch) {
      await db
        .update(inventoryBatches)
        .set({ status: origBatch.status })
        .where(eq(inventoryBatches.id, sampleMd.batchId));
    }
  });

  it("Milestone 3: supports Loyalty CRM enrollment, single-use coupon concurrency locking, points accrual/clawback, and promo toggling", async () => {
    // 1. Enroll new loyalty customer + duplicate phone 409 check
    const uniquePhone = `555-${String(Date.now()).slice(-7)}`;
    const enrollRes = await app.inject({
      method: "POST",
      url: "/api/loyalty/customers",
      headers: authHeaders(cashierToken),
      payload: {
        phone: uniquePhone,
        fullName: "Test Shopper Loyalty",
        email: "loyalty.test@example.com",
      },
    });
    expect(enrollRes.statusCode).toBe(201);
    const customer = enrollRes.json().customer as { id: string; phone: string };

    const dupEnroll = await app.inject({
      method: "POST",
      url: "/api/loyalty/customers",
      headers: authHeaders(cashierToken),
      payload: { phone: uniquePhone, fullName: "Duplicate Phone" },
    });
    expect(dupEnroll.statusCode).toBe(409);

    // 2. Cashier cannot issue coupons (403); owner issues single-use $2 coupon (min $5)
    const couponCode = `TESTC-${String(Date.now()).slice(-6)}`;
    const cashierIssue = await app.inject({
      method: "POST",
      url: "/api/loyalty/coupons",
      headers: authHeaders(cashierToken),
      payload: { code: couponCode, discountCents: 200, minBasketCents: 500, validDays: 7 },
    });
    expect(cashierIssue.statusCode).toBe(403);

    const issueRes = await app.inject({
      method: "POST",
      url: "/api/loyalty/coupons",
      headers: authHeaders(),
      payload: {
        code: couponCode,
        customerId: customer.id,
        discountCents: 200,
        minBasketCents: 500,
        validDays: 7,
      },
    });
    expect(issueRes.statusCode).toBe(201);
    const issuedCoupon = issueRes.json().coupon as { id: string; code: string };

    // 3. Validate coupon: fails below min basket, passes at $10 with matching customer
    const valLow = await app.inject({
      method: "GET",
      url: `/api/loyalty/coupons/validate/${couponCode}?basketCents=300&customerId=${customer.id}`,
      headers: authHeaders(cashierToken),
    });
    expect(valLow.statusCode).toBe(200);
    expect(valLow.json().valid).toBe(false);

    const valOk = await app.inject({
      method: "GET",
      url: `/api/loyalty/coupons/validate/${couponCode}?basketCents=1000&customerId=${customer.id}`,
      headers: authHeaders(cashierToken),
    });
    expect(valOk.statusCode).toBe(200);
    expect(valOk.json().valid).toBe(true);
    expect(valOk.json().coupon.discountCents).toBe(200);

    // 4. Concurrent double-redemption race on single-use coupon -> strictly one 201 and one 409!
    const bootRes = await app.inject({
      method: "GET",
      url: "/api/pos/bootstrap",
      headers: authHeaders(cashierToken),
    });
    const boot = bootRes.json() as {
      products: { id: string; taxRateId: string; avgCostCents: number; requiresAgeCheck: boolean }[];
      barcodes: { productId: string; barcode: string; packQty: number; packLabel: string; sellPriceCents: number }[];
      taxRates: { id: string; rateBp: number; isInclusive: boolean }[];
    };
    const safeProd = boot.products.find((p) => !p.requiresAgeCheck)!;
    const bc = boot.barcodes.find((b) => b.productId === safeProd.id)!;
    const tax = boot.taxRates.find((t) => t.id === safeProd.taxRateId)!;

    const unitPrice = 1000;
    const discountCents = 200;
    const afterDiscount = unitPrice - discountCents; // 800c
    const lineTax = tax.isInclusive
      ? Math.round((afterDiscount * tax.rateBp) / (10000 + tax.rateBp))
      : Math.round((afterDiscount * tax.rateBp) / 10000);
    const lineTotal = tax.isInclusive ? afterDiscount : afterDiscount + lineTax;

    const makeSalePayload = (saleId: string, rcpt: string) => ({
      id: saleId,
      registerCode: "REG-01",
      receiptNo: rcpt,
      kind: "sale" as const,
      soldAt: new Date().toISOString(),
      ageVerified: false,
      customerId: customer.id,
      couponCode,
      lines: [
        {
          id: generateUuidV7(),
          productId: safeProd.id,
          scannedBarcode: bc.barcode,
          packLabel: bc.packLabel,
          packQty: bc.packQty,
          qtyPacks: 1,
          unitPriceCents: unitPrice,
          unitCostCents: safeProd.avgCostCents,
          discountCents,
          taxRateBp: tax.rateBp,
          taxCents: lineTax,
          lineTotalCents: lineTotal,
        },
      ],
      payments: [
        {
          id: generateUuidV7(),
          method: "card" as const,
          amountCents: lineTotal,
          tenderedCents: lineTotal,
          changeCents: 0,
        },
      ],
    });

    const raceAId = generateUuidV7();
    const raceBId = generateUuidV7();
    const payloadA = makeSalePayload(raceAId, `TEST-CPN-A-${raceAId.slice(-6)}`);
    const payloadB = makeSalePayload(raceBId, `TEST-CPN-B-${raceBId.slice(-6)}`);

    const [resA, resB] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/pos/sales",
        headers: authHeaders(cashierToken),
        payload: payloadA,
      }),
      app.inject({
        method: "POST",
        url: "/api/pos/sales",
        headers: authHeaders(cashierToken),
        payload: payloadB,
      }),
    ]);
    expect([resA.statusCode, resB.statusCode].sort()).toEqual([201, 409]);

    const winnerPayload = resA.statusCode === 201 ? payloadA : payloadB;
    const winnerBody = (resA.statusCode === 201 ? resA : resB).json() as {
      id: string;
      pointsEarned: number;
    };
    expect(winnerBody.pointsEarned).toBe(Math.floor(lineTotal / 100));

    // Idempotent retry of winning sale ID still returns 200 duplicate: true!
    const retryWin = await app.inject({
      method: "POST",
      url: "/api/pos/sales",
      headers: authHeaders(cashierToken),
      payload: winnerPayload,
    });
    expect(retryWin.statusCode).toBe(200);
    expect(retryWin.json().duplicate).toBe(true);

    // 5. Verify customer accrued points and recent-sales includes lines + alreadyVoided=false
    const [custAfterSale] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customer.id));
    expect(custAfterSale.pointsBalance).toBe(Math.floor(lineTotal / 100));

    const recentRes = await app.inject({
      method: "GET",
      url: "/api/pos/recent-sales",
      headers: authHeaders(),
    });
    expect(recentRes.statusCode).toBe(200);
    const recentRow = (
      recentRes.json().sales as { id: string; alreadyVoided: boolean; lines: unknown[] }[]
    ).find((s) => s.id === winnerPayload.id);
    expect(recentRow).toBeDefined();
    expect(recentRow?.alreadyVoided).toBe(false);
    expect(recentRow?.lines.length).toBe(1);

    // 6. Owner voids the sale -> points clawed back to 0
    const voidId = generateUuidV7();
    const voidRes = await app.inject({
      method: "POST",
      url: "/api/pos/sales",
      headers: authHeaders(),
      payload: {
        ...winnerPayload,
        id: voidId,
        receiptNo: `TEST-CPN-VOID-${voidId.slice(-6)}`,
        kind: "void",
        originalSaleId: winnerPayload.id,
        couponCode: null,
        lines: [{ ...winnerPayload.lines[0], id: generateUuidV7() }],
        payments: [{ ...winnerPayload.payments[0], id: generateUuidV7() }],
      },
    });
    expect(voidRes.statusCode).toBe(201);
    const [custAfterVoid] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customer.id));
    expect(custAfterVoid.pointsBalance).toBe(0);

    // 7. Create & toggle a promotion via PATCH /api/promotions/:id
    const promoCreate = await app.inject({
      method: "POST",
      url: "/api/promotions",
      headers: authHeaders(),
      payload: {
        name: "Test M3 Morning Basket Promo",
        promoType: "basket_threshold",
        priority: 30,
        combinable: true,
        minMarginGuardBp: 500,
        daypartStartHour: 8,
        daypartEndHour: 12,
        rulesJson: { minBasketCents: 2000, flatDiscountCents: 200 },
      },
    });
    expect(promoCreate.statusCode).toBe(201);
    const createdPromoId = (promoCreate.json() as { id: string }).id;

    const promoPause = await app.inject({
      method: "PATCH",
      url: `/api/promotions/${createdPromoId}`,
      headers: authHeaders(),
      payload: { active: false },
    });
    expect(promoPause.statusCode).toBe(200);
    expect(promoPause.json().promotion.active).toBe(false);

    // Cleanup test rows
    await db.delete(promotions).where(eq(promotions.id, createdPromoId));
    await db.delete(loyaltyLedger).where(eq(loyaltyLedger.customerId, customer.id));
    await db.delete(targetedCoupons).where(eq(targetedCoupons.id, issuedCoupon.id));
    await db
      .delete(stockMovements)
      .where(inArray(stockMovements.refId, [winnerPayload.id, voidId]));
    await db.delete(sales).where(inArray(sales.id, [voidId, winnerPayload.id]));
    await db.delete(customers).where(eq(customers.id, customer.id));
  });

  it("Milestone 3: supports Hourly Lane Staffing Plan generation/assignment and Daily Floor Task Checklist completion with RBAC", async () => {
    const clerkLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "clerk1", pin: "2222" },
    });
    expect(clerkLogin.statusCode).toBe(200);
    const clerkToken = (clerkLogin.json() as { token: string }).token;

    // 1. Cashier blocked from staffing plan & tasks
    const cashierStaff = await app.inject({
      method: "GET",
      url: "/api/operations/staffing-plan",
      headers: authHeaders(cashierToken),
    });
    expect(cashierStaff.statusCode).toBe(403);

    const cashierTasks = await app.inject({
      method: "GET",
      url: "/api/operations/tasks",
      headers: authHeaders(cashierToken),
    });
    expect(cashierTasks.statusCode).toBe(403);

    // 2. Generate staffing plan for a dedicated test date, assign a cashier, and confirm
    const testPlanDate = "2027-01-15";
    const genRes = await app.inject({
      method: "POST",
      url: "/api/operations/staffing-plan/generate",
      headers: authHeaders(),
      payload: { planDate: testPlanDate },
    });
    expect(genRes.statusCode).toBe(201);
    expect(genRes.json().generatedCount).toBe(14);

    const listPlan = await app.inject({
      method: "GET",
      url: `/api/operations/staffing-plan?date=${testPlanDate}`,
      headers: authHeaders(),
    });
    expect(listPlan.statusCode).toBe(200);
    const planBody = listPlan.json() as {
      staffOptions: { id: string; fullName: string }[];
      slots: { id: string; hour: number }[];
    };
    expect(planBody.slots.length).toBe(14);
    expect(planBody.staffOptions.length).toBeGreaterThan(0);

    const patchSlot = await app.inject({
      method: "PATCH",
      url: `/api/operations/staffing-plan/${planBody.slots[0].id}`,
      headers: authHeaders(),
      payload: {
        assignedStaffId: planBody.staffOptions[0].id,
        status: "confirmed",
        recommendedLanes: 2,
      },
    });
    expect(patchSlot.statusCode).toBe(200);
    expect(patchSlot.json().slot.status).toBe("confirmed");
    expect(patchSlot.json().slot.assignedCashierName).toBe(planBody.staffOptions[0].fullName);

    // 3. Daily Floor Tasks: clerk lists tasks & completes one, then restore original state
    const tasksRes = await app.inject({
      method: "GET",
      url: "/api/operations/tasks?date=all",
      headers: authHeaders(clerkToken),
    });
    expect(tasksRes.statusCode).toBe(200);
    const taskList = tasksRes.json().tasks as {
      id: string;
      status: string;
      completedBy: string | null;
      completedAt: string | null;
      completionNote: string | null;
    }[];
    expect(taskList.length).toBeGreaterThan(0);
    const sampleTask = taskList[0];

    const compRes = await app.inject({
      method: "POST",
      url: `/api/operations/tasks/${sampleTask.id}/complete`,
      headers: authHeaders(clerkToken),
      payload: { note: "Restocked top shelf before 08:00" },
    });
    expect(compRes.statusCode).toBe(200);
    expect(compRes.json().task.status).toBe("completed");
    expect(compRes.json().task.completedBy).toContain("Marcus");

    // Cleanup test staffing plan & restore task state
    await db.delete(shiftRosters).where(eq(shiftRosters.planDate, testPlanDate));
    await db
      .update(storeTasks)
      .set({
        status: sampleTask.status,
        completedBy: sampleTask.completedBy,
        completedAt: sampleTask.completedAt ? new Date(sampleTask.completedAt) : null,
        completionNote: sampleTask.completionNote,
      })
      .where(eq(storeTasks.id, sampleTask.id));
  });
});
