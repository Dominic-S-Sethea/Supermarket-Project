import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  CreateShiftExperimentSchema,
  generateUuidV7,
  IngestFootfallSchema,
} from "@supermarket/shared";
import type { FastifyInstance } from "fastify";
import { desc, eq, isNotNull, sql } from "drizzle-orm";
import {
  analyticsAbcXyz,
  analyticsBasketRules,
  analyticsDemandForecasts,
  analyticsLpAnomalies,
  analyticsPromoRoi,
  analyticsShiftDiagnostics,
  auditLogs,
  categories,
  db,
  departments,
  hourlyStockSnapshots,
  products,
  promotions,
  shiftExperiments,
  storeFootfall,
} from "../db/index.js";
import { env } from "../config/env.js";
import { buildCsvDocument } from "../lib/helpers.js";
import { evaluateShiftExperiment } from "../lib/shiftDid.js";
import { requireAuth, requireRole } from "../plugins/auth.js";
import { createRateLimiter } from "../plugins/security.js";

const execFileAsync = promisify(execFile);
let localRecomputeInFlight = false;

export async function analyticsRoutes(app: FastifyInstance) {
  const analyticsReadOnly = [requireRole(["owner", "manager", "accountant"])];
  const recomputeLimiter = createRateLimiter({
    keyPrefix: "analytics_recompute",
    windowMs: 5 * 60_000,
    max: env.isTest ? 100 : 5,
  });
  const exportLimiter = createRateLimiter({
    keyPrefix: "analytics_csv_exports",
    windowMs: 60_000,
    max: env.isTest ? 300 : 20,
  });

  // Executive Overview KPIs, Daily Trend & Hourly Traffic Heatmap
  app.get("/api/analytics/overview", { preHandler: analyticsReadOnly }, async (req) => {
    const q = req.query as { days?: string };
    const rawDays = Number(q.days);
    const days = Number.isFinite(rawDays)
      ? Math.min(90, Math.max(7, Math.trunc(rawDays)))
      : 30;

    const [kpiRes, dailyRes, hourlyRes, payRes, shrinkRes, skuCountRes] =
      await Promise.all([
        db.execute(sql`
          SELECT
            COUNT(*) FILTER (WHERE kind = 'sale')::int AS receipt_count,
            COUNT(*) FILTER (WHERE kind IN ('void', 'refund'))::int AS reversal_count,
            COALESCE(SUM(CASE WHEN kind = 'sale' THEN total_cents ELSE -total_cents END), 0)::bigint AS gross_sales_cents,
            COALESCE(SUM(total_cents) FILTER (WHERE kind IN ('void', 'refund')), 0)::bigint AS refunds_voids_cents,
            COALESCE(SUM(CASE WHEN kind = 'sale' THEN discount_cents ELSE -discount_cents END), 0)::bigint AS discounts_cents,
            COALESCE(SUM(CASE WHEN kind = 'sale' THEN tax_cents ELSE -tax_cents END), 0)::bigint AS tax_cents,
            COALESCE(SUM(CASE WHEN kind = 'sale' THEN total_cost_cents ELSE -total_cost_cents END), 0)::bigint AS cogs_cents,
            COALESCE(SUM(CASE WHEN kind = 'sale' THEN (total_cents - tax_cents) ELSE -(total_cents - tax_cents) END), 0)::bigint AS net_sales_cents
          FROM sales
          WHERE sold_at >= now() - (${days} || ' days')::interval
        `),
        db.execute(sql`
          SELECT
            to_char(date_trunc('day', sold_at), 'YYYY-MM-DD') AS day,
            COUNT(*) FILTER (WHERE kind = 'sale')::int AS receipts,
            COALESCE(SUM(CASE WHEN kind = 'sale' THEN total_cents ELSE -total_cents END), 0)::bigint AS sales_cents,
            COALESCE(SUM(CASE WHEN kind = 'sale' THEN (total_cents - tax_cents - total_cost_cents) ELSE -(total_cents - tax_cents - total_cost_cents) END), 0)::bigint AS profit_cents
          FROM sales
          WHERE sold_at >= now() - (${days} || ' days')::interval
          GROUP BY 1
          ORDER BY 1 ASC
        `),
        db.execute(sql`
          SELECT
            EXTRACT(HOUR FROM sold_at)::int AS hour,
            COUNT(*) FILTER (WHERE kind = 'sale')::int AS receipts,
            COALESCE(SUM(CASE WHEN kind = 'sale' THEN total_cents ELSE -total_cents END), 0)::bigint AS sales_cents
          FROM sales
          WHERE sold_at >= now() - (${days} || ' days')::interval
          GROUP BY 1
          ORDER BY 1 ASC
        `),
        db.execute(sql`
          SELECT
            p.method,
            COUNT(*) FILTER (WHERE s.kind = 'sale')::int AS tx_count,
            COALESCE(SUM(CASE WHEN s.kind = 'sale' THEN p.amount_cents ELSE -p.amount_cents END), 0)::bigint AS total_cents
          FROM sale_payments p
          JOIN sales s ON s.id = p.sale_id
          WHERE s.sold_at >= now() - (${days} || ' days')::interval
          GROUP BY 1
          ORDER BY total_cents DESC
        `),
        db.execute(sql`
          SELECT
            COALESCE(SUM(ROUND((ABS(sm.qty_delta)::numeric * sm.unit_cost_cents) / CASE WHEN p.unit_mode IN ('weight_g', 'volume_ml') THEN 1000.0 ELSE 1.0 END)), 0)::bigint AS shrink_cost_cents
          FROM stock_movements sm
          JOIN products p ON p.id = sm.product_id
          WHERE sm.reason IN ('spoilage', 'damage', 'count_adj')
            AND sm.qty_delta < 0
            AND sm.created_at >= now() - (${days} || ' days')::interval
        `),
        db.execute(sql`
          WITH unfolded AS (
            SELECT product_id, COALESCE(SUM(qty_delta), 0)::int AS delta
            FROM stock_movements
            WHERE folded = false
            GROUP BY product_id
          )
          SELECT
            COUNT(*)::int AS total_skus,
            (SELECT COUNT(*)::int FROM product_barcodes) AS total_barcodes,
            COALESCE(SUM(ROUND((GREATEST(0, COALESCE(b.quantity, 0) + COALESCE(u.delta, 0))::numeric * p.avg_cost_cents) / CASE WHEN p.unit_mode IN ('weight_g', 'volume_ml') THEN 1000.0 ELSE 1.0 END)), 0)::bigint AS inventory_cost_value_cents
          FROM products p
          LEFT JOIN stock_baselines b ON b.product_id = p.id
          LEFT JOIN unfolded u ON u.product_id = p.id
          WHERE p.active = true
        `),
      ]);

    const kpi = kpiRes.rows[0] as Record<string, string | number>;
    const netSales = Number(kpi.net_sales_cents ?? 0);
    const grossSales = Number(kpi.gross_sales_cents ?? 0);
    const cogs = Number(kpi.cogs_cents ?? 0);
    const receipts = Number(kpi.receipt_count ?? 0);
    const grossProfit = netSales - cogs;
    const shrinkCost = Number(
      (shrinkRes.rows[0] as Record<string, string | number>)?.shrink_cost_cents ?? 0
    );
    const catalog = skuCountRes.rows[0] as Record<string, string | number>;

    return {
      days,
      kpis: {
        receiptCount: receipts,
        reversalCount: Number(kpi.reversal_count ?? 0),
        grossSalesCents: grossSales,
        refundsVoidsCents: Number(kpi.refunds_voids_cents ?? 0),
        netSalesCents: netSales,
        discountsCents: Number(kpi.discounts_cents ?? 0),
        taxCents: Number(kpi.tax_cents ?? 0),
        cogsCents: cogs,
        grossProfitCents: grossProfit,
        grossMarginBp: netSales > 0 ? Math.round((grossProfit * 10000) / netSales) : 0,
        avgTransactionValueCents: receipts > 0 ? Math.round(grossSales / receipts) : 0,
        shrinkageCostCents: shrinkCost,
        shrinkageRateBp: grossSales > 0 ? Math.round((shrinkCost * 10000) / grossSales) : 0,
        totalSkus: Number(catalog.total_skus ?? 0),
        totalBarcodes: Number(catalog.total_barcodes ?? 0),
        inventoryCostValueCents: Number(catalog.inventory_cost_value_cents ?? 0),
      },
      dailyTrend: dailyRes.rows.map((r: Record<string, unknown>) => ({
        day: String(r.day),
        receipts: Number(r.receipts),
        salesCents: Number(r.sales_cents),
        profitCents: Number(r.profit_cents),
      })),
      hourlyTraffic: hourlyRes.rows.map((r: Record<string, unknown>) => ({
        hour: Number(r.hour),
        receipts: Number(r.receipts),
        salesCents: Number(r.sales_cents),
      })),
      paymentMix: payRes.rows.map((r: Record<string, unknown>) => ({
        method: String(r.method),
        txCount: Number(r.tx_count),
        totalCents: Number(r.total_cents),
      })),
    };
  });

  // Department Profitability, GMROII & Stock Value (uses live unfolded stock)
  app.get("/api/analytics/departments", { preHandler: analyticsReadOnly }, async () => {
    const res = await db.execute(sql`
      WITH unfolded AS (
        SELECT product_id, COALESCE(SUM(qty_delta), 0)::int AS delta
        FROM stock_movements
        WHERE folded = false
        GROUP BY product_id
      ),
      sales_by_dept AS (
        SELECT
          d.id AS department_id,
          COALESCE(SUM(CASE WHEN s.kind = 'sale' THEN (sl.line_total_cents - sl.tax_cents) ELSE -(sl.line_total_cents - sl.tax_cents) END), 0)::bigint AS net_sales_60d,
          COALESCE(SUM(ROUND(((CASE WHEN s.kind = 'sale' THEN 1 ELSE -1 END) * sl.unit_cost_cents::numeric * sl.base_units_sold) / CASE WHEN p.unit_mode IN ('weight_g', 'volume_ml') THEN 1000.0 ELSE 1.0 END)), 0)::bigint AS cogs_60d,
          COALESCE(SUM(CASE WHEN s.kind = 'sale' THEN sl.base_units_sold ELSE -sl.base_units_sold END), 0)::int AS units_60d
        FROM sale_lines sl
        JOIN sales s ON s.id = sl.sale_id
        JOIN products p ON p.id = sl.product_id
        JOIN categories c ON c.id = p.category_id
        JOIN departments d ON d.id = c.department_id
        WHERE s.sold_at >= now() - interval '60 days'
        GROUP BY d.id
      ),
      inv_by_dept AS (
        SELECT
          d.id AS department_id,
          COUNT(p.id)::int AS sku_count,
          COALESCE(SUM(ROUND((GREATEST(0, COALESCE(sb.quantity, 0) + COALESCE(u.delta, 0))::numeric * p.avg_cost_cents) / CASE WHEN p.unit_mode IN ('weight_g', 'volume_ml') THEN 1000.0 ELSE 1.0 END)), 0)::bigint AS stock_cost_cents
        FROM products p
        JOIN categories c ON c.id = p.category_id
        JOIN departments d ON d.id = c.department_id
        LEFT JOIN stock_baselines sb ON sb.product_id = p.id
        LEFT JOIN unfolded u ON u.product_id = p.id
        GROUP BY d.id
      )
      SELECT
        d.id,
        d.code,
        d.name,
        d.target_margin_bp,
        COALESCE(i.sku_count, 0)::int AS sku_count,
        COALESCE(i.stock_cost_cents, 0)::bigint AS stock_cost_cents,
        COALESCE(sd.net_sales_60d, 0)::bigint AS net_sales_60d,
        COALESCE(sd.cogs_60d, 0)::bigint AS cogs_60d,
        COALESCE(sd.units_60d, 0)::int AS units_60d
      FROM departments d
      LEFT JOIN inv_by_dept i ON i.department_id = d.id
      LEFT JOIN sales_by_dept sd ON sd.department_id = d.id
      ORDER BY net_sales_60d DESC
    `);

    return {
      departments: res.rows.map((r: Record<string, unknown>) => {
        const net = Number(r.net_sales_60d);
        const cogs = Number(r.cogs_60d);
        const profit = net - cogs;
        const stockCost = Math.max(1, Number(r.stock_cost_cents));
        const annualizedProfit = profit * 6.08;
        const annualizedCogs = cogs * 6.08;
        return {
          id: String(r.id),
          code: String(r.code),
          name: String(r.name),
          targetMarginBp: Number(r.target_margin_bp),
          skuCount: Number(r.sku_count),
          stockCostCents: Number(r.stock_cost_cents),
          netSales60dCents: net,
          grossProfit60dCents: profit,
          grossMarginBp: net > 0 ? Math.round((profit * 10000) / net) : 0,
          units60d: Number(r.units_60d),
          gmroii: Number((annualizedProfit / stockCost).toFixed(2)),
          annualTurns: Number((annualizedCogs / stockCost).toFixed(1)),
        };
      }),
    };
  });

  // ABC-XYZ 3x3 Matrix + SKU Detail
  app.get("/api/analytics/abc-xyz", { preHandler: analyticsReadOnly }, async (req) => {
    const q = req.query as { segment?: string };
    const matrixRes = await db.execute(sql`
      SELECT
        segment,
        abc_class,
        xyz_class,
        COUNT(*)::int AS sku_count,
        COALESCE(SUM(revenue_60d_cents), 0)::bigint AS revenue_cents,
        COALESCE(SUM(profit_60d_cents), 0)::bigint AS profit_cents,
        ROUND(AVG(gmroii)::numeric, 2)::float AS avg_gmroii
      FROM analytics_abc_xyz
      GROUP BY segment, abc_class, xyz_class
      ORDER BY abc_class ASC, xyz_class ASC
    `);

    const topSkus = await db
      .select({
        productId: products.id,
        sku: products.sku,
        name: products.name,
        brand: products.brand,
        departmentName: departments.name,
        segment: analyticsAbcXyz.segment,
        revenue60dCents: analyticsAbcXyz.revenue60dCents,
        profit60dCents: analyticsAbcXyz.profit60dCents,
        units60d: analyticsAbcXyz.units60d,
        demandCv: analyticsAbcXyz.demandCv,
        gmroii: analyticsAbcXyz.gmroii,
        daysOfStock: analyticsAbcXyz.daysOfStock,
        recommendedAction: analyticsAbcXyz.recommendedAction,
      })
      .from(analyticsAbcXyz)
      .innerJoin(products, eq(analyticsAbcXyz.productId, products.id))
      .innerJoin(categories, eq(products.categoryId, categories.id))
      .innerJoin(departments, eq(categories.departmentId, departments.id))
      .where(q.segment ? eq(analyticsAbcXyz.segment, q.segment) : undefined)
      .orderBy(desc(analyticsAbcXyz.profit60dCents))
      .limit(50);

    return {
      matrix: matrixRes.rows.map((r: Record<string, unknown>) => ({
        segment: String(r.segment),
        abcClass: String(r.abc_class),
        xyzClass: String(r.xyz_class),
        skuCount: Number(r.sku_count),
        revenueCents: Number(r.revenue_cents),
        profitCents: Number(r.profit_cents),
        avgGmroii: Number(r.avg_gmroii),
      })),
      skus: topSkus,
    };
  });

  // Demand Forecasting & Auto-Replenishment Draft PO Suggestions
  app.get("/api/analytics/forecasts", { preHandler: analyticsReadOnly }, async (req) => {
    const q = req.query as { urgency?: string };
    const rows = await db
      .select({
        productId: products.id,
        sku: products.sku,
        name: products.name,
        brand: products.brand,
        departmentName: departments.name,
        avgCostCents: products.avgCostCents,
        modelUsed: analyticsDemandForecasts.modelUsed,
        forecast7dUnits: analyticsDemandForecasts.forecast7dUnits,
        forecast14dUnits: analyticsDemandForecasts.forecast14dUnits,
        safetyStockUnits: analyticsDemandForecasts.safetyStockUnits,
        reorderPointUnits: analyticsDemandForecasts.reorderPointUnits,
        currentStockUnits: analyticsDemandForecasts.currentStockUnits,
        suggestedOrderCases: analyticsDemandForecasts.suggestedOrderCases,
        caseQty: analyticsDemandForecasts.caseQty,
        estimatedOrderCostCents: analyticsDemandForecasts.estimatedOrderCostCents,
        supplierName: analyticsDemandForecasts.supplierName,
        wmapePct: analyticsDemandForecasts.wmapePct,
        urgency: analyticsDemandForecasts.urgency,
      })
      .from(analyticsDemandForecasts)
      .innerJoin(products, eq(analyticsDemandForecasts.productId, products.id))
      .innerJoin(categories, eq(products.categoryId, categories.id))
      .innerJoin(departments, eq(categories.departmentId, departments.id))
      .where(
        q.urgency
          ? eq(analyticsDemandForecasts.urgency, q.urgency)
          : sql`${analyticsDemandForecasts.suggestedOrderCases} > 0`
      )
      .orderBy(
        sql`CASE ${analyticsDemandForecasts.urgency} WHEN 'critical' THEN 1 WHEN 'reorder_now' THEN 2 WHEN 'watch' THEN 3 ELSE 4 END`,
        desc(analyticsDemandForecasts.estimatedOrderCostCents)
      )
      .limit(80);

    const bySupplierMap = new Map<
      string,
      { supplierName: string; skuCount: number; totalCases: number; estimatedCostCents: number }
    >();
    for (const r of rows) {
      if (r.suggestedOrderCases <= 0) continue;
      const cur = bySupplierMap.get(r.supplierName) ?? {
        supplierName: r.supplierName,
        skuCount: 0,
        totalCases: 0,
        estimatedCostCents: 0,
      };
      cur.skuCount++;
      cur.totalCases += r.suggestedOrderCases;
      cur.estimatedCostCents += r.estimatedOrderCostCents;
      bySupplierMap.set(r.supplierName, cur);
    }

    return {
      supplierDraftPos: Array.from(bySupplierMap.values()).sort(
        (a, b) => b.estimatedCostCents - a.estimatedCostCents
      ),
      items: rows,
    };
  });

  // Market Basket Association Rules (supports ?shift=all|morning)
  app.get("/api/analytics/basket-rules", { preHandler: [requireAuth] }, async (req) => {
    const q = req.query as { shift?: string };
    const shiftBucket = q.shift === "morning" ? "morning" : "all";
    const rules = await db
      .select()
      .from(analyticsBasketRules)
      .where(eq(analyticsBasketRules.shiftBucket, shiftBucket))
      .orderBy(desc(analyticsBasketRules.lift))
      .limit(30);
    return { shiftBucket, rules };
  });

  // Shift Diagnostics, Footfall Funnel, Morning OOS, Shopper Missions & DiD Experiments
  app.get("/api/analytics/shift-diagnostics", { preHandler: analyticsReadOnly }, async () => {
    const [diagRows, morningRules, daypartPromos, experiments] = await Promise.all([
      db
        .select()
        .from(analyticsShiftDiagnostics)
        .where(eq(analyticsShiftDiagnostics.id, "latest_60d"))
        .limit(1),
      db
        .select()
        .from(analyticsBasketRules)
        .where(eq(analyticsBasketRules.shiftBucket, "morning"))
        .orderBy(desc(analyticsBasketRules.lift))
        .limit(12),
      db
        .select()
        .from(promotions)
        .where(isNotNull(promotions.daypartStartHour))
        .orderBy(desc(promotions.active)),
      db.select().from(shiftExperiments).orderBy(desc(shiftExperiments.createdAt)).limit(15),
    ]);

    const diag = diagRows[0] ?? null;
    return {
      diagnostics: diag
        ? {
            id: diag.id,
            windowDays: diag.windowDays,
            primaryBottleneck: diag.primaryBottleneck,
            morningSharePct: diag.morningSharePct,
            morningConversionPct: diag.morningConversionPct,
            afternoonConversionPct: diag.afternoonConversionPct,
            eveningConversionPct: diag.eveningConversionPct,
            morningEstLostRevenueCents: Number(diag.morningEstLostRevenueCents),
            shiftComparison: diag.shiftComparisonJson,
            hourlyProfile: diag.hourlyProfileJson,
            oosRootCauses: diag.oosRootCausesJson,
            queueSaturation: diag.queueSaturationJson,
            driverAttribution: diag.driverAttributionJson,
            shopperMissions: diag.shopperMissionsJson,
            recommendations: diag.recommendationsJson,
            computedAt: diag.computedAt,
          }
        : null,
      morningBasketRules: morningRules,
      daypartPromotions: daypartPromos,
      experiments,
    };
  });

  // Ingest 15-minute door footfall counter buckets
  app.post(
    "/api/analytics/footfall",
    { preHandler: [requireRole(["owner", "manager", "stock_clerk"])] },
    async (req, reply) => {
      const parsed = IngestFootfallSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const buckets = parsed.data.buckets;

      // Deduplicate buckets by normalized timestamp so single multi-row ON CONFLICT succeeds
      const dedupByTs = new Map<string, (typeof buckets)[number]>();
      for (const b of buckets) {
        dedupByTs.set(new Date(b.bucketStart).toISOString(), b);
      }
      const upsertValues = Array.from(dedupByTs.entries()).map(([iso, b]) => ({
        id: generateUuidV7(),
        bucketStart: new Date(iso),
        entries: b.entries,
        exits: b.exits ?? b.entries,
        avgDwellSec: b.avgDwellSec,
        openLanes: b.openLanes,
        weatherRain: b.weatherRain,
        source: b.source,
      }));

      await db.transaction(async (tx) => {
        if (upsertValues.length > 0) {
          await tx
            .insert(storeFootfall)
            .values(upsertValues)
            .onConflictDoUpdate({
              target: storeFootfall.bucketStart,
              set: {
                entries: sql`EXCLUDED.entries`,
                exits: sql`EXCLUDED.exits`,
                avgDwellSec: sql`EXCLUDED.avg_dwell_sec`,
                openLanes: sql`EXCLUDED.open_lanes`,
                weatherRain: sql`EXCLUDED.weather_rain`,
                source: sql`EXCLUDED.source`,
              },
            });
        }
        await tx.insert(auditLogs).values({
          actor: req.authUser!.fullName,
          action: "footfall_ingest",
          entityType: "store_footfall",
          detailsJson: { bucketCount: upsertValues.length },
        });
      });

      return reply.status(201).send({ ingestedCount: upsertValues.length });
    }
  );

  // Capture hourly on-shelf stock snapshot for top 100 Class-A/B SKUs
  app.post(
    "/api/analytics/stock-snapshots/capture",
    { preHandler: [requireRole(["owner", "manager", "stock_clerk"])] },
    async (req, reply) => {
      const now = new Date();
      const snapshotDate = now.toISOString().slice(0, 10);
      const snapshotHour = now.getHours();

      const topLiveRes = await db.execute(sql`
        WITH unfolded AS (
          SELECT product_id, COALESCE(SUM(qty_delta), 0)::int AS delta
          FROM stock_movements WHERE folded = false GROUP BY product_id
        )
        SELECT
          p.id::text AS product_id,
          (COALESCE(sb.quantity, 0) + COALESCE(u.delta, 0))::int AS on_hand
        FROM analytics_abc_xyz ax
        JOIN products p ON p.id = ax.product_id
        LEFT JOIN stock_baselines sb ON sb.product_id = p.id
        LEFT JOIN unfolded u ON u.product_id = p.id
        WHERE p.active = true AND ax.abc_class IN ('A', 'B')
        ORDER BY ax.profit_60d_cents DESC
        LIMIT 100
      `);

      let oosCount = 0;
      const rows = topLiveRes.rows.map((r: Record<string, unknown>) => {
        const onHand = Number(r.on_hand ?? 0);
        const isOos = onHand <= 0;
        if (isOos) oosCount++;
        return {
          id: generateUuidV7(),
          snapshotDate,
          snapshotHour,
          productId: String(r.product_id),
          onHandUnits: Math.max(0, onHand),
          isOos,
          restockedAtHour: null as number | null,
        };
      });

      if (rows.length > 0) {
        await db.transaction(async (tx) => {
          await tx
            .insert(hourlyStockSnapshots)
            .values(rows)
            .onConflictDoUpdate({
              target: [
                hourlyStockSnapshots.snapshotDate,
                hourlyStockSnapshots.snapshotHour,
                hourlyStockSnapshots.productId,
              ],
              set: {
                onHandUnits: sql`EXCLUDED.on_hand_units`,
                isOos: sql`EXCLUDED.is_oos`,
              },
            });
          await tx.insert(auditLogs).values({
            actor: req.authUser!.fullName,
            action: "stock_snapshot_capture",
            entityType: "hourly_stock_snapshots",
            detailsJson: { snapshotDate, snapshotHour, capturedSkus: rows.length, oosCount },
          });
        });
      }

      return reply.status(201).send({
        snapshotDate,
        snapshotHour,
        capturedSkus: rows.length,
        oosCount,
      });
    }
  );

  // Difference-in-Differences Shift Intervention Experiments
  app.get("/api/analytics/shift-experiments", { preHandler: analyticsReadOnly }, async () => {
    const experiments = await db
      .select()
      .from(shiftExperiments)
      .orderBy(desc(shiftExperiments.createdAt))
      .limit(25);
    return { experiments };
  });

  app.post(
    "/api/analytics/shift-experiments",
    { preHandler: [requireRole(["owner", "manager"])] },
    async (req, reply) => {
      const parsed = CreateShiftExperimentSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const data = parsed.data;
      const resultsJson = await evaluateShiftExperiment(db, data);

      const [created] = await db
        .insert(shiftExperiments)
        .values({
          id: generateUuidV7(),
          name: data.name,
          hypothesis: data.hypothesis,
          interventionType: data.interventionType,
          targetShift: data.targetShift,
          controlShift: data.controlShift,
          preStartDate: data.preStartDate,
          preEndDate: data.preEndDate,
          postStartDate: data.postStartDate,
          postEndDate: data.postEndDate,
          status: "evaluated",
          resultsJson,
          createdBy: req.authUser!.fullName,
        })
        .returning();

      return reply.status(201).send(created);
    }
  );

  // Recompute Python Shift Diagnostics & ML Worker on Demand (decoupled HTTP worker or local dev fallback - H-02)
  app.post(
    "/api/analytics/shift-diagnostics/recompute",
    { preHandler: [requireRole(["owner", "manager"]), recomputeLimiter] },
    async (req, reply) => {
      const workerBaseUrl = (process.env.ANALYTICS_WORKER_URL?.trim() || env.analyticsWorkerUrl)?.replace(
        /\/+$/,
        ""
      );
      if (workerBaseUrl) {
        try {
          const workerToken =
            process.env.ANALYTICS_WORKER_TOKEN?.trim() || env.analyticsWorkerToken;
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (workerToken) headers.Authorization = `Bearer ${workerToken}`;
          const res = await fetch(`${workerBaseUrl}/recompute`, {
            method: "POST",
            headers,
            signal: AbortSignal.timeout(95_000),
          });
          if (res.status === 409) {
            return reply.status(409).send({
              error: "An analytics recompute is already running on the worker.",
            });
          }
          if (!res.ok) {
            req.log.error({ status: res.status }, "Analytics HTTP worker returned error");
            return reply.status(502).send({
              error: "Analytics worker failed to recompute diagnostics.",
            });
          }
          const payload = (await res.json()) as {
            ok?: boolean;
            elapsed_s?: number;
            finished_at?: string;
          };
          const [diag] = await db
            .select()
            .from(analyticsShiftDiagnostics)
            .where(eq(analyticsShiftDiagnostics.id, "latest_60d"))
            .limit(1);
          return {
            ok: Boolean(payload.ok ?? true),
            mode: "http_worker",
            log: `Worker recomputed in ${payload.elapsed_s ?? 0}s`,
            computedAt: diag?.computedAt ?? payload.finished_at ?? null,
          };
        } catch (err) {
          req.log.error({ err, workerBaseUrl }, "Analytics HTTP worker unreachable");
          return reply.status(503).send({
            error: "Analytics worker service is temporarily unavailable.",
          });
        }
      }

      if (localRecomputeInFlight) {
        return reply.status(409).send({
          error: "A local analytics recompute is already running.",
        });
      }

      // Resolve monorepo root relative to module URL so API cwd does not break local worker fallback
      const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
      const scriptPath = path.join(repoRoot, "services", "analytics", "run_all.py");
      if (!fs.existsSync(scriptPath)) {
        return reply.status(503).send({
          error:
            "Analytics recompute service is not configured. Set ANALYTICS_WORKER_URL in production.",
        });
      }
      const winPy = path.join(repoRoot, "services", "analytics", ".venv", "Scripts", "python.exe");
      const posixPy = path.join(repoRoot, "services", "analytics", ".venv", "bin", "python");
      const pyBin = fs.existsSync(winPy)
        ? winPy
        : fs.existsSync(posixPy)
          ? posixPy
          : "python3";

      localRecomputeInFlight = true;
      try {
        const { stdout } = await execFileAsync(pyBin, [scriptPath], {
          cwd: repoRoot,
          timeout: 90_000,
        });
        const [diag] = await db
          .select()
          .from(analyticsShiftDiagnostics)
          .where(eq(analyticsShiftDiagnostics.id, "latest_60d"))
          .limit(1);
        return {
          ok: true,
          mode: "local_dev_subprocess",
          log: stdout.trim(),
          computedAt: diag?.computedAt ?? null,
        };
      } catch (err) {
        req.log.error({ err }, "Python analytics recompute failed");
        return reply.status(500).send({
          error: "Analytics worker recompute failed. Check server logs for details.",
        });
      } finally {
        localRecomputeInFlight = false;
      }
    }
  );

  // Loss Prevention (Cashier Anomalies + Live-Stock Dead-Stock Cash Traps + Negative Stock)
  app.get(
    "/api/analytics/loss-prevention",
    { preHandler: analyticsReadOnly },
    async () => {
      const [cashiers, deadStock, negativeStock] = await Promise.all([
        db.select().from(analyticsLpAnomalies).orderBy(desc(analyticsLpAnomalies.zScore)),
        db.execute(sql`
          WITH unfolded AS (
            SELECT product_id, COALESCE(SUM(qty_delta), 0)::int AS delta
            FROM stock_movements
            WHERE folded = false
            GROUP BY product_id
          ),
          live AS (
            SELECT
              p.id,
              p.sku,
              p.name,
              p.brand,
              p.unit_mode,
              d.name AS department_name,
              (COALESCE(sb.quantity, 0) + COALESCE(u.delta, 0))::int AS on_hand_units,
              p.avg_cost_cents,
              COALESCE(ax.units_60d, 0)::int AS units_60d
            FROM products p
            JOIN categories c ON c.id = p.category_id
            JOIN departments d ON d.id = c.department_id
            LEFT JOIN stock_baselines sb ON sb.product_id = p.id
            LEFT JOIN unfolded u ON u.product_id = p.id
            LEFT JOIN analytics_abc_xyz ax ON ax.product_id = p.id
          )
          SELECT
            id,
            sku,
            name,
            brand,
            department_name,
            on_hand_units,
            ROUND((GREATEST(0, on_hand_units)::numeric * avg_cost_cents) / CASE WHEN unit_mode IN ('weight_g', 'volume_ml') THEN 1000.0 ELSE 1.0 END)::bigint AS tied_capital_cents,
            units_60d
          FROM live
          WHERE units_60d <= 2 AND on_hand_units > 10
          ORDER BY tied_capital_cents DESC
          LIMIT 25
        `),
        db.execute(sql`
          WITH unfolded AS (
            SELECT product_id, COALESCE(SUM(qty_delta), 0)::int AS delta
            FROM stock_movements
            WHERE folded = false
            GROUP BY product_id
          ),
          live_stock AS (
            SELECT
              p.id,
              p.sku,
              p.name,
              (COALESCE(sb.quantity, 0) + COALESCE(u.delta, 0))::int AS on_hand
            FROM products p
            LEFT JOIN stock_baselines sb ON sb.product_id = p.id
            LEFT JOIN unfolded u ON u.product_id = p.id
          )
          SELECT id, sku, name, on_hand AS on_hand_units
          FROM live_stock
          WHERE on_hand < 0
          ORDER BY on_hand ASC
          LIMIT 25
        `),
      ]);

      return {
        cashierAnomalies: cashiers,
        deadStockTraps: deadStock.rows.map((r: Record<string, unknown>) => ({
          id: String(r.id),
          sku: String(r.sku),
          name: String(r.name),
          brand: String(r.brand),
          departmentName: String(r.department_name),
          onHandUnits: Number(r.on_hand_units),
          tiedCapitalCents: Number(r.tied_capital_cents),
          units60d: Number(r.units_60d),
        })),
        negativeStock: negativeStock.rows,
      };
    }
  );

  // Accounting Journal Export (supports ?days=7|30|60|all, bounded at 730 days max)
  app.get(
    "/api/exports/accounting.csv",
    { preHandler: [...analyticsReadOnly, exportLimiter] },
    async (req, reply) => {
      const q = req.query as { days?: string };
      let effectiveDays = 730;
      if (q.days && q.days !== "all") {
        const raw = Number(q.days);
        effectiveDays = Number.isFinite(raw) ? Math.min(730, Math.max(1, Math.trunc(raw))) : 30;
      }

      const res = await db.execute(sql`
        SELECT
          to_char(date_trunc('day', s.sold_at), 'YYYY-MM-DD') AS date,
          COUNT(*) FILTER (WHERE s.kind = 'sale')::int AS receipts,
          COALESCE(SUM(s.subtotal_cents) FILTER (WHERE s.kind = 'sale'), 0)::bigint AS gross_sales_cents,
          COALESCE(SUM(CASE WHEN s.kind = 'sale' THEN s.discount_cents ELSE -s.discount_cents END), 0)::bigint AS discounts_cents,
          COALESCE(SUM(s.total_cents) FILTER (WHERE s.kind IN ('void', 'refund')), 0)::bigint AS returns_voids_cents,
          COALESCE(SUM(CASE WHEN s.kind = 'sale' THEN s.tax_cents ELSE -s.tax_cents END), 0)::bigint AS vat_collected_cents,
          COALESCE(SUM(CASE WHEN s.kind = 'sale' THEN (s.total_cents - s.tax_cents) ELSE -(s.total_cents - s.tax_cents) END), 0)::bigint AS net_revenue_cents,
          COALESCE(SUM(CASE WHEN s.kind = 'sale' THEN s.total_cost_cents ELSE -s.total_cost_cents END), 0)::bigint AS cogs_cents
        FROM sales s
        WHERE s.sold_at >= now() - (${effectiveDays} || ' days')::interval
        GROUP BY 1
        ORDER BY 1 DESC
      `);

      reply.header("X-Max-Days", String(effectiveDays));

      const toUsd = (v: unknown) => (Number(v ?? 0) / 100).toFixed(2);
      const csv = buildCsvDocument(
        [
          "Date",
          "Receipts",
          "GrossSalesUSD",
          "DiscountsUSD",
          "ReturnsVoidsUSD",
          "VATCollectedUSD",
          "NetRevenueUSD",
          "COGS_USD",
          "GrossProfitUSD",
        ],
        (res.rows as Record<string, unknown>[]).map((r) => {
          const net = Number(r.net_revenue_cents ?? 0);
          const cogs = Number(r.cogs_cents ?? 0);
          return [
            r.date,
            Number(r.receipts ?? 0),
            toUsd(r.gross_sales_cents),
            toUsd(r.discounts_cents),
            toUsd(r.returns_voids_cents),
            toUsd(r.vat_collected_cents),
            toUsd(net),
            toUsd(cogs),
            toUsd(net - cogs),
          ];
        })
      );

      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header(
        "Content-Disposition",
        `attachment; filename="supermarket-os-accounting-journal-${q.days && q.days !== "all" ? `${effectiveDays}d` : `all-${effectiveDays}d`}.csv"`
      );
      return csv;
    }
  );

  // Wave 2 Phase 3: Promotion ROI & Margin Attribution
  app.get("/api/analytics/promo-roi", { preHandler: analyticsReadOnly }, async () => {
    const rows = await db
      .select()
      .from(analyticsPromoRoi)
      .orderBy(desc(analyticsPromoRoi.estimatedProfitDeltaCents));

    const totalDiscountGivenCents = rows.reduce((s, r) => s + r.discountGivenCents, 0);
    const totalProfitDeltaCents = rows.reduce((s, r) => s + r.estimatedProfitDeltaCents, 0);
    const accretiveCount = rows.filter((r) => r.verdict === "profit_accretive").length;
    const dilutiveCount = rows.filter((r) => r.verdict === "margin_dilutive").length;

    return {
      summary: {
        promotionsEvaluated: rows.length,
        accretiveCount,
        dilutiveCount,
        totalDiscountGivenCents,
        totalProfitDeltaCents,
      },
      items: rows,
    };
  });
}
