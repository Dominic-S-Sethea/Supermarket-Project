import { eq } from "drizzle-orm";
import { buildValidEan13 } from "@supermarket/shared";
import {
  categories,
  db,
  departments,
  inventoryBatches,
  pool,
  productBarcodes,
  products,
  recipeIngredients,
  recipes,
  stockBaselines,
  taxRates,
} from "./index.js";

function futureDateStr(daysFromNow: number): string {
  const d = new Date(Date.now() + daysFromNow * 86_400_000);
  return d.toISOString().slice(0, 10);
}

interface FreshSkuSeed {
  sku: string;
  name: string;
  brand: string;
  sizeLabel: string;
  deptCode: string;
  catName: string;
  taxCode: string;
  baseUnitLabel: string;
  unitMode: "each" | "weight_g" | "volume_ml";
  pluCode: string | null;
  defaultTareGrams: number;
  netContentAmount: number;
  netContentUnit: "g" | "ml" | "ea";
  allergens: string[];
  ingredientsText: string | null;
  avgCostCents: number;
  sellPriceCents: number;
  minMarginBp: number;
  aisleLocation: string;
  expiryAlertDays: number;
  initialStockUnits: number; // grams for weight_g, each for each
  batchExpiryDays: number;
  barcodeSeq: number;
}

const FRESH_DEPARTMENTS = [
  { code: "PROD", name: "Fresh Produce", targetMarginBp: 3400, defaultCat: "Seasonal Fruit & Veg" },
  { code: "MEAT", name: "Butcher & Seafood", targetMarginBp: 2800, defaultCat: "Fresh Cuts & Fish" },
  { code: "DELI", name: "Deli & Cheese", targetMarginBp: 3600, defaultCat: "Artisan Counter Deli" },
  { code: "BAKE", name: "In-Store Bakery", targetMarginBp: 4800, defaultCat: "Scratch Bakery & Raw Inputs" },
];

