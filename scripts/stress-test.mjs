#!/usr/bin/env node
/**
 * SupermarketOS High-Concurrency Stress & Invariant Test Harness (Wave 2 Phase 4)
 *
 * Boots the compiled production API against live PostgreSQL 16 on an isolated port and runs:
 *   Scenario A: 40 concurrent checkouts racing on 1 hot SKU + FEFO batch (0 deadlocks, 0 negative batches)
 *   Scenario B: 25 concurrent checkouts racing on 1 single-use coupon (strictly 1x201 + 24x409)
 *   Scenario C: 200-request mixed catalog/POS/analytics/tasks/health load benchmark (p50/p95/p99)
 *   Scenario D: Full post-stress DB invariant audit & spotless cleanup
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(path.join(repoRoot, "apps/api/package.json"));
const { Pool } = require("pg");

const PORT = Number(process.env.STRESS_PORT ?? 4010);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://supermarket:supermarket_dev_password@127.0.0.1:5433/supermarket_os";

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[idx].toFixed(2));
}

async function waitForHealth(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) {
        const body = await res.json();
        if (body.status === "ok" && body.db === "connected") return;
      }
    } catch {
      // retry until server binds
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`API server at ${BASE_URL} did not become healthy within ${timeoutMs}ms`);
}

function computeLineTaxCents(netAfterDiscountCents, taxRateBp, isInclusive) {
  if (taxRateBp <= 0 || netAfterDiscountCents <= 0) return 0;
  if (isInclusive) {
    return Math.round((netAfterDiscountCents * taxRateBp) / (10_000 + taxRateBp));
  }
  return Math.round((netAfterDiscountCents * taxRateBp) / 10_000);
}

function buildSalePayload({ product, barcode, taxRate, couponCode = null, couponDiscountCents = 0 }) {
  const saleId = crypto.randomUUID();
  const unitPrice = Number(barcode.sellPriceCents);
  const unitCost = Number(product.avgCostCents);
  const lineDiscount = Math.min(unitPrice, couponDiscountCents);
  const discountedGross = unitPrice - lineDiscount;
  const taxCents = computeLineTaxCents(discountedGross, taxRate.rateBp, taxRate.isInclusive);
  const lineTotalCents = taxRate.isInclusive ? discountedGross : discountedGross + taxCents;

  return {
    id: saleId,
    registerCode: "STRESS-01",
    receiptNo: `STRESS-${saleId.slice(0, 8).toUpperCase()}`,
    kind: "sale",
    soldAt: new Date().toISOString(),
    ageVerified: true,
    couponCode,
    lines: [
      {
        id: crypto.randomUUID(),
        productId: product.id,
        scannedBarcode: barcode.barcode,
        packLabel: barcode.packLabel,
        packQty: barcode.packQty,
        qtyPacks: 1,
        unitPriceCents: unitPrice,
        unitCostCents: unitCost,
        discountCents: lineDiscount,
        taxRateBp: taxRate.rateBp,
        taxCents,
        lineTotalCents,
      },
    ],
    payments: [
      {
        id: crypto.randomUUID(),
        method: "card",
        amountCents: lineTotalCents,
      },
    ],
  };
}

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 10 });
  const stressNodeEnv = process.env.STRESS_NODE_ENV ?? "production";
  const stressAuthSecret =
    process.env.AUTH_SECRET || "stress-test-auth-secret-minimum-thirty-two-characters-long";
  const serverProc = spawn("node", [path.join(repoRoot, "apps/api/dist/server.js")], {
    cwd: path.join(repoRoot, "apps/api"),
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      NODE_ENV: stressNodeEnv,
      AUTH_SECRET: stressAuthSecret,
      COOKIE_SECURE: "false",
      DATABASE_URL,
      LOG_LEVEL: "warn",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderrBuf = "";
  serverProc.stderr.on("data", (d) => {
    stderrBuf += d.toString();
  });

  const createdSaleIds = [];
  let syntheticBatchId = null;
  let originalBatchesSnapshot = [];
  let stressCouponId = null;

  try {
    await waitForHealth();
    console.log(`[stress] Compiled API healthy at ${BASE_URL}`);

    // Authenticate as owner (non-browser CLI explicitly requests bearer token)
    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Mode": "bearer" },
      body: JSON.stringify({ username: "owner", pin: "1111", includeToken: true }),
    });
    assert.equal(loginRes.status, 200, "Owner login must succeed");
    const { token } = await loginRes.json();
    const authHeaders = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    // Bootstrap catalog & choose a clean single-unit non-age-restricted SKU
    const bootRes = await fetch(`${BASE_URL}/api/pos/bootstrap`, { headers: authHeaders });
    assert.equal(bootRes.status, 200, "POS bootstrap must succeed");
    const boot = await bootRes.json();
    const taxById = new Map(boot.taxRates.map((t) => [t.id, t]));
    const primarySingleBarcode = boot.barcodes.find(
      (b) => b.isPrimary && b.packQty === 1 && Number(b.sellPriceCents) >= 300
    );
    assert.ok(primarySingleBarcode, "Expected at least one primary single-unit barcode >= $3.00");
    const hotProduct = boot.products.find((p) => p.id === primarySingleBarcode.productId);
    assert.ok(hotProduct, "Expected hotProduct matching primary barcode");
    const hotTax = taxById.get(hotProduct.taxRateId) ?? { rateBp: 0, isInclusive: true };

    // Snapshot original FEFO batches for hotProduct so we can restore 100% cleanly
    const snapRes = await pool.query(
      "SELECT id, qty_remaining, status FROM inventory_batches WHERE product_id = $1",
      [hotProduct.id]
    );
    originalBatchesSnapshot = snapRes.rows;

    // Insert earliest FEFO batch with qty_remaining = 35 so 40 concurrent 1-unit sales exhaust it cleanly
    const batchInsert = await pool.query(
      `INSERT INTO inventory_batches (product_id, lot_code, best_before_date, qty_received, qty_remaining, unit_cost_cents, status)
       VALUES ($1, $2, '2020-01-01', 35, 35, $3, 'active')
       RETURNING id`,
      [hotProduct.id, `STRESS-LOT-${Date.now()}`, hotProduct.avgCostCents]
    );
    syntheticBatchId = batchInsert.rows[0].id;

    // =========================================================================
    // SCENARIO A: 40 Concurrent Hot-SKU FEFO Checkouts
    // =========================================================================
    const STORM_COUNT = 40;
    const stormPayloads = Array.from({ length: STORM_COUNT }, () =>
      buildSalePayload({ product: hotProduct, barcode: primarySingleBarcode, taxRate: hotTax })
    );
    const tStorm = performance.now();
    const stormResults = await Promise.all(
      stormPayloads.map(async (payload) => {
        const s0 = performance.now();
        const res = await fetch(`${BASE_URL}/api/pos/sales`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify(payload),
        });
        const ms = performance.now() - s0;
        if (res.status === 201) createdSaleIds.push(payload.id);
        return { status: res.status, ms, body: res.status !== 201 ? await res.text() : "" };
      })
    );
    const stormElapsedMs = performance.now() - tStorm;
    const storm201 = stormResults.filter((r) => r.status === 201).length;
    const storm5xx = stormResults.filter((r) => r.status >= 500).length;
    const stormLat = stormResults.map((r) => r.ms).sort((a, b) => a - b);

    assert.equal(storm5xx, 0, `Expected 0 5xx/deadlocks in Scenario A, got ${storm5xx}`);
    assert.equal(
      storm201,
      STORM_COUNT,
      `Expected ${STORM_COUNT}x201 in Scenario A, got ${storm201}: ${stormResults.find((r) => r.status !== 201)?.body}`
    );

    const synBatchAfter = await pool.query(
      "SELECT qty_remaining, status FROM inventory_batches WHERE id = $1",
      [syntheticBatchId]
    );
    assert.equal(Number(synBatchAfter.rows[0].qty_remaining), 0, "Synthetic FEFO batch must reach exactly 0");
    assert.equal(synBatchAfter.rows[0].status, "depleted", "Synthetic FEFO batch status must be depleted");

    const movSumRes = await pool.query(
      "SELECT COALESCE(SUM(qty_delta), 0)::int AS net_delta FROM stock_movements WHERE ref_id = ANY($1::uuid[])",
      [stormPayloads.map((p) => p.id)]
    );
    assert.equal(
      Number(movSumRes.rows[0].net_delta),
      -STORM_COUNT,
      `Stock movements net delta must equal exactly -${STORM_COUNT}`
    );

    console.log(
      `[Scenario A] 40 concurrent hot-SKU FEFO checkouts: ${storm201}/40 HTTP 201, 0 deadlocks, ` +
        `batch=0(depleted), ledger=-40 | total=${stormElapsedMs.toFixed(0)}ms ` +
        `p50=${percentile(stormLat, 50)}ms p95=${percentile(stormLat, 95)}ms p99=${percentile(stormLat, 99)}ms`
    );

    // =========================================================================
    // SCENARIO B: 25 Concurrent Single-Use Coupon Stampede
    // =========================================================================
    const couponCode = `STRESSCPN${Date.now().toString().slice(-6)}`;
    const cpCreateRes = await fetch(`${BASE_URL}/api/loyalty/coupons`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        code: couponCode,
        discountCents: 100,
        minBasketCents: 0,
        validDays: 7,
      }),
    });
    assert.equal(cpCreateRes.status, 201, "Stress coupon creation must succeed");
    const cpCreated = await cpCreateRes.json();
    stressCouponId = cpCreated.coupon.id;

    const STAMPEDE_COUNT = 25;
    const stampedePayloads = Array.from({ length: STAMPEDE_COUNT }, () =>
      buildSalePayload({
        product: hotProduct,
        barcode: primarySingleBarcode,
        taxRate: hotTax,
        couponCode,
        couponDiscountCents: 100,
      })
    );
    const tStampede = performance.now();
    const stampedeResults = await Promise.all(
      stampedePayloads.map(async (payload) => {
        const s0 = performance.now();
        const res = await fetch(`${BASE_URL}/api/pos/sales`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify(payload),
        });
        const ms = performance.now() - s0;
        if (res.status === 201) createdSaleIds.push(payload.id);
        return { status: res.status, ms };
      })
    );
    const stampedeElapsedMs = performance.now() - tStampede;
    const stampede201 = stampedeResults.filter((r) => r.status === 201).length;
    const stampede409 = stampedeResults.filter((r) => r.status === 409).length;
    const stampede5xx = stampedeResults.filter((r) => r.status >= 500).length;
    const stampedeLat = stampedeResults.map((r) => r.ms).sort((a, b) => a - b);

    assert.equal(stampede5xx, 0, "Expected 0 5xx in Scenario B");
    assert.equal(stampede201, 1, `Expected strictly 1 winning redemption, got ${stampede201}`);
    assert.equal(
      stampede409,
      STAMPEDE_COUNT - 1,
      `Expected strictly ${STAMPEDE_COUNT - 1}x409 conflicts, got ${stampede409}`
    );

    console.log(
      `[Scenario B] 25 concurrent single-use coupon stampede: ${stampede201}x201 + ${stampede409}x409 (0 double-redemptions) | ` +
        `total=${stampedeElapsedMs.toFixed(0)}ms p50=${percentile(stampedeLat, 50)}ms p95=${percentile(stampedeLat, 95)}ms`
    );

    // =========================================================================
    // SCENARIO C: 200-Request Mixed Read Load Benchmark (5 waves x 40 concurrent)
    // =========================================================================
    const endpoints = [
      "/api/products?page=1&pageSize=25",
      "/api/pos/bootstrap",
      "/api/analytics/overview?days=30",
      "/api/operations/tasks",
      "/api/health",
    ];
    const perEndpointLat = new Map(endpoints.map((ep) => [ep, []]));
    const allReadLat = [];
    let readOk = 0;
    let readFail = 0;

    const tLoad = performance.now();
    for (let wave = 0; wave < 5; wave++) {
      const batch = Array.from({ length: 40 }, (_, i) => endpoints[(wave * 40 + i) % endpoints.length]);
      await Promise.all(
        batch.map(async (ep) => {
          const s0 = performance.now();
          const res = await fetch(`${BASE_URL}${ep}`, { headers: authHeaders });
          await res.text();
          const ms = performance.now() - s0;
          allReadLat.push(ms);
          perEndpointLat.get(ep).push(ms);
          if (res.status === 200) readOk += 1;
          else readFail += 1;
        })
      );
    }
    const loadElapsedSec = (performance.now() - tLoad) / 1000;
    allReadLat.sort((a, b) => a - b);
    const throughputRps = Number((200 / loadElapsedSec).toFixed(1));

    assert.equal(readFail, 0, `Expected 0 failed requests in Scenario C, got ${readFail}`);
    assert.equal(readOk, 200, `Expected 200x200 in Scenario C, got ${readOk}`);

    console.log(
      `[Scenario C] 200 mixed API requests (40 concurrency): 200/200 HTTP 200 | ` +
        `throughput=${throughputRps} req/s | p50=${percentile(allReadLat, 50)}ms ` +
        `p95=${percentile(allReadLat, 95)}ms p99=${percentile(allReadLat, 99)}ms`
    );
    for (const [ep, lats] of perEndpointLat.entries()) {
      lats.sort((a, b) => a - b);
      console.log(
        `  - ${ep.padEnd(36)} p50=${String(percentile(lats, 50)).padStart(6)}ms  ` +
          `p95=${String(percentile(lats, 95)).padStart(6)}ms  p99=${String(percentile(lats, 99)).padStart(6)}ms`
      );
    }

    // =========================================================================
    // SCENARIO D: Full Post-Stress Database Ledger & Batch Invariant Audit
    // =========================================================================
    const invCheck = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM inventory_batches WHERE qty_remaining < 0) AS neg_batches,
        (SELECT COUNT(*)::int FROM sales WHERE total_cents < 0 OR subtotal_cents < 0) AS neg_sales,
        (SELECT COUNT(*)::int FROM sale_lines WHERE pack_qty <= 0 OR qty_packs <= 0 OR base_units_sold <= 0) AS bad_lines,
        (SELECT COUNT(*)::int FROM targeted_coupons WHERE redeemed_sale_id IS NOT NULL AND redeemed_at IS NULL) AS half_redeemed
    `);
    const inv = invCheck.rows[0];
    assert.equal(inv.neg_batches, 0, "Zero negative FEFO batches invariant violated");
    assert.equal(inv.neg_sales, 0, "Zero negative sales totals invariant violated");
    assert.equal(inv.bad_lines, 0, "Zero invalid sale_lines quantities invariant violated");
    assert.equal(inv.half_redeemed, 0, "Zero inconsistent redeemed coupon rows invariant violated");

    console.log(
      `[Scenario D] Post-stress DB invariants: neg_batches=0, neg_sales=0, bad_lines=0, half_redeemed=0 — ALL PASS`
    );
  } finally {
    // Spotless cleanup of every synthetic stress record & exact batch restoration
    try {
      if (stressCouponId) {
        await pool.query("DELETE FROM targeted_coupons WHERE id = $1", [stressCouponId]);
        await pool.query("DELETE FROM audit_logs WHERE entity_id = $1", [stressCouponId]);
      }
      if (createdSaleIds.length > 0) {
        await pool.query("DELETE FROM stock_movements WHERE ref_id = ANY($1::uuid[])", [createdSaleIds]);
        await pool.query("DELETE FROM loyalty_ledger WHERE sale_id = ANY($1::uuid[])", [createdSaleIds]);
        await pool.query("DELETE FROM sale_payments WHERE sale_id = ANY($1::uuid[])", [createdSaleIds]);
        await pool.query("DELETE FROM sale_lines WHERE sale_id = ANY($1::uuid[])", [createdSaleIds]);
        await pool.query("DELETE FROM sales WHERE id = ANY($1::uuid[])", [createdSaleIds]);
      }
      if (syntheticBatchId) {
        await pool.query("DELETE FROM inventory_batches WHERE id = $1", [syntheticBatchId]);
      }
      for (const b of originalBatchesSnapshot) {
        await pool.query(
          "UPDATE inventory_batches SET qty_remaining = $1, status = $2 WHERE id = $3",
          [b.qty_remaining, b.status, b.id]
        );
      }
      console.log(`[cleanup] Removed ${createdSaleIds.length} stress sales & restored original FEFO batches.`);
    } catch (cleanErr) {
      console.error("[cleanup] Error cleaning up stress artifacts:", cleanErr);
    }

    serverProc.kill("SIGTERM");
    await new Promise((resolve) => {
      serverProc.once("exit", resolve);
      setTimeout(resolve, 2500);
    });
    await pool.end();
    if (stderrBuf.trim()) {
      console.error("[server stderr]", stderrBuf.trim().slice(0, 400));
    }
  }
}

main().catch((err) => {
  console.error("[stress] FAILED:", err);
  process.exit(1);
});
