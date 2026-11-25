import {
  bigint,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ============================================================================
// 1. CATALOG, TAX & MULTI-UOM BARCODES
// ============================================================================

export const departments = pgTable("departments", {
  id: uuid("id").defaultRandom().primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  targetMarginBp: integer("target_margin_bp").notNull().default(2400),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const categories = pgTable(
  "categories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_categories_department").on(t.departmentId)]
);

export const taxRates = pgTable("tax_rates", {
  id: uuid("id").defaultRandom().primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  rateBp: integer("rate_bp").notNull(), // e.g., 1000 = 10.00%
  isInclusive: boolean("is_inclusive").notNull().default(true),
});

export const products = pgTable(
  "products",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sku: text("sku").notNull().unique(),
    name: text("name").notNull(),
    brand: text("brand").notNull(),
    sizeLabel: text("size_label").notNull().default(""),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "restrict" }),
    taxRateId: uuid("tax_rate_id")
      .notNull()
      .references(() => taxRates.id, { onDelete: "restrict" }),
    baseUnitLabel: text("base_unit_label").notNull().default("unit"), // can, bottle, pack, bag
    avgCostCents: bigint("avg_cost_cents", { mode: "number" }).notNull().default(0),
    minMarginBp: integer("min_margin_bp").notNull().default(1500),
    requiresAgeCheck: boolean("requires_age_check").notNull().default(false),
    trackExpiry: boolean("track_expiry").notNull().default(true),
    expiryAlertDays: integer("expiry_alert_days").notNull().default(30),
    aisleLocation: text("aisle_location").notNull().default("A1"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_products_category").on(t.categoryId),
    index("idx_products_brand").on(t.brand),
    index("idx_products_name").on(t.name),
    index("idx_products_active").on(t.active),
  ]
);

export const productBarcodes = pgTable(
  "product_barcodes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    barcode: text("barcode").notNull().unique(),
    packQty: integer("pack_qty").notNull().default(1), // 1 = single, 6 = 6-pack, 24 = case
    packLabel: text("pack_label").notNull().default("Single"),
    sellPriceCents: bigint("sell_price_cents", { mode: "number" }).notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    isOrderableCase: boolean("is_orderable_case").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_product_barcodes_product").on(t.productId)]
);

// ============================================================================
// 2. IMMUTABLE INVENTORY LEDGER & FEFO BEST-BEFORE BATCHES
// ============================================================================

export const stockBaselines = pgTable(
  "stock_baselines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    productId: uuid("product_id")
      .notNull()
      .unique()
      .references(() => products.id, { onDelete: "cascade" }),
    quantity: integer("quantity").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_stock_baselines_product").on(t.productId)]
);

export const inventoryBatches = pgTable(
  "inventory_batches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    lotCode: text("lot_code").notNull(),
    bestBeforeDate: date("best_before_date").notNull(),
    unitCostCents: bigint("unit_cost_cents", { mode: "number" }).notNull(),
    qtyReceived: integer("qty_received").notNull(),
    qtyRemaining: integer("qty_remaining").notNull(),
    status: text("status").notNull().default("active"), // active | clearance | expired | depleted
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_batches_product_expiry").on(t.productId, t.bestBeforeDate),
    index("idx_batches_expiry_status").on(t.bestBeforeDate, t.status),
  ]
);

export const stockMovements = pgTable(
  "stock_movements",
  {
    id: uuid("id").primaryKey(), // Client UUIDv7 for offline-first idempotency
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    batchId: uuid("batch_id").references(() => inventoryBatches.id, {
      onDelete: "set null",
    }),
    qtyDelta: integer("qty_delta").notNull(),
    unitCostCents: bigint("unit_cost_cents", { mode: "number" }).notNull().default(0),
    reason: text("reason").notNull(), // sale | refund | void | grn | bonus_grn | spoilage | damage | count_adj
    refId: uuid("ref_id"),
    folded: boolean("folded").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_stock_movements_product_folded").on(t.productId, t.folded),
    index("idx_stock_movements_created").on(t.createdAt),
    index("idx_stock_movements_reason").on(t.reason),
  ]
);