const FRESH_SKUS: FreshSkuSeed[] = [
  // Fresh Produce (weight_g -> 1 base unit = 1 gram; prices & costs per kg)
  {
    sku: "PROD-4011",
    name: "Cavendish Bananas (Loose)",
    brand: "TropiFresh",
    sizeLabel: "Per kg",
    deptCode: "PROD",
    catName: "Seasonal Fruit & Veg",
    taxCode: "REDUCED_FOOD",
    baseUnitLabel: "g",
    unitMode: "weight_g",
    pluCode: "4011",
    defaultTareGrams: 12,
    netContentAmount: 1000,
    netContentUnit: "g",
    allergens: [],
    ingredientsText: "Fresh Cavendish Bananas",
    avgCostCents: 110,
    sellPriceCents: 199,
    minMarginBp: 2500,
    aisleLocation: "F1-Produce",
    expiryAlertDays: 4,
    initialStockUnits: 65000, // 65.000 kg
    batchExpiryDays: 5,
    barcodeSeq: 910001,
  },
  {
    sku: "PROD-94011",
    name: "Organic Cavendish Bananas",
    brand: "EcoHarvest",
    sizeLabel: "Per kg",
    deptCode: "PROD",
    catName: "Seasonal Fruit & Veg",
    taxCode: "REDUCED_FOOD",
    baseUnitLabel: "g",
    unitMode: "weight_g",
    pluCode: "94011",
    defaultTareGrams: 12,
    netContentAmount: 1000,
    netContentUnit: "g",
    allergens: [],
    ingredientsText: "Certified Organic Bananas",
    avgCostCents: 155,
    sellPriceCents: 269,
    minMarginBp: 2800,
    aisleLocation: "F1-Produce",
    expiryAlertDays: 4,
    initialStockUnits: 32000,
    batchExpiryDays: 5,
    barcodeSeq: 910002,
  },
  {
    sku: "PROD-4131",
    name: "Crisp Fuji Apples (Loose)",
    brand: "Highland Orchards",
    sizeLabel: "Per kg",
    deptCode: "PROD",
    catName: "Seasonal Fruit & Veg",
    taxCode: "REDUCED_FOOD",
    baseUnitLabel: "g",
    unitMode: "weight_g",
    pluCode: "4131",
    defaultTareGrams: 15,
    netContentAmount: 1000,
    netContentUnit: "g",
    allergens: [],
    ingredientsText: "Fresh Fuji Apples",
    avgCostCents: 210,
    sellPriceCents: 389,
    minMarginBp: 2800,
    aisleLocation: "F1-Produce",
    expiryAlertDays: 10,
    initialStockUnits: 48000,
    batchExpiryDays: 14,
    barcodeSeq: 910003,
  },
  {
    sku: "PROD-4087",
    name: "Vine-Ripened Roma Tomatoes",
    brand: "SunValley Farms",
    sizeLabel: "Per kg",
    deptCode: "PROD",
    catName: "Seasonal Fruit & Veg",
    taxCode: "REDUCED_FOOD",
    baseUnitLabel: "g",
    unitMode: "weight_g",
    pluCode: "4087",
    defaultTareGrams: 15,
    netContentAmount: 1000,
    netContentUnit: "g",
    allergens: [],
    ingredientsText: "Fresh Roma Tomatoes",
    avgCostCents: 185,
    sellPriceCents: 329,
    minMarginBp: 2600,
    aisleLocation: "F1-Produce",
    expiryAlertDays: 5,
    initialStockUnits: 36000,
    batchExpiryDays: 6,
    barcodeSeq: 910004,
  },
  {
    sku: "PROD-4225",
    name: "Hass Avocados (Large)",
    brand: "GreenGrove",
    sizeLabel: "Each (220g avg)",
    deptCode: "PROD",
    catName: "Seasonal Fruit & Veg",
    taxCode: "REDUCED_FOOD",
    baseUnitLabel: "ea",
    unitMode: "each",
    pluCode: "4225",
    defaultTareGrams: 0,
    netContentAmount: 220,
    netContentUnit: "g",
    allergens: [],
    ingredientsText: "Fresh Hass Avocado",
    avgCostCents: 95,
    sellPriceCents: 179,
    minMarginBp: 2800,
    aisleLocation: "F1-Produce",
    expiryAlertDays: 4,
    initialStockUnits: 140,
    batchExpiryDays: 5,
    barcodeSeq: 910005,
  },
  // Butcher & Seafood
  {
    sku: "MEAT-20010",
    name: "Prime Angus Ribeye Steak (Cut)",
    brand: "Flagship Butcher",
    sizeLabel: "Per kg",
    deptCode: "MEAT",
    catName: "Fresh Cuts & Fish",
    taxCode: "REDUCED_FOOD",
    baseUnitLabel: "g",
    unitMode: "weight_g",
    pluCode: "20010",
    defaultTareGrams: 25,
    netContentAmount: 1000,
    netContentUnit: "g",
    allergens: [],
    ingredientsText: "100% Grass-Fed Angus Beef Ribeye",
    avgCostCents: 1690,
    sellPriceCents: 2690,
    minMarginBp: 2200,
    aisleLocation: "F2-Butcher",
    expiryAlertDays: 3,
    initialStockUnits: 22000,
    batchExpiryDays: 4,
    barcodeSeq: 910006,
  },
  {
    sku: "MEAT-20020",
    name: "Norwegian Atlantic Salmon Fillet",
    brand: "Nordic Catch",
    sizeLabel: "Per kg",
    deptCode: "MEAT",
    catName: "Fresh Cuts & Fish",
    taxCode: "REDUCED_FOOD",
    baseUnitLabel: "g",
    unitMode: "weight_g",
    pluCode: "20020",
    defaultTareGrams: 30,
    netContentAmount: 1000,
    netContentUnit: "g",
    allergens: ["fish"],
    ingredientsText: "Fresh Atlantic Salmon (Salmo salar) [FISH]",
    avgCostCents: 1580,
    sellPriceCents: 2450,
    minMarginBp: 2200,
    aisleLocation: "F2-Seafood",
    expiryAlertDays: 2,
    initialStockUnits: 18500,
    batchExpiryDays: 3,
    barcodeSeq: 910007,
  },
  {
    sku: "MEAT-20030",
    name: "Free-Range Chicken Breast",
    brand: "MeadowFarm",
    sizeLabel: "Per kg",
    deptCode: "MEAT",
    catName: "Fresh Cuts & Fish",
    taxCode: "REDUCED_FOOD",
    baseUnitLabel: "g",
    unitMode: "weight_g",
    pluCode: "20030",
    defaultTareGrams: 20,
    netContentAmount: 1000,
    netContentUnit: "g",
    allergens: [],
    ingredientsText: "100% Free-Range Chicken Breast Fillet",
    avgCostCents: 640,
    sellPriceCents: 1090,
    minMarginBp: 2400,
    aisleLocation: "F2-Butcher",
    expiryAlertDays: 3,
    initialStockUnits: 34000,
    batchExpiryDays: 4,
    barcodeSeq: 910008,
  },
  {
    sku: "MEAT-PRIMAL-01",
    name: "Angus Primal Ribeye Loin (Backroom Input)",
    brand: "Wholesale Ranch",
    sizeLabel: "Per kg (Primal)",
    deptCode: "MEAT",
    catName: "Fresh Cuts & Fish",
    taxCode: "REDUCED_FOOD",
    baseUnitLabel: "g",
    unitMode: "weight_g",
    pluCode: null,
    defaultTareGrams: 0,
    netContentAmount: 1000,
    netContentUnit: "g",
    allergens: [],
    ingredientsText: "Whole Bone-Off Beef Ribeye Primal",
    avgCostCents: 1380,
    sellPriceCents: 1850,
    minMarginBp: 1500,
    aisleLocation: "Backroom-Cooler",
    expiryAlertDays: 7,
    initialStockUnits: 45000,
    batchExpiryDays: 10,
    barcodeSeq: 910009,
  },
  // Deli & Cheese
  {
    sku: "DELI-30010",
    name: "12-Month Aged Dutch Gouda (Counter)",
    brand: "KaasMeester",
    sizeLabel: "Per kg",
    deptCode: "DELI",
    catName: "Artisan Counter Deli",
    taxCode: "REDUCED_FOOD",
    baseUnitLabel: "g",
    unitMode: "weight_g",
    pluCode: "30010",
    defaultTareGrams: 18,
    netContentAmount: 1000,
    netContentUnit: "g",
    allergens: ["milk"],
    ingredientsText: "Pasteurized Cow MILK, Salt, Cheese Cultures, Rennet",
    avgCostCents: 1120,
    sellPriceCents: 1990,
    minMarginBp: 3000,
    aisleLocation: "F3-Deli",
    expiryAlertDays: 14,
    initialStockUnits: 24000,
    batchExpiryDays: 21,
    barcodeSeq: 910010,
  },
  {
    sku: "DELI-30020",
    name: "Hickory Smoked Turkey Breast (Sliced)",
    brand: "Flagship Deli",
    sizeLabel: "Per kg",
    deptCode: "DELI",
    catName: "Artisan Counter Deli",
    taxCode: "REDUCED_FOOD",
    baseUnitLabel: "g",
    unitMode: "weight_g",
    pluCode: "30020",
    defaultTareGrams: 18,
    netContentAmount: 1000,
    netContentUnit: "g",
    allergens: ["mustard", "celery"],
    ingredientsText: "Turkey Breast (92%), Sea Salt, Black Pepper, CELERY Extract, MUSTARD Seed",
    avgCostCents: 980,
    sellPriceCents: 1750,
    minMarginBp: 2800,
    aisleLocation: "F3-Deli",
    expiryAlertDays: 5,
    initialStockUnits: 19000,
    batchExpiryDays: 7,
    barcodeSeq: 910011,
  },
  {
    sku: "DELI-30030",
    name: "House Cheese & Turkey Tasting Platter 450g",
    brand: "Flagship Deli",
    sizeLabel: "450g Pack",
    deptCode: "DELI",
    catName: "Artisan Counter Deli",
    taxCode: "REDUCED_FOOD",
    baseUnitLabel: "pack",
    unitMode: "each",
    pluCode: "30030",
    defaultTareGrams: 0,
    netContentAmount: 450,
    netContentUnit: "g",
    allergens: ["milk", "mustard", "celery"],
    ingredientsText: "Aged Gouda (MILK), Smoked Turkey (CELERY, MUSTARD)",
    avgCostCents: 520,
    sellPriceCents: 990,
    minMarginBp: 3200,
    aisleLocation: "F3-Deli",
    expiryAlertDays: 3,
    initialStockUnits: 24,
    batchExpiryDays: 4,
    barcodeSeq: 910012,
  },
  // In-Store Bakery + Raw Ingredients
  {
    sku: "BAKE-40010",
    name: "Artisan Country Sourdough Loaf 750g",
    brand: "Flagship Bakery",
    sizeLabel: "750g Loaf",
    deptCode: "BAKE",
    catName: "Scratch Bakery & Raw Inputs",
    taxCode: "REDUCED_FOOD",
    baseUnitLabel: "loaf",
    unitMode: "each",
    pluCode: "40010",
    defaultTareGrams: 0,
    netContentAmount: 750,
    netContentUnit: "g",
    allergens: ["gluten", "sesame"],
    ingredientsText: "Unbleached WHEAT Flour (GLUTEN), Water, Sourdough Starter, Sea Salt, SESAME Seeds",
    avgCostCents: 145,
    sellPriceCents: 495,
    minMarginBp: 4500,
    aisleLocation: "F4-Bakery",
    expiryAlertDays: 2,
    initialStockUnits: 36,
    batchExpiryDays: 2,
    barcodeSeq: 910013,
  },
  {
    sku: "BAKE-40020",
    name: "All-Butter French Croissants (4-Pack)",
    brand: "Flagship Bakery",
    sizeLabel: "280g (4-Pack)",
    deptCode: "BAKE",
    catName: "Scratch Bakery & Raw Inputs",
    taxCode: "REDUCED_FOOD",
    baseUnitLabel: "pack",
    unitMode: "each",
    pluCode: "40020",
    defaultTareGrams: 0,
    netContentAmount: 280,
    netContentUnit: "g",
    allergens: ["gluten", "milk", "eggs"],
    ingredientsText: "WHEAT Flour (GLUTEN), Cultured Butter (MILK) 28%, Free-Range EGGS, Sugar, Yeast, Salt",
    avgCostCents: 195,
    sellPriceCents: 550,
    minMarginBp: 4200,
    aisleLocation: "F4-Bakery",
    expiryAlertDays: 2,
    initialStockUnits: 28,
    batchExpiryDays: 2,
    barcodeSeq: 910014,
  },
  {
    sku: "BAKE-RAW-FLOUR",
    name: "Artisan Bread Flour T65 (Bulk Ingredient)",
    brand: "Moulin Pro",
    sizeLabel: "Per kg (Bulk)",
    deptCode: "BAKE",
    catName: "Scratch Bakery & Raw Inputs",
    taxCode: "REDUCED_FOOD",
    baseUnitLabel: "g",
    unitMode: "weight_g",
    pluCode: null,
    defaultTareGrams: 0,
    netContentAmount: 1000,
    netContentUnit: "g",
    allergens: ["gluten"],
    ingredientsText: "100% Stone-Milled WHEAT Flour (GLUTEN)",
    avgCostCents: 140,
    sellPriceCents: 240,
    minMarginBp: 2000,
    aisleLocation: "Backroom-Bakery",
    expiryAlertDays: 60,
    initialStockUnits: 120000, // 120 kg
    batchExpiryDays: 120,
    barcodeSeq: 910015,
  },
  {
    sku: "BAKE-RAW-BUTTER",
    name: "82% Cultured Pastry Butter (Bulk Ingredient)",
    brand: "Normandy Dairy",
    sizeLabel: "Per kg (Bulk)",
    deptCode: "BAKE",
    catName: "Scratch Bakery & Raw Inputs",
    taxCode: "REDUCED_FOOD",
    baseUnitLabel: "g",
    unitMode: "weight_g",
    pluCode: null,
    defaultTareGrams: 0,
    netContentAmount: 1000,
    netContentUnit: "g",
    allergens: ["milk"],
    ingredientsText: "Pasteurized Cream (MILK), Lactic Cultures",
    avgCostCents: 780,
    sellPriceCents: 1150,
    minMarginBp: 2000,
    aisleLocation: "Backroom-Cooler",
    expiryAlertDays: 21,
    initialStockUnits: 40000, // 40 kg
    batchExpiryDays: 45,
    barcodeSeq: 910016,
  },
];

