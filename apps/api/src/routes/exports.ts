import type { FastifyInstance } from "fastify";
import { desc, eq, sql } from "drizzle-orm";
import {
  auditLogs,
  db,
  goodsReceipts,
  grnVariances,
  posShifts,
  products,
  purchaseOrders,
  suppliers,
} from "../db/index.js";
import { env } from "../config/env.js";
import { buildCsvDocument } from "../lib/helpers.js";
import { requireRole } from "../plugins/auth.js";
import { createRateLimiter } from "../plugins/security.js";

export async function exportRoutes(app: FastifyInstance) {
  const exportLimiter = createRateLimiter({
    keyPrefix: "csv_exports",
    windowMs: 60_000,
    max: env.isTest ? 300 : 20,
  });
  const financeRoles = [requireRole(["owner", "manager", "accountant"]), exportLimiter];

  // 1. Live 3,120-SKU Inventory Valuation CSV (formula-injection safe)
  app.get(
    "/api/exports/inventory-valuation.csv",
    { preHandler: financeRoles },
    async (_req, reply) => {
      const res = await db.execute(sql`
        WITH unfolded AS (
          SELECT product_id, COALESCE(SUM(qty_delta), 0)::int AS delta
          FROM stock_movements
          WHERE folded = false
          GROUP BY product_id
        )
        SELECT
          p.sku,
          p.name,
          p.brand,
          d.name AS department_name,
          c.name AS category_name,
          p.aisle_location,
          COALESCE(ax.segment, 'UNSCORED') AS abc_xyz_segment,
          (COALESCE(sb.quantity, 0) + COALESCE(u.delta, 0))::int AS on_hand_units,
          p.avg_cost_cents::bigint AS avg_cost_cents,
          (GREATEST(0, COALESCE(sb.quantity, 0) + COALESCE(u.delta, 0)) * p.avg_cost_cents)::bigint AS valuation_cents
        FROM products p
        JOIN categories c ON c.id = p.category_id
        JOIN departments d ON d.id = c.department_id
        LEFT JOIN stock_baselines sb ON sb.product_id = p.id
        LEFT JOIN unfolded u ON u.product_id = p.id
        LEFT JOIN analytics_abc_xyz ax ON ax.product_id = p.id
        WHERE p.active = true
        ORDER BY valuation_cents DESC, p.sku ASC
      `);

      const toUsd = (v: unknown) => (Number(v ?? 0) / 100).toFixed(2);
      const csv = buildCsvDocument(
        [
          "SKU",
          "ProductName",
          "Brand",
          "Department",
          "Category",
          "Aisle",
          "ABC_XYZ",
          "OnHandUnits",
          "AvgCostUSD",
          "ValuationUSD",
        ],
        (res.rows as Record<string, unknown>[]).map((r) => [
          r.sku,
          r.name,
          r.brand,
          r.department_name,
          r.category_name,
          r.aisle_location,
          r.abc_xyz_segment,
          Number(r.on_hand_units ?? 0),
          toUsd(r.avg_cost_cents),
          toUsd(r.valuation_cents),
        ])
      );

      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header(
        "Content-Disposition",
        `attachment; filename="supermarket-os-inventory-valuation-${new Date().toISOString().slice(0, 10)}.csv"`
      );
      return csv;
    }
  );

  // 2. 3-Way Supplier Dock Variance Register CSV
  app.get(
    "/api/exports/supplier-variances.csv",
    { preHandler: financeRoles },
    async (_req, reply) => {
      const rows = await db
        .select({
          createdAt: grnVariances.createdAt,
          supplierName: suppliers.name,
          poNumber: purchaseOrders.poNumber,
          invoiceNumber: goodsReceipts.invoiceNumber,
          sku: products.sku,
          productName: products.name,
          varianceType: grnVariances.varianceType,
          orderedQtyUnits: grnVariances.orderedQtyUnits,
          receivedQtyUnits: grnVariances.receivedQtyUnits,
          poUnitCostCents: grnVariances.poUnitCostCents,
          invoiceUnitCostCents: grnVariances.invoiceUnitCostCents,
          financialImpactCents: grnVariances.financialImpactCents,
          status: grnVariances.status,
          resolutionNote: grnVariances.resolutionNote,
        })
        .from(grnVariances)
        .innerJoin(suppliers, eq(grnVariances.supplierId, suppliers.id))
        .innerJoin(products, eq(grnVariances.productId, products.id))
        .innerJoin(goodsReceipts, eq(grnVariances.grnId, goodsReceipts.id))
        .leftJoin(purchaseOrders, eq(grnVariances.poId, purchaseOrders.id))
        .orderBy(desc(grnVariances.createdAt))
        .limit(500);

      const toUsd = (c: number) => (c / 100).toFixed(2);
      const csv = buildCsvDocument(
        [
          "CreatedAt",
          "Supplier",
          "PONumber",
          "InvoiceNumber",
          "SKU",
          "Product",
          "VarianceType",
          "OrderedUnits",
          "ReceivedUnits",
          "POUnitCostUSD",
          "InvoiceUnitCostUSD",
          "FinancialImpactUSD",
          "Status",
          "ResolutionNote",
        ],
        rows.map((r) => [
          new Date(r.createdAt).toISOString(),
          r.supplierName,
          r.poNumber ?? "",
          r.invoiceNumber,
          r.sku,
          r.productName,
          r.varianceType,
          r.orderedQtyUnits,
          r.receivedQtyUnits,
          toUsd(r.poUnitCostCents),
          toUsd(r.invoiceUnitCostCents),
          toUsd(r.financialImpactCents),
          r.status,
          r.resolutionNote ?? "",
        ])
      );

      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header(
        "Content-Disposition",
        `attachment; filename="supermarket-os-supplier-variances-${new Date().toISOString().slice(0, 10)}.csv"`
      );
      return csv;
    }
  );

  // 3. Z-Report Blind Shift Closeout Register CSV
  app.get("/api/exports/shifts.csv", { preHandler: financeRoles }, async (_req, reply) => {
    const rows = await db
      .select()
      .from(posShifts)
      .orderBy(desc(posShifts.openedAt))
      .limit(500);

    const toUsd = (c: number | null) => (c === null ? "" : (c / 100).toFixed(2));
    const csv = buildCsvDocument(
      [
        "ZReportNo",
        "Register",
        "Cashier",
        "OpenedAt",
        "ClosedAt",
        "OpeningFloatUSD",
        "CashDropsUSD",
        "ExpectedCashUSD",
        "BlindCountedUSD",
        "VarianceUSD",
      ],
      rows.map((r) => [
        r.zReportNo ?? "OPEN",
        r.registerCode,
        r.cashierName,
        new Date(r.openedAt).toISOString(),
        r.closedAt ? new Date(r.closedAt).toISOString() : "",
        toUsd(r.openingFloatCents),
        toUsd(r.cashDropsCents),
        toUsd(r.expectedCashCents),
        toUsd(r.blindCountedCashCents),
        toUsd(r.varianceCents),
      ])
    );

    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header(
      "Content-Disposition",
      `attachment; filename="supermarket-os-z-reports-${new Date().toISOString().slice(0, 10)}.csv"`
    );
    return csv;
  });

  // 4. Immutable Compliance Audit Trail CSV
  app.get("/api/exports/audit-logs.csv", { preHandler: financeRoles }, async (_req, reply) => {
    const rows = await db
      .select()
      .from(auditLogs)
      .orderBy(desc(auditLogs.createdAt))
      .limit(1000);

    const csv = buildCsvDocument(
      ["Timestamp", "Actor", "Action", "EntityType", "EntityId", "DetailsJSON"],
      rows.map((r) => [
        new Date(r.createdAt).toISOString(),
        r.actor,
        r.action,
        r.entityType,
        r.entityId ?? "",
        r.detailsJson ? JSON.stringify(r.detailsJson) : "",
      ])
    );

    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header(
      "Content-Disposition",
      `attachment; filename="supermarket-os-audit-logs-${new Date().toISOString().slice(0, 10)}.csv"`
    );
    return csv;
  });

  // 5. Machine-readable OpenAPI 3.1 Contract Spec (auto-merges 100% of live Fastify routes - M-11)
  app.get(
    "/api/openapi.json",
    { preHandler: [requireRole(["owner", "manager", "accountant"])] },
    async (_req, reply) => {
      if (!env.enableOpenApiDocs) {
        return reply.status(404).send({ error: "OpenAPI documentation is disabled." });
      }

      const curatedPaths: Record<
        string,
        Record<string, { summary: string; tags: string[]; parameters?: unknown[]; responses?: Record<string, unknown> }>
      > = {
        "/health": { get: { summary: "PostgreSQL readiness probe", tags: ["SRE"] } },
        "/health/live": { get: { summary: "Fast process liveness probe", tags: ["SRE"] } },
        "/metrics": { get: { summary: "Prometheus text metrics", tags: ["SRE"] } },
        "/auth/login": { post: { summary: "Authenticate staff with username & PIN", tags: ["Auth"] } },
        "/auth/logout": { post: { summary: "Revoke active session", tags: ["Auth"] } },
        "/auth/me": { get: { summary: "Current authenticated staff profile", tags: ["Auth"] } },
        "/auth/change-pin": { post: { summary: "Self-service PIN rotation", tags: ["Auth"] } },
        "/meta": { get: { summary: "Role-scoped catalog metadata (departments, categories, tax rates, active promos)", tags: ["Catalog"] } },
        "/products": {
          get: { summary: "Paginated 3,120+ SKU catalog with live stock & net margin", tags: ["Catalog"] },
          post: { summary: "Create packaged SKU with Multi-UOM barcodes", tags: ["Catalog"] },
        },
        "/products/scan/{barcode}": { get: { summary: "Instant GS1 barcode scanner lookup", tags: ["Catalog"] } },
        "/products/{id}/barcodes": { post: { summary: "Add Multi-UOM pack barcode to product", tags: ["Catalog"] } },
        "/products/{id}/barcodes/{barcodeId}": {
          patch: { summary: "Update pack label, qty, or shelf price (auto-queues shelf tag)", tags: ["Catalog"] },
          delete: { summary: "Remove secondary Multi-UOM barcode", tags: ["Catalog"] },
        },
        "/import/preview": { post: { summary: "Validate & preview bulk CSV catalog import", tags: ["Catalog"] } },
        "/import/commit": { post: { summary: "Commit validated CSV catalog import rows", tags: ["Catalog"] } },
        "/lookup/barcode/{barcode}": { get: { summary: "Open Food Facts external GS1 enrichment lookup", tags: ["Catalog"] } },
        "/labels/zpl": { post: { summary: "Generate Zebra ZPL shelf-tag labels", tags: ["Labels"] } },
        "/promotions": {
          get: { summary: "List promotions", tags: ["Promotions"] },
          post: { summary: "Create promotion", tags: ["Promotions"] },
        },
        "/promotions/{id}": { patch: { summary: "Pause or activate promotion", tags: ["Promotions"] } },
        "/pos/bootstrap": { get: { summary: "Offline-first POS catalog snapshot with ETag caching", tags: ["POS"] } },
        "/pos/sales": { post: { summary: "Idempotent append-only POS sale/void/refund upload", tags: ["POS"] } },
        "/pos/recent-sales": { get: { summary: "Recent lane receipts with lines, payments & void state", tags: ["POS"] } },
        "/pos/fold-ledger": { post: { summary: "Atomically fold unfolded stock_movements into stock_baselines", tags: ["POS"] } },
        "/pos/shifts": { get: { summary: "List recent register shifts", tags: ["POS"] } },
        "/pos/shifts/active": { get: { summary: "Get active open shift for register", tags: ["POS"] } },
        "/pos/shifts/open": { post: { summary: "Open register shift", tags: ["POS"] } },
        "/pos/shifts/close": { post: { summary: "Blind cash closeout (Z-Report)", tags: ["POS"] } },
        "/pos/shifts/summary": { get: { summary: "Cashier Z-Report variance scorecard", tags: ["POS"] } },
        "/purchasing/orders": {
          get: { summary: "List persistent purchase orders", tags: ["Purchasing"] },
          post: { summary: "Create purchase order", tags: ["Purchasing"] },
        },
        "/purchasing/orders/{id}": { get: { summary: "Purchase order detail with line receipts & GRNs", tags: ["Purchasing"] } },
        "/purchasing/orders/{id}/status": { patch: { summary: "Transition purchase order lifecycle status", tags: ["Purchasing"] } },
        "/purchasing/grn": { post: { summary: "Receive goods (GRN + bonus cases + 3-way auto-variance)", tags: ["Purchasing"] } },
        "/purchasing/grns": { get: { summary: "List recent Goods Received Notes", tags: ["Purchasing"] } },
        "/purchasing/supplier-scorecards": { get: { summary: "90-day Supplier OTIF scorecards", tags: ["Purchasing"] } },
        "/purchasing/variances": { get: { summary: "3-way PO vs GRN vs Invoice variances", tags: ["Purchasing"] } },
        "/purchasing/variances/{id}": { patch: { summary: "Dispute/resolve/write-off dock variance", tags: ["Purchasing"] } },
        "/inventory/expiry-alerts": { get: { summary: "FEFO best-before expiry alerts console", tags: ["Inventory"] } },
        "/inventory/batches/{id}/action": { post: { summary: "Clearance markdown or spoilage write-off on batch", tags: ["Inventory"] } },
        "/inventory/margin-alerts": { get: { summary: "Open margin erosion alerts after wholesale cost increases", tags: ["Inventory"] } },
        "/inventory/margin-alerts/{id}/apply-price": { post: { summary: "Apply suggested retail price & scale pack tiers", tags: ["Inventory"] } },
        "/inventory/cycle-count": { post: { summary: "Blind physical cycle count adjustment", tags: ["Inventory"] } },
        "/inventory/phantom-stock": { get: { summary: "Poisson phantom stock alerts", tags: ["Inventory"] } },
        "/inventory/phantom-stock/{productId}/verify": { post: { summary: "Blind physical verification", tags: ["Inventory"] } },
        "/inventory/dynamic-markdowns": { get: { summary: "FEFO elasticity markdown recommendations", tags: ["Inventory"] } },
        "/inventory/dynamic-markdowns/{batchId}/apply": { post: { summary: "Apply dynamic markdown + queue tag", tags: ["Inventory"] } },
        "/labels/queue": { get: { summary: "07:30 shelf tag print queue", tags: ["Labels"] } },
        "/labels/queue/print": { post: { summary: "Generate Zebra ZPL batch & mark printed", tags: ["Labels"] } },
        "/loyalty/customers": {
          get: { summary: "Search RFM loyalty customers", tags: ["Loyalty"] },
          post: { summary: "Enroll loyalty customer", tags: ["Loyalty"] },
        },
        "/loyalty/coupons": {
          get: { summary: "List targeted single-use coupons", tags: ["Loyalty"] },
          post: { summary: "Issue single-use coupon", tags: ["Loyalty"] },
        },
        "/loyalty/coupons/validate/{code}": { get: { summary: "Validate coupon eligibility", tags: ["Loyalty"] } },
        "/operations/staffing-plan": { get: { summary: "Hourly checkout lane staffing roster", tags: ["Operations"] } },
        "/operations/staffing-plan/generate": { post: { summary: "Generate 28d footfall-based lane roster", tags: ["Operations"] } },
        "/operations/staffing-plan/{id}": { patch: { summary: "Assign staff or update lane slot status", tags: ["Operations"] } },
        "/operations/tasks": { get: { summary: "Daily floor task checklist", tags: ["Operations"] } },
        "/operations/tasks/{id}/complete": { post: { summary: "Complete floor task + optional blind count", tags: ["Operations"] } },
        "/analytics/overview": { get: { summary: "Executive KPIs, daily trend, hourly traffic & payment mix", tags: ["Analytics"] } },
        "/analytics/departments": { get: { summary: "Department profitability, GMROII & inventory turns", tags: ["Analytics"] } },
        "/analytics/abc-xyz": { get: { summary: "ABC-XYZ 3x3 segmentation matrix & SKU rankings", tags: ["Analytics"] } },
        "/analytics/forecasts": { get: { summary: "Demand forecasts & auto-replenishment PO suggestions", tags: ["Analytics"] } },
        "/analytics/basket-rules": { get: { summary: "Market basket lift & co-occurrence association rules", tags: ["Analytics"] } },
        "/analytics/shift-diagnostics": { get: { summary: "Shift conversion funnel, OOS root causes & DiD experiments", tags: ["Analytics"] } },
        "/analytics/shift-diagnostics/recompute": { post: { summary: "Trigger Python ML analytics pipeline recompute", tags: ["Analytics"] } },
        "/analytics/footfall": { post: { summary: "Ingest 15-minute door footfall counter buckets", tags: ["Analytics"] } },
        "/analytics/stock-snapshots/capture": { post: { summary: "Capture hourly on-shelf stock snapshot", tags: ["Analytics"] } },
        "/analytics/shift-experiments": {
          get: { summary: "List Difference-in-Differences shift experiments", tags: ["Analytics"] },
          post: { summary: "Create & evaluate DiD shift intervention experiment", tags: ["Analytics"] },
        },
        "/analytics/loss-prevention": { get: { summary: "Cashier MAD anomalies, dead-stock traps & negative stock", tags: ["Analytics"] } },
        "/analytics/promo-roi": { get: { summary: "Promotion ROI velocity lift & margin attribution", tags: ["Analytics", "Promotions"] } },
        "/ai/status": { get: { summary: "AI Copilot model & semantic index status", tags: ["AI"] } },
        "/ai/conversations": { get: { summary: "List user AI Copilot conversation history", tags: ["AI"] } },
        "/ai/conversations/{id}": {
          get: { summary: "Get conversation messages & proposed actions", tags: ["AI"] },
          delete: { summary: "Delete AI Copilot conversation", tags: ["AI"] },
        },
        "/ai/chat": { post: { summary: "Non-streaming AI Copilot turn with tool execution", tags: ["AI"] } },
        "/ai/chat/stream": { post: { summary: "SSE streaming AI Copilot turn", tags: ["AI"] } },
        "/ai/actions/{id}/execute": { post: { summary: "Human-in-the-loop approval & execution of AI proposal", tags: ["AI"] } },
        "/ai/actions/{id}/reject": { post: { summary: "Reject pending AI Copilot proposal", tags: ["AI"] } },
        "/ai/briefing/today": { get: { summary: "Daily executive AI morning briefing", tags: ["AI"] } },
        "/ai/search/semantic": { get: { summary: "Semantic vector catalog search", tags: ["AI", "Catalog"] } },
        "/ai/embeddings/sync": { post: { summary: "Rebuild product semantic embeddings index", tags: ["AI"] } },
        "/ai/invoice/parse": { post: { summary: "OCR / structured supplier invoice parser for GRN", tags: ["AI", "Purchasing"] } },
        "/ai/triage": { post: { summary: "Calibrated AI anomaly/discrepancy triage", tags: ["AI"] } },
        "/admin/users": {
          get: { summary: "List staff accounts & active session counts", tags: ["Admin"] },
          post: { summary: "Create staff user", tags: ["Admin"] },
        },
        "/admin/users/{id}": { patch: { summary: "Update staff role/status or reset PIN", tags: ["Admin"] } },
        "/admin/users/{id}/revoke-sessions": { post: { summary: "Revoke all active sessions for user", tags: ["Admin"] } },
        "/admin/audit-logs": { get: { summary: "Paginated immutable audit trail", tags: ["Admin"] } },
        "/admin/pipeline-runs": { get: { summary: "ML analytics pipeline run telemetry & 12-check data-quality contracts", tags: ["Admin", "Analytics"] } },
        "/exports/accounting.csv": { get: { summary: "Accounting journal CSV", tags: ["Exports"] } },
        "/exports/inventory-valuation.csv": { get: { summary: "Live 3,120-SKU inventory valuation CSV", tags: ["Exports"] } },
        "/exports/supplier-variances.csv": { get: { summary: "3-way supplier variance register CSV", tags: ["Exports"] } },
        "/exports/shifts.csv": { get: { summary: "Z-Report shift closeout CSV", tags: ["Exports"] } },
        "/exports/audit-logs.csv": { get: { summary: "Immutable compliance audit log CSV", tags: ["Exports"] } },
        "/openapi.json": { get: { summary: "Machine-readable OpenAPI 3.1 contract specification", tags: ["SRE"] } },
      };

      const paths: Record<string, Record<string, unknown>> = {};
      for (const route of app.registeredRoutes) {
        const relativePath = route.url
          .replace(/^\/api/, "")
          .replace(/:([A-Za-z0-9_]+)/g, "{$1}");
        const methodKey = route.method.toLowerCase();
        const curated = curatedPaths[relativePath]?.[methodKey];
        const pathParams = Array.from(relativePath.matchAll(/\{([A-Za-z0-9_]+)\}/g)).map((m) => ({
          name: m[1],
          in: "path",
          required: true,
          schema: { type: "string" },
        }));
        const seg = relativePath.split("/").filter(Boolean)[0] ?? "General";
        const autoTag = seg.charAt(0).toUpperCase() + seg.slice(1);

        if (!paths[relativePath]) paths[relativePath] = {};
        paths[relativePath][methodKey] = {
          summary: curated?.summary ?? `${route.method} ${relativePath}`,
          tags: curated?.tags ?? [autoTag],
          ...(pathParams.length > 0 ? { parameters: pathParams } : {}),
          responses: curated?.responses ?? {
            "200": { description: "Successful response" },
            "401": { description: "Authentication required" },
            "403": { description: "Insufficient permissions" },
          },
        };
      }

      return {
        openapi: "3.1.0",
        info: {
          title: "SupermarketOS Retail Operations, Offline POS & BI API",
          version: "2.0.0",
          description:
            "Integer-cent packaged-goods supermarket ERP/POS/BI API with RBAC, FEFO batch depletion, 3-way GRN matching, Loyalty CRM, and AI Copilot.",
        },
        servers: [{ url: "/api", description: "Same-origin API base" }],
        components: {
          securitySchemes: {
            cookieAuth: { type: "apiKey", in: "cookie", name: "smos_session" },
            bearerAuth: { type: "http", scheme: "bearer" },
          },
        },
        paths,
      };
    }
  );
}
