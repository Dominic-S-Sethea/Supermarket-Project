import { z } from "zod";
import {
  EU_ALLERGENS,
  type EuAllergenCode,
  type NetContentUnit,
  type StockMovementReason,
  type UnitMode,
  type UserRole,
} from "./dtos.js";

export const UserRoleSchema: z.ZodType<UserRole> = z.enum([
  "owner",
  "manager",
  "stock_clerk",
  "cashier",
  "accountant",
]);

export const UnitModeSchema: z.ZodType<UnitMode> = z.enum(["each", "weight_g", "volume_ml"]);
export const NetContentUnitSchema: z.ZodType<NetContentUnit> = z.enum(["g", "ml", "ea"]);
export const EuAllergenSchema: z.ZodType<EuAllergenCode> = z.enum(
  EU_ALLERGENS.map((a) => a.code) as [EuAllergenCode, ...EuAllergenCode[]]
);

export const StockMovementReasonSchema: z.ZodType<StockMovementReason> = z.enum([
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
  "production_in",
  "production_out",
  "trim_waste",
]);

export const CreateProductSchema = z.object({
  sku: z.string().min(2).max(64),
  name: z.string().min(2).max(200),
  brand: z.string().min(1).max(120),
  categoryId: z.string().uuid(),
  taxRateId: z.string().uuid(),
  baseUnitLabel: z.string().min(1).max(32).default("unit"),
  unitMode: UnitModeSchema.optional().default("each"),
  pluCode: z
    .string()
    .trim()
    .regex(/^\d{4,5}$/, "PLU code must be 4 or 5 digits")
    .nullable()
    .optional(),
  defaultTareGrams: z.number().int().min(0).max(50_000).optional().default(0),
  netContentAmount: z.number().int().min(1).max(1_000_000).nullable().optional(),
  netContentUnit: NetContentUnitSchema.nullable().optional(),
  allergens: z.array(EuAllergenSchema).max(14).optional().default([]),
  ingredientsText: z.string().trim().max(1000).nullable().optional(),
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
        weightGrams: z.number().int().min(1).max(500_000).nullable().optional(),
        tareGrams: z.number().int().min(0).max(50_000).nullable().optional(),
        unitPriceCents: z.number().int().min(0),
        unitCostCents: z.number().int().min(0).optional().default(0),
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
  partialDelivery: z.boolean().optional().default(false),
  lines: z
    .array(
      z
        .object({
          productId: z.string().uuid(),
          caseQty: z.number().int().min(1),
          paidCases: z.number().int().min(0),
          freeBonusCases: z.number().int().min(0).default(0),
          invoiceLineTotalCents: z.number().int().min(0),
          lotCode: z.string().max(64).optional(),
          bestBeforeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        })
        .refine((l) => l.paidCases + l.freeBonusCases >= 1, {
          message: "Each GRN line must receive at least 1 paid or bonus case",
        })
    )
    .min(1),
});