export async function seedFreshDepartmentsAndBom() {
  // 1. Ensure EU Reduced Food VAT (7%) exists
  let [reducedTax] = await db
    .select()
    .from(taxRates)
    .where(eq(taxRates.code, "REDUCED_FOOD"))
    .limit(1);
  if (!reducedTax) {
    [reducedTax] = await db
      .insert(taxRates)
      .values({
        code: "REDUCED_FOOD",
        name: "7% Reduced Fresh Food VAT",
        rateBp: 700,
        isInclusive: true,
      })
      .returning();
  }

  // 2. Ensure Fresh Departments & Categories exist
  const catIdByDeptCode = new Map<string, string>();
  for (const d of FRESH_DEPARTMENTS) {
    let [dept] = await db.select().from(departments).where(eq(departments.code, d.code)).limit(1);
    if (!dept) {
      [dept] = await db
        .insert(departments)
        .values({ code: d.code, name: d.name, targetMarginBp: d.targetMarginBp })
        .returning();
    }
    const existingCats = await db
      .select()
      .from(categories)
      .where(eq(categories.departmentId, dept.id));
    let cat = existingCats.find((c) => c.name === d.defaultCat);
    if (!cat) {
      [cat] = await db
        .insert(categories)
        .values({ departmentId: dept.id, name: d.defaultCat })
        .returning();
    }
    catIdByDeptCode.set(d.code, cat.id);
  }

  // 3. Upsert Fresh SKUs, primary barcodes, stock baselines, and FEFO batches
  const prodIdBySku = new Map<string, string>();
  for (const item of FRESH_SKUS) {
    let [existing] = await db.select().from(products).where(eq(products.sku, item.sku)).limit(1);
    if (!existing) {
      [existing] = await db
        .insert(products)
        .values({
          sku: item.sku,
          name: item.name,
          brand: item.brand,
          sizeLabel: item.sizeLabel,
          categoryId: catIdByDeptCode.get(item.deptCode)!,
          taxRateId: reducedTax.id,
          baseUnitLabel: item.baseUnitLabel,
          unitMode: item.unitMode,
          pluCode: item.pluCode,
          defaultTareGrams: item.defaultTareGrams,
          netContentAmount: item.netContentAmount,
          netContentUnit: item.netContentUnit,
          allergensJson: item.allergens,
          ingredientsText: item.ingredientsText,
          avgCostCents: item.avgCostCents,
          minMarginBp: item.minMarginBp,
          requiresAgeCheck: false,
          trackExpiry: true,
          expiryAlertDays: item.expiryAlertDays,
          aisleLocation: item.aisleLocation,
        })
        .returning();

      const primaryBc = buildValidEan13("899", item.barcodeSeq);
      await db.insert(productBarcodes).values({
        productId: existing.id,
        barcode: primaryBc,
        packQty: 1,
        packLabel: item.unitMode === "weight_g" ? "Per kg (Scale)" : item.sizeLabel,
        sellPriceCents: item.sellPriceCents,
        isPrimary: true,
        isOrderableCase: false,
      });

      await db.insert(stockBaselines).values({
        productId: existing.id,
        quantity: item.initialStockUnits,
      });

      await db.insert(inventoryBatches).values({
        productId: existing.id,
        lotCode: `FRESH-${item.sku}`,
        bestBeforeDate: futureDateStr(item.batchExpiryDays),
        unitCostCents: item.avgCostCents,
        qtyReceived: item.initialStockUnits,
        qtyRemaining: item.initialStockUnits,
        status: "active",
      });
    }
    prodIdBySku.set(item.sku, existing.id);
  }

  // 4. Upsert 3 Flagship BOM Recipes (Bakery, Butcher, Deli)
  const bomSeeds = [
    {
      code: "BAKE-SOURDOUGH-10",
      name: "Artisan Country Sourdough Bake (10 Loaves)",
      outputSku: "BAKE-40010",
      expectedYieldBaseUnits: 10,
      shelfLifeDays: 2,
      notes: "24h cold-fermented sourdough; 5.0 kg T65 flour yields 10 x 750g baked loaves.",
      ingredients: [{ sku: "BAKE-RAW-FLOUR", qtyBaseUnits: 5000 }],
    },
    {
      code: "BAKE-CROISSANT-12",
      name: "All-Butter Croissant Bake (12 x 4-Packs)",
      outputSku: "BAKE-40020",
      expectedYieldBaseUnits: 12,
      shelfLifeDays: 2,
      notes: "Laminated French butter dough: 2.0 kg T65 flour + 0.95 kg 82% cultured butter.",
      ingredients: [
        { sku: "BAKE-RAW-FLOUR", qtyBaseUnits: 2000 },
        { sku: "BAKE-RAW-BUTTER", qtyBaseUnits: 950 },
      ],
    },
    {
      code: "MEAT-RIBEYE-CUT",
      name: "Angus Primal Loin -> Ribeye Steaks (5 kg Loin)",
      outputSku: "MEAT-20010",
      expectedYieldBaseUnits: 4250, // 4.250 kg retail yield (~15% fat/silverskin trim)
      shelfLifeDays: 4,
      notes: "5.0 kg primal ribeye loin trimmed to ~4.25 kg retail steaks (15% expected trim).",
      ingredients: [{ sku: "MEAT-PRIMAL-01", qtyBaseUnits: 5000 }],
    },
    {
      code: "DELI-PLATTER-10",
      name: "House Cheese & Turkey Tasting Platters (10 Packs)",
      outputSku: "DELI-30030",
      expectedYieldBaseUnits: 10,
      shelfLifeDays: 4,
      notes: "2.25 kg Aged Gouda + 2.25 kg Smoked Turkey sliced & packed into 10 x 450g trays.",
      ingredients: [
        { sku: "DELI-30010", qtyBaseUnits: 2250 },
        { sku: "DELI-30020", qtyBaseUnits: 2250 },
      ],
    },
  ];

  for (const r of bomSeeds) {
    const [existingRecipe] = await db
      .select()
      .from(recipes)
      .where(eq(recipes.code, r.code))
      .limit(1);
    if (existingRecipe) continue;

    const outputId = prodIdBySku.get(r.outputSku);
    if (!outputId) continue;

    const [created] = await db
      .insert(recipes)
      .values({
        code: r.code,
        name: r.name,
        outputProductId: outputId,
        expectedYieldBaseUnits: r.expectedYieldBaseUnits,
        shelfLifeDays: r.shelfLifeDays,
        notes: r.notes,
      })
      .returning();

    for (const ing of r.ingredients) {
      const ingId = prodIdBySku.get(ing.sku);
      if (!ingId) continue;
      await db.insert(recipeIngredients).values({
        recipeId: created.id,
        ingredientProductId: ingId,
        qtyBaseUnits: ing.qtyBaseUnits,
      });
    }
  }

  return { seededSkus: FRESH_SKUS.length, seededRecipes: bomSeeds.length };
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("/seedFresh.ts");
if (isMain) {
  seedFreshDepartmentsAndBom()
    .then(async (res) => {
      console.log(`Seeded Fresh Produce/Meat/Deli/Bakery core: ${res.seededSkus} SKUs, ${res.seededRecipes} BOM recipes.`);
      await pool.end();
    })
    .catch(async (err) => {
      console.error("Failed seeding fresh departments:", err);
      await pool.end();
      process.exit(1);
    });
}
