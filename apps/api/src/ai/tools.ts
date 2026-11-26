import {
  computeNetMarginBp,
  computeSuggestedSellPriceCents,
  evaluateCart,
  formatBp,
  formatMoney,
  type CartInputLine,
  type PromotionRule,
} from "@supermarket/shared";
import { and, asc, desc, eq, ilike, inArray, lte, or, sql } from "drizzle-orm";
import {
  aiProposedActions,
  analyticsAbcXyz,
  analyticsBasketRules,
  analyticsDemandForecasts,
  analyticsDynamicMarkdowns,
  analyticsLpAnomalies,
  analyticsPhantomStock,
  analyticsShiftDiagnostics,
  analyticsSupplierScorecards,
  db,
  grnVariances,
  inventoryBatches,
  marginAlerts,
  productBarcodes,
  products,
  shiftExperiments,
  stockBaselines,
  stockMovements,
  storeTasks,
  supplierProducts,
  suppliers,
  taxRates,
} from "../db/index.js";
import type { AuthUser } from "../plugins/auth.js";

export interface CopilotToolContext {
  conversationId: string;
  user: AuthUser;
}

export interface CopilotToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const COPILOT_TOOLS: CopilotToolDefinition[] = [
  {
    type: "function",
    name: "get_store_kpis",
    description:
      "Get store-wide executive KPIs (net sales, gross sales, gross profit, margin %, average transaction value, shrinkage, and live inventory capital) for the last N days.",
    parameters: {
      type: "object",
      properties: {
        days: { type: "integer", description: "Lookback window in days (7, 30, or 60). Default 30." },
      },
    },
  },
  {
    type: "function",
    name: "get_department_profitability",
    description:
      "Get 60-day department profitability, actual vs target gross margin, live shelf stock value, GMROII, and annual turns.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "search_catalog",
    description:
      "Search the 3,120+ SKU supermarket catalog by name, brand, SKU, or barcode, returning live stock, cost, primary price, net margin, and ABC-XYZ segment.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Product name, brand, SKU, or barcode." },
        limit: { type: "integer", description: "Max rows to return (default 10, max 25)." },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "get_reorder_alerts",
    description:
      "Get urgent replenishment demand forecasts and supplier-grouped reorder case quantities.",
    parameters: {
      type: "object",
      properties: {
        urgency: {
          type: "string",
          description: "Optional filter: critical, reorder_now, or watch.",
        },
        limit: { type: "integer", description: "Max SKUs to return (default 15)." },
      },
    },
  },
  {
    type: "function",
    name: "get_expiry_risks",
    description:
      "Get FEFO near-expiry packaged batches within N days, ranked by earliest Best-Before date and at-risk capital.",
    parameters: {
      type: "object",
      properties: {
        days: { type: "integer", description: "Expiry horizon in days (default 30)." },
        limit: { type: "integer", description: "Max batches to return (default 15)." },
      },
    },
  },
  {
    type: "function",
    name: "get_margin_alerts",
    description:
      "Get unresolved vendor margin-erosion alerts caused by distributor cost hikes below category floor.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "get_loss_prevention_report",
    description:
      "Get cashier anomaly scores (voids, refunds, no-sale drawer opens, MAD Z-scores) and top dead-stock capital traps.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "get_basket_associations",
    description:
      "Get top high-lift Market Basket co-purchase pairs for merchandising, end-caps, and bundle promotions.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Max rules to return (default 10)." },
        shiftBucket: {
          type: "string",
          enum: ["all", "morning"],
          description: "Optional shift slice: 'morning' (08:00-11:59) or 'all'.",
        },
      },
    },
  },
  {
    type: "function",
    name: "diagnose_shift_performance",
    description:
      "Diagnose morning-shift vs afternoon/evening performance using Traffic x Conversion x UPT x ASP funnel decomposition, 08:00 Class-A stockout losses, single-lane queue saturation, chronological Ridge causal drivers, K-Means shopper missions, morning basket rules, and DiD experiments.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "propose_purchase_order",
    description:
      "Create a pending Human-in-the-Loop Purchase Order proposal for manager approval. Does NOT modify operational tables until approved in the UI.",
    parameters: {
      type: "object",
      properties: {
        supplierName: {
          type: "string",
          description: "Supplier name (or partial match) to draft a reorder PO for.",
        },
        urgency: {
          type: "string",
          description: "Optional urgency filter (critical or reorder_now). Defaults to all suggested reorders for that supplier.",
        },
        notes: { type: "string", description: "Reason or context for the PO." },
      },
      required: ["supplierName"],
    },
  },
  {
    type: "function",
    name: "propose_price_update",
    description:
      "Create a pending Human-in-the-Loop retail price update proposal for a SKU (e.g. to resolve a margin erosion alert), including proportional multi-pack/case scaling.",
    parameters: {
      type: "object",
      properties: {
        skuOrProductId: { type: "string", description: "Product SKU or UUID." },
        newSellPriceCents: {
          type: "integer",
          description: "Optional new primary unit price in integer cents. If omitted, uses the category floor suggested price.",
        },
        reason: { type: "string", description: "Short explanation for the price update." },
      },
      required: ["skuOrProductId"],
    },
  },
  {
    type: "function",
    name: "propose_promotion",
    description:
      "Design a pending Human-in-the-Loop promotion or clearance markdown proposal and dry-run simulate it through the deterministic @supermarket/shared pricing engine to verify net margin compliance.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Promotion display name." },
        promoType: {
          type: "string",
          enum: ["clearance", "tier_price", "mix_and_match", "bogo", "basket_threshold"],
        },
        productIds: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of product UUIDs targeted.",
        },
        discountBp: {
          type: "integer",
          description: "Discount in basis points (e.g. 2000 = 20% off) for clearance/tier_price/bogo.",
        },
        requiredQty: { type: "integer", description: "Bundle or tier threshold quantity." },
        bundlePriceCents: { type: "integer", description: "Fixed bundle price in cents for mix_and_match." },
        buyQty: { type: "integer", description: "Buy X for bogo." },
        getQty: { type: "integer", description: "Get Y for bogo." },
        minMarginGuardBp: {
          type: "integer",
          description: "Minimum net margin guard in basis points (default 1000 = 10%).",
        },
        daypartStartHour: {
          type: "integer",
          description: "Optional inclusive local hour 0..23 (e.g. 8 for morning start).",
        },
        daypartEndHour: {
          type: "integer",
          description: "Optional exclusive local hour 1..24 (e.g. 12 for 08:00-11:59 morning end).",
        },
      },
      required: ["name", "promoType"],
    },
  },
  {
    type: "function",
    name: "get_supplier_scorecards",
    description:
      "Get 90-day Supplier OTIF scorecards (on-time, in-full, lead-time variability, A-D grade) and open 3-way PO/GRN/invoice dock variance exposure.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "get_phantom_stock_alerts",
    description:
      "Get open Poisson phantom-stock (silent zero-sales ghost inventory) alerts ranked by probability and estimated book value at risk.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Max SKUs to return (default 10, max 25)." },
      },
    },
  },
  {
    type: "function",
    name: "get_dynamic_markdowns",
    description:
      "Get elasticity-optimized FEFO dynamic markdown recommendations for near-expiry batches with incremental cash recovery estimates.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Max batches to return (default 10, max 25)." },
      },
    },
  },
  {
    type: "function",
    name: "get_floor_tasks",
    description:
      "Get today's pending store floor task checklist (pre-open restocks, blind cycle counts, 07:30 shelf tags, expiry markdowns) ranked by priority.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Max tasks to return (default 12, max 30)." },
      },
    },
  },
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_URGENCIES = new Set(["critical", "reorder_now", "watch", "healthy"]);
const VALID_PROMO_TYPES = new Set<PromotionRule["promoType"]>([
  "clearance",
  "tier_price",
  "mix_and_match",
  "bogo",
  "basket_threshold",
]);

