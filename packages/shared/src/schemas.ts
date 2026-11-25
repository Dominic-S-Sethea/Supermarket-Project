import { z } from "zod";

export const UserRoleSchema = z.enum([
  "owner",
  "manager",
  "stock_clerk",
  "cashier",
  "accountant",
]);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const StockMovementReasonSchema = z.enum([
  "sale",
  "refund",
  "void",
  "grn",
  "bonus_grn",
  "spoilage",
  "damage",
  "count_adj",
  "clearance",
  "opening_stock",
]);
export type StockMovementReason = z.infer<typeof StockMovementReasonSchema>;

export const CreateProductSchema = z.object({
  sku: z.string().min(2).max(64),
  name: z.string().min(2).max(200),
  brand: z.string().min(1).max(120),
  categoryId: z.string().uuid(),
  taxRateId: z.string().uuid(),
  baseUnitLabel: z.string().min(1).max(32).default("unit"),
  avgCostCents: z.number().int().min(0),
  minMarginBp: z.number().int().min(0).max(9500).default(1500),
  requiresAgeCheck: z.boolean().default(false),
  trackExpiry: z.boolean().default(true),
  expiryAlertDays: z.number().int().min(1).max(365).default(30),
  barcodes: z
    .array(
      z.object({
        barcode: z.string().min(4).max(32),
        packQty: z.number().int().min(1).default(1),
        packLabel: z.string().min(1).max(64).default("Single"),
        sellPriceCents: z.number().int().min(1),
        isPrimary: z.boolean().default(false),
        isOrderableCase: z.boolean().default(false),
      })
    )
    .min(1),
});

export const PosSaleUploadSchema = z.object({
  id: z.string().uuid(),
  registerCode: z.string().min(1).max(32).default("REG-01"),
  shiftId: z.string().uuid().optional(),
  receiptNo: z.string().min(3).max(64),
  kind: z.enum(["sale", "refund", "void"]).default("sale"),
  originalSaleId: z.string().uuid().nullable().optional(),
  soldAt: z.string().datetime(),
  cashierName: z.string().min(1).max(120).optional(),
  ageVerified: z.boolean().default(false),
  customerId: z.string().uuid().nullable().optional(),
  couponCode: z.string().min(3).max(40).nullable().optional(),
  priceOverrideReason: z.string().min(3).max(160).nullable().optional(),
  lines: z
    .array(
      z.object({
        id: z.string().uuid(),
        productId: z.string().uuid(),
        scannedBarcode: z.string().min(1),
        packLabel: z.string().min(1),
        packQty: z.number().int().min(1),
        qtyPacks: z.number().int().min(1),
        unitPriceCents: z.number().int().min(0),
        unitCostCents: z.number().int().min(0),
        discountCents: z.number().int().min(0),
        taxRateBp: z.number().int().min(0),
        taxCents: z.number().int().min(0),
        lineTotalCents: z.number().int().min(0),
      })
    )
    .min(1),
  payments: z
    .array(
      z.object({
        id: z.string().uuid(),
        method: z.enum(["cash", "card", "mobile_pay", "voucher"]),
        amountCents: z.number().int().min(0),
        tenderedCents: z.number().int().min(0).optional(),
        changeCents: z.number().int().min(0).optional(),
      })
    )
    .min(1),
});