// ============================================================================
// 3. SUPPLIERS, PURCHASING, GRN (WITH FREE BONUS CASES) & MARGIN ALERTS
// ============================================================================

export const suppliers = pgTable("suppliers", {
  id: uuid("id").defaultRandom().primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  contactEmail: text("contact_email"),
  phone: text("phone"),
  defaultLeadTimeDays: integer("default_lead_time_days").notNull().default(3),
  paymentTermsDays: integer("payment_terms_days").notNull().default(14),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const supplierProducts = pgTable(
  "supplier_products",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    supplierSku: text("supplier_sku").notNull(),
    caseQty: integer("case_qty").notNull().default(24),
    caseCostCents: bigint("case_cost_cents", { mode: "number" }).notNull(),
    moqCases: integer("moq_cases").notNull().default(1),
    leadTimeDays: integer("lead_time_days").notNull().default(3),
    isPrimary: boolean("is_primary").notNull().default(true),
  },
  (t) => [
    uniqueIndex("uq_supplier_product").on(t.supplierId, t.productId),
    index("idx_supplier_products_product").on(t.productId),
  ]
);

export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    poNumber: text("po_number").notNull().unique(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("approved"), // draft | approved | sent | received | cancelled
    totalCases: integer("total_cases").notNull().default(0),
    estimatedCostCents: bigint("estimated_cost_cents", { mode: "number" }).notNull().default(0),
    createdBy: text("created_by").notNull(),
    approvedBy: text("approved_by"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_po_supplier").on(t.supplierId),
    index("idx_po_status").on(t.status),
  ]
);

export const purchaseOrderLines = pgTable(
  "purchase_order_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    poId: uuid("po_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    caseQty: integer("case_qty").notNull(),
    orderedCases: integer("ordered_cases").notNull(),
    receivedCases: integer("received_cases").notNull().default(0),
    unitCostCents: bigint("unit_cost_cents", { mode: "number" }).notNull(),
    lineTotalCents: bigint("line_total_cents", { mode: "number" }).notNull(),
  },
  (t) => [index("idx_po_lines_po").on(t.poId)]
);

export const goodsReceipts = pgTable(
  "goods_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "restrict" }),
    poId: uuid("po_id").references(() => purchaseOrders.id, { onDelete: "set null" }),
    invoiceNumber: text("invoice_number").notNull(),
    receivedBy: text("received_by").notNull(),
    totalInvoiceCents: bigint("total_invoice_cents", { mode: "number" }).notNull(),
    notes: text("notes"),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_goods_receipts_supplier_received").on(t.supplierId, t.receivedAt),
    index("idx_goods_receipts_po").on(t.poId),
  ]
);

export const grnLines = pgTable(
  "grn_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    grnId: uuid("grn_id")
      .notNull()
      .references(() => goodsReceipts.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    caseQty: integer("case_qty").notNull(),
    paidCases: integer("paid_cases").notNull(),
    freeBonusCases: integer("free_bonus_cases").notNull().default(0),
    baseUnitsReceived: integer("base_units_received").notNull(),
    invoiceLineTotalCents: bigint("invoice_line_total_cents", { mode: "number" }).notNull(),
    effectiveUnitCostCents: bigint("effective_unit_cost_cents", { mode: "number" }).notNull(),
    bestBeforeDate: date("best_before_date"),
  },
  (t) => [index("idx_grn_lines_grn").on(t.grnId)]
);

export const marginAlerts = pgTable(
  "margin_alerts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    grnId: uuid("grn_id").references(() => goodsReceipts.id, { onDelete: "set null" }),
    previousCostCents: bigint("previous_cost_cents", { mode: "number" }).notNull(),
    newCostCents: bigint("new_cost_cents", { mode: "number" }).notNull(),
    currentSellPriceCents: bigint("current_sell_price_cents", { mode: "number" }).notNull(),
    resultingMarginBp: integer("resulting_margin_bp").notNull(),
    minMarginBp: integer("min_margin_bp").notNull(),
    suggestedSellPriceCents: bigint("suggested_sell_price_cents", { mode: "number" }).notNull(),
    resolved: boolean("resolved").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_margin_alerts_resolved").on(t.resolved),
    index("idx_margin_alerts_product_resolved").on(t.productId, t.resolved),
  ]
);

