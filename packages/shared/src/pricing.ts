import { computeTaxCents, computeWeightedPriceCents } from "./money.js";
import type { UnitMode } from "./dtos.js";

export type PromoType =
  | "mix_and_match"
  | "bogo"
  | "tier_price"
  | "clearance"
  | "basket_threshold";

export interface PromotionRule {
  id: string;
  name: string;
  promoType: PromoType;
  priority: number; // lower number = evaluated first
  combinable: boolean;
  minMarginGuardBp: number | null; // e.g., 500 = 5% minimum net margin floor; null = no floor
  productIds?: string[];
  categoryIds?: string[];
  eligiblePackQty?: number; // restricts mix_and_match / bogo to specific UOM tier (defaults to 1 = single)
  daypartStartHour?: number | null; // inclusive local hour 0..23
  daypartEndHour?: number | null; // exclusive local hour 1..24
  startsAt?: string | null; // optional ISO start timestamp
  endsAt?: string | null; // optional ISO expiry timestamp
  // Type-specific parameters
  requiredQty?: number; // mix_and_match (e.g. 5) or tier_price min packs/units
  bundlePriceCents?: number; // mix_and_match fixed bundle price (e.g. 400 cents for 5 noodles)
  buyQty?: number; // bogo buy X
  getQty?: number; // bogo get Y
  discountBp?: number; // bogo Y discount (10000=free, 5000=50% off), clearance %, or tier %
  minBasketCents?: number; // basket_threshold
  flatDiscountCents?: number; // basket_threshold flat discount
}

export interface CartInputLine {
  lineKey: string;
  productId: string;
  categoryId: string;
  sku: string;
  name: string;
  scannedBarcode: string;
  packLabel: string;
  packQty: number; // base units per pack (1, 5, 6, 24)
  qtyPacks: number; // number of packs scanned (1 for weighted lines)
  unitMode?: UnitMode; // each | weight_g | volume_ml
  weightGrams?: number | null; // net measure in grams/ml for weight_g / volume_ml lines
  tareGrams?: number | null; // deducted container/bag tare in grams
  embeddedPriceCents?: number | null; // verified GS1 25-29 embedded scale price
  unitPriceCents: number; // price per scanned pack (or per 1,000g/ml for weighted items)
  unitCostCents: number; // cost per BASE unit (or per 1,000g/ml for weighted items)
  taxRateBp: number;
  taxInclusive: boolean;
  requiresAgeCheck: boolean;
}

export interface AppliedPromoSummary {
  promotionId: string;
  promotionName: string;
  promoType: PromoType;
  discountCents: number;
}

export interface EvaluatedCartLine extends CartInputLine {
  baseUnitsSold: number;
  grossBeforeDiscountCents: number;
  discountCents: number;
  netCents: number;
  taxCents: number;
  lineTotalCents: number;
  lineCostCents: number;
  appliedPromotions: string[];
}

export interface EvaluatedCart {
  lines: EvaluatedCartLine[];
  subtotalBeforeDiscountCents: number;
  totalDiscountCents: number;
  totalNetCents: number;
  totalTaxCents: number;
  grandTotalCents: number;
  couponDiscountCents: number;
  totalCostCents: number;
  estimatedMarginBp: number;
  requiresAgeCheck: boolean;
  appliedPromos: AppliedPromoSummary[];
}

function lineMatchesPromo(line: CartInputLine, promo: PromotionRule): boolean {
  const productIds = Array.isArray(promo.productIds) ? promo.productIds : [];
  const categoryIds = Array.isArray(promo.categoryIds) ? promo.categoryIds : [];
  const hasProductScope = productIds.length > 0;
  const hasCategoryScope = categoryIds.length > 0;
  if (!hasProductScope && !hasCategoryScope) return true; // storewide
  if (hasProductScope && productIds.includes(line.productId)) return true;
  if (hasCategoryScope && categoryIds.includes(line.categoryId)) return true;
  return false;
}

/**
 * Clamp a proposed additional discount on a line so the discounted line never drops
 * below its tax-exclusive floor-price margin guard (when configured on the promotion).
 */
