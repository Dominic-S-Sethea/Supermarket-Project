/**
 * Shared runtime-free TypeScript DTO contracts used by both @supermarket/api and @supermarket/web.
 * Kept strictly free of Zod or Node.js imports so frontend bundles stay lean and tree-shakeable (M-01, M-03).
 */

export type UserRole = "owner" | "manager" | "stock_clerk" | "cashier" | "accountant";

export type UnitMode = "each" | "weight_g" | "volume_ml";
export type NetContentUnit = "g" | "ml" | "ea";

/** Official 14 major food allergens under EU Regulation (EU) No 1169/2011 */
export const EU_ALLERGENS = [
  { code: "gluten", label: "Cereals containing gluten" },
  { code: "crustaceans", label: "Crustaceans" },
  { code: "eggs", label: "Eggs" },
  { code: "fish", label: "Fish" },
  { code: "peanuts", label: "Peanuts" },
  { code: "soybeans", label: "Soybeans" },
  { code: "milk", label: "Milk" },
  { code: "nuts", label: "Tree nuts" },
  { code: "celery", label: "Celery" },
  { code: "mustard", label: "Mustard" },
  { code: "sesame", label: "Sesame seeds" },
  { code: "sulphites", label: "Sulphur dioxide & sulphites" },
  { code: "lupin", label: "Lupin" },
  { code: "molluscs", label: "Molluscs" },
] as const;

export type EuAllergenCode = (typeof EU_ALLERGENS)[number]["code"];

export type StockMovementReason =
  | "sale"
  | "refund"
  | "void"
  | "grn"
  | "bonus_grn"
  | "spoilage"
  | "damage"
  | "count_adj"
  | "clearance"
  | "opening_stock"
  | "production_in"
  | "production_out"
  | "trim_waste";

export interface SessionUserDto {
  id: string;
  username: string;
  fullName: string;
  role: UserRole;
}

export interface DepartmentDto {
  id: string;
  code: string;
  name: string;
  targetMarginBp?: number;
}

export interface SupplierDto {
  id: string;
  code: string;
  name: string;
  contactEmail?: string | null;
  phone?: string | null;
  defaultLeadTimeDays?: number;
  paymentTermsDays?: number;
}

export interface ProductBarcodeDto {
  id: string;
  productId?: string;
  barcode: string;
  packQty: number;
  packLabel: string;
  sellPriceCents: number;
  isPrimary: boolean;
  isOrderableCase?: boolean;
}

export interface ProductCatalogItemDto {
  id: string;
  sku: string;
  name: string;
  brand: string;
  sizeLabel: string;
  categoryName: string;
  departmentName: string;
  baseUnitLabel: string;
  unitMode?: UnitMode;
  pluCode?: string | null;
  defaultTareGrams?: number;
  netContentAmount?: number | null;
  netContentUnit?: NetContentUnit | null;
  allergens?: EuAllergenCode[];
  ingredientsText?: string | null;
  recalled?: boolean;
  recallReason?: string | null;
  avgCostCents?: number;
  minMarginBp?: number;
  taxRateBp?: number;
  taxInclusive?: boolean;
  requiresAgeCheck: boolean;
  aisleLocation: string;
  onHandUnits: number;
  primaryBarcode: string;
  primarySellPriceCents: number;
  marginBp?: number;
  segment: string | null;
  earliestExpiry: string | null;
  barcodes: ProductBarcodeDto[];
}

export interface PosShiftDto {
  id: string;
  registerCode: string;
  cashierName: string;
  openedAt: string;
  closedAt: string | null;
  openingFloatCents: number;
  cashDropsCents: number;
  blindCountedCashCents: number | null;
  expectedCashCents: number | null;
  varianceCents: number | null;
  zReportNo: string | null;
}

export interface ApiErrorEnvelope {
  error: string | { formErrors?: string[]; fieldErrors?: Record<string, string[]> };
}
