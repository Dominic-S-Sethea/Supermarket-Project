import { describe, expect, it } from "vitest";
import {
  buildScaleBarcode,
  buildValidEan13,
  computeEffectiveUnitCostCents,
  computeInventoryValueCents,
  computeLegalUnitPrice,
  computeMarginBp,
  computeMovingWeightedAvgCostCents,
  computeNetMarginBp,
  computeSuggestedSellPriceCents,
  computeTaxCents,
  computeWeightedPriceCents,
  CreateGrnSchema,
  CreatePromotionSchema,
  CreateRecipeSchema,
  deriveWeightFromPriceGrams,
  evaluateCart,
  formatMeasure,
  formatMoney,
  generateUuidV7,
  parseScaleBarcode,
  RecallProductSchema,
  UpdateStoreSettingsSchema,
  validateBarcode,
  type CartInputLine,
  type PromotionRule,
} from "../index.js";

describe("money and cost accounting math", () => {
  it("formats integer cents cleanly without floating-point drift", () => {
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(199)).toBe("$1.99");
    expect(formatMoney(1234567)).toBe("$12,345.67");
    expect(formatMoney(-450)).toBe("-$4.50");
  });

  it("computes effective unit cost accurately with free bonus cases (Buy 10 Get 1 Free) and measured units", () => {
    const effective = computeEffectiveUnitCostCents(24000, 240, 24);
    expect(effective).toBe(91);

    // 20 kg (20,000g) bananas @ $22.00 (2,200c) -> 110c/kg ($1.10/kg)
    expect(computeEffectiveUnitCostCents(2200, 20000, 0, "weight_g")).toBe(110);
    // 20 kg paid + 2 kg free bonus @ $22.00 -> 100c/kg
    expect(computeEffectiveUnitCostCents(2200, 20000, 2000, "weight_g")).toBe(100);
    // 50L (50,000ml) oil @ $150.00 -> 300c/L
    expect(computeEffectiveUnitCostCents(15000, 50000, 0, "volume_ml")).toBe(300);
  });

  it("normalizes inventory valuation cents by unitMode without 1000x inflation", () => {
    expect(computeInventoryValueCents(65000, 110, "weight_g")).toBe(7150);
    expect(computeInventoryValueCents(500, 110, "weight_g")).toBe(55);
    expect(computeInventoryValueCents(-500, 110, "weight_g")).toBe(-55);
    expect(computeInventoryValueCents(2500, 400, "volume_ml")).toBe(1000);
    expect(computeInventoryValueCents(10, 110, "each")).toBe(1100);
    expect(computeInventoryValueCents(0, 110, "weight_g")).toBe(0);
  });

  it("computes Moving Weighted Average Cost (MWAC)", () => {
    expect(computeMovingWeightedAvgCostCents(100, 100, 200, 130)).toBe(120);
    expect(computeMovingWeightedAvgCostCents(-5, 100, 50, 140)).toBe(140);
  });

  it("computes tax exclusive and tax inclusive accurately", () => {
    expect(computeTaxCents(1000, 1000, false)).toEqual({
      netCents: 1000,
      taxCents: 100,
      grossCents: 1100,
    });
    expect(computeTaxCents(1100, 1000, true)).toEqual({
      netCents: 1000,
      taxCents: 100,
      grossCents: 1100,
    });
  });

  it("computes gross and tax-exclusive net margins and suggested prices", () => {
    expect(computeMarginBp(200, 150)).toBe(2500);
    // 10% inclusive VAT on $1.10 -> net $1.00, cost $0.80 -> 20.00% net margin
    expect(computeNetMarginBp(110, 80, 1000, true)).toBe(2000);
    // Tax-exclusive keeps full sell price as net
    expect(computeNetMarginBp(100, 80, 1000, false)).toBe(2000);
    // Suggested price for 80c cost, 20% net margin, 10% inclusive VAT -> net 100c -> gross 110c
    expect(computeSuggestedSellPriceCents(80, 2000, 1000, true)).toBe(110);
    // Tax-exclusive suggested price -> 100c
    expect(computeSuggestedSellPriceCents(80, 2000, 1000, false)).toBe(100);
  });

  it("generates valid RFC 9562 UUIDv7", () => {
    const id = generateUuidV7();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });
});

describe("GS1 barcode validation", () => {
  it("builds and validates EAN-13 barcodes", () => {
    const ean = buildValidEan13("885", 123456);
    expect(ean).toHaveLength(13);
    expect(validateBarcode(ean)).toEqual({
      valid: true,
      normalized: ean,
      format: "EAN-13",
    });

    const badCheck = ean.slice(0, 12) + String((Number(ean[12]) + 1) % 10);
    const res = validateBarcode(badCheck);
    expect(res.valid).toBe(false);
    expect(res.error).toContain("Invalid EAN-13 check digit");
  });

  it("validates UPC-A and store internal codes", () => {
    expect(validateBarcode("036000291452").valid).toBe(true);
    expect(validateBarcode("INT-BEER-001").valid).toBe(true);
  });
});