function clampDiscountByMarginGuard(
  grossBeforeDiscountCents: number,
  currentDiscountCents: number,
  proposedExtraDiscountCents: number,
  lineCostCents: number,
  minMarginGuardBp: number | null,
  taxRateBp: number,
  taxInclusive: boolean
): number {
  if (proposedExtraDiscountCents <= 0) return 0;
  const maxAllowedTotalDiscount = Math.max(0, grossBeforeDiscountCents - currentDiscountCents);
  let extra = Math.min(proposedExtraDiscountCents, maxAllowedTotalDiscount);

  if (minMarginGuardBp !== null && lineCostCents > 0) {
    // Require: netPrice >= cost / (1 - minMarginBp/10000), converted to gross shelf price if taxInclusive
    const denom = Math.max(1, 10000 - minMarginGuardBp);
    const minNetCents = Math.ceil((lineCostCents * 10000) / denom);
    const floorPriceCents =
      taxInclusive && taxRateBp > 0
        ? Math.ceil((minNetCents * (10000 + taxRateBp)) / 10000)
        : minNetCents;
    const maxDiscountWithFloor = Math.max(
      0,
      grossBeforeDiscountCents - floorPriceCents - currentDiscountCents
    );
    extra = Math.min(extra, maxDiscountWithFloor);
  }
  return Math.max(0, Math.round(extra));
}

/**
 * Distribute an integer cent amount proportionally across positive weights using
 * the Largest Remainder (Hamilton) method so shares are always >= 0 and sum to
 * exactly `totalCents` (never over-allocating due to rounding up).
 */
function allocateProportionalCents(totalCents: number, weights: number[]): number[] {
  const n = weights.length;
  if (n === 0 || totalCents <= 0) return new Array<number>(n).fill(0);
  const safeWeights = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const weightSum = safeWeights.reduce((s, w) => s + w, 0);
  if (weightSum <= 0) return new Array<number>(n).fill(0);

  const exact = safeWeights.map((w) => (totalCents * w) / weightSum);
  const shares = exact.map((e) => Math.floor(e));
  let remainder = totalCents - shares.reduce((s, v) => s + v, 0);

  if (remainder > 0) {
    const order = exact
      .map((e, idx) => ({ idx, frac: e - shares[idx], weight: safeWeights[idx] }))
      .filter((item) => item.weight > 0)
      .sort((a, b) => b.frac - a.frac || a.idx - b.idx);
    for (let i = 0; i < remainder && i < order.length; i++) {
      shares[order[i].idx] += 1;
    }
  }
  return shares;
}

/**
 * Returns true if a promotion is active at the supplied local hour (0..23).
 * When evalHour or daypart window bounds are omitted, treats the promotion as always active.
 */
export function isPromoActiveAtHour(promo: PromotionRule, evalHour?: number): boolean {
  if (
    evalHour === undefined ||
    !Number.isFinite(evalHour) ||
    promo.daypartStartHour === undefined ||
    promo.daypartStartHour === null ||
    promo.daypartEndHour === undefined ||
    promo.daypartEndHour === null
  ) {
    return true;
  }
  const start = promo.daypartStartHour;
  const end = promo.daypartEndHour;
  if (start === end) {
    return false;
  }
  if (start < end) {
    return evalHour >= start && evalHour < end;
  }
  return evalHour >= start || evalHour < end;
}

/**
 * Returns true if a promotion is active at the supplied timestamp/hour.
 * Enforces startsAt/endsAt ISO date bounds when present, and daypart hours when
 * evalHour (or evalNow) is supplied.
 */
export function isPromoActiveAtTime(
  promo: PromotionRule,
  now?: Date,
  evalHour?: number
): boolean {
  const effectiveNow = now ?? new Date();
  if (promo.startsAt) {
    const startMs = Date.parse(promo.startsAt);
    if (Number.isFinite(startMs) && effectiveNow.getTime() < startMs) {
      return false;
    }
  }
  if (promo.endsAt) {
    const endMs = Date.parse(promo.endsAt);
    if (Number.isFinite(endMs) && effectiveNow.getTime() > endMs) {
      return false;
    }
  }
  const effectiveHour = evalHour !== undefined ? evalHour : now ? now.getHours() : undefined;
  return isPromoActiveAtHour(promo, effectiveHour);
}

