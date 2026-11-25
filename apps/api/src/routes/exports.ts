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
        SELECT
          p.sku,
          p.name,
          p.brand,
          d.name AS department_name,
          c.name AS category_name,
          p.aisle_location,
          COALESCE(ax.segment, 'UNSCORED') AS abc_xyz_segment,
          COALESCE(ls.on_hand_units, 0)::int AS on_hand_units,
          p.avg_cost_cents::bigint AS avg_cost_cents,
          (GREATEST(0, COALESCE(ls.on_hand_units, 0)) * p.avg_cost_cents)::bigint AS valuation_cents
        FROM products p
        JOIN categories c ON c.id = p.category_id
        JOIN departments d ON d.id = c.department_id
        LEFT JOIN v_product_live_stock ls ON ls.product_id = p.id
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

  // 5. Machine-readable OpenAPI 3.1 Contract Spec
  app.get("/api/openapi.json", async () => ({
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
    paths: {
      "/health": { get: { summary: "PostgreSQL readiness probe", tags: ["SRE"] } },
      "/health/live": { get: { summary: "Fast process liveness probe", tags: ["SRE"] } },
      "/metrics": { get: { summary: "Prometheus text metrics", tags: ["SRE"] } },
      "/auth/login": { post: { summary: "Authenticate staff with username & PIN", tags: ["Auth"] } },
      "/auth/logout": { post: { summary: "Revoke active session", tags: ["Auth"] } },
      "/auth/me": { get: { summary: "Current authenticated staff profile", tags: ["Auth"] } },
      "/auth/change-pin": { post: { summary: "Self-service PIN rotation", tags: ["Auth"] } },
      "/products": { get: { summary: "Paginated 3,120+ SKU catalog with live stock & net margin", tags: ["Catalog"] } },
      "/promotions": {
        get: { summary: "List promotions", tags: ["Promotions"] },
        post: { summary: "Create promotion", tags: ["Promotions"] },
      },
      "/promotions/{id}": { patch: { summary: "Pause or activate promotion", tags: ["Promotions"] } },
      "/pos/bootstrap": { get: { summary: "Offline-first POS catalog snapshot", tags: ["POS"] } },
      "/pos/sales": { post: { summary: "Idempotent append-only POS sale/void/refund upload", tags: ["POS"] } },
      "/pos/recent-sales": { get: { summary: "Recent lane receipts with lines, payments & void state", tags: ["POS"] } },
      "/pos/shifts/open": { post: { summary: "Open register shift", tags: ["POS"] } },
      "/pos/shifts/close": { post: { summary: "Blind cash closeout (Z-Report)", tags: ["POS"] } },
      "/pos/shifts/summary": { get: { summary: "Cashier Z-Report variance scorecard", tags: ["POS"] } },
      "/purchasing/orders": {
        get: { summary: "List persistent purchase orders", tags: ["Purchasing"] },
        post: { summary: "Create purchase order", tags: ["Purchasing"] },
      },
      "/purchasing/orders/{id}": { get: { summary: "Purchase order detail with line receipts & GRNs", tags: ["Purchasing"] } },
      "/purchasing/grn": { post: { summary: "Receive goods (GRN + bonus cases + 3-way auto-variance)", tags: ["Purchasing"] } },
      "/purchasing/supplier-scorecards": { get: { summary: "90-day Supplier OTIF scorecards", tags: ["Purchasing"] } },
      "/purchasing/variances": { get: { summary: "3-way PO vs GRN vs Invoice variances", tags: ["Purchasing"] } },
      "/purchasing/variances/{id}": { patch: { summary: "Dispute/resolve/write-off dock variance", tags: ["Purchasing"] } },
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
      "/operations/tasks": { get: { summary: "Daily floor task checklist", tags: ["Operations"] } },
      "/operations/tasks/{id}/complete": { post: { summary: "Complete floor task + optional blind count", tags: ["Operations"] } },
      "/admin/users": {
        get: { summary: "List staff accounts & active session counts", tags: ["Admin"] },
        post: { summary: "Create staff user", tags: ["Admin"] },
      },
      "/admin/users/{id}": { patch: { summary: "Update staff role/status or reset PIN", tags: ["Admin"] } },
      "/admin/users/{id}/revoke-sessions": { post: { summary: "Revoke all active sessions for user", tags: ["Admin"] } },
      "/admin/audit-logs": { get: { summary: "Paginated immutable audit trail", tags: ["Admin"] } },
      "/exports/accounting.csv": { get: { summary: "Accounting journal CSV", tags: ["Exports"] } },
      "/exports/inventory-valuation.csv": { get: { summary: "Live 3,120-SKU inventory valuation CSV", tags: ["Exports"] } },
      "/exports/supplier-variances.csv": { get: { summary: "3-way supplier variance register CSV", tags: ["Exports"] } },
      "/exports/shifts.csv": { get: { summary: "Z-Report shift closeout CSV", tags: ["Exports"] } },
      "/exports/audit-logs.csv": { get: { summary: "Immutable compliance audit log CSV", tags: ["Exports"] } },
    },
  }));
}