describe("deterministic promotion and multi-UOM pricing engine", () => {
  const noodleA: CartInputLine = {
    lineKey: "l1",
    productId: "p-noodle-a",
    categoryId: "cat-noodles",
    sku: "NDL-001",
    name: "Indomie Mi Goreng 85g",
    scannedBarcode: "89686010947",
    packLabel: "Single Pack",
    packQty: 1,
    qtyPacks: 3,
    unitPriceCents: 100,
    unitCostCents: 60,
    taxRateBp: 0,
    taxInclusive: true,
    requiresAgeCheck: false,
  };

  const noodleB: CartInputLine = {
    ...noodleA,
    lineKey: "l2",
    productId: "p-noodle-b",
    sku: "NDL-002",
    name: "Indomie Spicy Beef 85g",
    qtyPacks: 2,
  };

  const beer6Pack: CartInputLine = {
    lineKey: "l3",
    productId: "p-beer-1",
    categoryId: "cat-beer",
    sku: "BER-001",
    name: "Heineken Lager 330ml",
    scannedBarcode: "8712000025649",
    packLabel: "6-Pack",
    packQty: 6,
    qtyPacks: 1,
    unitPriceCents: 1000,
    unitCostCents: 110, // 6 * 110 = 660 cents total cost
    taxRateBp: 1000, // 10% VAT inclusive
    taxInclusive: true,
    requiresAgeCheck: true,
  };

  it("applies mix-and-match across different noodle flavors (Any 5 for $4.00)", () => {
    const promos: PromotionRule[] = [
      {
        id: "promo-noodles-5",
        name: "Any 5 Instant Noodles for $4.00",
        promoType: "mix_and_match",
        priority: 10,
        combinable: false,
        minMarginGuardBp: 500,
        categoryIds: ["cat-noodles"],
        requiredQty: 5,
        bundlePriceCents: 400,
      },
    ];

    const res = evaluateCart([noodleA, noodleB], promos);
    expect(res.subtotalBeforeDiscountCents).toBe(500);
    expect(res.totalDiscountCents).toBe(100);
    expect(res.grandTotalCents).toBe(400);
    expect(res.lines[0].baseUnitsSold).toBe(3);
    expect(res.lines[1].baseUnitsSold).toBe(2);
    expect(res.appliedPromos[0].discountCents).toBe(100);
  });

  it("blocks multi-pack/case barcodes from exploiting single-unit mix-and-match and BOGO promos", () => {
    const noodleCases: CartInputLine = {
      ...noodleA,
      lineKey: "case-noodle",
      packLabel: "Case (30)",
      packQty: 30,
      qtyPacks: 5,
      unitPriceCents: 2400,
      unitCostCents: 60,
    };
    const promos: PromotionRule[] = [
      {
        id: "promo-noodles-5",
        name: "Any 5 Instant Noodles for $3.95",
        promoType: "mix_and_match",
        priority: 5,
        combinable: false,
        minMarginGuardBp: null,
        categoryIds: ["cat-noodles"],
        requiredQty: 5,
        bundlePriceCents: 395,
      },
    ];

    const res = evaluateCart([noodleCases], promos);
    expect(res.totalDiscountCents).toBe(0);
    expect(res.grandTotalCents).toBe(12000);
  });

  it("enforces tax-inclusive floor-price margin guard and blocks non-combinable stacking", () => {
    const promos: PromotionRule[] = [
      {
        id: "promo-clearance",
        name: "Clearance 50% Off",
        promoType: "clearance",
        priority: 1,
        combinable: false,
        minMarginGuardBp: 1000, // 10% net margin over 660c cost => minNet = ceil(660*10000/9000)=734; with 10% inclusive VAT => floorGross = ceil(734*11000/10000)=808
        productIds: ["p-beer-1"],
        discountBp: 5000,
      },
      {
        id: "promo-second",
        name: "Extra 20% Off Beer",
        promoType: "clearance",
        priority: 2,
        combinable: false,
        minMarginGuardBp: null,
        productIds: ["p-beer-1"],
        discountBp: 2000,
      },
    ];

    const res = evaluateCart([beer6Pack], promos);
    expect(res.totalDiscountCents).toBe(192);
    expect(res.grandTotalCents).toBe(808);
    expect(res.requiresAgeCheck).toBe(true);
    expect(res.appliedPromos).toHaveLength(1);
    expect(res.lines[0].baseUnitsSold).toBe(6);
  });

  it("applies BOGO (Buy 2 Get 1 Free) on cheapest eligible pack", () => {
    const chipsExpensive: CartInputLine = {
      ...noodleA,
      lineKey: "c1",
      productId: "p-chip-1",
      categoryId: "cat-snacks",
      qtyPacks: 2,
      unitPriceCents: 350,
      unitCostCents: 180,
    };
    const chipsCheaper: CartInputLine = {
      ...noodleA,
      lineKey: "c2",
      productId: "p-chip-2",
      categoryId: "cat-snacks",
      qtyPacks: 1,
      unitPriceCents: 250,
      unitCostCents: 120,
    };

    const promos: PromotionRule[] = [
      {
        id: "promo-bogo",
        name: "Snacks Buy 2 Get 1 Free",
        promoType: "bogo",
        priority: 5,
        combinable: false,
        minMarginGuardBp: null,
        categoryIds: ["cat-snacks"],
        buyQty: 2,
        getQty: 1,
        discountBp: 10000,
      },
    ];

    const res = evaluateCart([chipsExpensive, chipsCheaper], promos);
    expect(res.subtotalBeforeDiscountCents).toBe(950);
    expect(res.totalDiscountCents).toBe(250);
    expect(res.grandTotalCents).toBe(700);
  });

  it("applies tier_price on baseUnitsSold and does not spill clamped basket_threshold savings onto other lines", () => {
    const lowMarginLine: CartInputLine = {
      ...noodleA,
      lineKey: "low-m",
      productId: "p-low",
      categoryId: "cat-dairy",
      qtyPacks: 1,
      unitPriceCents: 3000,
      unitCostCents: 2800, // high cost -> margin guard blocks extra discount
      taxRateBp: 0,
    };
    const healthyLine: CartInputLine = {
      ...noodleA,
      lineKey: "hi-m",
      productId: "p-hi",
      categoryId: "cat-beverages",
      packQty: 12,
      qtyPacks: 1,
      unitPriceCents: 3000,
      unitCostCents: 100, // 12*100 = 1200 cost -> healthy margin
      taxRateBp: 0,
    };

    const promos: PromotionRule[] = [
      {
        id: "tier-1",
        name: "Case Tier 10% Off",
        promoType: "tier_price",
        priority: 1,
        combinable: true,
        minMarginGuardBp: 1000,
        productIds: ["p-hi"],
        requiredQty: 12,
        discountBp: 1000,
      },
      {
        id: "basket-1",
        name: "$5 Off Over $50",
        promoType: "basket_threshold",
        priority: 20,
        combinable: true,
        minMarginGuardBp: 1500,
        minBasketCents: 5000,
        flatDiscountCents: 500,
      },
      {
        id: "after-lock",
        name: "Should Be Blocked After Non-Combinable After Prior Promo",
        promoType: "clearance",
        priority: 30,
        combinable: false,
        minMarginGuardBp: null,
        productIds: ["p-hi"],
        discountBp: 5000,
      },
    ];

    const res = evaluateCart([lowMarginLine, healthyLine], promos);
    // Tier 10% off 3000 = 300 on healthyLine (remaining 2700)
    // Basket $50 threshold eligible total = 3000 + 2700 = 5700 >= 5000
    // lowMarginLine share = round(500 * 3000 / 5700) = 263 -> blocked by 15% guard (floor = 3295 > 3000)
    // healthyLine share = 500 - 263 = 237 -> MUST remain 237 (must NOT spill 263 onto healthyLine!)
    expect(res.lines[0].discountCents).toBe(0);
    expect(res.lines[1].discountCents).toBe(300 + 237);
    expect(res.appliedPromos.some((p) => p.promotionId === "after-lock")).toBe(false);
  });

  it("enforces daypart hour windows while preserving margin guard and omitted-hour fallback", () => {
    const coffee: CartInputLine = {
      ...noodleA,
      lineKey: "coffee-1",
      productId: "p-coffee",
      categoryId: "cat-coffee",
      qtyPacks: 1,
      unitPriceCents: 250,
      unitCostCents: 110,
      taxRateBp: 1000,
      taxInclusive: true,
    };
    const biscuit: CartInputLine = {
      ...noodleA,
      lineKey: "biscuit-1",
      productId: "p-biscuit",
      categoryId: "cat-biscuit",
      qtyPacks: 1,
      unitPriceCents: 200,
      unitCostCents: 100,
      taxRateBp: 1000,
      taxInclusive: true,
    };

    const morningPromo: PromotionRule = {
      id: "morning-combo",
      name: "Morning Commuter Combo $3.49",
      promoType: "mix_and_match",
      priority: 8,
      combinable: false,
      minMarginGuardBp: 1500,
      categoryIds: ["cat-coffee", "cat-biscuit"],
      requiredQty: 2,
      bundlePriceCents: 349,
      daypartStartHour: 8,
      daypartEndHour: 12,
    };

    const morningRes = evaluateCart([coffee, biscuit], [morningPromo], { evalHour: 9 });
    expect(morningRes.totalDiscountCents).toBeGreaterThan(0);
    expect(morningRes.grandTotalCents).toBeLessThan(450);
    expect(morningRes.estimatedMarginBp).toBeGreaterThanOrEqual(1500);
    expect(morningRes.appliedPromos).toHaveLength(1);

    const afternoonRes = evaluateCart([coffee, biscuit], [morningPromo], { evalHour: 15 });
    expect(afternoonRes.totalDiscountCents).toBe(0);
    expect(afternoonRes.grandTotalCents).toBe(450);
    expect(afternoonRes.appliedPromos).toHaveLength(0);

    const defaultRes = evaluateCart([coffee, biscuit], [morningPromo]);
    expect(defaultRes.totalDiscountCents).toBe(morningRes.totalDiscountCents);
  });

  it("enforces promotion startsAt/endsAt date windows and prorates loyalty coupon discounts cleanly", () => {
    const expiredPromo: PromotionRule = {
      id: "expired-1",
      name: "Yesterday Promo",
      promoType: "clearance",
      priority: 5,
      combinable: true,
      minMarginGuardBp: null,
      productIds: ["p1"],
      discountBp: 2000,
      startsAt: "2025-01-01T00:00:00Z",
      endsAt: "2025-01-31T23:59:59Z",
    };
    const activeLine: CartInputLine = {
      lineKey: "p1-single",
      productId: "p1",
      categoryId: "c1",
      sku: "SKU-1",
      name: "Matcha Tin",
      scannedBarcode: "8901234567890",
      packLabel: "Single",
      packQty: 1,
      qtyPacks: 2,
      unitPriceCents: 1000,
      unitCostCents: 600,
      taxRateBp: 1000,
      taxInclusive: true,
      requiresAgeCheck: false,
    };

    const resExpired = evaluateCart([activeLine], [expiredPromo], {
      evalNow: new Date("2026-11-25T10:00:00Z"),
      couponDiscountCents: 300,
    });
    expect(resExpired.appliedPromos).toHaveLength(0);
    expect(resExpired.couponDiscountCents).toBe(300);
    expect(resExpired.totalDiscountCents).toBe(300);
    expect(resExpired.grandTotalCents).toBe(1700);
    expect(resExpired.lines[0]?.appliedPromotions).toContain("Loyalty Coupon");
    expect(resExpired.lines[0]!.netCents + resExpired.lines[0]!.taxCents).toBe(
      resExpired.lines[0]!.lineTotalCents
    );

    const resWithin = evaluateCart([activeLine], [expiredPromo], {
      evalNow: new Date("2025-01-15T10:00:00Z"),
    });
    expect(resWithin.appliedPromos).toHaveLength(1);
    expect(resWithin.totalDiscountCents).toBe(400);
    expect(resWithin.couponDiscountCents).toBe(0);
  });

  it("handles zero/negative quantities cleanly without triggering promos or age checks", () => {
    const zeroBeer: CartInputLine = {
      ...beer6Pack,
      lineKey: "zero-beer",
      qtyPacks: 0,
    };
    const negNoodle: CartInputLine = {
      ...noodleA,
      lineKey: "neg-noodle",
      qtyPacks: -3,
    };
    const res = evaluateCart([zeroBeer, negNoodle], [
      {
        id: "p-clear",
        name: "Clearance",
        promoType: "clearance",
        priority: 1,
        combinable: true,
        minMarginGuardBp: null,
        productIds: ["p-beer-1", "p-noodle-a"],
        discountBp: 2000,
      },
    ]);
    expect(res.subtotalBeforeDiscountCents).toBe(0);
    expect(res.totalDiscountCents).toBe(0);
    expect(res.grandTotalCents).toBe(0);
    expect(res.requiresAgeCheck).toBe(false);
    expect(res.appliedPromos).toHaveLength(0);
  });

  it("allocates basket_threshold and coupon discounts with Hamilton Largest Remainder without over-allocating", () => {
    // 5 identical lines of 1000c each with flatDiscountCents = 3c (previously naive rounding allocated 1c*4 = 4c > 3c)
    const lines: CartInputLine[] = Array.from({ length: 5 }, (_, idx) => ({
      ...noodleA,
      lineKey: `eq-${idx}`,
      productId: `p-eq-${idx}`,
      qtyPacks: 1,
      unitPriceCents: 1000,
      unitCostCents: 400,
    }));
    const basketPromo: PromotionRule = {
      id: "tiny-basket",
      name: "$0.03 Off Over $20",
      promoType: "basket_threshold",
      priority: 10,
      combinable: true,
      minMarginGuardBp: null,
      minBasketCents: 2000,
      flatDiscountCents: 3,
    };
    const res = evaluateCart(lines, [basketPromo], { couponDiscountCents: 7 });
    const lineDiscountSum = res.lines.reduce((acc, l) => acc + l.discountCents, 0);
    expect(res.appliedPromos[0]?.discountCents).toBe(3);
    expect(res.couponDiscountCents).toBe(7);
    expect(res.totalDiscountCents).toBe(10);
    expect(lineDiscountSum).toBe(10);
    expect(res.grandTotalCents).toBe(4990);
  });

  it("prevents double-discounting when combinable clearance stacks with mix_and_match", () => {
    // Two single packs at 100c each -> combinable 20% clearance makes them 80c each (160c total).
    // Then mix_and_match "2 for 150c" should only discount the remaining 10c (NOT 50c down to 110c!).
    const twoNoodles: CartInputLine = {
      ...noodleA,
      lineKey: "stack-1",
      qtyPacks: 2,
      unitPriceCents: 100,
      unitCostCents: 30,
    };
    const promos: PromotionRule[] = [
      {
        id: "comb-clear",
        name: "20% Combinable Clearance",
        promoType: "clearance",
        priority: 1,
        combinable: true,
        minMarginGuardBp: null,
        productIds: ["p-noodle-a"],
        discountBp: 2000,
      },
      {
        id: "comb-bundle",
        name: "2 for $1.50",
        promoType: "mix_and_match",
        priority: 2,
        combinable: true,
        minMarginGuardBp: null,
        categoryIds: ["cat-noodles"],
        requiredQty: 2,
        bundlePriceCents: 150,
      },
    ];
    const res = evaluateCart([twoNoodles], promos);
    expect(res.totalDiscountCents).toBe(50);
    expect(res.grandTotalCents).toBe(150);
  });

  it("safely ignores malformed/negative promotion parameters and non-finite coupons", () => {
    const malformedPromos: PromotionRule[] = [
      {
        id: "bad-bogo",
        name: "Bad BOGO",
        promoType: "bogo",
        priority: 1,
        combinable: true,
        minMarginGuardBp: null,
        categoryIds: ["cat-noodles"],
        buyQty: -1,
        getQty: 1,
        discountBp: 10000,
      },
      {
        id: "bad-bundle",
        name: "Negative Bundle",
        promoType: "mix_and_match",
        priority: 2,
        combinable: true,
        minMarginGuardBp: null,
        categoryIds: ["cat-noodles"],
        requiredQty: 2,
        bundlePriceCents: -100,
      },
      {
        id: "over-discount",
        name: "150% Off Clamped",
        promoType: "clearance",
        priority: 3,
        combinable: true,
        minMarginGuardBp: null,
        productIds: ["p-noodle-a"],
        discountBp: 15000,
      },
    ];

    const res = evaluateCart([noodleA], malformedPromos, {
      couponDiscountCents: Number.POSITIVE_INFINITY,
    });
    expect(res.totalDiscountCents).toBe(300); // clamped to 100% of 300c, never negative grandTotal
    expect(res.grandTotalCents).toBe(0);
    expect(res.couponDiscountCents).toBe(0);
    expect(Number.isFinite(res.estimatedMarginBp)).toBe(true);
  });
});