/**
 * Deterministic pure cart evaluator.
 * Runs identically offline inside the POS terminal and server-side during validation/replays.
 */
export function evaluateCart(
  inputLines: CartInputLine[],
  activePromos: PromotionRule[],
  options?: { evalHour?: number; evalNow?: Date; couponDiscountCents?: number }
): EvaluatedCart {
  const working = inputLines.map((line) => {
    const packQty = Number.isFinite(line.packQty) ? Math.max(1, Math.trunc(line.packQty)) : 1;
    const qtyPacks = Number.isFinite(line.qtyPacks) ? Math.max(0, Math.trunc(line.qtyPacks)) : 0;
    const unitPriceCents = Number.isFinite(line.unitPriceCents)
      ? Math.max(0, Math.round(line.unitPriceCents))
      : 0;
    const unitCostCents = Number.isFinite(line.unitCostCents)
      ? Math.max(0, Math.round(line.unitCostCents))
      : 0;
    const taxRateBp = Number.isFinite(line.taxRateBp)
      ? Math.max(0, Math.round(line.taxRateBp))
      : 0;
    const isMeasured =
      (line.unitMode === "weight_g" || line.unitMode === "volume_ml") &&
      typeof line.weightGrams === "number" &&
      Number.isFinite(line.weightGrams) &&
      line.weightGrams > 0;
    const weightGrams = isMeasured ? Math.max(1, Math.round(line.weightGrams!)) : null;
    const baseUnitsSold = isMeasured ? weightGrams! : packQty * qtyPacks;
    const grossBeforeDiscountCents = isMeasured
      ? typeof line.embeddedPriceCents === "number" &&
        Number.isFinite(line.embeddedPriceCents) &&
        line.embeddedPriceCents > 0
        ? Math.round(line.embeddedPriceCents)
        : computeWeightedPriceCents(weightGrams!, unitPriceCents)
      : unitPriceCents * qtyPacks;
    const lineCostCents = isMeasured
      ? computeWeightedPriceCents(weightGrams!, unitCostCents)
      : unitCostCents * baseUnitsSold;
    return {
      ...line,
      packQty,
      qtyPacks,
      weightGrams,
      unitPriceCents,
      unitCostCents,
      taxRateBp,
      baseUnitsSold,
      grossBeforeDiscountCents,
      lineCostCents,
      discountCents: 0,
      lockedNonCombinable: false,
      appliedPromotions: [] as string[],
    };
  });

  const sortedPromos = [...activePromos]
    .filter((p) => isPromoActiveAtTime(p, options?.evalNow, options?.evalHour))
    .sort((a, b) => a.priority - b.priority);
  const appliedPromosMap = new Map<string, AppliedPromoSummary>();

  const recordPromo = (promo: PromotionRule, amount: number) => {
    if (amount <= 0) return;
    const existing = appliedPromosMap.get(promo.id);
    if (existing) {
      existing.discountCents += amount;
    } else {
      appliedPromosMap.set(promo.id, {
        promotionId: promo.id,
        promotionName: promo.name,
        promoType: promo.promoType,
        discountCents: amount,
      });
    }
  };

  for (const promo of sortedPromos) {
    const eligible = working.filter((line) => {
      if (
        line.qtyPacks <= 0 ||
        line.grossBeforeDiscountCents <= line.discountCents ||
        !lineMatchesPromo(line, promo)
      ) {
        return false;
      }
      if (line.appliedPromotions.length === 0) return true;
      return promo.combinable && (!line.lockedNonCombinable || promo.promoType === "basket_threshold");
    });
    if (eligible.length === 0) continue;

    if (
      promo.promoType === "clearance" &&
      typeof promo.discountBp === "number" &&
      Number.isFinite(promo.discountBp) &&
      promo.discountBp > 0
    ) {
      const effectiveBp = Math.min(10000, Math.round(promo.discountBp));
      for (const line of eligible) {
        const remaining = line.grossBeforeDiscountCents - line.discountCents;
        const proposed = Math.round((remaining * effectiveBp) / 10000);
        const applied = clampDiscountByMarginGuard(
          line.grossBeforeDiscountCents,
          line.discountCents,
          proposed,
          line.lineCostCents,
          promo.minMarginGuardBp,
          line.taxRateBp,
          line.taxInclusive
        );
        if (applied > 0) {
          line.discountCents += applied;
          line.appliedPromotions.push(promo.name);
          if (!promo.combinable) line.lockedNonCombinable = true;
          recordPromo(promo, applied);
        }
      }
    } else if (
      promo.promoType === "tier_price" &&
      typeof promo.requiredQty === "number" &&
      Number.isFinite(promo.requiredQty) &&
      promo.requiredQty > 0 &&
      typeof promo.discountBp === "number" &&
      Number.isFinite(promo.discountBp) &&
      promo.discountBp > 0
    ) {
      const effectiveBp = Math.min(10000, Math.round(promo.discountBp));
      for (const line of eligible) {
        if (line.baseUnitsSold >= promo.requiredQty) {
          const remaining = line.grossBeforeDiscountCents - line.discountCents;
          const proposed = Math.round((remaining * effectiveBp) / 10000);
          const applied = clampDiscountByMarginGuard(
            line.grossBeforeDiscountCents,
            line.discountCents,
            proposed,
            line.lineCostCents,
            promo.minMarginGuardBp,
            line.taxRateBp,
            line.taxInclusive
          );
          if (applied > 0) {
            line.discountCents += applied;
            line.appliedPromotions.push(promo.name);
            if (!promo.combinable) line.lockedNonCombinable = true;
            recordPromo(promo, applied);
          }
        }
      }
    } else if (
      promo.promoType === "mix_and_match" &&
      typeof promo.requiredQty === "number" &&
      Number.isFinite(promo.requiredQty) &&
      promo.requiredQty > 0 &&
      typeof promo.bundlePriceCents === "number" &&
      Number.isFinite(promo.bundlePriceCents) &&
      promo.bundlePriceCents >= 0
    ) {
      // Restrict mix-and-match to matching UOM packQty (defaults to 1 = single) so multi-packs/cases cannot exploit single bundles
      const targetPackQty = promo.eligiblePackQty ?? 1;
      const requiredQty = Math.trunc(promo.requiredQty);
      const packEligible = eligible.filter(
        (line) =>
          line.unitMode !== "weight_g" &&
          line.unitMode !== "volume_ml" &&
          line.packQty === targetPackQty
      );
      type UnitSlot = { lineIdx: number; effectivePriceCents: number };
      const slots: UnitSlot[] = [];
      packEligible.forEach((line) => {
        const idx = working.indexOf(line);
        // Distribute post-discount remaining balance across pack slots so stacked promos never double-discount
        const lineRemaining = Math.max(0, line.grossBeforeDiscountCents - line.discountCents);
        const basePerPack = Math.floor(lineRemaining / line.qtyPacks);
        const extraCents = lineRemaining - basePerPack * line.qtyPacks;
        for (let i = 0; i < line.qtyPacks; i++) {
          slots.push({
            lineIdx: idx,
            effectivePriceCents: basePerPack + (i < extraCents ? 1 : 0),
          });
        }
      });

      const bundleCount = Math.floor(slots.length / requiredQty);
      if (bundleCount > 0) {
        slots.sort((a, b) => b.effectivePriceCents - a.effectivePriceCents);
        const usedSlots = slots.slice(0, bundleCount * requiredQty);
        const regularSum = usedSlots.reduce((s, u) => s + u.effectivePriceCents, 0);
        const targetSum = bundleCount * Math.round(promo.bundlePriceCents);
        const rawSavings = Math.max(0, regularSum - targetSum);

        if (rawSavings > 0 && regularSum > 0) {
          const perLineRegular = new Map<number, number>();
          for (const slot of usedSlots) {
            perLineRegular.set(
              slot.lineIdx,
              (perLineRegular.get(slot.lineIdx) ?? 0) + slot.effectivePriceCents
            );
          }

          // Compute exact un-clamped proportional shares first (Hamilton largest remainder; margin clamping never spills across lines)
          const lineEntries = Array.from(perLineRegular.entries());
          const shares = allocateProportionalCents(
            rawSavings,
            lineEntries.map(([, reg]) => reg)
          );
          lineEntries.forEach(([lineIdx], pos) => {
            const line = working[lineIdx];
            const share = shares[pos];

            const applied = clampDiscountByMarginGuard(
              line.grossBeforeDiscountCents,
              line.discountCents,
              share,
              line.lineCostCents,
              promo.minMarginGuardBp,
              line.taxRateBp,
              line.taxInclusive
            );
            if (applied > 0) {
              line.discountCents += applied;
              line.appliedPromotions.push(promo.name);
              if (!promo.combinable) line.lockedNonCombinable = true;
              recordPromo(promo, applied);
            }
          });
        }
      }
    } else if (
      promo.promoType === "bogo" &&
      typeof promo.buyQty === "number" &&
      Number.isFinite(promo.buyQty) &&
      promo.buyQty > 0 &&
      typeof promo.getQty === "number" &&
      Number.isFinite(promo.getQty) &&
      promo.getQty > 0
    ) {
      const targetPackQty = promo.eligiblePackQty ?? 1;
      const buyQty = Math.trunc(promo.buyQty);
      const getQty = Math.trunc(promo.getQty);
      const packEligible = eligible.filter(
        (line) =>
          line.unitMode !== "weight_g" &&
          line.unitMode !== "volume_ml" &&
          line.packQty === targetPackQty
      );
      const groupSize = buyQty + getQty;
      const rawDiscountBp = promo.discountBp ?? 10000;
      const discountBp = Number.isFinite(rawDiscountBp)
        ? Math.min(10000, Math.max(0, Math.round(rawDiscountBp)))
        : 0;
      if (discountBp <= 0) continue;

      const slots: { lineIdx: number; effectivePriceCents: number }[] = [];
      packEligible.forEach((line) => {
        const idx = working.indexOf(line);
        const lineRemaining = Math.max(0, line.grossBeforeDiscountCents - line.discountCents);
        const basePerPack = Math.floor(lineRemaining / line.qtyPacks);
        const extraCents = lineRemaining - basePerPack * line.qtyPacks;
        for (let i = 0; i < line.qtyPacks; i++) {
          slots.push({
            lineIdx: idx,
            effectivePriceCents: basePerPack + (i < extraCents ? 1 : 0),
          });
        }
      });

      const sets = Math.floor(slots.length / groupSize);
      if (sets > 0) {
        // Retail standard: discount applies to the cheapest eligible items in the set
        slots.sort((a, b) => a.effectivePriceCents - b.effectivePriceCents);
        const discountedSlots = slots.slice(0, sets * getQty);
        const perLineDiscount = new Map<number, number>();
        for (const slot of discountedSlots) {
          const disc = Math.round((slot.effectivePriceCents * discountBp) / 10000);
          perLineDiscount.set(slot.lineIdx, (perLineDiscount.get(slot.lineIdx) ?? 0) + disc);
        }

        for (const [lineIdx, proposed] of perLineDiscount.entries()) {
          const line = working[lineIdx];
          const applied = clampDiscountByMarginGuard(
            line.grossBeforeDiscountCents,
            line.discountCents,
            proposed,
            line.lineCostCents,
            promo.minMarginGuardBp,
            line.taxRateBp,
            line.taxInclusive
          );
          if (applied > 0) {
            line.discountCents += applied;
            line.appliedPromotions.push(promo.name);
            if (!promo.combinable) line.lockedNonCombinable = true;
            recordPromo(promo, applied);
          }
        }
      }
    } else if (
      promo.promoType === "basket_threshold" &&
      typeof promo.minBasketCents === "number" &&
      Number.isFinite(promo.minBasketCents) &&
      promo.minBasketCents > 0 &&
      typeof promo.flatDiscountCents === "number" &&
      Number.isFinite(promo.flatDiscountCents) &&
      promo.flatDiscountCents > 0
    ) {
      const eligibleNetTotal = eligible.reduce(
        (sum, l) => sum + (l.grossBeforeDiscountCents - l.discountCents),
        0
      );
      if (eligibleNetTotal >= promo.minBasketCents) {
        // Compute exact un-clamped proportional shares first so margin clamping on one line never spills onto another
        const totalAllocTarget = Math.min(Math.round(promo.flatDiscountCents), eligibleNetTotal);
        const shares = allocateProportionalCents(
          totalAllocTarget,
          eligible.map((line) => line.grossBeforeDiscountCents - line.discountCents)
        );
        eligible.forEach((line, idx) => {
          const share = shares[idx];

          const applied = clampDiscountByMarginGuard(
            line.grossBeforeDiscountCents,
            line.discountCents,
            share,
            line.lineCostCents,
            promo.minMarginGuardBp,
            line.taxRateBp,
            line.taxInclusive
          );
          if (applied > 0) {
            line.discountCents += applied;
            line.appliedPromotions.push(promo.name);
            if (!promo.combinable) line.lockedNonCombinable = true;
            recordPromo(promo, applied);
          }
        });
      }
    }
  }

  // Prorate targeted loyalty coupon discount (if any) proportionally across post-promo balances
  const rawCoupon = options?.couponDiscountCents ?? 0;
  const requestedCoupon = Number.isFinite(rawCoupon) ? Math.max(0, Math.round(rawCoupon)) : 0;
  const totalRemainingBeforeCoupon = working.reduce(
    (sum, line) => sum + Math.max(0, line.grossBeforeDiscountCents - line.discountCents),
    0
  );
  const appliedCouponCents = Math.min(requestedCoupon, totalRemainingBeforeCoupon);
  if (appliedCouponCents > 0 && totalRemainingBeforeCoupon > 0) {
    const couponShares = allocateProportionalCents(
      appliedCouponCents,
      working.map((line) => Math.max(0, line.grossBeforeDiscountCents - line.discountCents))
    );
    working.forEach((line, idx) => {
      const share = couponShares[idx];
      if (share > 0) {
        line.discountCents += share;
        line.appliedPromotions.push("Loyalty Coupon");
      }
    });
  }

  let subtotalBeforeDiscountCents = 0;
  let totalDiscountCents = 0;
  let totalNetCents = 0;
  let totalTaxCents = 0;
  let grandTotalCents = 0;
  let totalCostCents = 0;
  let requiresAgeCheck = false;

  const lines: EvaluatedCartLine[] = working.map((line) => {
    const afterDiscount = Math.max(0, line.grossBeforeDiscountCents - line.discountCents);
    const tax = computeTaxCents(afterDiscount, line.taxRateBp, line.taxInclusive);

    subtotalBeforeDiscountCents += line.grossBeforeDiscountCents;
    totalDiscountCents += line.discountCents;
    totalNetCents += tax.netCents;
    totalTaxCents += tax.taxCents;
    grandTotalCents += tax.grossCents;
    totalCostCents += line.lineCostCents;
    if (line.requiresAgeCheck && line.qtyPacks > 0) requiresAgeCheck = true;

    return {
      lineKey: line.lineKey,
      productId: line.productId,
      categoryId: line.categoryId,
      sku: line.sku,
      name: line.name,
      scannedBarcode: line.scannedBarcode,
      packLabel: line.packLabel,
      packQty: line.packQty,
      qtyPacks: line.qtyPacks,
      unitMode: line.unitMode,
      weightGrams: line.weightGrams,
      tareGrams: line.tareGrams,
      embeddedPriceCents: line.embeddedPriceCents,
      unitPriceCents: line.unitPriceCents,
      unitCostCents: line.unitCostCents,
      taxRateBp: line.taxRateBp,
      taxInclusive: line.taxInclusive,
      requiresAgeCheck: line.requiresAgeCheck,
      baseUnitsSold: line.baseUnitsSold,
      grossBeforeDiscountCents: line.grossBeforeDiscountCents,
      discountCents: line.discountCents,
      netCents: tax.netCents,
      taxCents: tax.taxCents,
      lineTotalCents: tax.grossCents,
      lineCostCents: line.lineCostCents,
      appliedPromotions: line.appliedPromotions,
    };
  });

  const estimatedMarginBp =
    totalNetCents > 0 ? Math.round(((totalNetCents - totalCostCents) * 10000) / totalNetCents) : 0;

  return {
    lines,
    subtotalBeforeDiscountCents,
    totalDiscountCents,
    totalNetCents,
    totalTaxCents,
    grandTotalCents,
    couponDiscountCents: appliedCouponCents,
    totalCostCents,
    estimatedMarginBp,
    requiresAgeCheck,
    appliedPromos: Array.from(appliedPromosMap.values()),
  };
}
