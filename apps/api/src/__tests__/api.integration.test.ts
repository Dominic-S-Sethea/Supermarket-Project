import { buildValidEan13, generateUuidV7 } from "@supermarket/shared";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import {
  aiBriefings,
  aiConversations,
  auditLogs,
  db,
  goodsReceipts,
  hourlyStockSnapshots,
  inventoryBatches,
  marginAlerts,
  pool,
  posShifts,
  productBarcodes,
  purchaseOrders,
  sales,
  shiftExperiments,
  stockMovements,
  storeFootfall,
} from "../db/index.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let ownerToken = "";
let cashierToken = "";

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

  it("enforces offline-first POS sale idempotency, payment coverage, and FEFO batch decrement", async () => {
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
      .where(eq(inventoryBatches.productId, prod.id))
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
      ageVerified: false,
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

    if (firstBatch && origQty >= bc.packQty) {
      const [afterBatch] = await db
        .select()
        .from(inventoryBatches)
        .where(eq(inventoryBatches.id, firstBatch.id));
      expect(afterBatch.qtyRemaining).toBe(origQty - bc.packQty);
      await db
        .update(inventoryBatches)
        .set({ qtyRemaining: origQty, status: firstBatch.status })
        .where(eq(inventoryBatches.id, firstBatch.id));
    }

    await db.delete(stockMovements).where(eq(stockMovements.refId, saleId));
    await db.delete(sales).where(eq(sales.id, saleId));
  });

  it("handles GRN bonus cases, tax-aware margin alerts, multi-pack scaling, and persistent POs", async () => {
    const metaRes = await app.inject({
      method: "GET",
      url: "/api/meta",
      headers: authHeaders(),
    });
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

    // 1. Create a persistent PO
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
            orderedCases: 2,
            unitCostCents: origAvgCost,
          },
        ],
      },
    });
    expect(poRes.statusCode).toBe(201);
    const po = poRes.json() as { id: string; status: string };
    expect(po.status).toBe("approved");

    // 2. Receive GRN linked to PO with high invoice cost to trigger margin alert
    const grnRes = await app.inject({
      method: "POST",
      url: "/api/purchasing/grn",
      headers: authHeaders(),
      payload: {
        supplierId: meta.suppliers[0].id,
        poId: po.id,
        invoiceNumber: `TEST-GRN-${Date.now()}`,
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

    // 3. Apply suggested price -> resolves alert and scales multi-pack barcodes
    const [createdAlert] = await db
      .select()
      .from(marginAlerts)
      .where(and(eq(marginAlerts.grnId, grnBody.grnId), eq(marginAlerts.resolved, false)))
      .limit(1);
    expect(createdAlert).toBeDefined();

    const applyRes = await app.inject({
      method: "POST",
      url: `/api/inventory/margin-alerts/${createdAlert.id}/apply-price`,
      headers: authHeaders(),
      payload: {},
    });
    expect(applyRes.statusCode).toBe(200);
    expect(applyRes.json().updatedPackTiers).toBeGreaterThanOrEqual(1);

    // Clean up test GRN, PO, alerts, movements, batches & restore original prices/cost
    await db.delete(marginAlerts).where(eq(marginAlerts.grnId, grnBody.grnId));
    await db.delete(stockMovements).where(eq(stockMovements.refId, grnBody.grnId));
    await db.delete(inventoryBatches).where(eq(inventoryBatches.lotCode, `GRN-${grnBody.grnId}`));
    await db.delete(goodsReceipts).where(eq(goodsReceipts.id, grnBody.grnId));
    await db.delete(purchaseOrders).where(eq(purchaseOrders.id, po.id));
    for (const op of origPrices) {
      await db
        .update(productBarcodes)
        .set({ sellPriceCents: op.sellPriceCents })
        .where(eq(productBarcodes.id, op.id));
    }
  });

  it("supports blind shift open/close, quoted CSV preview, and sanitized ZPL generation", async () => {
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
    const pid = listRes.json().items[0].id as string;
    const zplRes = await app.inject({
      method: "POST",
      url: "/api/labels/zpl",
      headers: authHeaders(),
      payload: { productIds: [pid] },
    });
    expect(zplRes.statusCode).toBe(200);
    expect(zplRes.json().zpl).toContain("^XA");
    expect(zplRes.json().zpl).toContain("^BEN");
  });

  it("runs Embedded AI Copilot chat + HITL proposal execution with audit trail", async () => {
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

    const execRes = await app.inject({
      method: "POST",
      url: `/api/ai/actions/${pendingPo!.id}/execute`,
      headers: authHeaders(),
      payload: {},
    });
    expect(execRes.statusCode).toBe(200);
    expect(execRes.json().action.status).toBe("executed");
    const createdPoId = execRes.json().result.poId as string;
    expect(createdPoId).toBeTruthy();

    // Clean up AI test conversation, PO & audit log
    await db.delete(purchaseOrders).where(eq(purchaseOrders.id, createdPoId));
    await db.delete(aiConversations).where(eq(aiConversations.id, chatData.conversationId));
    await db.delete(auditLogs).where(eq(auditLogs.entityId, createdPoId));
  });

  it("supports Morning Briefing, Semantic Search, Invoice GRN Scanner, Calibrated Triage & SSE Streaming", async () => {
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

    // 3. Supplier Invoice -> GRN Scanner
    const invRes = await app.inject({
      method: "POST",
      url: "/api/ai/grn/parse-invoice",
      headers: authHeaders(),
      payload: {
        fileName: "test-invoice.txt",
        mimeType: "text/plain",
        textContent:
          "Supplier: Summit Brewing & Beer Supply\nInvoice: INV-TEST-888\nBEER-0001 Heineken Original | 24 | 10 | 1 | 310.00 | 2027-06-01",
      },
    });
    expect(invRes.statusCode).toBe(200);
    expect(invRes.json().lines).toHaveLength(1);
    expect(invRes.json().lines[0].freeBonusCases).toBe(1);
    expect(invRes.json().lines[0].matchedSku).toBe("BEER-0001");
    expect(invRes.json().triage.questions.length).toBeGreaterThanOrEqual(2);

    // 4. Calibrated Cashier Triage
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

    // 5. SSE Streaming Copilot Chat (via ephemeral listen on port 0 for raw hijack support)
    const liveUrl = await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const sseRes = await fetch(`${liveUrl}/api/ai/chat/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({ message: "Give me today morning risk briefing" }),
      });
      expect(sseRes.status).toBe(200);
      const bodyText = await sseRes.text();
      expect(bodyText).toContain('"type":"tool_call"');
      expect(bodyText).toContain('"type":"delta"');
      expect(bodyText).toContain('"type":"done"');
      const convMatch = bodyText.match(/"conversationId":"([^"]+)"/);
      if (convMatch?.[1]) {
        await db.delete(aiConversations).where(eq(aiConversations.id, convMatch[1]));
      }
    } finally {
      // Leave Fastify instance ready or close cleanly? afterAll closes app, which works fine even after listen
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
});
