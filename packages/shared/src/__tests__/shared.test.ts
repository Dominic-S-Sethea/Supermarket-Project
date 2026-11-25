import { describe, expect, it } from "vitest";
import {
  buildValidEan13,
  computeEffectiveUnitCostCents,
  computeMarginBp,
  computeMovingWeightedAvgCostCents,
  computeNetMarginBp,
  computeSuggestedSellPriceCents,
  computeTaxCents,
  evaluateCart,
  formatMoney,
  generateUuidV7,
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

  it("computes effective unit cost accurately with free bonus cases (Buy 10 Get 1 Free)", () => {
    const effective = computeEffectiveUnitCostCents(24000, 240, 24);
    expect(effective).toBe(91);
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
        combinable: false,
        minMarginGuardBp: 1500,
        minBasketCents: 5000,
        flatDiscountCents: 500,
      },
      {
        id: "after-lock",
        name: "Should Be Blocked After Non-Combinable Basket",
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
});