// ============================================================================
// 4. USERS, SESSIONS, PROMOTIONS, LOYALTY, OFFLINE-FIRST POS & SALES
// ============================================================================

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  username: text("username").notNull().unique(),
  fullName: text("full_name").notNull(),
  role: text("role").notNull().default("cashier"), // owner | manager | stock_clerk | cashier | accountant
  pinHash: text("pin_hash").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const userSessions = pgTable(
  "user_sessions",
  {
    jti: uuid("jti").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_user_sessions_user_revoked").on(t.userId, t.revokedAt),
    index("idx_user_sessions_expires").on(t.expiresAt),
  ]
);

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    phone: text("phone").notNull().unique(),
    fullName: text("full_name").notNull(),
    email: text("email"),
    pointsBalance: integer("points_balance").notNull().default(0),
    lifetimeSpendCents: bigint("lifetime_spend_cents", { mode: "number" }).notNull().default(0),
    visits60d: integer("visits_60d").notNull().default(0),
    rfmSegment: text("rfm_segment").notNull().default("New"),
    lastVisitAt: timestamp("last_visit_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_customers_rfm").on(t.rfmSegment)]
);

export const promotions = pgTable(
  "promotions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    promoType: text("promo_type").notNull(), // mix_and_match | bogo | tier_price | clearance | basket_threshold
    rulesJson: jsonb("rules_json").notNull(),
    priority: integer("priority").notNull().default(10),
    combinable: boolean("combinable").notNull().default(false),
    minMarginGuardBp: integer("min_margin_guard_bp"),
    daypartStartHour: integer("daypart_start_hour"),
    daypartEndHour: integer("daypart_end_hour"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    active: boolean("active").notNull().default(true),
  },
  (t) => [index("idx_promotions_active_window").on(t.active, t.startsAt, t.endsAt)]
);

export const posShifts = pgTable(
  "pos_shifts",
  {
    id: uuid("id").primaryKey(),
    registerCode: text("register_code").notNull(),
    cashierName: text("cashier_name").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    openingFloatCents: bigint("opening_float_cents", { mode: "number" }).notNull().default(0),
    cashDropsCents: bigint("cash_drops_cents", { mode: "number" }).notNull().default(0),
    blindCountedCashCents: bigint("blind_counted_cash_cents", { mode: "number" }),
    expectedCashCents: bigint("expected_cash_cents", { mode: "number" }),
    varianceCents: bigint("variance_cents", { mode: "number" }),
    zReportNo: text("z_report_no"),
  },
  (t) => [
    index("idx_pos_shifts_cashier_opened").on(t.cashierName, t.openedAt),
    index("idx_pos_shifts_register_closed").on(t.registerCode, t.closedAt),
  ]
);

export const sales = pgTable(
  "sales",
  {
    id: uuid("id").primaryKey(), // Client UUIDv7
    registerCode: text("register_code").notNull(),
    shiftId: uuid("shift_id").references(() => posShifts.id, { onDelete: "set null" }),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    receiptNo: text("receipt_no").notNull().unique(),
    kind: text("kind").notNull().default("sale"), // sale | refund | void
    originalSaleId: uuid("original_sale_id"),
    cashierName: text("cashier_name").notNull(),
    subtotalCents: bigint("subtotal_cents", { mode: "number" }).notNull(),
    discountCents: bigint("discount_cents", { mode: "number" }).notNull().default(0),
    taxCents: bigint("tax_cents", { mode: "number" }).notNull().default(0),
    totalCents: bigint("total_cents", { mode: "number" }).notNull(),
    totalCostCents: bigint("total_cost_cents", { mode: "number" }).notNull().default(0),
    ageVerified: boolean("age_verified").notNull().default(false),
    soldAt: timestamp("sold_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_sales_sold_at").on(t.soldAt),
    index("idx_sales_cashier").on(t.cashierName),
    index("idx_sales_kind").on(t.kind),
    index("idx_sales_sold_at_kind").on(t.soldAt, t.kind),
    index("idx_sales_register_sold").on(t.registerCode, t.soldAt),
    index("idx_sales_customer").on(t.customerId),
  ]
);

