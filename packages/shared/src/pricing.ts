import { computeTaxCents } from "./money.js";

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
  qtyPacks: number; // number of packs scanned
  unitPriceCents: number; // price per scanned pack
  unitCostCents: number; // cost per BASE unit (snapshot)
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
  const hasProductScope = promo.productIds && promo.productIds.length > 0;
  const hasCategoryScope = promo.categoryIds && promo.categoryIds.length > 0;
  if (!hasProductScope && !hasCategoryScope) return true; // storewide
  if (hasProductScope && promo.productIds!.includes(line.productId)) return true;
  if (hasCategoryScope && promo.categoryIds!.includes(line.categoryId)) return true;
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
 * Returns true if a promotion is active at the supplied local hour (0..23).
 * When evalHour or daypart window bounds are omitted, treats the promotion as always active.
 */
export function isPromoActiveAtHour(promo: PromotionRule, evalHour?: number): boolean {
  if (
    evalHour === undefined ||
    promo.daypartStartHour === undefined ||
    promo.daypartStartHour === null ||
    promo.daypartEndHour === undefined ||
    promo.daypartEndHour === null
  ) {
    return true;
  }
  const start = promo.daypartStartHour;
  const end = promo.daypartEndHour;
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
    const baseUnitsSold = line.packQty * line.qtyPacks;
    const grossBeforeDiscountCents = line.unitPriceCents * line.qtyPacks;
    const lineCostCents = line.unitCostCents * baseUnitsSold;
    return {
      ...line,
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
    const eligible = working.filter(
      (line) =>
        lineMatchesPromo(line, promo) &&
        (!line.lockedNonCombinable || (promo.combinable && promo.promoType === "basket_threshold"))
    );
    if (eligible.length === 0) continue;

    if (promo.promoType === "clearance" && promo.discountBp && promo.discountBp > 0) {
      for (const line of eligible) {
        const remaining = line.grossBeforeDiscountCents - line.discountCents;
        const proposed = Math.round((remaining * promo.discountBp) / 10000);
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
      promo.requiredQty &&
      promo.discountBp &&
      promo.discountBp > 0
    ) {
      for (const line of eligible) {
        if (line.baseUnitsSold >= promo.requiredQty) {
          const remaining = line.grossBeforeDiscountCents - line.discountCents;
          const proposed = Math.round((remaining * promo.discountBp) / 10000);
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
      promo.requiredQty &&
      promo.requiredQty > 0 &&
      promo.bundlePriceCents !== undefined
    ) {
      // Restrict mix-and-match to matching UOM packQty (defaults to 1 = single) so multi-packs/cases cannot exploit single bundles
      const targetPackQty = promo.eligiblePackQty ?? 1;
      const packEligible = eligible.filter((line) => line.packQty === targetPackQty);
      type UnitSlot = { lineIdx: number; unitPriceCents: number };
      const slots: UnitSlot[] = [];
      packEligible.forEach((line) => {
        const idx = working.indexOf(line);
        for (let i = 0; i < line.qtyPacks; i++) {
          slots.push({ lineIdx: idx, unitPriceCents: line.unitPriceCents });
        }
      });

      const bundleCount = Math.floor(slots.length / promo.requiredQty);
      if (bundleCount > 0) {
        slots.sort((a, b) => b.unitPriceCents - a.unitPriceCents);
        const usedSlots = slots.slice(0, bundleCount * promo.requiredQty);
        const regularSum = usedSlots.reduce((s, u) => s + u.unitPriceCents, 0);
        const targetSum = bundleCount * promo.bundlePriceCents;
        const rawSavings = Math.max(0, regularSum - targetSum);

        if (rawSavings > 0 && regularSum > 0) {
          const perLineRegular = new Map<number, number>();
          for (const slot of usedSlots) {
            perLineRegular.set(
              slot.lineIdx,
              (perLineRegular.get(slot.lineIdx) ?? 0) + slot.unitPriceCents
            );
          }

          // Compute un-clamped proportional shares first (assigning rounding remainder before margin clamping)
          let remainingUnclamped = rawSavings;
          const lineEntries = Array.from(perLineRegular.entries());
          lineEntries.forEach(([lineIdx, lineReg], pos) => {
            const line = working[lineIdx];
            const share =
              pos === lineEntries.length - 1
                ? remainingUnclamped
                : Math.round((rawSavings * lineReg) / regularSum);
            remainingUnclamped -= share;

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
    } else if (promo.promoType === "bogo" && promo.buyQty && promo.getQty) {
      const targetPackQty = promo.eligiblePackQty ?? 1;
      const packEligible = eligible.filter((line) => line.packQty === targetPackQty);
      const groupSize = promo.buyQty + promo.getQty;
      const discountBp = promo.discountBp ?? 10000;
      const slots: { lineIdx: number; unitPriceCents: number }[] = [];
      packEligible.forEach((line) => {
        const idx = working.indexOf(line);
        for (let i = 0; i < line.qtyPacks; i++) {
          slots.push({ lineIdx: idx, unitPriceCents: line.unitPriceCents });
        }
      });

      const sets = Math.floor(slots.length / groupSize);
      if (sets > 0) {
        // Retail standard: discount applies to the cheapest eligible items in the set
        slots.sort((a, b) => a.unitPriceCents - b.unitPriceCents);
        const discountedSlots = slots.slice(0, sets * promo.getQty);
        const perLineDiscount = new Map<number, number>();
        for (const slot of discountedSlots) {
          const disc = Math.round((slot.unitPriceCents * discountBp) / 10000);
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
      promo.minBasketCents &&
      promo.flatDiscountCents
    ) {
      const eligibleNetTotal = eligible.reduce(
        (sum, l) => sum + (l.grossBeforeDiscountCents - l.discountCents),
        0
      );
      if (eligibleNetTotal >= promo.minBasketCents) {
        // Compute un-clamped proportional shares first so margin clamping on one line never spills onto another
        let remainingUnclamped = Math.min(promo.flatDiscountCents, eligibleNetTotal);
        const totalAllocTarget = remainingUnclamped;
        eligible.forEach((line, idx) => {
          const lineAvail = line.grossBeforeDiscountCents - line.discountCents;
          const share =
            idx === eligible.length - 1
              ? remainingUnclamped
              : Math.round((totalAllocTarget * lineAvail) / eligibleNetTotal);
          remainingUnclamped -= share;

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
  const requestedCoupon = Math.max(0, Math.round(options?.couponDiscountCents ?? 0));
  const totalRemainingBeforeCoupon = working.reduce(
    (sum, line) => sum + Math.max(0, line.grossBeforeDiscountCents - line.discountCents),
    0
  );
  const appliedCouponCents = Math.min(requestedCoupon, totalRemainingBeforeCoupon);
  if (appliedCouponCents > 0 && totalRemainingBeforeCoupon > 0) {
    let couponRemaining = appliedCouponCents;
    working.forEach((line, idx) => {
      if (couponRemaining <= 0) return;
      const headroom = Math.max(0, line.grossBeforeDiscountCents - line.discountCents);
      if (headroom <= 0) return;
      const isLast = idx === working.length - 1;
      const share = isLast
        ? Math.min(couponRemaining, headroom)
        : Math.min(
            headroom,
            Math.min(
              couponRemaining,
              Math.floor((appliedCouponCents * headroom) / totalRemainingBeforeCoupon)
            )
          );
      if (share > 0) {
        line.discountCents += share;
        line.appliedPromotions.push("Loyalty Coupon");
        couponRemaining -= share;
      }
    });
    // Distribute any rounding remainder cents cleanly across lines with headroom
    if (couponRemaining > 0) {
      for (const line of working) {
        if (couponRemaining <= 0) break;
        const headroom = Math.max(0, line.grossBeforeDiscountCents - line.discountCents);
        const take = Math.min(headroom, couponRemaining);
        if (take > 0) {
          line.discountCents += take;
          if (!line.appliedPromotions.includes("Loyalty Coupon")) {
            line.appliedPromotions.push("Loyalty Coupon");
          }
          couponRemaining -= take;
        }
      }
    }
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
    if (line.requiresAgeCheck) requiresAgeCheck = true;

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