describe("money and Zod schema edge cases", () => {
  it("guards money utilities against -0, NaN, non-positive roundStep, and negative units", () => {
    expect(formatMoney(-0.1)).toBe("$0.00");
    expect(formatMoney(Number.NaN)).toBe("$0.00");
    expect(computeSuggestedSellPriceCents(100, 2000, 1000, true, 0)).toBeGreaterThan(100);
    expect(computeEffectiveUnitCostCents(1000, -10, 0)).toBe(0);
    expect(computeMovingWeightedAvgCostCents(10, 100, 0, 500)).toBe(100);
    expect(computeMovingWeightedAvgCostCents(10, 100, -5, 500)).toBe(100);
    expect(computeTaxCents(Number.NaN, 1000, true)).toEqual({
      netCents: 0,
      taxCents: 0,
      grossCents: 0,
    });
  });

  it("rejects zero-case GRN lines and invalid promotion daypart/date windows", () => {
    const emptyGrn = CreateGrnSchema.safeParse({
      supplierId: "01950000-0000-7000-8000-000000000001",
      invoiceNumber: "INV-001",
      lines: [
        {
          productId: "01950000-0000-7000-8000-000000000002",
          paidCases: 0,
          freeBonusCases: 0,
          caseQty: 12,
          invoiceLineTotalCents: 0,
        },
      ],
    });
    expect(emptyGrn.success).toBe(false);
    if (!emptyGrn.success) {
      expect(emptyGrn.error.issues.some((i) => i.message.includes("at least 1 paid or bonus case"))).toBe(true);
    }

    const partialDaypart = CreatePromotionSchema.safeParse({
      name: "Broken Daypart",
      promoType: "clearance",
      daypartStartHour: 8,
      rulesJson: { discountBp: 1500 },
    });
    expect(partialDaypart.success).toBe(false);
    if (!partialDaypart.success) {
      expect(partialDaypart.error.issues.some((i) => i.message.includes("provided together"))).toBe(true);
    }

    const equalDaypart = CreatePromotionSchema.safeParse({
      name: "Zero Hour Window",
      promoType: "clearance",
      daypartStartHour: 8,
      daypartEndHour: 8,
      rulesJson: { discountBp: 1500 },
    });
    expect(equalDaypart.success).toBe(false);

    const reversedDates = CreatePromotionSchema.safeParse({
      name: "Reversed Dates",
      promoType: "clearance",
      startsAt: "2026-12-31T00:00:00Z",
      endsAt: "2026-01-01T00:00:00Z",
      rulesJson: { discountBp: 1500 },
    });
    expect(reversedDates.success).toBe(false);
    if (!reversedDates.success) {
      expect(reversedDates.error.issues.some((i) => i.message.includes("earlier than or equal to endsAt"))).toBe(true);
    }

    expect(
      CreatePromotionSchema.safeParse({
        name: "Bad Array Obj",
        promoType: "clearance",
        rulesJson: { productIds: { length: 1 }, discountBp: 1000 },
      }).success
    ).toBe(false);
    expect(
      CreatePromotionSchema.safeParse({
        name: "Dead Tier Promo",
        promoType: "tier_price",
        rulesJson: { discountBp: 1000 },
      }).success
    ).toBe(false);
    expect(
      CreatePromotionSchema.safeParse({
        name: "Missing Clearance Discount",
        promoType: "clearance",
        rulesJson: {},
      }).success
    ).toBe(false);
  });

  it("enforces strict non-combinable exclusivity, empty daypart rejection, and measured-unit exclusion from slot promos", () => {
    const noodleLine: CartInputLine = {
      lineKey: "l1",
      productId: "p-noodle-a",
      categoryId: "cat-noodles",
      sku: "NDL-001",
      name: "Indomie Mi Goreng 85g",
      scannedBarcode: "89686010947",
      packLabel: "Single Pack",
      packQty: 1,
      qtyPacks: 3,
      unitPriceCents: 100,
      unitCostCents: 60,
      taxRateBp: 0,
      taxInclusive: true,
      requiresAgeCheck: false,
    };
    const p1Comb: PromotionRule = {
      id: "p1-comb",
      name: "10% Combinable",
      promoType: "clearance",
      priority: 1,
      combinable: true,
      minMarginGuardBp: null,
      productIds: ["p-noodle-a"],
      discountBp: 1000,
    };
    const p2Exclusive: PromotionRule = {
      id: "p2-excl",
      name: "20% Non-Combinable",
      promoType: "clearance",
      priority: 2,
      combinable: false,
      minMarginGuardBp: null,
      productIds: ["p-noodle-a"],
      discountBp: 2000,
    };
    const resExcl = evaluateCart([noodleLine], [p1Comb, p2Exclusive]);
    expect(resExcl.appliedPromos.map((p) => p.promotionId)).toEqual(["p1-comb"]);
    expect(resExcl.totalDiscountCents).toBe(30);

    // Equal daypart hours (8..8) never match
    expect(
      evaluateCart([noodleLine], [{ ...p1Comb, daypartStartHour: 8, daypartEndHour: 8 }], {
        evalHour: 8,
      }).totalDiscountCents
    ).toBe(0);

    // Measured weight_g lines are excluded from mix_and_match / bogo unit-slot promos
    const weightedProduce: CartInputLine = {
      lineKey: "w-1",
      productId: "p-mango",
      categoryId: "cat-noodles",
      sku: "PRD-MANGO",
      name: "Fresh Mango",
      scannedBarcode: "201234005001",
      packLabel: "0.500 kg",
      packQty: 1,
      qtyPacks: 1,
      unitMode: "weight_g",
      weightGrams: 500,
      unitPriceCents: 600,
      unitCostCents: 300,
      taxRateBp: 0,
      taxInclusive: true,
      requiresAgeCheck: false,
    };
    const bogoPromo: PromotionRule = {
      id: "bogo-1",
      name: "Buy 1 Get 1",
      promoType: "bogo",
      priority: 1,
      combinable: false,
      minMarginGuardBp: null,
      categoryIds: ["cat-noodles"],
      buyQty: 1,
      getQty: 1,
      discountBp: 10000,
    };
    const mixPromo: PromotionRule = {
      id: "mix-1",
      name: "Any 1 for $1",
      promoType: "mix_and_match",
      priority: 2,
      combinable: false,
      minMarginGuardBp: null,
      categoryIds: ["cat-noodles"],
      requiredQty: 1,
      bundlePriceCents: 100,
    };
    const resMeasured = evaluateCart([weightedProduce, noodleLine], [bogoPromo, mixPromo]);
    // weightedProduce (weight_g) must not count toward bogo or mix_and_match slots
    expect(resMeasured.lines[0].discountCents).toBe(0);
  });
});