export const saleLines = pgTable(
  "sale_lines",
  {
    id: uuid("id").primaryKey(),
    saleId: uuid("sale_id")
      .notNull()
      .references(() => sales.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    scannedBarcode: text("scanned_barcode").notNull(),
    packLabel: text("pack_label").notNull(),
    packQty: integer("pack_qty").notNull(),
    qtyPacks: integer("qty_packs").notNull(),
    baseUnitsSold: integer("base_units_sold").notNull(),
    unitPriceCents: bigint("unit_price_cents", { mode: "number" }).notNull(),
    unitCostCents: bigint("unit_cost_cents", { mode: "number" }).notNull(),
    discountCents: bigint("discount_cents", { mode: "number" }).notNull().default(0),
    taxRateBp: integer("tax_rate_bp").notNull().default(0),
    taxCents: bigint("tax_cents", { mode: "number" }).notNull().default(0),
    lineTotalCents: bigint("line_total_cents", { mode: "number" }).notNull(),
  },
  (t) => [
    index("idx_sale_lines_sale").on(t.saleId),
    index("idx_sale_lines_product").on(t.productId),
  ]
);

export const salePayments = pgTable(
  "sale_payments",
  {
    id: uuid("id").primaryKey(),
    saleId: uuid("sale_id")
      .notNull()
      .references(() => sales.id, { onDelete: "cascade" }),
    method: text("method").notNull(), // cash | card | mobile_pay | voucher
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    tenderedCents: bigint("tendered_cents", { mode: "number" }),
    changeCents: bigint("change_cents", { mode: "number" }),
  },
  (t) => [index("idx_sale_payments_sale").on(t.saleId)]
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actor: text("actor").notNull(),
    action: text("action").notNull(), // void_line | price_override | no_sale_drawer | grn_post | csv_import | expiry_markdown
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    detailsJson: jsonb("details_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_audit_logs_actor_action").on(t.actor, t.action),
    index("idx_audit_logs_created").on(t.createdAt),
  ]
);

// ============================================================================
// 5. PRECOMPUTED ANALYTICS & ML TABLES (WRITTEN BY PYTHON ANALYTICS WORKER)
// ============================================================================