export const LoginSchema = z.object({
  username: z.string().min(1).max(64),
  pin: z.string().min(4).max(64),
  includeToken: z.boolean().optional(),
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

export const CreatePromotionSchema = z
  .object({
    name: z.string().min(2).max(160),
    promoType: z.enum(["mix_and_match", "bogo", "tier_price", "clearance", "basket_threshold"]),
    priority: z.number().int().min(1).max(1000).default(15),
    combinable: z.boolean().default(false),
    minMarginGuardBp: z.number().int().min(0).max(9500).nullable().default(800),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().optional(),
    daypartStartHour: z.number().int().min(0).max(23).nullable().optional(),
    daypartEndHour: z.number().int().min(1).max(24).nullable().optional(),
    rulesJson: z.record(z.string(), z.unknown()),
  })
  .refine(
    (d) =>
      (d.daypartStartHour == null && d.daypartEndHour == null) ||
      (d.daypartStartHour != null && d.daypartEndHour != null),
    {
      message: "Both daypartStartHour and daypartEndHour must be provided together or both omitted",
    }
  )
  .refine(
    (d) => !d.startsAt || !d.endsAt || Date.parse(d.startsAt) <= Date.parse(d.endsAt),
    {
      message: "Promotion startsAt must be earlier than or equal to endsAt",
    }
  );

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
  metrics: z.record(z.string(), z.unknown()),
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

export const WEAK_CREDENTIALS = new Set([
  "0000",
  "1111",
  "2222",
  "3333",
  "4444",
  "5555",
  "6666",
  "7777",
  "8888",
  "9999",
  "1234",
  "4321",
  "000000",
  "111111",
  "123456",
  "654321",
  "password",
  "admin123",
  "supermarket",
]);

export const PRIVILEGED_ROLES = new Set<UserRole>(["owner", "manager", "accountant"]);

export function validateCredentialStrength(pin: string, role?: UserRole): string | null {
  const clean = pin.trim();
  const lower = clean.toLowerCase();
  if (WEAK_CREDENTIALS.has(lower) || /^(.)\1+$/.test(clean)) {
    return "PIN/password is too predictable. Avoid repeated digits or trivial sequences.";
  }
  if (role && PRIVILEGED_ROLES.has(role) && clean.length < 8) {
    return `Role "${role}" requires a PIN or password of at least 8 characters.`;
  }
  if (clean.length < 4 || clean.length > 64) {
    return "PIN or password must be 4 to 64 characters.";
  }
  return null;
}

export const CreateUserSchema = z
  .object({
    username: z
      .string()
      .trim()
      .min(3)
      .max(40)
      .regex(/^[a-z0-9._-]+$/i, "Username may only contain letters, digits, dots, underscores, and hyphens"),
    fullName: z.string().trim().min(2).max(120),
    role: UserRoleSchema,
    pin: z.string().trim().min(4).max(64),
  })
  .superRefine((d, ctx) => {
    const err = validateCredentialStrength(d.pin, d.role);
    if (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["pin"], message: err });
    }
  });

export const UpdateUserSchema = z
  .object({
    fullName: z.string().trim().min(2).max(120).optional(),
    role: UserRoleSchema.optional(),
    active: z.boolean().optional(),
    pin: z.string().trim().min(4).max(64).optional(),
  })
  .superRefine((d, ctx) => {
    if (d.pin !== undefined) {
      const err = validateCredentialStrength(d.pin, d.role);
      if (err) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["pin"], message: err });
      }
    }
  });

export const ChangePinSchema = z
  .object({
    currentPin: z.string().trim().min(4).max(64),
    newPin: z.string().trim().min(4).max(64),
  })
  .superRefine((d, ctx) => {
    const err = validateCredentialStrength(d.newPin);
    if (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["newPin"], message: err });
    }
  });

export const RecallProductSchema = z
  .object({
    recalled: z.boolean(),
    reason: z.string().trim().max(240).nullable().optional(),
  })
  .superRefine((d, ctx) => {
    if (d.recalled && (!d.reason || d.reason.trim().length < 4)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "Recall reason (min 4 characters) is required when activating a food-safety recall.",
      });
    }
  });

export const CreateRecipeSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[A-Z0-9_-]+$/i, "Recipe code must be alphanumeric with - or _"),
  name: z.string().trim().min(2).max(160),
  outputProductId: z.string().uuid(),
  expectedYieldBaseUnits: z.number().int().min(1).max(1_000_000),
  shelfLifeDays: z.number().int().min(1).max(365).default(3),
  notes: z.string().trim().max(500).optional(),
  ingredients: z
    .array(
      z.object({
        ingredientProductId: z.string().uuid(),
        qtyBaseUnits: z.number().int().min(1).max(1_000_000),
      })
    )
    .min(1)
    .max(40),
});

export const LogProductionBatchSchema = z.object({
  recipeId: z.string().uuid(),
  batchMultiplier: z.number().int().min(1).max(100).default(1),
  actualOutputUnits: z.number().int().min(1).max(10_000_000),
  trimWasteUnits: z.number().int().min(0).max(10_000_000).default(0),
  lotCode: z.string().trim().min(2).max(64).optional(),
  notes: z.string().trim().max(500).optional(),
});
