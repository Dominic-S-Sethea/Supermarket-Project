/**
 * Shared runtime-free TypeScript DTO contracts used by both @supermarket/api and @supermarket/web.
 * Kept strictly free of Zod or Node.js imports so frontend bundles stay lean and tree-shakeable (M-01, M-03).
 */

export type UserRole = "owner" | "manager" | "stock_clerk" | "cashier" | "accountant";

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
  | "opening_stock";

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