function finiteIntInRange(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export async function executeCopilotTool(
  name: string,
  args: Record<string, unknown>,
  ctx: CopilotToolContext
): Promise<Record<string, unknown>> {
  try {
    return await executeCopilotToolInner(name, args ?? {}, ctx);
  } catch {
    return { error: `Tool "${name}" could not complete with the supplied parameters.` };
  }
}

async function executeCopilotToolInner(
  name: string,
  args: Record<string, unknown>,
  ctx: CopilotToolContext
): Promise<Record<string, unknown>> {
  switch (name) {
    case "get_store_kpis": {
      const days = Math.min(90, Math.max(7, Number(args.days ?? 30) || 30));
      const [kpiRes, shrinkRes, invRes] = await Promise.all([
        db.execute(sql`
          SELECT
            COUNT(*) FILTER (WHERE kind = 'sale')::int AS receipt_count,
            COALESCE(SUM(total_cents) FILTER (WHERE kind = 'sale'), 0)::bigint AS gross_sales_cents,
            COALESCE(SUM(discount_cents) FILTER (WHERE kind = 'sale'), 0)::bigint AS discounts_cents,
            COALESCE(SUM(tax_cents) FILTER (WHERE kind = 'sale'), 0)::bigint AS tax_cents,
            COALESCE(SUM(total_cost_cents) FILTER (WHERE kind = 'sale'), 0)::bigint AS cogs_cents,
            COALESCE(SUM(total_cents - tax_cents) FILTER (WHERE kind = 'sale'), 0)::bigint AS net_sales_cents
          FROM sales
          WHERE sold_at >= now() - (${days} || ' days')::interval
        `),
        db.execute(sql`
          SELECT COALESCE(SUM(ABS(qty_delta) * unit_cost_cents), 0)::bigint AS shrink_cost_cents
          FROM stock_movements
          WHERE reason IN ('spoilage', 'damage', 'count_adj') AND qty_delta < 0
            AND created_at >= now() - (${days} || ' days')::interval
        `),
        db.execute(sql`
          WITH unfolded AS (
            SELECT product_id, COALESCE(SUM(qty_delta), 0)::int AS delta
            FROM stock_movements WHERE folded = false GROUP BY product_id
          )
          SELECT
            COUNT(*)::int AS total_skus,
            COALESCE(SUM(GREATEST(0, COALESCE(b.quantity, 0) + COALESCE(u.delta, 0)) * p.avg_cost_cents), 0)::bigint AS inv_cost_cents
          FROM products p
          LEFT JOIN stock_baselines b ON b.product_id = p.id
          LEFT JOIN unfolded u ON u.product_id = p.id
          WHERE p.active = true
        `),
      ]);
      const k = kpiRes.rows[0] as Record<string, unknown>;
      const net = Number(k.net_sales_cents ?? 0);
      const gross = Number(k.gross_sales_cents ?? 0);
      const cogs = Number(k.cogs_cents ?? 0);
      const profit = net - cogs;
      const shrink = Number((shrinkRes.rows[0] as Record<string, unknown>)?.shrink_cost_cents ?? 0);
      const inv = invRes.rows[0] as Record<string, unknown>;
      return {
        days,
        receiptCount: Number(k.receipt_count ?? 0),
        grossSalesUsd: formatMoney(gross),
        netSalesUsd: formatMoney(net),
        grossProfitUsd: formatMoney(profit),
        grossMarginPct: formatBp(net > 0 ? Math.round((profit * 10000) / net) : 0),
        discountsUsd: formatMoney(Number(k.discounts_cents ?? 0)),
        shrinkageUsd: formatMoney(shrink),
        inventoryValueUsd: formatMoney(Number(inv.inv_cost_cents ?? 0)),
        totalSkus: Number(inv.total_skus ?? 0),
      };
    }

    case "get_department_profitability": {
      const res = await db.execute(sql`
        WITH unfolded AS (
          SELECT product_id, COALESCE(SUM(qty_delta), 0)::int AS delta
          FROM stock_movements WHERE folded = false GROUP BY product_id
        ),
        sales_by_dept AS (
          SELECT d.id AS department_id,
            COALESCE(SUM(sl.line_total_cents - sl.tax_cents), 0)::bigint AS net_sales_60d,
            COALESCE(SUM(sl.unit_cost_cents * sl.base_units_sold), 0)::bigint AS cogs_60d
          FROM sale_lines sl
          JOIN sales s ON s.id = sl.sale_id AND s.kind = 'sale'
          JOIN products p ON p.id = sl.product_id
          JOIN categories c ON c.id = p.category_id
          JOIN departments d ON d.id = c.department_id
          GROUP BY d.id
        ),
        inv_by_dept AS (
          SELECT d.id AS department_id,
            COALESCE(SUM(GREATEST(0, COALESCE(sb.quantity, 0) + COALESCE(u.delta, 0)) * p.avg_cost_cents), 0)::bigint AS stock_cost_cents
          FROM products p
          JOIN categories c ON c.id = p.category_id
          JOIN departments d ON d.id = c.department_id
          LEFT JOIN stock_baselines sb ON sb.product_id = p.id
          LEFT JOIN unfolded u ON u.product_id = p.id
          GROUP BY d.id
        )
        SELECT d.code, d.name, d.target_margin_bp,
          COALESCE(sd.net_sales_60d, 0)::bigint AS net_sales_60d,
          COALESCE(sd.cogs_60d, 0)::bigint AS cogs_60d,
          COALESCE(i.stock_cost_cents, 0)::bigint AS stock_cost_cents
        FROM departments d
        LEFT JOIN sales_by_dept sd ON sd.department_id = d.id
        LEFT JOIN inv_by_dept i ON i.department_id = d.id
        ORDER BY net_sales_60d DESC
      `);
      return {
        departments: res.rows.map((r: Record<string, unknown>) => {
          const net = Number(r.net_sales_60d ?? 0);
          const cogs = Number(r.cogs_60d ?? 0);
          const profit = net - cogs;
          const stock = Math.max(1, Number(r.stock_cost_cents ?? 0));
          const actualBp = net > 0 ? Math.round((profit * 10000) / net) : 0;
          return {
            code: String(r.code),
            name: String(r.name),
            netSales60d: formatMoney(net),
            grossProfit60d: formatMoney(profit),
            actualMargin: formatBp(actualBp),
            targetMargin: formatBp(Number(r.target_margin_bp)),
            gmroii: Number(((profit * 6.08) / stock).toFixed(2)),
          };
        }),
      };
    }

    case "search_catalog": {
      const q = String(args.query ?? "").trim().slice(0, 120);
      if (!q) {
        return { error: "Search query must be a non-empty string." };
      }
      const limit = Math.min(25, Math.max(1, Number(args.limit ?? 10) || 10));
      const unfoldedSq = db
        .select({
          productId: stockMovements.productId,
          delta: sql<number>`coalesce(sum(${stockMovements.qtyDelta}), 0)::int`.as("unfolded_delta"),
        })
        .from(stockMovements)
        .where(eq(stockMovements.folded, false))
        .groupBy(stockMovements.productId)
        .as("unfolded_sq");

      const bcMatches = await db
        .select({ productId: productBarcodes.productId })
        .from(productBarcodes)
        .where(ilike(productBarcodes.barcode, `%${q}%`))
        .limit(25);
      const bcPids = bcMatches.map((b) => b.productId);

      const whereCond =
        bcPids.length > 0
          ? or(
              ilike(products.name, `%${q}%`),
              ilike(products.sku, `%${q}%`),
              ilike(products.brand, `%${q}%`),
              inArray(products.id, bcPids)
            )
          : or(
              ilike(products.name, `%${q}%`),
              ilike(products.sku, `%${q}%`),
              ilike(products.brand, `%${q}%`)
            );

      const rows = await db
        .select({
          id: products.id,
          sku: products.sku,
          name: products.name,
          brand: products.brand,
          avgCostCents: products.avgCostCents,
          minMarginBp: products.minMarginBp,
          taxRateBp: taxRates.rateBp,
          taxInclusive: taxRates.isInclusive,
          onHandUnits: sql<number>`(coalesce(${stockBaselines.quantity}, 0) + coalesce(${unfoldedSq.delta}, 0))::int`,
          segment: analyticsAbcXyz.segment,
          primaryPriceCents: productBarcodes.sellPriceCents,
        })
        .from(products)
        .innerJoin(taxRates, eq(products.taxRateId, taxRates.id))
        .leftJoin(stockBaselines, eq(products.id, stockBaselines.productId))
        .leftJoin(unfoldedSq, eq(products.id, unfoldedSq.productId))
        .leftJoin(analyticsAbcXyz, eq(products.id, analyticsAbcXyz.productId))
        .leftJoin(
          productBarcodes,
          and(eq(productBarcodes.productId, products.id), eq(productBarcodes.isPrimary, true))
        )
        .where(whereCond)
        .limit(limit);

      return {
        count: rows.length,
        items: rows.map((r) => ({
          productId: r.id,
          sku: r.sku,
          name: r.name,
          brand: r.brand,
          cost: formatMoney(r.avgCostCents),
          sellPrice: formatMoney(r.primaryPriceCents ?? 0),
          netMargin: formatBp(
            computeNetMarginBp(
              r.primaryPriceCents ?? 0,
              r.avgCostCents,
              r.taxRateBp,
              r.taxInclusive
            )
          ),
          onHandUnits: r.onHandUnits,
          segment: r.segment ?? "N/A",
        })),
      };
    }

    case "get_reorder_alerts": {
      const rawUrgency = typeof args.urgency === "string" ? args.urgency.trim().toLowerCase() : "";
      if (rawUrgency && !VALID_URGENCIES.has(rawUrgency)) {
        return { error: `Invalid urgency filter "${rawUrgency}".` };
      }
      const urgency = rawUrgency || null;
      const limit = Math.min(30, Math.max(1, Number(args.limit ?? 15) || 15));
      const rows = await db
        .select({
          productId: products.id,
          sku: products.sku,
          name: products.name,
          urgency: analyticsDemandForecasts.urgency,
          currentStock: analyticsDemandForecasts.currentStockUnits,
          reorderPoint: analyticsDemandForecasts.reorderPointUnits,
          suggestedCases: analyticsDemandForecasts.suggestedOrderCases,
          caseQty: analyticsDemandForecasts.caseQty,
          estCostCents: analyticsDemandForecasts.estimatedOrderCostCents,
          supplierName: analyticsDemandForecasts.supplierName,
          modelUsed: analyticsDemandForecasts.modelUsed,
          wmapePct: analyticsDemandForecasts.wmapePct,
        })
        .from(analyticsDemandForecasts)
        .innerJoin(products, eq(analyticsDemandForecasts.productId, products.id))
        .where(
          urgency
            ? eq(analyticsDemandForecasts.urgency, urgency)
            : sql`${analyticsDemandForecasts.suggestedOrderCases} > 0`
        )
        .orderBy(
          sql`CASE ${analyticsDemandForecasts.urgency} WHEN 'critical' THEN 1 WHEN 'reorder_now' THEN 2 WHEN 'watch' THEN 3 ELSE 4 END`,
          desc(analyticsDemandForecasts.estimatedOrderCostCents)
        )
        .limit(limit);

      return {
        items: rows.map((r) => ({
          ...r,
          estCostUsd: formatMoney(r.estCostCents),
        })),
      };
    }

    case "get_expiry_risks": {
      const days = Math.min(180, Math.max(7, Number(args.days ?? 30) || 30));
      const limit = Math.min(30, Math.max(1, Number(args.limit ?? 15) || 15));
      const cutoff = new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
      const rows = await db
        .select({
          batchId: inventoryBatches.id,
          productId: products.id,
          sku: products.sku,
          name: products.name,
          bestBeforeDate: inventoryBatches.bestBeforeDate,
          qtyRemaining: inventoryBatches.qtyRemaining,
          unitCostCents: inventoryBatches.unitCostCents,
          status: inventoryBatches.status,
        })
        .from(inventoryBatches)
        .innerJoin(products, eq(inventoryBatches.productId, products.id))
        .where(
          and(
            lte(inventoryBatches.bestBeforeDate, cutoff),
            sql`${inventoryBatches.qtyRemaining} > 0`,
            sql`${inventoryBatches.status} IN ('active', 'clearance')`
          )
        )
        .orderBy(ascDate(inventoryBatches.bestBeforeDate))
        .limit(limit);

      return {
        horizonDays: days,
        batches: rows.map((r) => ({
          ...r,
          atRiskCostUsd: formatMoney(r.qtyRemaining * r.unitCostCents),
        })),
      };
    }

    case "get_margin_alerts": {
      const rows = await db
        .select({
          alertId: marginAlerts.id,
          productId: products.id,
          sku: products.sku,
          name: products.name,
          previousCostCents: marginAlerts.previousCostCents,
          newCostCents: marginAlerts.newCostCents,
          currentSellPriceCents: marginAlerts.currentSellPriceCents,
          resultingMarginBp: marginAlerts.resultingMarginBp,
          minMarginBp: marginAlerts.minMarginBp,
          suggestedSellPriceCents: marginAlerts.suggestedSellPriceCents,
        })
        .from(marginAlerts)
        .innerJoin(products, eq(marginAlerts.productId, products.id))
        .where(eq(marginAlerts.resolved, false))
        .orderBy(desc(marginAlerts.createdAt))
        .limit(20);

      return {
        openAlerts: rows.length,
        alerts: rows.map((r) => ({
          alertId: r.alertId,
          productId: r.productId,
          sku: r.sku,
          name: r.name,
          oldCost: formatMoney(r.previousCostCents),
          newCost: formatMoney(r.newCostCents),
          currentPrice: formatMoney(r.currentSellPriceCents),
          resultingMargin: formatBp(r.resultingMarginBp),
          floorMargin: formatBp(r.minMarginBp),
          suggestedPrice: formatMoney(r.suggestedSellPriceCents),
          suggestedPriceCents: r.suggestedSellPriceCents,
        })),
      };
    }

    case "get_loss_prevention_report": {
      const cashiers = await db
        .select()
        .from(analyticsLpAnomalies)
        .orderBy(desc(analyticsLpAnomalies.zScore));
      const deadStock = await db.execute(sql`
        WITH unfolded AS (
          SELECT product_id, COALESCE(SUM(qty_delta), 0)::int AS delta
          FROM stock_movements WHERE folded = false GROUP BY product_id
        ),
        live AS (
          SELECT p.id, p.sku, p.name,
            (COALESCE(sb.quantity, 0) + COALESCE(u.delta, 0))::int AS on_hand,
            p.avg_cost_cents,
            COALESCE(ax.units_60d, 0)::int AS units_60d
          FROM products p
          LEFT JOIN stock_baselines sb ON sb.product_id = p.id
          LEFT JOIN unfolded u ON u.product_id = p.id
          LEFT JOIN analytics_abc_xyz ax ON ax.product_id = p.id
        )
        SELECT sku, name, on_hand, units_60d,
          (GREATEST(0, on_hand) * avg_cost_cents)::bigint AS tied_cents
        FROM live
        WHERE units_60d <= 2 AND on_hand > 10
        ORDER BY tied_cents DESC
        LIMIT 10
      `);

      return {
        cashierAnomalies: cashiers.map((c) => ({
          cashier: c.cashierName,
          receipts: c.totalSalesCount,
          voids: c.voidCount,
          refunds: c.refundCount,
          noSales: c.noSaleDrawerCount,
          voidRatePct: c.voidRatePct,
          robustZScore: c.zScore,
          riskLevel: c.riskLevel,
        })),
        topDeadStock: deadStock.rows.map((d: Record<string, unknown>) => ({
          sku: String(d.sku),
          name: String(d.name),
          onHand: Number(d.on_hand),
          units60d: Number(d.units_60d),
          tiedCapitalUsd: formatMoney(Number(d.tied_cents ?? 0)),
        })),
      };
    }

    case "get_basket_associations": {
      const limit = Math.min(20, Math.max(1, Number(args.limit ?? 10) || 10));
      const shiftBucket = args.shiftBucket === "morning" ? "morning" : "all";
      const rules = await db
        .select()
        .from(analyticsBasketRules)
        .where(eq(analyticsBasketRules.shiftBucket, shiftBucket))
        .orderBy(desc(analyticsBasketRules.lift))
        .limit(limit);
      return {
        shiftBucket,
        rules: rules.map((r) => ({
          antecedentProductId: r.antecedentProductId,
          consequentProductId: r.consequentProductId,
          antecedentName: r.antecedentName,
          consequentName: r.consequentName,
          coOccurrences: r.coOccurrences,
          confidencePct: `${(r.confidence * 100).toFixed(1)}%`,
          lift: r.lift,
        })),
      };
    }

    case "diagnose_shift_performance": {
      const [diagRows, morningRules, expRows] = await Promise.all([
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
          .limit(5),
        db.select().from(shiftExperiments).orderBy(desc(shiftExperiments.createdAt)).limit(3),
      ]);

      const diag = diagRows[0];
      if (!diag) {
        return {
          error:
            "Shift diagnostics have not been computed yet. Trigger /api/analytics/shift-diagnostics/recompute.",
        };
      }

      const comparison = (diag.shiftComparisonJson ?? {}) as {
        shifts?: Array<Record<string, unknown>>;
        morningVsAfternoonConversionPValue?: number;
      };
      const oosList = ((diag.oosRootCausesJson as Array<Record<string, unknown>>) ?? []).slice(0, 5);
      const queue = (diag.queueSaturationJson ?? {}) as Record<string, unknown>;
      const attribution = (diag.driverAttributionJson ?? {}) as {
        drivers?: Array<Record<string, unknown>>;
        holdoutWmapePct?: number;
        baselineWmapePct?: number;
      };

      return {
        primaryBottleneck: diag.primaryBottleneck,
        morningSharePct: diag.morningSharePct,
        morningConversionPct: diag.morningConversionPct,
        afternoonConversionPct: diag.afternoonConversionPct,
        eveningConversionPct: diag.eveningConversionPct,
        conversionPValue: comparison.morningVsAfternoonConversionPValue ?? null,
        morningEstLostRevenueUsd: formatMoney(Number(diag.morningEstLostRevenueCents)),
        shifts: comparison.shifts ?? [],
        topOosSkus: oosList.map((o) => ({
          sku: o.sku,
          name: o.name,
          segment: o.abcSegment,
          oosDays: o.oosDays,
          avgRestockHour: o.avgRestockHour,
          estLostUsd: formatMoney(Number(o.estLostRevenueCents ?? 0)),
          supplierName: o.supplierName,
        })),
        queueSaturationThreshold: queue.thresholdBin ?? "Unknown",
        topDrivers: (attribution.drivers ?? []).slice(0, 4),
        holdoutWmapePct: attribution.holdoutWmapePct ?? 0,
        baselineWmapePct: attribution.baselineWmapePct ?? 0,
        topMorningBasketRules: morningRules.map((r) => ({
          antecedentProductId: r.antecedentProductId,
          consequentProductId: r.consequentProductId,
          antecedentName: r.antecedentName,
          consequentName: r.consequentName,
          lift: r.lift,
          confidencePct: `${(r.confidence * 100).toFixed(1)}%`,
        })),
        experiments: expRows.map((e) => ({
          name: e.name,
          results: e.resultsJson,
        })),
      };
    }

    case "propose_purchase_order": {
      const supQuery = String(args.supplierName ?? "").trim().slice(0, 120);
      if (!supQuery) {
        return { error: "supplierName is required to propose a purchase order." };
      }
      const rawUrgency = typeof args.urgency === "string" ? args.urgency.trim().toLowerCase() : "";
      if (rawUrgency && !VALID_URGENCIES.has(rawUrgency)) {
        return { error: `Invalid urgency filter "${rawUrgency}".` };
      }
      const urgencyFilter = rawUrgency || null;
      const [sup] = await db
        .select()
        .from(suppliers)
        .where(ilike(suppliers.name, `%${supQuery}%`))
        .limit(1);
      if (!sup) {
        return { error: `No supplier matched "${supQuery}".` };
      }

      const forecastRows = await db
        .select({
          productId: products.id,
          sku: products.sku,
          name: products.name,
          avgCostCents: products.avgCostCents,
          caseQty: analyticsDemandForecasts.caseQty,
          suggestedCases: analyticsDemandForecasts.suggestedOrderCases,
          estCostCents: analyticsDemandForecasts.estimatedOrderCostCents,
          urgency: analyticsDemandForecasts.urgency,
        })
        .from(analyticsDemandForecasts)
        .innerJoin(products, eq(analyticsDemandForecasts.productId, products.id))
        .innerJoin(
          supplierProducts,
          and(
            eq(supplierProducts.productId, products.id),
            eq(supplierProducts.supplierId, sup.id)
          )
        )
        .where(
          and(
            sql`${analyticsDemandForecasts.suggestedOrderCases} > 0`,
            urgencyFilter ? eq(analyticsDemandForecasts.urgency, urgencyFilter) : undefined
          )
        )
        .orderBy(desc(analyticsDemandForecasts.estimatedOrderCostCents))
        .limit(25);

      if (forecastRows.length === 0) {
        return { error: `No suggested reorder SKUs found for ${sup.name}.` };
      }

      const totalCases = forecastRows.reduce((s, r) => s + r.suggestedCases, 0);
      const totalCostCents = forecastRows.reduce((s, r) => s + r.estCostCents, 0);

      const payloadJson = {
        supplierId: sup.id,
        supplierName: sup.name,
        notes:
          typeof args.notes === "string" && args.notes.trim()
            ? args.notes.trim().slice(0, 500)
            : `AI-drafted replenishment PO for ${sup.name}`,
        lines: forecastRows.map((r) => ({
          productId: r.productId,
          sku: r.sku,
          name: r.name,
          caseQty: r.caseQty,
          orderedCases: r.suggestedCases,
          unitCostCents: r.avgCostCents,
        })),
      };

      const previewJson = {
        supplierName: sup.name,
        skuCount: forecastRows.length,
        totalCases,
        estimatedCostUsd: formatMoney(totalCostCents),
        topLines: forecastRows.slice(0, 5).map((r) => `${r.sku} (${r.suggestedCases} cs)`),
      };

      const [action] = await db
        .insert(aiProposedActions)
        .values({
          conversationId: ctx.conversationId,
          actionType: "create_po",
          title: `Draft PO: ${sup.name} (${totalCases} cases)`,
          summary: `${forecastRows.length} SKUs · Est. ${formatMoney(totalCostCents)}`,
          payloadJson,
          previewJson,
          status: "pending",
          createdBy: ctx.user.fullName,
        })
        .returning();

      return {
        proposedActionId: action.id,
        status: "pending_approval",
        ...previewJson,
      };
    }

    case "propose_price_update": {
      const key = String(args.skuOrProductId ?? "").trim().slice(0, 80);
      if (!key) {
        return { error: "skuOrProductId is required." };
      }
      const isUuid = UUID_RE.test(key);
      const [prod] = await db
        .select({
          id: products.id,
          sku: products.sku,
          name: products.name,
          avgCostCents: products.avgCostCents,
          minMarginBp: products.minMarginBp,
          taxRateBp: taxRates.rateBp,
          taxInclusive: taxRates.isInclusive,
        })
        .from(products)
        .innerJoin(taxRates, eq(products.taxRateId, taxRates.id))
        .where(isUuid ? eq(products.id, key) : ilike(products.sku, key))
        .limit(1);

      if (!prod) {
        return { error: `Product "${key}" not found.` };
      }

      const [primaryBc] = await db
        .select()
        .from(productBarcodes)
        .where(and(eq(productBarcodes.productId, prod.id), eq(productBarcodes.isPrimary, true)))
        .limit(1);

      if (!primaryBc) {
        return { error: `No primary barcode found for ${prod.sku}.` };
      }

      const [openAlert] = await db
        .select()
        .from(marginAlerts)
        .where(and(eq(marginAlerts.productId, prod.id), eq(marginAlerts.resolved, false)))
        .limit(1);

      const basisCost = openAlert ? Math.max(prod.avgCostCents, openAlert.newCostCents) : prod.avgCostCents;
      const suggested = computeSuggestedSellPriceCents(
        basisCost * primaryBc.packQty,
        prod.minMarginBp,
        prod.taxRateBp,
        prod.taxInclusive,
        5
      );
      const requestedPrice = finiteIntInRange(args.newSellPriceCents, 1, 10_000_000);
      const targetPrice = requestedPrice ?? openAlert?.suggestedSellPriceCents ?? suggested;

      const currentMarginBp = computeNetMarginBp(
        primaryBc.sellPriceCents,
        basisCost * primaryBc.packQty,
        prod.taxRateBp,
        prod.taxInclusive
      );
      const newMarginBp = computeNetMarginBp(
        targetPrice,
        basisCost * primaryBc.packQty,
        prod.taxRateBp,
        prod.taxInclusive
      );

      const payloadJson = {
        productId: prod.id,
        alertId: openAlert?.id ?? null,
        newSellPriceCents: targetPrice,
        reason:
          typeof args.reason === "string" && args.reason.trim()
            ? args.reason.trim().slice(0, 300)
            : "Restore net margin floor across primary & multi-pack tiers",
      };

      const previewJson = {
        sku: prod.sku,
        name: prod.name,
        oldPriceUsd: formatMoney(primaryBc.sellPriceCents),
        newPriceUsd: formatMoney(targetPrice),
        currentNetMargin: formatBp(currentMarginBp),
        newNetMargin: formatBp(newMarginBp),
      };

      const [action] = await db
        .insert(aiProposedActions)
        .values({
          conversationId: ctx.conversationId,
          actionType: "update_price",
          title: `Reprice ${prod.sku}: ${formatMoney(primaryBc.sellPriceCents)} → ${formatMoney(targetPrice)}`,
          summary: `${prod.name} · Net margin ${formatBp(currentMarginBp)} → ${formatBp(newMarginBp)}`,
          payloadJson,
          previewJson,
          status: "pending",
          createdBy: ctx.user.fullName,
        })
        .returning();

      return {
        proposedActionId: action.id,
        status: "pending_approval",
        ...previewJson,
      };
    }

    case "propose_promotion": {
      const rawPromoType = String(args.promoType ?? "clearance").trim() as PromotionRule["promoType"];
      if (!VALID_PROMO_TYPES.has(rawPromoType)) {
        return { error: `Unsupported promoType "${rawPromoType}".` };
      }
      const promoType = rawPromoType;
      const promoName = String(args.name ?? "AI Suggested Promotion").trim().slice(0, 160);
      if (promoName.length < 2) {
        return { error: "Promotion name must be at least 2 characters." };
      }
      const minMarginGuardBp = finiteIntInRange(args.minMarginGuardBp, 0, 9500) ?? 1000;
      const rawDaypartStart = finiteIntInRange(args.daypartStartHour, 0, 23);
      const rawDaypartEnd = finiteIntInRange(args.daypartEndHour, 1, 24);
      const hasCompleteDaypart = rawDaypartStart !== null && rawDaypartEnd !== null;
      const daypartStartHour = hasCompleteDaypart ? rawDaypartStart : null;
      const daypartEndHour = hasCompleteDaypart ? rawDaypartEnd : null;

      // Filter productIds safely to valid UUIDs (prevent Postgres 22P02 if LLM passes SKUs or garbage)
      let productIds: string[] | undefined;
      if (Array.isArray(args.productIds) && args.productIds.length > 0) {
        const rawIds = args.productIds.map((x) => String(x).trim()).filter(Boolean).slice(0, 50);
        const uuids = rawIds.filter((x) => UUID_RE.test(x));
        const nonUuids = rawIds.filter((x) => !UUID_RE.test(x));
        if (nonUuids.length > 0) {
          const resolvedBySku = await db
            .select({ id: products.id })
            .from(products)
            .where(inArray(products.sku, nonUuids));
          uuids.push(...resolvedBySku.map((r) => r.id));
        }
        const deduped = Array.from(new Set(uuids));
        if (deduped.length === 0) {
          return { error: "No valid product UUIDs or SKUs found in productIds." };
        }
        productIds = deduped;
      }

      const rulesJson: Record<string, unknown> = {};
      if (productIds && productIds.length > 0) rulesJson.productIds = productIds;
      const discountBp = finiteIntInRange(args.discountBp, 1, 9500);
      if (discountBp !== null) rulesJson.discountBp = discountBp;
      const requiredQty = finiteIntInRange(args.requiredQty, 1, 100);
      if (requiredQty !== null) rulesJson.requiredQty = requiredQty;
      const bundlePriceCents = finiteIntInRange(args.bundlePriceCents, 1, 10_000_000);
      if (bundlePriceCents !== null) rulesJson.bundlePriceCents = bundlePriceCents;
      const buyQty = finiteIntInRange(args.buyQty, 1, 50);
      if (buyQty !== null) rulesJson.buyQty = buyQty;
      const getQty = finiteIntInRange(args.getQty, 1, 50);
      if (getQty !== null) rulesJson.getQty = getQty;

      // Dry-run simulate through @supermarket/shared evaluateCart()
      const sampleProds = await db
        .select({
          id: products.id,
          sku: products.sku,
          name: products.name,
          categoryId: products.categoryId,
          avgCostCents: products.avgCostCents,
          requiresAgeCheck: products.requiresAgeCheck,
          taxRateBp: taxRates.rateBp,
          taxInclusive: taxRates.isInclusive,
          barcode: productBarcodes.barcode,
          packLabel: productBarcodes.packLabel,
          packQty: productBarcodes.packQty,
          sellPriceCents: productBarcodes.sellPriceCents,
        })
        .from(products)
        .innerJoin(taxRates, eq(products.taxRateId, taxRates.id))
        .innerJoin(
          productBarcodes,
          and(eq(productBarcodes.productId, products.id), eq(productBarcodes.isPrimary, true))
        )
        .where(productIds && productIds.length > 0 ? inArray(products.id, productIds) : undefined)
        .limit(3);

      const qtyPerLine =
        promoType === "bogo"
          ? (buyQty ?? 2) + (getQty ?? 1)
          : promoType === "tier_price" || promoType === "mix_and_match"
            ? Math.max(1, requiredQty ?? 2)
            : 1;

      const sampleCart: CartInputLine[] = sampleProds.map((p, idx) => ({
        lineKey: `sim-${idx}`,
        productId: p.id,
        categoryId: p.categoryId,
        sku: p.sku,
        name: p.name,
        scannedBarcode: p.barcode,
        packLabel: p.packLabel,
        packQty: p.packQty,
        qtyPacks: qtyPerLine,
        unitPriceCents: p.sellPriceCents,
        unitCostCents: p.avgCostCents,
        taxRateBp: p.taxRateBp,
        taxInclusive: p.taxInclusive,
        requiresAgeCheck: p.requiresAgeCheck,
      }));

      const rule: PromotionRule = {
        id: "sim-promo",
        name: promoName,
        promoType,
        priority: 15,
        combinable: false,
        minMarginGuardBp,
        daypartStartHour,
        daypartEndHour,
        ...(rulesJson as Record<string, unknown>),
      };

      const sim = evaluateCart(
        sampleCart,
        [rule],
        daypartStartHour !== null ? { evalHour: daypartStartHour } : undefined
      );

      const payloadJson = {
        name: promoName,
        promoType,
        priority: 15,
        combinable: false,
        minMarginGuardBp,
        daypartStartHour,
        daypartEndHour,
        rulesJson,
      };
      const daypartLabel =
        daypartStartHour !== null && daypartEndHour !== null
          ? `${String(daypartStartHour).padStart(2, "0")}:00-${String(daypartEndHour).padStart(2, "0")}:00`
          : "All hours";
      const previewJson = {
        promoType,
        daypartWindow: daypartLabel,
        minMarginFloor: formatBp(minMarginGuardBp),
        sampleSubtotalUsd: formatMoney(sim.subtotalBeforeDiscountCents),
        sampleDiscountUsd: formatMoney(sim.totalDiscountCents),
        sampleTotalUsd: formatMoney(sim.grandTotalCents),
        simulatedNetMargin: formatBp(sim.estimatedMarginBp),
      };

      const [action] = await db
        .insert(aiProposedActions)
        .values({
          conversationId: ctx.conversationId,
          actionType: "create_promo",
          title: `Launch Promo: ${promoName}`,
          summary: `${promoType} (${daypartLabel}) · Simulated net margin ${formatBp(sim.estimatedMarginBp)} (floor ${formatBp(minMarginGuardBp)})`,
          payloadJson,
          previewJson,
          status: "pending",
          createdBy: ctx.user.fullName,
        })
        .returning();

      return {
        proposedActionId: action.id,
        status: "pending_approval",
        ...previewJson,
      };
    }

    case "get_supplier_scorecards": {
      const rows = await db
        .select({
          supplierName: suppliers.name,
          grade: analyticsSupplierScorecards.grade,
          otifRatePct: analyticsSupplierScorecards.otifRatePct,
          onTimeRatePct: analyticsSupplierScorecards.onTimeRatePct,
          inFullRatePct: analyticsSupplierScorecards.inFullRatePct,
          avgLeadTimeDays: analyticsSupplierScorecards.avgLeadTimeDays,
          leadTimeStdDays: analyticsSupplierScorecards.leadTimeStdDays,
          costVarianceRatePct: analyticsSupplierScorecards.costVarianceRatePct,
          totalVarianceCents: analyticsSupplierScorecards.totalVarianceCents,
        })
        .from(analyticsSupplierScorecards)
        .innerJoin(suppliers, eq(analyticsSupplierScorecards.supplierId, suppliers.id))
        .orderBy(asc(analyticsSupplierScorecards.otifRatePct));

      const [openVars] = await db
        .select({
          cnt: sql<number>`count(*)::int`,
          impactCents: sql<number>`coalesce(sum(${grnVariances.financialImpactCents}), 0)::bigint`,
        })
        .from(grnVariances)
        .where(inArray(grnVariances.status, ["open", "disputed"]));

      return {
        supplierCount: rows.length,
        openVarianceCount: Number(openVars?.cnt ?? 0),
        openVarianceImpactUsd: formatMoney(Number(openVars?.impactCents ?? 0)),
        scorecards: rows.map((r) => ({
          supplierName: r.supplierName,
          grade: r.grade,
          otifPct: Number(r.otifRatePct.toFixed(1)),
          onTimePct: Number(r.onTimeRatePct.toFixed(1)),
          inFullPct: Number(r.inFullRatePct.toFixed(1)),
          leadTimeDays: `${r.avgLeadTimeDays.toFixed(1)}±${r.leadTimeStdDays.toFixed(1)}d`,
          costVariancePct: Number(r.costVarianceRatePct.toFixed(1)),
        })),
      };
    }

    case "get_phantom_stock_alerts": {
      const limit = finiteIntInRange(args.limit, 1, 25) ?? 10;
      const rows = await db
        .select({
          sku: products.sku,
          name: products.name,
          aisleLocation: products.aisleLocation,
          bookStockUnits: analyticsPhantomStock.bookStockUnits,
          daysSinceLastSale: analyticsPhantomStock.daysSinceLastSale,
          phantomProb: analyticsPhantomStock.phantomProb,
          estimatedValueAtRiskCents: analyticsPhantomStock.estimatedValueAtRiskCents,
        })
        .from(analyticsPhantomStock)
        .innerJoin(products, eq(analyticsPhantomStock.productId, products.id))
        .where(eq(analyticsPhantomStock.status, "open"))
        .orderBy(desc(analyticsPhantomStock.phantomProb))
        .limit(limit);

      const totalAtRisk = rows.reduce((s, r) => s + r.estimatedValueAtRiskCents, 0);
      return {
        openAlerts: rows.length,
        totalAtRiskUsd: formatMoney(totalAtRisk),
        items: rows.map((r) => ({
          sku: r.sku,
          name: r.name,
          aisle: r.aisleLocation,
          bookStock: r.bookStockUnits,
          silentDays: Number(r.daysSinceLastSale.toFixed(1)),
          phantomProbPct: Math.round(r.phantomProb * 100),
          atRiskUsd: formatMoney(r.estimatedValueAtRiskCents),
        })),
      };
    }

    case "get_dynamic_markdowns": {
      const limit = finiteIntInRange(args.limit, 1, 25) ?? 10;
      const rows = await db
        .select({
          sku: products.sku,
          name: products.name,
          daysLeft: analyticsDynamicMarkdowns.daysLeft,
          qtyRemaining: analyticsDynamicMarkdowns.qtyRemaining,
          recommendedDiscountBp: analyticsDynamicMarkdowns.recommendedDiscountBp,
          recommendedPromoPriceCents: analyticsDynamicMarkdowns.recommendedPromoPriceCents,
          expectedRecoveryCents: analyticsDynamicMarkdowns.expectedRecoveryCents,
          baselineNoPromoRecoveryCents: analyticsDynamicMarkdowns.baselineNoPromoRecoveryCents,
        })
        .from(analyticsDynamicMarkdowns)
        .innerJoin(products, eq(analyticsDynamicMarkdowns.productId, products.id))
        .where(eq(analyticsDynamicMarkdowns.status, "recommended"))
        .orderBy(asc(analyticsDynamicMarkdowns.daysLeft), desc(analyticsDynamicMarkdowns.expectedRecoveryCents))
        .limit(limit);

      const totalLift = rows.reduce(
        (s, r) => s + Math.max(0, r.expectedRecoveryCents - r.baselineNoPromoRecoveryCents),
        0
      );
      return {
        recommendedCount: rows.length,
        totalIncrementalRecoveryUsd: formatMoney(totalLift),
        items: rows.map((r) => ({
          sku: r.sku,
          name: r.name,
          daysLeft: r.daysLeft,
          qtyRemaining: r.qtyRemaining,
          recommendedDiscount: formatBp(r.recommendedDiscountBp),
          promoPriceUsd: formatMoney(r.recommendedPromoPriceCents),
          incrementalRecoveryUsd: formatMoney(
            Math.max(0, r.expectedRecoveryCents - r.baselineNoPromoRecoveryCents)
          ),
        })),
      };
    }

    case "get_floor_tasks": {
      const limit = finiteIntInRange(args.limit, 1, 30) ?? 12;
      const rows = await db
        .select({
          taskDate: storeTasks.taskDate,
          shiftBucket: storeTasks.shiftBucket,
          taskType: storeTasks.taskType,
          priority: storeTasks.priority,
          title: storeTasks.title,
          aisleLocation: storeTasks.aisleLocation,
          targetQty: storeTasks.targetQty,
          status: storeTasks.status,
        })
        .from(storeTasks)
        .where(eq(storeTasks.status, "pending"))
        .orderBy(asc(storeTasks.priority), desc(storeTasks.taskDate))
        .limit(limit);

      return {
        pendingTasks: rows.length,
        urgentCount: rows.filter((r) => r.priority === 1).length,
        tasks: rows,
      };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

function ascDate(col: typeof inventoryBatches.bestBeforeDate) {
  return sql`${col} ASC`;
}