export const analyticsAbcXyz = pgTable(
  "analytics_abc_xyz",
  {
    productId: uuid("product_id")
      .primaryKey()
      .references(() => products.id, { onDelete: "cascade" }),
    revenue60dCents: bigint("revenue_60d_cents", { mode: "number" }).notNull(),
    profit60dCents: bigint("profit_60d_cents", { mode: "number" }).notNull(),
    units60d: integer("units_60d").notNull(),
    avgDailyUnits: doublePrecision("avg_daily_units").notNull(),
    demandCv: doublePrecision("demand_cv").notNull(),
    adi: doublePrecision("adi").notNull(),
    abcClass: text("abc_class").notNull(), // A | B | C
    xyzClass: text("xyz_class").notNull(), // X | Y | Z
    segment: text("segment").notNull(), // AX, AY, ..., CZ
    gmroii: doublePrecision("gmroii").notNull(),
    daysOfStock: doublePrecision("days_of_stock").notNull(),
    recommendedAction: text("recommended_action").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_abc_xyz_segment").on(t.segment)]
);

export const analyticsDemandForecasts = pgTable(
  "analytics_demand_forecasts",
  {
    productId: uuid("product_id")
      .primaryKey()
      .references(() => products.id, { onDelete: "cascade" }),
    modelUsed: text("model_used").notNull(), // AutoETS | CrostonSBA | WeekendSeasonal
    forecast7dUnits: integer("forecast_7d_units").notNull(),
    forecast14dUnits: integer("forecast_14d_units").notNull(),
    safetyStockUnits: integer("safety_stock_units").notNull(),
    reorderPointUnits: integer("reorder_point_units").notNull(),
    currentStockUnits: integer("current_stock_units").notNull(),
    suggestedOrderCases: integer("suggested_order_cases").notNull(),
    caseQty: integer("case_qty").notNull(),
    estimatedOrderCostCents: bigint("estimated_order_cost_cents", { mode: "number" }).notNull(),
    supplierName: text("supplier_name").notNull(),
    wmapePct: doublePrecision("wmape_pct").notNull(),
    urgency: text("urgency").notNull(), // critical | reorder_now | watch | healthy
    computedAt: timestamp("computed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_forecasts_urgency").on(t.urgency)]
);

export const analyticsBasketRules = pgTable(
  "analytics_basket_rules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    shiftBucket: text("shift_bucket").notNull().default("all"),
    antecedentProductId: uuid("antecedent_product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    consequentProductId: uuid("consequent_product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    antecedentName: text("antecedent_name").notNull(),
    consequentName: text("consequent_name").notNull(),
    coOccurrences: integer("co_occurrences").notNull(),
    support: doublePrecision("support").notNull(),
    confidence: doublePrecision("confidence").notNull(),
    lift: doublePrecision("lift").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_basket_rules_shift").on(t.shiftBucket),
    index("idx_basket_rules_shift_lift").on(t.shiftBucket, t.lift),
  ]
);

export const storeFootfall = pgTable(
  "store_footfall",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    bucketStart: timestamp("bucket_start", { withTimezone: true }).notNull().unique(),
    entries: integer("entries").notNull(),
    exits: integer("exits").notNull(),
    avgDwellSec: integer("avg_dwell_sec").notNull().default(360),
    openLanes: integer("open_lanes").notNull().default(1),
    weatherRain: boolean("weather_rain").notNull().default(false),
    source: text("source").notNull().default("door_sensor"),
  },
  (t) => [index("idx_store_footfall_bucket").on(t.bucketStart)]
);

export const hourlyStockSnapshots = pgTable(
  "hourly_stock_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    snapshotDate: date("snapshot_date").notNull(),
    snapshotHour: integer("snapshot_hour").notNull(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    onHandUnits: integer("on_hand_units").notNull(),
    isOos: boolean("is_oos").notNull().default(false),
    restockedAtHour: integer("restocked_at_hour"),
  },
  (t) => [
    uniqueIndex("uq_hourly_stock_snap").on(t.snapshotDate, t.snapshotHour, t.productId),
    index("idx_hourly_stock_oos").on(t.snapshotDate, t.snapshotHour, t.isOos),
  ]
);

export const analyticsShiftDiagnostics = pgTable("analytics_shift_diagnostics", {
  id: text("id").primaryKey(),
  windowDays: integer("window_days").notNull().default(60),
  primaryBottleneck: text("primary_bottleneck").notNull(),
  morningSharePct: doublePrecision("morning_share_pct").notNull(),
  morningConversionPct: doublePrecision("morning_conversion_pct").notNull(),
  afternoonConversionPct: doublePrecision("afternoon_conversion_pct").notNull(),
  eveningConversionPct: doublePrecision("evening_conversion_pct").notNull(),
  morningEstLostRevenueCents: bigint("morning_est_lost_revenue_cents", {
    mode: "number",
  }).notNull(),
  shiftComparisonJson: jsonb("shift_comparison_json").notNull(),
  hourlyProfileJson: jsonb("hourly_profile_json").notNull(),
  oosRootCausesJson: jsonb("oos_root_causes_json").notNull(),
  queueSaturationJson: jsonb("queue_saturation_json").notNull(),
  driverAttributionJson: jsonb("driver_attribution_json").notNull(),
  shopperMissionsJson: jsonb("shopper_missions_json").notNull(),
  recommendationsJson: jsonb("recommendations_json").notNull(),
  computedAt: timestamp("computed_at", { withTimezone: true }).defaultNow().notNull(),
});