export const CreateGrnSchema = z.object({
  supplierId: z.string().uuid(),
  poId: z.string().uuid().optional(),
  invoiceNumber: z.string().min(1).max(80),
  receivedBy: z.string().min(1).max(120).default("Store Manager"),
  notes: z.string().max(500).optional(),
  lines: z
    .array(
      z.object({
        productId: z.string().uuid(),
        caseQty: z.number().int().min(1),
        paidCases: z.number().int().min(0),
        freeBonusCases: z.number().int().min(0).default(0),
        invoiceLineTotalCents: z.number().int().min(0),
        lotCode: z.string().max(64).optional(),
        bestBeforeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
    )
    .min(1),
});

export const LoginSchema = z.object({
  username: z.string().min(1).max(64),
  pin: z.string().min(4).max(12),
});

export const CreatePurchaseOrderSchema = z.object({
  supplierId: z.string().uuid(),
  notes: z.string().max(500).optional(),
  status: z.enum(["draft", "approved"]).optional().default("approved"),
  lines: z
    .array(
      z.object({
        productId: z.string().uuid(),
        caseQty: z.number().int().min(1),
        orderedCases: z.number().int().min(1),
        unitCostCents: z.number().int().min(0),
      })
    )
    .min(1),
});

export const UpdatePoStatusSchema = z.object({
  status: z.enum(["draft", "approved", "sent", "partially_received", "received", "cancelled"]),
});

export const CreatePromotionSchema = z.object({
  name: z.string().min(2).max(160),
  promoType: z.enum(["mix_and_match", "bogo", "tier_price", "clearance", "basket_threshold"]),
  priority: z.number().int().min(1).max(1000).default(15),
  combinable: z.boolean().default(false),
  minMarginGuardBp: z.number().int().min(0).max(9500).nullable().default(800),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  daypartStartHour: z.number().int().min(0).max(23).nullable().optional(),
  daypartEndHour: z.number().int().min(1).max(24).nullable().optional(),
  rulesJson: z.record(z.unknown()),
});

export const IngestFootfallSchema = z.object({
  buckets: z
    .array(
      z.object({
        bucketStart: z.string().datetime(),
        entries: z.number().int().min(0).max(5000),
        exits: z.number().int().min(0).max(5000).optional(),
        avgDwellSec: z.number().int().min(0).max(14400).default(360),
        openLanes: z.number().int().min(1).max(32).default(1),
        weatherRain: z.boolean().default(false),
        source: z.string().max(40).default("door_sensor"),
      })
    )
    .min(1)
    .max(1000),
});

export const CreateShiftExperimentSchema = z
  .object({
    name: z.string().min(3).max(160),
    hypothesis: z.string().min(5).max(500),
    interventionType: z.enum([
      "pre_open_restock",
      "morning_daypart_promo",
      "express_lane_staffing",
      "entrance_merchandising",
      "other",
    ]),
    targetShift: z.enum(["morning", "afternoon", "evening"]).default("morning"),
    controlShift: z.enum(["morning", "afternoon", "evening"]).default("afternoon"),
    preStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    preEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    postStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    postEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .refine((d) => d.preStartDate <= d.preEndDate && d.postStartDate <= d.postEndDate, {
    message: "Pre and post date ranges must have start <= end",
  })
  .refine((d) => d.targetShift !== d.controlShift, {
    message: "targetShift and controlShift must be different shift buckets",
  });

export const AiChatRequestSchema = z.object({
  conversationId: z.string().uuid().optional(),
  message: z.string().min(1).max(2000),
});

export const ParseInvoiceSchema = z
  .object({
    fileName: z.string().min(1).max(200),
    mimeType: z.enum([
      "application/pdf",
      "text/csv",
      "text/plain",
      "image/png",
      "image/jpeg",
      "image/webp",
      "application/json",
    ]),
    base64Data: z.string().max(10_000_000).optional(),
    textContent: z.string().max(500_000).optional(),
  })
  .refine((d) => Boolean(d.base64Data || d.textContent), {
    message: "Either base64Data or textContent is required",
  });

export const AiTriageRequestSchema = z.object({
  targetType: z.enum(["cashier_anomaly", "invoice_discrepancy", "expiry_batch"]),
  subjectId: z.string().optional(),
  metrics: z.record(z.unknown()),
});

export const ApplyDynamicMarkdownSchema = z.object({
  discountBp: z.number().int().min(500).max(9000),
  minMarginGuardBp: z.number().int().min(0).max(5000).nullable().optional(),
});

export const PrintShelfTagBatchSchema = z.object({
  tagIds: z.array(z.string().uuid()).min(1).max(500),
});

export const UpdateVarianceStatusSchema = z.object({
  status: z.enum(["open", "disputed", "resolved_credit_note", "written_off"]),
  resolutionNote: z.string().max(500).optional(),
});

export const CreateCustomerSchema = z.object({
  phone: z.string().trim().min(6).max(32),
  fullName: z.string().trim().min(2).max(120),
  email: z.string().email().max(160).nullable().optional(),
});

export const CreateCouponSchema = z.object({
  code: z.string().trim().min(3).max(40).optional(),
  customerId: z.string().uuid().nullable().optional(),
  rfmSegment: z.string().max(40).nullable().optional(),
  discountCents: z.number().int().min(10).max(100_000),
  minBasketCents: z.number().int().min(0).max(1_000_000).default(0),
  validDays: z.number().int().min(1).max(365).default(30),
});

export const GenerateStaffingPlanSchema = z.object({
  planDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  shiftBucket: z.enum(["morning", "afternoon", "evening"]).optional(),
});

export const UpdateStaffingPlanSchema = z.object({
  assignedStaffId: z.string().uuid().nullable().optional(),
  assignedCashierName: z.string().max(120).nullable().optional(),
  status: z.enum(["planned", "confirmed", "completed"]).optional(),
  recommendedLanes: z.number().int().min(1).max(16).optional(),
});

export const CompleteFloorTaskSchema = z.object({
  note: z.string().max(300).optional(),
  actualQty: z.number().int().min(0).max(100_000).optional(),
});