describe("Milestone 1: Fresh produce, scale barcodes (GS1 20-29), weighted pricing & EU unit price", () => {
  it("builds and parses GS1 prefix 20-24 embedded-weight and prefix 25-29 embedded-price barcodes", () => {
    const weightBc = buildScaleBarcode("weight", "4011", 425);
    expect(weightBc).toHaveLength(13);
    expect(validateBarcode(weightBc).valid).toBe(true);
    const parsedW = parseScaleBarcode(weightBc);
    expect(parsedW).not.toBeNull();
    expect(parsedW?.kind).toBe("weight");
    expect(parsedW?.pluCandidates).toContain("4011");
    expect(parsedW?.weightGrams).toBe(425);
    expect(parsedW?.embeddedPriceCents).toBeNull();

    const priceBc = buildScaleBarcode("price", "20010", 1245);
    const parsedP = parseScaleBarcode(priceBc);
    expect(parsedP?.kind).toBe("price");
    expect(parsedP?.pluCandidates).toContain("20010");
    expect(parsedP?.embeddedPriceCents).toBe(1245);
    expect(parsedP?.weightGrams).toBeNull();

    // Corrupt check digit or non-2x prefix must return null
    const badCheck = `${weightBc.slice(0, 12)}${(Number(weightBc[12]) + 1) % 10}`;
    expect(parseScaleBarcode(badCheck)).toBeNull();
    expect(parseScaleBarcode(buildValidEan13("885", 12345))).toBeNull();
  });

  it("computes exact integer weighted line prices, derived weight, measures, and EU legal unit prices", () => {
    expect(computeWeightedPriceCents(425, 199)).toBe(85);
    expect(computeWeightedPriceCents(500, 2490)).toBe(1245);
    expect(deriveWeightFromPriceGrams(1245, 2490)).toBe(500);
    expect(formatMeasure(425, "weight_g")).toBe("0.425 kg");
    expect(formatMeasure(750, "volume_ml")).toBe("0.750 L");
    expect(formatMeasure(12, "each", "can")).toBe("12 can");

    expect(computeLegalUnitPrice(199, 1000, "g", "weight_g")).toBe("$1.99 / kg");
    expect(computeLegalUnitPrice(150, 330, "ml", "each")).toBe("$4.55 / L");
    expect(computeLegalUnitPrice(95, 150, "g", "each")).toBe("$0.63 / 100g");
    expect(computeLegalUnitPrice(240, 500, "g", "each", "€")).toBe("€4.80 / kg");
  });

  it("evaluates variable-weight lines accurately in evaluateCart with exact integer tax & cost", () => {
    const bananaLine: CartInputLine = {
      lineKey: "fresh-4011",
      productId: "p-banana",
      categoryId: "cat-produce",
      sku: "PROD-4011",
      name: "Cavendish Bananas",
      scannedBarcode: buildScaleBarcode("weight", "4011", 425),
      packLabel: "0.425 kg (Net)",
      packQty: 1,
      qtyPacks: 1,
      unitMode: "weight_g",
      weightGrams: 425,
      tareGrams: 15,
      unitPriceCents: 199, // $1.99 / kg
      unitCostCents: 110,  // $1.10 / kg
      taxRateBp: 700,      // 7% EU reduced food VAT inclusive
      taxInclusive: true,
      requiresAgeCheck: false,
    };
    const res = evaluateCart([bananaLine], []);
    expect(res.grandTotalCents).toBe(85);
    expect(res.totalCostCents).toBe(47);
    expect(res.lines[0].baseUnitsSold).toBe(425);
    expect(res.lines[0].unitMode).toBe("weight_g");
    expect(res.lines[0].weightGrams).toBe(425);
    expect(res.lines[0].tareGrams).toBe(15);
    expect(res.totalTaxCents).toBe(computeTaxCents(85, 700, true).taxCents);
  });

  it("validates RecallProductSchema and CreateRecipeSchema", () => {
    expect(RecallProductSchema.safeParse({ recalled: true, reason: "ok" }).success).toBe(false);
    expect(
      RecallProductSchema.safeParse({ recalled: true, reason: "Salmonella lot 26B recall" }).success
    ).toBe(true);
    expect(RecallProductSchema.safeParse({ recalled: false }).success).toBe(true);

    expect(
      CreateRecipeSchema.safeParse({
        code: "BAKE-SD01",
        name: "Artisan Sourdough Loaf (10-Loaf Bake)",
        outputProductId: "01950000-0000-7000-8000-000000000010",
        expectedYieldBaseUnits: 10,
        shelfLifeDays: 2,
        ingredients: [
          { ingredientProductId: "01950000-0000-7000-8000-000000000011", qtyBaseUnits: 5000 },
        ],
      }).success
    ).toBe(true);
  });
});