export const shiftExperiments = pgTable("shift_experiments", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  hypothesis: text("hypothesis").notNull(),
  interventionType: text("intervention_type").notNull(),
  targetShift: text("target_shift").notNull().default("morning"),
  controlShift: text("control_shift").notNull().default("afternoon"),
  preStartDate: date("pre_start_date").notNull(),
  preEndDate: date("pre_end_date").notNull(),
  postStartDate: date("post_start_date").notNull(),
  postEndDate: date("post_end_date").notNull(),
  status: text("status").notNull().default("active"),
  resultsJson: jsonb("results_json"),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const analyticsLpAnomalies = pgTable("analytics_lp_anomalies", {
  id: uuid("id").defaultRandom().primaryKey(),
  cashierName: text("cashier_name").notNull(),
  totalSalesCount: integer("total_sales_count").notNull(),
  voidCount: integer("void_count").notNull(),
  refundCount: integer("refund_count").notNull(),
  noSaleDrawerCount: integer("no_sale_drawer_count").notNull(),
  voidRatePct: doublePrecision("void_rate_pct").notNull(),
  zScore: doublePrecision("z_score").notNull(),
  riskLevel: text("risk_level").notNull(), // normal | elevated | high
  computedAt: timestamp("computed_at", { withTimezone: true }).defaultNow().notNull(),
});

// ============================================================================
// 6. EMBEDDED AI COPILOT CONVERSATIONS & HUMAN-IN-THE-LOOP ACTION QUEUE
// ============================================================================

export const aiConversations = pgTable(
  "ai_conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    lastInteractionId: text("last_interaction_id"),
    model: text("model").notNull().default("gemini-4-hydrogen"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_ai_conversations_user").on(t.userId)]
);

export const aiMessages = pgTable(
  "ai_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => aiConversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // user | assistant
    content: text("content").notNull(),
    toolCallsJson: jsonb("tool_calls_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_ai_messages_conv").on(t.conversationId, t.createdAt)]
);

export const aiProposedActions = pgTable(
  "ai_proposed_actions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => aiConversations.id, { onDelete: "cascade" }),
    messageId: uuid("message_id"),
    actionType: text("action_type").notNull(), // create_po | update_price | create_promo
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    payloadJson: jsonb("payload_json").notNull(),
    previewJson: jsonb("preview_json").notNull(),
    status: text("status").notNull().default("pending"), // pending | executed | rejected
    createdBy: text("created_by").notNull(),
    executedBy: text("executed_by"),
    executionResultJson: jsonb("execution_result_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    executedAt: timestamp("executed_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_ai_actions_conv").on(t.conversationId),
    index("idx_ai_actions_status").on(t.status),
  ]
);

export const aiBriefings = pgTable("ai_briefings", {
  id: uuid("id").defaultRandom().primaryKey(),
  briefingDate: text("briefing_date").notNull().unique(),
  headline: text("headline").notNull(),
  bulletsJson: jsonb("bullets_json").notNull(),
  model: text("model").notNull(),
  generatedAt: timestamp("generated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const productEmbeddings = pgTable("product_embeddings", {
  productId: uuid("product_id")
    .primaryKey()
    .references(() => products.id, { onDelete: "cascade" }),
  embeddingModel: text("embedding_model").notNull(),
  textHash: text("text_hash").notNull(),
  vectorJson: jsonb("vector_json").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ============================================================================
// 7. MILESTONE 1: SHELF INTEGRITY, PHANTOM STOCK & DYNAMIC FEFO MARKDOWNS
// ============================================================================

export const shelfTagQueue = pgTable(
  "shelf_tag_queue",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    barcode: text("barcode").notNull(),
    oldPriceCents: bigint("old_price_cents", { mode: "number" }).notNull(),
    newPriceCents: bigint("new_price_cents", { mode: "number" }).notNull(),
    reason: text("reason").notNull(), // cost_change | promo | clearance | manual
    status: text("status").notNull().default("pending"), // pending | printed
    printedBy: text("printed_by"),
    printedAt: timestamp("printed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_shelf_tag_status_created").on(t.status, t.createdAt),
    index("idx_shelf_tag_product").on(t.productId),
  ]
);

export const analyticsPhantomStock = pgTable(
  "analytics_phantom_stock",
  {
    productId: uuid("product_id")
      .primaryKey()
      .references(() => products.id, { onDelete: "cascade" }),
    bookStockUnits: integer("book_stock_units").notNull(),
    avgDailyUnits: doublePrecision("avg_daily_units").notNull(),
    daysSinceLastSale: doublePrecision("days_since_last_sale").notNull(),
    voidRefundScore: doublePrecision("void_refund_score").notNull().default(0),
    phantomProb: doublePrecision("phantom_prob").notNull(),
    estimatedValueAtRiskCents: bigint("estimated_value_at_risk_cents", {
      mode: "number",
    }).notNull(),
    status: text("status").notNull().default("open"), // open | verified_ok | recounted
    computedAt: timestamp("computed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_phantom_stock_prob").on(t.phantomProb)]
);

export const analyticsDynamicMarkdowns = pgTable(
  "analytics_dynamic_markdowns",
  {
    batchId: uuid("batch_id")
      .primaryKey()
      .references(() => inventoryBatches.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    daysLeft: integer("days_left").notNull(),
    qtyRemaining: integer("qty_remaining").notNull(),
    currentSellPriceCents: bigint("current_sell_price_cents", { mode: "number" }).notNull(),
    unitCostCents: bigint("unit_cost_cents", { mode: "number" }).notNull(),
    recommendedDiscountBp: integer("recommended_discount_bp").notNull(),
    recommendedPromoPriceCents: bigint("recommended_promo_price_cents", {
      mode: "number",
    }).notNull(),
    predictedClearanceUnits: integer("predicted_clearance_units").notNull(),
    expectedRecoveryCents: bigint("expected_recovery_cents", { mode: "number" }).notNull(),
    baselineNoPromoRecoveryCents: bigint("baseline_no_promo_recovery_cents", {
      mode: "number",
    }).notNull(),
    status: text("status").notNull().default("recommended"), // recommended | applied
    computedAt: timestamp("computed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_dynamic_markdowns_status").on(t.status),
    index("idx_dynamic_markdowns_product").on(t.productId),
  ]
);

// ============================================================================
// 8. MILESTONE 2: 3-WAY DOCK VARIANCES & SUPPLIER OTIF SCORECARDS
// ============================================================================

export const grnVariances = pgTable(
  "grn_variances",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    grnId: uuid("grn_id")
      .notNull()
      .references(() => goodsReceipts.id, { onDelete: "cascade" }),
    poId: uuid("po_id").references(() => purchaseOrders.id, { onDelete: "set null" }),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "restrict" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    varianceType: text("variance_type").notNull(), // short_delivery | over_delivery | cost_overcharge | cost_savings
    orderedQtyUnits: integer("ordered_qty_units").notNull(),
    receivedQtyUnits: integer("received_qty_units").notNull(),
    poUnitCostCents: bigint("po_unit_cost_cents", { mode: "number" }).notNull(),
    invoiceUnitCostCents: bigint("invoice_unit_cost_cents", { mode: "number" }).notNull(),
    financialImpactCents: bigint("financial_impact_cents", { mode: "number" }).notNull(),
    status: text("status").notNull().default("open"), // open | disputed | resolved_credit_note | written_off
    resolutionNote: text("resolution_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_grn_variances_status_created").on(t.status, t.createdAt),
    index("idx_grn_variances_supplier").on(t.supplierId),
    index("idx_grn_variances_grn").on(t.grnId),
  ]
);

export const analyticsSupplierScorecards = pgTable("analytics_supplier_scorecards", {
  supplierId: uuid("supplier_id")
    .primaryKey()
    .references(() => suppliers.id, { onDelete: "cascade" }),
  poCount90d: integer("po_count_90d").notNull(),
  grnCount90d: integer("grn_count_90d").notNull(),
  onTimeRatePct: doublePrecision("on_time_rate_pct").notNull(),
  inFullRatePct: doublePrecision("in_full_rate_pct").notNull(),
  otifRatePct: doublePrecision("otif_rate_pct").notNull(),
  costVarianceRatePct: doublePrecision("cost_variance_rate_pct").notNull(),
  avgLeadTimeDays: doublePrecision("avg_lead_time_days").notNull(),
  leadTimeStdDays: doublePrecision("lead_time_std_days").notNull(),
  totalVarianceCents: bigint("total_variance_cents", { mode: "number" }).notNull().default(0),
  grade: text("grade").notNull(), // A | B | C | D
  computedAt: timestamp("computed_at", { withTimezone: true }).defaultNow().notNull(),
});

// ============================================================================
// 9. MILESTONE 3: LOYALTY LEDGER, TARGETED COUPONS, STAFFING & FLOOR TASKS
// ============================================================================

export const loyaltyLedger = pgTable(
  "loyalty_ledger",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    saleId: uuid("sale_id").references(() => sales.id, { onDelete: "set null" }),
    pointsDelta: integer("points_delta").notNull(),
    reason: text("reason").notNull(), // earn | redeem | bonus | refund_clawback
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_loyalty_ledger_customer").on(t.customerId, t.createdAt)]
);

export const targetedCoupons = pgTable(
  "targeted_coupons",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    code: text("code").notNull().unique(),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "cascade" }),
    rfmSegment: text("rfm_segment"),
    discountCents: bigint("discount_cents", { mode: "number" }).notNull(),
    minBasketCents: bigint("min_basket_cents", { mode: "number" }).notNull().default(0),
    validFrom: timestamp("valid_from", { withTimezone: true }).defaultNow().notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }).notNull(),
    redeemedSaleId: uuid("redeemed_sale_id").references(() => sales.id, { onDelete: "set null" }),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_targeted_coupons_customer").on(t.customerId),
    index("idx_targeted_coupons_rfm").on(t.rfmSegment),
  ]
);

