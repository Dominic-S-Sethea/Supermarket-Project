/**
 * Integer minor-unit currency & basis-point math utilities.
 * Zero floating-point operations for monetary ledger integrity.
 * 1 basis point (bp) = 0.01% (so 1000 bp = 10.00%, 10000 bp = 100.00%).
 */

export function formatMoney(cents: number, currencySymbol = "$"): string {
  const safe = Number.isFinite(cents) ? Math.round(cents) : 0;
  const neg = safe < 0;
  const abs = Math.abs(safe);
  const major = Math.floor(abs / 100);
  const minor = String(abs % 100).padStart(2, "0");
  return `${neg ? "-" : ""}${currencySymbol}${major.toLocaleString("en-US")}.${minor}`;
}

export function formatBp(bp: number): string {
  const safe = Number.isFinite(bp) ? bp : 0;
  return `${(safe / 100).toFixed(2)}%`;
}

/**
 * Compute gross margin in basis points: ((sellPrice - cost) / sellPrice) * 10000
 */
export function computeMarginBp(sellPriceCents: number, costCents: number): number {
  if (!Number.isFinite(sellPriceCents) || sellPriceCents <= 0) return 0;
  const safeCost = Number.isFinite(costCents) ? costCents : 0;
  return Math.round(((sellPriceCents - safeCost) * 10000) / sellPriceCents);
}

/**
 * Compute tax-exclusive net gross margin in basis points.
 * For tax-inclusive shelf prices, extracts net revenue first so VAT/excise is not counted as profit.
 */
export function computeNetMarginBp(
  sellPriceCents: number,
  costCents: number,
  taxRateBp: number,
  isInclusive: boolean
): number {
  if (!Number.isFinite(sellPriceCents) || sellPriceCents <= 0) return 0;
  const { netCents } = computeTaxCents(sellPriceCents, taxRateBp, isInclusive);
  return computeMarginBp(netCents, costCents);
}

/**
 * Compute suggested retail shelf price in integer cents from cost, target net margin (bp), and tax.
 * Rounds up to nearest `roundStep` cents (default 5c) to preserve the margin floor.
 */
export function computeSuggestedSellPriceCents(
  costCents: number,
  minMarginBp: number,
  taxRateBp: number,
  isInclusive: boolean,
  roundStep = 5
): number {
  const step = Number.isFinite(roundStep) ? Math.max(1, Math.round(roundStep)) : 5;
  if (!Number.isFinite(costCents) || costCents <= 0) return step;
  const safeMarginBp = Number.isFinite(minMarginBp) ? minMarginBp : 0;
  const safeTaxBp = Number.isFinite(taxRateBp) ? Math.max(0, taxRateBp) : 0;
  const clampedMarginBp = Math.min(9500, Math.max(0, safeMarginBp));
  const minNetCents = Math.ceil((costCents * 10000) / Math.max(500, 10000 - clampedMarginBp));
  const grossBeforeRound =
    isInclusive && safeTaxBp > 0
      ? Math.ceil((minNetCents * (10000 + safeTaxBp)) / 10000)
      : minNetCents;
  return Math.ceil(grossBeforeRound / step) * step;
}

/**
 * Compute effective unit cost when a supplier gives free bonus stock (e.g. buy 10 cases get 1 free).
 */
export function computeEffectiveUnitCostCents(
  invoiceLineTotalCents: number,
  paidBaseUnits: number,
  freeBonusBaseUnits: number
): number {
  const safePaid = Number.isFinite(paidBaseUnits) ? Math.max(0, paidBaseUnits) : 0;
  const safeFree = Number.isFinite(freeBonusBaseUnits) ? Math.max(0, freeBonusBaseUnits) : 0;
  const totalUnits = safePaid + safeFree;
  if (totalUnits <= 0) return 0;
  const safeInvoice = Number.isFinite(invoiceLineTotalCents) ? Math.max(0, invoiceLineTotalCents) : 0;
  return Math.round(safeInvoice / totalUnits);
}

/**
 * Compute Moving Weighted Average Cost (MWAC) in integer cents.
 */
export function computeMovingWeightedAvgCostCents(
  currentStockUnits: number,
  currentAvgCostCents: number,
  incomingUnits: number,
  incomingUnitCostCents: number
): number {
  const safeCurrentCost = Number.isFinite(currentAvgCostCents) ? Math.max(0, currentAvgCostCents) : 0;
  const safeIncomingCost = Number.isFinite(incomingUnitCostCents)
    ? Math.max(0, incomingUnitCostCents)
    : 0;
  const safeIncoming = Number.isFinite(incomingUnits) ? Math.max(0, incomingUnits) : 0;
  if (safeIncoming <= 0) return Math.round(safeCurrentCost);
  const effectiveCurrentStock = Number.isFinite(currentStockUnits) ? Math.max(0, currentStockUnits) : 0;
  const totalUnits = effectiveCurrentStock + safeIncoming;
  if (totalUnits <= 0) return Math.round(safeIncomingCost);
  const totalValue =
    effectiveCurrentStock * safeCurrentCost + safeIncoming * safeIncomingCost;
  return Math.round(totalValue / totalUnits);
}

/**
 * Compute tax cents for a taxable amount in cents.
 * Supports both tax-exclusive (add tax on top) and tax-inclusive (extract tax from shelf price).
 */
export function computeTaxCents(
  amountCents: number,
  taxRateBp: number,
  isInclusive: boolean
): { netCents: number; taxCents: number; grossCents: number } {
  const safeAmount = Number.isFinite(amountCents) ? Math.round(amountCents) : 0;
  const safeRate = Number.isFinite(taxRateBp) ? Math.max(0, taxRateBp) : 0;
  if (safeRate <= 0 || safeAmount <= 0) {
    return { netCents: safeAmount, taxCents: 0, grossCents: safeAmount };
  }
  if (isInclusive) {
    // gross = net * (1 + r) => tax = gross - round(gross * 10000 / (10000 + bp))
    const netCents = Math.round((safeAmount * 10000) / (10000 + safeRate));
    const taxCents = safeAmount - netCents;
    return { netCents, taxCents, grossCents: safeAmount };
  }
  const taxCents = Math.round((safeAmount * safeRate) / 10000);
  return { netCents: safeAmount, taxCents, grossCents: safeAmount + taxCents };
}

/**
 * Generate a time-ordered UUIDv7 string (RFC 9562) for offline-first POS idempotency.
 */
export function generateUuidV7(): string {
  const now = BigInt(Date.now());
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // 48-bit big-endian timestamp
  bytes[0] = Number((now >> 40n) & 0xffn);
  bytes[1] = Number((now >> 32n) & 0xffn);
  bytes[2] = Number((now >> 24n) & 0xffn);
  bytes[3] = Number((now >> 16n) & 0xffn);
  bytes[4] = Number((now >> 8n) & 0xffn);
  bytes[5] = Number(now & 0xffn);

  // version 7 (0111)
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  // variant 10xx
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