describe("Milestone 2: SE Asia EMVCo QR (KHQR / PromptPay / PayNow), QR Matrix & Dual-Currency Math", () => {
  it("computes standard EMVCo CRC-16/CCITT-FALSE and encodes valid KHQR (USD & KHR), PromptPay (THB), and PayNow (SGD) payloads", async () => {
    const {
      buildKhqrPayload,
      buildPayNowPayload,
      buildPromptPayPayload,
      crc16CcittFalse,
      generateQrMatrix,
      parseEmvQrTlv,
      convertFromSecondaryToPrimaryCents,
      convertToSecondaryCurrency,
      formatCurrency,
      CreatePaymentIntentSchema,
      VerifySupervisorOverrideSchema,
    } = await import("../index.js");

    // Standard CRC-16/CCITT-FALSE check vector ("123456789" -> 0x29B1)
    expect(crc16CcittFalse("123456789")).toBe("29B1");

    // 1. Bakong KHQR (USD Tag 30 merchant + Tag 99 expiry + CRC-16)
    const khqrUsd = buildKhqrPayload({
      accountId: "flagship_market@aba",
      merchantId: "MERCH-88412",
      acquiringBank: "ABA Bank",
      merchantName: "Flagship Supermarket",
      merchantCity: "Phnom Penh",
      currencyCode: "USD",
      amountMinorUnits: 1445,
      billReference: "REG01-9911",
    });
    const parsedKhqr = parseEmvQrTlv(khqrUsd.payload);
    expect(parsedKhqr.valid).toBe(true);
    expect(parsedKhqr.crcValid).toBe(true);
    expect(parsedKhqr.rail).toBe("khqr");
    expect(parsedKhqr.currencyNumeric).toBe("840");
    expect(parsedKhqr.amount).toBe("14.45");
    expect(parsedKhqr.billReference).toBe("REG01-9911");
    expect(parsedKhqr.tags["30"]).toContain("flagship_market@aba");
    expect(parsedKhqr.tags["99"]).toBeTruthy();

    // Tampered CRC must fail validation
    const tampered = `${khqrUsd.payload.slice(0, -1)}${khqrUsd.crc16.endsWith("A") ? "B" : "A"}`;
    expect(parseEmvQrTlv(tampered).valid).toBe(false);
    expect(parseEmvQrTlv(tampered).crcValid).toBe(false);

    // 2. Bakong KHQR (KHR zero-decimal)
    const khqrKhr = buildKhqrPayload({
      accountId: "flagship_market@aba",
      merchantName: "Flagship Supermarket",
      currencyCode: "KHR",
      amountMinorUnits: 59200,
      billReference: "REG01-KHR1",
    });
    const parsedKhr = parseEmvQrTlv(khqrKhr.payload);
    expect(parsedKhr.valid).toBe(true);
    expect(parsedKhr.currencyNumeric).toBe("116");
    expect(parsedKhr.amount).toBe("59200");

    // 3. Thailand BOT PromptPay (AID A000000677010111, THB 764, mobile normalized to 0066...)
    const pp = buildPromptPayPayload({
      proxy: "081-234-5678",
      merchantName: "Flagship Bangkok",
      amountMinorUnits: 49950,
      billReference: "PP-2026-01",
    });
    const parsedPp = parseEmvQrTlv(pp.payload);
    expect(parsedPp.valid).toBe(true);
    expect(parsedPp.rail).toBe("promptpay");
    expect(parsedPp.currencyNumeric).toBe("764");
    expect(parsedPp.amount).toBe("499.50");
    expect(parsedPp.tags["29"]).toContain("A000000677010111");
    expect(parsedPp.tags["29"]).toContain("0066812345678");

    // 4. Singapore ABS PayNow (Tag 26 SG.PAYNOW, UEN proxy, non-editable locked amount, SGD 702)
    const pn = buildPayNowPayload({
      proxy: "202612345K",
      merchantName: "Flagship SG",
      amountMinorUnits: 2890,
      billReference: "PN-2026-01",
      expiryDateYyyymmdd: "20261231",
    });
    const parsedPn = parseEmvQrTlv(pn.payload);
    expect(parsedPn.valid).toBe(true);
    expect(parsedPn.rail).toBe("paynow");
    expect(parsedPn.currencyNumeric).toBe("702");
    expect(parsedPn.amount).toBe("28.90");
    expect(parsedPn.tags["26"]).toContain("SG.PAYNOW");
    expect(parsedPn.tags["26"]).toContain("202612345K");

    // 5. ISO/IEC 18004 QR Matrix generation checks (finder patterns, timing, dark module, capacity)
    const qr = generateQrMatrix(khqrUsd.payload);
    expect(qr.version).toBeGreaterThanOrEqual(4);
    expect(qr.size).toBe(qr.version * 4 + 17);
    expect(qr.modules).toHaveLength(qr.size);
    // Top-left 7x7 finder outer border + 3x3 inner core must be dark
    expect(qr.modules[0][0]).toBe(true);
    expect(qr.modules[3][3]).toBe(true);
    expect(qr.modules[1][1]).toBe(false);
    // Mandatory dark module at (size - 8, 8)
    expect(qr.modules[qr.size - 8][8]).toBe(true);

    // 6. Dual-currency USD <-> KHR conversion & formatting
    expect(convertToSecondaryCurrency(1445, 4100, 100)).toBe(59200);
    expect(convertFromSecondaryToPrimaryCents(41000, 4100)).toBe(1000);
    expect(formatCurrency(59200, "KHR")).toBe("59,200 ៛");
    expect(formatCurrency(1445, "USD")).toBe("$14.45");
    expect(formatCurrency(2890, "SGD")).toBe("S$28.90");
    expect(formatCurrency(49950, "THB")).toBe("฿499.50");

    // 7. Milestone 2 schemas
    expect(
      CreatePaymentIntentSchema.safeParse({ rail: "khqr", amountCents: 1445 }).success
    ).toBe(true);
    expect(
      VerifySupervisorOverrideSchema.safeParse({
        username: "manager",
        pin: "9999",
        actionType: "no_sale_drawer",
        reason: "Change coins for customer",
      }).success
    ).toBe(true);
    expect(
      UpdateStoreSettingsSchema.safeParse({
        railFxRatesJson: { THB: 35.5, SGD: 1.35 },
      }).success
    ).toBe(true);
    expect(UpdateStoreSettingsSchema.safeParse({ railFxRatesJson: null }).success).toBe(true);
    expect(UpdateStoreSettingsSchema.safeParse({ railFxRatesJson: { THB: 0 } }).success).toBe(false);
    expect(
      UpdateStoreSettingsSchema.safeParse({ railFxRatesJson: { XYZ: 1.5 } }).success
    ).toBe(false);

    // 8. ISO/IEC 18004 bottom-left 7-bit format strip, terminal Tag 63, and UTF-8 CRC-16 (AUD-035)
    for (const payload of [khqrUsd.payload, pp.payload, pn.payload]) {
      const mat = generateQrMatrix(payload);
      const topLeftHighBits = [
        mat.modules[8][0],
        mat.modules[8][1],
        mat.modules[8][2],
        mat.modules[8][3],
        mat.modules[8][4],
        mat.modules[8][5],
        mat.modules[8][7],
      ];
      const bottomLeftStrip = Array.from({ length: 7 }, (_, i) => mat.modules[mat.size - 1 - i][8]);
      expect(bottomLeftStrip).toEqual(topLeftHighBits);
    }

    const nonTerminalTag63 = `${khqrUsd.payload}9102OK`;
    expect(parseEmvQrTlv(nonTerminalTag63).valid).toBe(false);

    // UTF-8 bytes for "é" are [0xC3, 0xA9] -> CRC-16/CCITT-FALSE = 0x7ACB (vs 1-byte Latin-1)
    expect(crc16CcittFalse("123456789")).toBe("29B1");
    expect(crc16CcittFalse("é")).toBe("7ACB");
  });
});