export const shiftRosters = pgTable(
  "shift_rosters",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    planDate: date("plan_date").notNull(),
    hour: integer("hour").notNull(),
    shiftBucket: text("shift_bucket").notNull(), // morning | afternoon | evening
    predictedEntries: doublePrecision("predicted_entries").notNull(),
    predictedTransactions: doublePrecision("predicted_transactions").notNull(),
    recommendedLanes: integer("recommended_lanes").notNull(),
    assignedStaffId: uuid("assigned_staff_id").references(() => users.id, {
      onDelete: "set null",
    }),
    assignedCashierName: text("assigned_cashier_name"),
    status: text("status").notNull().default("planned"), // planned | confirmed | completed
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_shift_roster_slot").on(t.planDate, t.hour)]
);

export const storeTasks = pgTable(
  "store_tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    taskDate: date("task_date").notNull(),
    shiftBucket: text("shift_bucket").notNull(), // morning | afternoon | evening
    taskType: text("task_type").notNull(), // restock | cycle_count | shelf_tag | expiry_markdown
    priority: integer("priority").notNull().default(2), // 1 = urgent, 2 = normal, 3 = low
    title: text("title").notNull(),
    aisleLocation: text("aisle_location"),
    productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
    targetQty: integer("target_qty"),
    status: text("status").notNull().default("pending"), // pending | completed | skipped
    completedBy: text("completed_by"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completionNote: text("completion_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_store_tasks_date_status").on(t.taskDate, t.status),
    index("idx_store_tasks_type").on(t.taskType),
  ]
);
