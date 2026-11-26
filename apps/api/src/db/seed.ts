import {
  buildValidEan13,
  computeNetMarginBp,
  computeSuggestedSellPriceCents,
  generateUuidV7,
} from "@supermarket/shared";
import { eq, isNotNull, sql } from "drizzle-orm";
import { hashPin } from "../plugins/auth.js";
import { applyDatabaseConstraintsAndViews } from "./applyConstraints.js";
import { seedFreshDepartmentsAndBom } from "./seedFresh.js";
import {
  auditLogs,
  categories,
  customers,
  db,
  departments,
  goodsReceipts,
  grnLines,
  grnVariances,
  hourlyStockSnapshots,
  inventoryBatches,
  loyaltyLedger,
  marginAlerts,
  pool,
  posShifts,
  productBarcodes,
  products,
  promotions,
  purchaseOrderLines,
  purchaseOrders,
  saleLines,
  salePayments,
  sales,
  shelfTagQueue,
  shiftExperiments,
  stockBaselines,
  stockMovements,
  storeFootfall,
  supplierProducts,
  suppliers,
  targetedCoupons,
  taxRates,
  users,
} from "./index.js";

// Deterministic fast PRNG (Mulberry32) so seed output is reproducible
function createRng(seedVal = 20261125) {
  let a = seedVal;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function chunkInsert<T>(
  rows: T[],
  chunkSize: number,
  inserter: (chunk: T[]) => Promise<unknown>
) {
  for (let i = 0; i < rows.length; i += chunkSize) {
    await inserter(rows.slice(i, i + chunkSize));
  }
}

interface DeptTemplate {
  code: string;
  name: string;
  targetMarginBp: number;
  taxCode: string;
  requiresAgeCheck: boolean;
  aislePrefix: string;
  unitLabel: string;
  caseQty: number;
  multiPackQty: number | null;
  multiPackLabel: string | null;
  supplierIndex: number;
  baseCostRange: [number, number];
  categories: {
    name: string;
    skuCount: number;
    brands: string[];
    variants: string[];
    sizes: string[];
  }[];
}

const DEPT_TEMPLATES: DeptTemplate[] = [
  {
    code: "BEER",
    name: "Beer & Cider",
    targetMarginBp: 2400,
    taxCode: "ALC",
    requiresAgeCheck: true,
    aislePrefix: "A1",
    unitLabel: "can",
    caseQty: 24,
    multiPackQty: 6,
    multiPackLabel: "6-Pack",
    supplierIndex: 0,
    baseCostRange: [95, 220],
    categories: [
      {
        name: "International Lager",
        skuCount: 110,
        brands: ["Heineken", "Asahi", "Tiger", "Stella Artois", "Corona", "Carlsberg", "Sapporo", "Peroni", "Singha", "Chang"],
        variants: ["Original", "Silver", "Dry", "Light", "Extra Cold", "Draft", "Reserve", "Gold", "Unfiltered", "Crisp", "Classic"],
        sizes: ["330ml Can", "355ml Bottle", "500ml Tall Can"],
      },
      {
        name: "Craft IPA & Pale Ale",
        skuCount: 95,
        brands: ["Sierra Nevada", "Lagunitas", "BrewDog", "Stone", "Goose Island", "Founders", "Kona", "Brooklyn", "Harpoon"],
        variants: ["Hazy IPA", "West Coast IPA", "Session IPA", "Golden Ale", "Amber Ale", "Citrus Pale", "Double IPA", "Wheat", "Pilsner", "Hoppy Lager", "Blonde"],
        sizes: ["330ml Can", "355ml Can", "473ml Pint Can"],
      },
      {
        name: "Stout, Cider & Zero-Alc",
        skuCount: 155,
        brands: ["Guinness", "Strongbow", "Somersby", "Sapporo 0.0", "Heineken 0.0", "Kirin", "Hoegaarden", "Blue Moon", "Erdinger", "Paulaner"],
        variants: ["Draught Stout", "Apple Cider", "Pear Cider", "Berry Cider", "0.0 Alcohol-Free", "Witbier", "Rosée", "Hefeweizen", "Dark Wheat", "Mango Cider", "Crisp Dry", "Lime", "Peach", "Ginger", "Honey", "Elderflower"],
        sizes: ["330ml Can", "330ml Bottle", "440ml Can"],
      },
    ],
  },
  {
    code: "SODA",
    name: "Soft Drinks & Juices",
    targetMarginBp: 2800,
    taxCode: "STD",
    requiresAgeCheck: false,
    aislePrefix: "A2",
    unitLabel: "can",
    caseQty: 24,
    multiPackQty: 6,
    multiPackLabel: "6-Pack",
    supplierIndex: 1,
    baseCostRange: [45, 130],
    categories: [
      {
        name: "Cola & Sparkling Soda",
        skuCount: 150,
        brands: ["Coca-Cola", "Pepsi", "Sprite", "Fanta", "7UP", "Schweppes", "Dr Pepper", "Mountain Dew", "A&W", "Mirinda"],
        variants: ["Original", "Zero Sugar", "Cherry", "Vanilla", "Lemon-Lime", "Orange", "Grape", "Strawberry", "Ginger Ale", "Tonic Water", "Cream Soda", "Root Beer", "Mango", "Pineapple", "Wild Berry"],
        sizes: ["330ml Can", "500ml Bottle", "1.5L Bottle"],
      },
      {
        name: "Iced Tea & Botanical",
        skuCount: 150,
        brands: ["Lipton", "Nestea", "Ito En", "Pokka", "Arizona", "Fuze Tea", "Oishi", "C2", "Honest Tea", "Kirin Afternoon"],
        variants: ["Lemon", "Peach", "Green Tea Unsweetened", "Honey Green Tea", "Jasmine", "Oolong", "Matcha", "Lychee", "Mango", "Raspberry", "Chamomile", "Milk Tea", "Earl Grey", "Yuzu", "Passionfruit"],
        sizes: ["350ml Bottle", "500ml Bottle", "1L Carton"],
      },
      {
        name: "Fruit Juice & Nectar",
        skuCount: 150,
        brands: ["Tropicana", "Minute Maid", "Tipco", "Malee", "Ocean Spray", "Welch's", "Ceres", "Rauch", "Del Monte", "Kagome"],
        variants: ["100% Orange", "Apple", "Cranberry", "Concord Grape", "Mango Nectar", "Guava", "Pineapple", "Tomato", "Pomegranate", "Mixed Berry", "Aloe Vera", "Coconut Water", "Pink Grapefruit", "Peach", "Tropical Blend"],
        sizes: ["250ml Pack", "500ml Bottle", "1L Carton"],
      },
    ],
  },
  {
    code: "ENRG",
    name: "Energy & Sports Drinks",
    targetMarginBp: 3000,
    taxCode: "STD",
    requiresAgeCheck: false,
    aislePrefix: "A3",
    unitLabel: "can",
    caseQty: 24,
    multiPackQty: 4,
    multiPackLabel: "4-Pack",
    supplierIndex: 2,
    baseCostRange: [75, 175],
    categories: [
      {
        name: "Energy Drinks",
        skuCount: 130,
        brands: ["Red Bull", "Monster", "Rockstar", "Celsius", "Prime", "C4", "Burn", "Lipovitan", "Sting", "M-150"],
        variants: ["Original", "Sugar Free", "Tropical", "Watermelon", "Blueberry", "Mango Loco", "Ultra White", "Ultra Paradise", "Peach Vibe", "Berry Frost", "Citrus", "Grape", "Strawberry"],
        sizes: ["250ml Can", "355ml Can", "473ml Can"],
      },
      {
        name: "Isotonic & Vitamin Drinks",
        skuCount: 110,
        brands: ["Gatorade", "Pocari Sweat", "100Plus", "Powerade", "Aquarius", "Vitaminwater", "BodyArmor", "Electrolit", "Revive"],
        variants: ["Lemon Lime", "Blue Bolt", "Fruit Punch", "Orange", "Original Ion", "Zero Sugar", "Grape", "Strawberry Kiwi", "Tropical Mango", "Coconut Berry", "Dragonfruit", "Citrus Blast"],
        sizes: ["330ml Can", "500ml Bottle", "900ml Bottle"],
      },
    ],
  },
  {
    code: "WATR",
    name: "Bottled Water",
    targetMarginBp: 3500,
    taxCode: "ZERO",
    requiresAgeCheck: false,
    aislePrefix: "A4",
    unitLabel: "bottle",
    caseQty: 24,
    multiPackQty: 6,
    multiPackLabel: "6-Pack",
    supplierIndex: 1,
    baseCostRange: [22, 85],
    categories: [
      {
        name: "Still & Spring Water",
        skuCount: 100,
        brands: ["Evian", "Fiji", "Dasani", "Aquafina", "Volvic", "Voss", "Smartwater", "Crystal Geyser", "Acqua Panna", "Spritzer"],
        variants: ["Natural Spring", "Purified", "Electrolyte", "Alkaline pH9", "Mineral", "Sport Cap", "Kids Cap", "Pure Still", "Glacier", "Artesian"],
        sizes: ["330ml Bottle", "500ml Bottle", "1.5L Bottle"],
      },
      {
        name: "Sparkling Water",
        skuCount: 80,
        brands: ["Perrier", "San Pellegrino", "LaCroix", "Bubly", "Schweppes Soda", "Spindrift", "Polar", "Topo Chico"],
        variants: ["Plain", "Lime", "Lemon", "Grapefruit", "Blood Orange", "Berry", "Peach", "Mango", "Blackberry", "Cucumber Mint"],
        sizes: ["330ml Can", "500ml Bottle", "750ml Glass"],
      },
    ],
  },
  {
    code: "SNCK",
    name: "Chips & Savory Snacks",
    targetMarginBp: 3400,
    taxCode: "STD",
    requiresAgeCheck: false,
    aislePrefix: "B1",
    unitLabel: "bag",
    caseQty: 12,
    multiPackQty: null,
    multiPackLabel: null,
    supplierIndex: 3,
    baseCostRange: [65, 195],
    categories: [
      {
        name: "Potato Chips",
        skuCount: 180,
        brands: ["Lay's", "Pringles", "Kettle Brand", "Calbee", "Ruffles", "Tyrrells", "Jack 'n Jill", "Walkers", "Cape Cod", "Terra"],
        variants: ["Classic Salted", "Sour Cream & Onion", "BBQ", "Cheddar & Sour Cream", "Sea Salt & Vinegar", "Spicy Chili", "Nori Seaweed", "Honey Butter", "Truffle", "Jalapeño", "Smoky Bacon", "Sweet Chili", "Grilled Squid", "Salted Egg", "Wasabi", "Paprika", "Garlic Butter", "Pizza"],
        sizes: ["50g Bag", "110g Canister", "160g Share Bag"],
      },
      {
        name: "Tortilla, Corn & Puffs",
        skuCount: 170,
        brands: ["Doritos", "Cheetos", "Tostitos", "Takis", "Bugles", "Fritos", "Oishi Prawn", "Turtle Chips", "Popcorners", "Smartfood"],
        variants: ["Nacho Cheese", "Cool Ranch", "Flamin' Hot", "Fuego Chili Lime", "Crunchy Cheese", "Sweet Chili Heat", "Taco", "Churro", "Corn Soup", "Spicy Prawn", "White Cheddar", "Kettle Corn", "Sea Salt", "BBQ Corn", "Salsa Verde", "Jalapeño Cheddar", "Loaded Nacho"],
        sizes: ["65g Bag", "140g Bag", "190g Party Bag"],
      },
      {
        name: "Nuts, Seaweed & Crackers",
        skuCount: 170,
        brands: ["Planters", "Blue Diamond", "Tao Kae Noi", "Koh-Kae", "Ritz", "Cheez-It", "Snyder's", "Wonderful", "Tong Garden", "Wheat Thins"],
        variants: ["Roasted Salted Peanuts", "Honey Roasted", "Smokehouse Almonds", "Wasabi Soy", "Salted Cashews", "Pistachios", "Crispy Seaweed Original", "Spicy Seaweed", "Tempura Seaweed", "Cheese Crackers", "Pretzel Pieces", "Honey Mustard", "Garlic Bread", "BBQ Peanuts", "Coconut Cream Peanuts", "Mixed Nuts", "Sunflower Seeds"],
        sizes: ["40g Pack", "100g Pouch", "200g Can"],
      },
    ],
  },
  {
    code: "NDLS",
    name: "Instant Noodles & Quick Meals",
    targetMarginBp: 2900,
    taxCode: "ZERO",
    requiresAgeCheck: false,
    aislePrefix: "B2",
    unitLabel: "pack",
    caseQty: 30,
    multiPackQty: 5,
    multiPackLabel: "5-Pack Bundle",
    supplierIndex: 4,
    baseCostRange: [32, 135],
    categories: [
      {
        name: "Stir-Fry & Dry Instant Noodles",
        skuCount: 160,
        brands: ["Indomie", "Samyang", "Mamee", "Mie Sedaap", "Nissin UFO", "Paldo", "Maggi", "MyKuali", "Ottogi", "Mama"],
        variants: ["Mi Goreng Original", "Hot & Spicy", "Buldak 2x Spicy", "Buldak Carbonara", "Buldak Cheese", "Rendang", "Satay", "BBQ Chicken", "Jjajangmen", "Yakisoba", "Salted Egg", "Garlic Oil", "Korean Spicy", "Teriyaki", "Black Pepper", "Curry Goreng"],
        sizes: ["85g Pack", "130g Pack", "140g Pack"],
      },
      {
        name: "Soup Packet Noodles",
        skuCount: 160,
        brands: ["Nongshim", "Nissin", "Sapporo Ichiban", "Mama", "Maruchan", "Ottogi", "Jin Ramen", "Kang Shi Fu", "Wai Wai", "Koka"],
        variants: ["Shin Ramyun Spicy", "Shin Black", "Tom Yum Shrimp", "Creamy Tom Yum", "Tonkotsu Pork", "Miso Ramen", "Shoyu Ramen", "Braised Beef", "Chicken Curry", "Kimchi", "Seafood", "Laksa", "Pho Bo", "Spicy Mushroom", "Mild Soup", "Sesame Oil"],
        sizes: ["75g Pack", "100g Pack", "120g Pack"],
      },
      {
        name: "Cup Noodles & Rice Bowls",
        skuCount: 160,
        brands: ["Nissin Cup Noodles", "Nongshim Bowl", "Samyang Cup", "Mama Cup", "Maruchan Instant Lunch", "Knorr Cup", "Bibigo", "Haidilao", "Ottogi Cup", "Acecook"],
        variants: ["Seafood Cup", "Chili Crab Cup", "Spicy Beef Bowl", "Chicken Corn Cup", "Curry Cup", "Tom Yum Cup", "Carbonara Big Bowl", "Pork Congee Cup", "Chicken Porridge", "Kimchi Stew Bowl", "Udon Bowl", "Mala Hotpot Cup", "Tteokbokki Cup", "Cheese Ramen Cup", "Black Garlic Tonkotsu", "Vegetarian Cup"],
        sizes: ["65g Cup", "86g Big Cup", "115g Bowl"],
      },
    ],
  },
  {
    code: "SWET",
    name: "Biscuits, Candy & Coffee",
    targetMarginBp: 3300,
    taxCode: "STD",
    requiresAgeCheck: false,
    aislePrefix: "C1",
    unitLabel: "pack",
    caseQty: 12,
    multiPackQty: null,
    multiPackLabel: null,
    supplierIndex: 5,
    baseCostRange: [55, 210],
    categories: [
      {
        name: "Cookies, Wafers & Biscuits",
        skuCount: 170,
        brands: ["Oreo", "Pocky", "Loacker", "Lotte", "Chips Ahoy!", "Tim Tam", "Biscoff", "Julie's", "Meiji", "McVitie's"],
        variants: ["Original", "Double Stuf", "Strawberry", "Matcha Green Tea", "Chocolate Cream", "Peanut Butter", "Hazelnut Wafer", "Vanilla Wafer", "Dark Chocolate", "Caramelized", "Butter Shortbread", "Digestive", "Hello Panda Choco", "Koala's March", "Choco Pie", "Almond Crush", "Cookies & Cream"],
        sizes: ["47g Box", "133g Sleeve", "250g Family Pack"],
      },
      {
        name: "Chocolate & Confectionery",
        skuCount: 160,
        brands: ["KitKat", "Snickers", "M&M's", "Ferrero", "Lindt", "Haribo", "Skittles", "Mentos", "Cadbury", "Toblerone"],
        variants: ["Milk Chocolate", "Dark 70%", "Peanut", "Crispy", "Matcha", "Goldbears Gummy", "Sour Worms", "Original Fruit", "Mint Roll", "Fruit Roll", "Hazelnut", "Caramel", "Almond", "White Chocolate", "Salted Caramel", "Berry Mix"],
        sizes: ["45g Bar", "100g Tablet", "180g Share Bag"],
      },
      {
        name: "RTD Coffee & Instant Mixes",
        skuCount: 160,
        brands: ["Nescafé", "Boss Coffee", "Starbucks RTD", "UCC", "OldTown", "G7", "Maxim", "illy", "Kopiko", "Owl"],
        variants: ["Black Unsweetened", "Latte", "Espresso Roast", "Caramel Macchiato", "Mocha", "3-in-1 Original", "White Coffee Classic", "Hazelnut 3-in-1", "Cappuccino", "Cold Brew", "Matcha Latte", "Teh Tarik", "Vanilla Iced", "Double Shot", "Decaf", "Gold Blend"],
        sizes: ["240ml Can", "280ml Bottle", "15-Sachet Pack"],
      },
    ],
  },
  {
    code: "PNTY",
    name: "Pantry & Household Packs",
    targetMarginBp: 2500,
    taxCode: "STD",
    requiresAgeCheck: false,
    aislePrefix: "D1",
    unitLabel: "unit",
    caseQty: 12,
    multiPackQty: null,
    multiPackLabel: null,
    supplierIndex: 6,
    baseCostRange: [80, 340],
    categories: [
      {
        name: "Canned Food & Condiments",
        skuCount: 200,
        brands: ["Ayam Brand", "Spam", "Heinz", "Kikkoman", "Lee Kum Kee", "Campbell's", "Sriracha", "Kewpie", "Barilla", "San Remo"],
        variants: ["Tuna in Oil", "Tuna in Water", "Chili Tuna", "Sardines Tomato", "Classic Luncheon Meat", "Less Sodium", "Tomato Ketchup", "Soy Sauce", "Oyster Sauce", "Sesame Oil", "Mayonnaise", "Chili Garlic", "Mushroom Soup", "Baked Beans", "Sweet Corn", "Pasta Sauce Basil", "Bolognese", "Spaghetti No.5", "Penne", "Coconut Milk"],
        sizes: ["150g Can", "340g Can", "500ml Bottle"],
      },
      {
        name: "Household & Paper Essentials",
        skuCount: 200,
        brands: ["Tide", "Downy", "Sunlight", "Dettol", "Kleenex", "Scott", "Colgate", "Dove", "Head & Shoulders", "Ziploc"],
        variants: ["Original", "Lavender", "Lemon Fresh", "Antibacterial", "3-Ply Soft", "Kitchen Towels", "Triple Action", "Sensitive", "Deep Moisture", "Cool Menthol", "Freezer Bags", "Trash Bags", "Dish Tabs", "Glass Cleaner", "Floor Cleaner", "Hand Wash", "Wet Wipes", "Fabric Softener", "Bleach Gel", "Air Freshener"],
        sizes: ["500ml Bottle", "1L Refill", "6-Roll Pack"],
      },
    ],
  },
];

const SUPPLIER_SEEDS = [
  { code: "SUP-BREW", name: "Summit Brewing & Beer Supply", email: "orders@summitbrew.local", lead: 2 },
  { code: "SUP-BEV", name: "Pacific Beverage Distributors", email: "dispatch@pacificbev.local", lead: 2 },
  { code: "SUP-ENG", name: "Apex Energy & Hydration Co.", email: "sales@apexenergy.local", lead: 3 },
  { code: "SUP-SNK", name: "Metro Snack & Savory Trading", email: "orders@metrosnack.local", lead: 3 },
  { code: "SUP-NDL", name: "Golden Dragon Noodle & Asian Goods", email: "po@goldendragon.local", lead: 4 },
  { code: "SUP-CNF", name: "Continental Confectionery & Coffee", email: "supply@conticoffee.local", lead: 4 },
  { code: "SUP-HSH", name: "Allied Pantry & Home Wholesale", email: "wholesale@alliedpantry.local", lead: 5 },
];

async function seed() {
  console.log("Checking existing catalog...");
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(products);

  if (count >= 3000) {
    console.log(`Database already seeded with ${count} products. Ensuring shift telemetry, constraints & M1-M3 data...`);
    // Self-heal any users seeded before await hashPin() fix (corrupted "{}" pin_hash)
    const repairPins: Record<string, string> = {
      cashier4: "4567",
      cashier5: "5678",
    };
    const existingUsers = await db.select().from(users);
    for (const u of existingUsers) {
      if (repairPins[u.username] && !u.pinHash.includes(":")) {
        await db
          .update(users)
          .set({ pinHash: await hashPin(repairPins[u.username]) })
          .where(eq(users.id, u.id));
      }
    }
    const rng = createRng(20261126);
    await seedShiftTelemetryAndDaypart(rng);
    await seedRetailExpansionData(rng);
    await seedFreshDepartmentsAndBom();
    await applyDatabaseConstraintsAndViews();
    await pool.end();
    return;
  }

  console.log("Clearing partial seed tables...");
  await db.execute(sql`
    TRUNCATE TABLE
      store_tasks,
      shift_rosters,
      targeted_coupons,
      loyalty_ledger,
      analytics_supplier_scorecards,
      grn_variances,
      analytics_dynamic_markdowns,
      analytics_phantom_stock,
      shelf_tag_queue,
      shift_experiments,
      analytics_shift_diagnostics,
      hourly_stock_snapshots,
      store_footfall,
      product_embeddings,
      ai_briefings,
      ai_proposed_actions,
      ai_messages,
      ai_conversations,
      analytics_lp_anomalies,
      analytics_basket_rules,
      analytics_demand_forecasts,
      analytics_abc_xyz,
      audit_logs,
      sale_payments,
      sale_lines,
      sales,
      customers,
      pos_shifts,
      promotions,
      user_sessions,
      users,
      margin_alerts,
      grn_lines,
      goods_receipts,
      purchase_order_lines,
      purchase_orders,
      supplier_products,
      suppliers,
      stock_movements,
      inventory_batches,
      stock_baselines,
      product_barcodes,
      products,
      tax_rates,
      categories,
      departments
    CASCADE;
  `);

  const rng = createRng(20261125);
  const startTime = Date.now();

  // 1. Tax Rates
  const insertedTaxes = await db
    .insert(taxRates)
    .values([
      { code: "ZERO", name: "0% Staple Food / Water", rateBp: 0, isInclusive: true },
      { code: "STD", name: "10% Standard Retail VAT", rateBp: 1000, isInclusive: true },
      { code: "ALC", name: "15% Alcohol & Excise Tax", rateBp: 1500, isInclusive: true },
    ])
    .returning();
  const taxMap = new Map(insertedTaxes.map((t) => [t.code, t]));

  // 2. Users (salted scrypt PIN hashes)
  await db.insert(users).values([
    { username: "owner", fullName: "Alex Rivera (Owner)", role: "owner", pinHash: await hashPin("1111") },
    { username: "manager", fullName: "Priya Patel (Manager)", role: "manager", pinHash: await hashPin("9999") },
    { username: "accountant", fullName: "David Okafor (Accountant)", role: "accountant", pinHash: await hashPin("4444") },
    { username: "clerk1", fullName: "Marcus Chen (Stock Clerk)", role: "stock_clerk", pinHash: await hashPin("2222") },
    { username: "cashier1", fullName: "Elena Morales", role: "cashier", pinHash: await hashPin("1234") },
    { username: "cashier2", fullName: "Liam O'Connor", role: "cashier", pinHash: await hashPin("2345") },
    { username: "cashier3", fullName: "Mei Lin", role: "cashier", pinHash: await hashPin("3456") },
    { username: "cashier4", fullName: "Jordan Brooks", role: "cashier", pinHash: await hashPin("4567") },
    { username: "cashier5", fullName: "Samira Haddad", role: "cashier", pinHash: await hashPin("5678") },
  ]);

  // 3. Suppliers
  const insertedSuppliers = await db
    .insert(suppliers)
    .values(
      SUPPLIER_SEEDS.map((s) => ({
        code: s.code,
        name: s.name,
        contactEmail: s.email,
        phone: `+1-555-${String(Math.floor(1000 + rng() * 8999))}`,
        defaultLeadTimeDays: s.lead,
        paymentTermsDays: 14,
      }))
    )
    .returning();

  // 4. Departments, Categories, Products, Multi-UOM Barcodes, Stock Baselines, Batches, Supplier Links
  const allProducts: (typeof products.$inferInsert & {
    id: string;
    avgCostCents: number;
    _deptCode: string;
    _singlePriceCents: number;
    _singleBarcode: string;
    _multiBarcode?: { barcode: string; qty: number; label: string; price: number };
    _caseBarcode?: { barcode: string; qty: number; label: string; price: number };
    _velocityTier: "A" | "B" | "C";
    _caseQty: number;
    _taxRateBp: number;
  })[] = [];

  const allBarcodes: (typeof productBarcodes.$inferInsert)[] = [];
  const allBaselines: (typeof stockBaselines.$inferInsert)[] = [];
  const allBatches: (typeof inventoryBatches.$inferInsert)[] = [];
  const allSupplierLinks: (typeof supplierProducts.$inferInsert)[] = [];

  const categoryIdByName = new Map<string, string>();
  let skuSeq = 1;
  let barcodeSeq = 1000001;

  for (const deptTpl of DEPT_TEMPLATES) {
    const [dept] = await db
      .insert(departments)
      .values({
        code: deptTpl.code,
        name: deptTpl.name,
        targetMarginBp: deptTpl.targetMarginBp,
      })
      .returning();

    const tax = taxMap.get(deptTpl.taxCode)!;
    const supplier = insertedSuppliers[deptTpl.supplierIndex];

    for (const catTpl of deptTpl.categories) {
      const [cat] = await db
        .insert(categories)
        .values({
          departmentId: dept.id,
          name: catTpl.name,
        })
        .returning();
      categoryIdByName.set(catTpl.name, cat.id);

      const usedNames = new Set<string>();
      for (let i = 0; i < catTpl.skuCount; i++) {
        const brand = catTpl.brands[i % catTpl.brands.length];
        const variant = catTpl.variants[Math.floor(i / catTpl.brands.length) % catTpl.variants.length];
        const size = catTpl.sizes[Math.floor(i / (catTpl.brands.length * catTpl.variants.length)) % catTpl.sizes.length];
        let fullName = `${brand} ${variant} ${size}`;
        let edition = 2;
        while (usedNames.has(fullName)) {
          fullName = `${brand} ${variant} Edition ${edition} ${size}`;
          edition++;
        }
        usedNames.add(fullName);

        const productId = generateUuidV7();
        const sku = `${deptTpl.code}-${String(skuSeq++).padStart(4, "0")}`;
        const [minC, maxC] = deptTpl.baseCostRange;
        const avgCostCents = Math.round(minC + rng() * (maxC - minC));
        // Retail price targets department NET margin +/- 4% on top of tax
        const targetNetBp = Math.round(
          Math.min(6500, Math.max(1400, deptTpl.targetMarginBp + (rng() * 800 - 400)))
        );
        const singlePriceCents = computeSuggestedSellPriceCents(
          avgCostCents,
          targetNetBp,
          tax.rateBp,
          tax.isInclusive,
          5
        );

        // Assign realistic Pareto velocity tier (top ~15% A, next ~25% B, ~60% C)
        const rVel = rng();
        const velocityTier: "A" | "B" | "C" =
          i < 3 || rVel < 0.14 ? "A" : rVel < 0.38 ? "B" : "C";

        const singleBarcode = buildValidEan13("885", barcodeSeq++);
        const aisleNum = (i % 6) + 1;

        allProducts.push({
          id: productId,
          sku,
          name: fullName,
          brand,
          sizeLabel: size,
          categoryId: cat.id,
          taxRateId: tax.id,
          baseUnitLabel: deptTpl.unitLabel,
          avgCostCents,
          minMarginBp: Math.max(1200, deptTpl.targetMarginBp - 800),
          requiresAgeCheck: deptTpl.requiresAgeCheck,
          trackExpiry: true,
          expiryAlertDays: deptTpl.code === "BEER" || deptTpl.code === "SNCK" ? 45 : 30,
          aisleLocation: `${deptTpl.aislePrefix}-S${aisleNum}`,
          active: true,
          _deptCode: deptTpl.code,
          _singlePriceCents: singlePriceCents,
          _singleBarcode: singleBarcode,
          _velocityTier: velocityTier,
          _caseQty: deptTpl.caseQty,
          _taxRateBp: tax.rateBp,
        });

        // Primary single barcode
        allBarcodes.push({
          productId,
          barcode: singleBarcode,
          packQty: 1,
          packLabel: `Single ${deptTpl.unitLabel}`,
          sellPriceCents: singlePriceCents,
          isPrimary: true,
          isOrderableCase: false,
        });

        // Multi-Pack barcode (e.g., 6-Pack Beer/Soda, 5-Pack Instant Noodles, 4-Pack Energy)
        if (deptTpl.multiPackQty && deptTpl.multiPackLabel) {
          const mpBarcode = buildValidEan13("886", barcodeSeq++);
          const mpPrice = Math.round((singlePriceCents * deptTpl.multiPackQty * 0.92) / 5) * 5;
          allBarcodes.push({
            productId,
            barcode: mpBarcode,
            packQty: deptTpl.multiPackQty,
            packLabel: deptTpl.multiPackLabel,
            sellPriceCents: mpPrice,
            isPrimary: false,
            isOrderableCase: false,
          });
          allProducts[allProducts.length - 1]._multiBarcode = {
            barcode: mpBarcode,
            qty: deptTpl.multiPackQty,
            label: deptTpl.multiPackLabel,
            price: mpPrice,
          };
        }

        // Full Case / Carton barcode
        const caseBarcode = buildValidEan13("889", barcodeSeq++);
        const caseSellPrice = Math.round((singlePriceCents * deptTpl.caseQty * 0.85) / 10) * 10;
        allBarcodes.push({
          productId,
          barcode: caseBarcode,
          packQty: deptTpl.caseQty,
          packLabel: `Case (${deptTpl.caseQty})`,
          sellPriceCents: caseSellPrice,
          isPrimary: false,
          isOrderableCase: true,
        });
        allProducts[allProducts.length - 1]._caseBarcode = {
          barcode: caseBarcode,
          qty: deptTpl.caseQty,
          label: `Case (${deptTpl.caseQty})`,
          price: caseSellPrice,
        };

        // Supplier Link
        allSupplierLinks.push({
          supplierId: supplier.id,
          productId,
          supplierSku: `${supplier.code}-${sku}`,
          caseQty: deptTpl.caseQty,
          caseCostCents: avgCostCents * deptTpl.caseQty,
          moqCases: velocityTier === "A" ? 2 : 1,
          leadTimeDays: supplier.defaultLeadTimeDays,
          isPrimary: true,
        });

        // Initial realistic stock level (with some intentional low-stock & overstock for forecasting/dead-stock detection!)
        const stockCases =
          velocityTier === "A"
            ? rng() < 0.12
              ? 0.4 // intentional reorder urgency!
              : 2 + Math.floor(rng() * 6)
            : velocityTier === "B"
              ? 1 + Math.floor(rng() * 4)
              : Math.floor(rng() * 3) + 1;
        const onHandUnits = Math.max(2, Math.round(stockCases * deptTpl.caseQty));

        allBaselines.push({
          productId,
          quantity: onHandUnits,
        });

        // FEFO Best-Before Batch (create realistic upcoming expiries for ~2% of SKUs)
        const daysToExpiry =
          rng() < 0.014
            ? Math.floor(4 + rng() * 26) // Urgent 4-30 days!
            : rng() < 0.04
              ? Math.floor(31 + rng() * 30) // Watch 31-60 days
              : Math.floor(90 + rng() * 270); // Healthy 3-12 months
        const expiryDate = new Date(Date.now() + daysToExpiry * 86400_000)
          .toISOString()
          .slice(0, 10);

        allBatches.push({
          productId,
          lotCode: `LOT-${expiryDate.replace(/-/g, "").slice(2)}-${String(skuSeq % 99).padStart(2, "0")}`,
          bestBeforeDate: expiryDate,
          unitCostCents: avgCostCents,
          qtyReceived: onHandUnits,
          qtyRemaining: onHandUnits,
          status: daysToExpiry <= 14 ? "clearance" : "active",
        });
      }
    }
  }

  console.log(`Inserting ${allProducts.length} products and ${allBarcodes.length} multi-UOM barcodes...`);
  await chunkInsert(allProducts, 400, (chunk) =>
    db.insert(products).values(
      chunk.map(
        ({
          _deptCode,
          _singlePriceCents,
          _singleBarcode,
          _multiBarcode,
          _caseBarcode,
          _velocityTier,
          _caseQty,
          _taxRateBp,
          ...row
        }) => row
      )
    )
  );
  await chunkInsert(allBarcodes, 600, (c) => db.insert(productBarcodes).values(c));
  await chunkInsert(allSupplierLinks, 500, (c) => db.insert(supplierProducts).values(c));
  await chunkInsert(allBaselines, 500, (c) => db.insert(stockBaselines).values(c));
  await chunkInsert(allBatches, 500, (c) => db.insert(inventoryBatches).values(c));

  // 5. Active Supermarket Promotions
  const now = new Date();
  const in90Days = new Date(now.getTime() + 90 * 86400_000);
  const noodleCatIds = [
    categoryIdByName.get("Stir-Fry & Dry Instant Noodles")!,
    categoryIdByName.get("Soup Packet Noodles")!,
  ];
  const chipsCatId = categoryIdByName.get("Potato Chips")!;
  const beerCatId = categoryIdByName.get("International Lager")!;

  await db.insert(promotions).values([
    {
      name: "Any 5 Instant Noodles for $3.95",
      promoType: "mix_and_match",
      priority: 5,
      combinable: false,
      minMarginGuardBp: 800,
      startsAt: new Date(now.getTime() - 30 * 86400_000),
      endsAt: in90Days,
      active: true,
      rulesJson: {
        categoryIds: noodleCatIds,
        requiredQty: 5,
        bundlePriceCents: 395,
      },
    },
    {
      name: "Potato Chips Buy 2 Get 1 Free",
      promoType: "bogo",
      priority: 10,
      combinable: false,
      minMarginGuardBp: 500,
      startsAt: new Date(now.getTime() - 15 * 86400_000),
      endsAt: in90Days,
      active: true,
      rulesJson: {
        categoryIds: [chipsCatId],
        buyQty: 2,
        getQty: 1,
        discountBp: 10000,
      },
    },
    {
      name: "Lager Case Tier: 8% Off 12+ Cans",
      promoType: "tier_price",
      priority: 12,
      combinable: false,
      minMarginGuardBp: 1000,
      startsAt: new Date(now.getTime() - 15 * 86400_000),
      endsAt: in90Days,
      active: true,
      rulesJson: {
        categoryIds: [beerCatId],
        requiredQty: 12,
        discountBp: 800,
      },
    },
    {
      name: "Weekend Basket: $5 Off Orders Over $50",
      promoType: "basket_threshold",
      priority: 50,
      combinable: true,
      minMarginGuardBp: 1000,
      startsAt: new Date(now.getTime() - 15 * 86400_000),
      endsAt: in90Days,
      active: true,
      rulesJson: {
        minBasketCents: 5000,
        flatDiscountCents: 500,
      },
    },
  ]);

  // 6. Seed Realistic Margin Erosion Alerts (simulate recent vendor invoice cost hikes!)
  const sampleAlertSkus = allProducts.filter((p) => p._velocityTier === "A").slice(0, 6);
  const [sampleGrn] = await db
    .insert(goodsReceipts)
    .values({
      supplierId: insertedSuppliers[0].id,
      invoiceNumber: "INV-2026-88412",
      receivedBy: "Priya Patel (Manager)",
      totalInvoiceCents: 184200,
      notes: "Weekly beverage & snack restock — detected wholesale price increases on 6 SKUs",
    })
    .returning();

  const alertRows: (typeof marginAlerts.$inferInsert)[] = [];
  const grnLineRows: (typeof grnLines.$inferInsert)[] = [];
  for (const prod of sampleAlertSkus) {
    const newCost = Math.round(prod.avgCostCents * 1.18);
    const minMargin = prod.minMarginBp ?? 1800;
    const resultingMargin = computeNetMarginBp(
      prod._singlePriceCents,
      newCost,
      prod._taxRateBp,
      true
    );
    const suggestedSell = computeSuggestedSellPriceCents(
      newCost,
      minMargin,
      prod._taxRateBp,
      true,
      5
    );
    alertRows.push({
      productId: prod.id,
      grnId: sampleGrn.id,
      previousCostCents: prod.avgCostCents,
      newCostCents: newCost,
      currentSellPriceCents: prod._singlePriceCents,
      resultingMarginBp: resultingMargin,
      minMarginBp: minMargin,
      suggestedSellPriceCents: suggestedSell,
      resolved: false,
    });
    grnLineRows.push({
      grnId: sampleGrn.id,
      productId: prod.id,
      caseQty: prod._caseQty,
      paidCases: 4,
      freeBonusCases: 0,
      baseUnitsReceived: 4 * prod._caseQty,
      invoiceLineTotalCents: 4 * prod._caseQty * newCost,
      effectiveUnitCostCents: newCost,
      bestBeforeDate: new Date(Date.now() + 180 * 86400_000).toISOString().slice(0, 10),
    });
  }
  await db.insert(grnLines).values(grnLineRows);
  await db.insert(marginAlerts).values(alertRows);

  // 7. Seed 60 Days of Realistic POS Receipts (Pareto demand, Fri/Sat surge, co-purchase pairs, LP anomalies)
  console.log("Generating 60 days of realistic packaged-goods POS receipts...");
  const aProducts = allProducts.filter((p) => p._velocityTier === "A");
  const bProducts = allProducts.filter((p) => p._velocityTier === "B");
  const cProducts = allProducts.filter((p) => p._velocityTier === "C");

  // Named anchor items for strong, discoverable Market Basket Association Rules
  const topBeer = aProducts.filter((p) => p._deptCode === "BEER").slice(0, 6);
  const topChips = aProducts.filter((p) => p._deptCode === "SNCK").slice(0, 6);
  const topNoodles = aProducts.filter((p) => p._deptCode === "NDLS").slice(0, 6);
  const topSoda = aProducts.filter((p) => p._deptCode === "SODA").slice(0, 6);
  const topEnergy = aProducts.filter((p) => p._deptCode === "ENRG").slice(0, 4);
  const topSweets = aProducts.filter((p) => p._deptCode === "SWET").slice(0, 6);
  const topPantry = aProducts.filter((p) => p._deptCode === "PNTY").slice(0, 4);

  const cashiers = [
    { name: "Elena Morales", voidProb: 0.011, noSaleRate: 2 },
    { name: "Liam O'Connor", voidProb: 0.014, noSaleRate: 3 },
    { name: "Mei Lin", voidProb: 0.009, noSaleRate: 1 },
    { name: "Jordan Brooks", voidProb: 0.068, noSaleRate: 19 }, // Intentional LP anomaly (>2 sigma)
    { name: "Samira Haddad", voidProb: 0.012, noSaleRate: 2 },
  ];

  const saleRows: (typeof sales.$inferInsert)[] = [];
  const saleLineRows: (typeof saleLines.$inferInsert)[] = [];
  const salePaymentRows: (typeof salePayments.$inferInsert)[] = [];
  const auditRows: (typeof auditLogs.$inferInsert)[] = [];
  const shiftRows: (typeof posShifts.$inferInsert)[] = [];

  let receiptCounter = 100001;
  const pickWeightedProduct = () => {
    const u = rng();
    if (u < 0.64) return aProducts[Math.floor(rng() * aProducts.length)];
    if (u < 0.89) return bProducts[Math.floor(rng() * bProducts.length)];
    return cProducts[Math.floor(rng() * cProducts.length)];
  };

  for (let dayOffset = 59; dayOffset >= 0; dayOffset--) {
    const dayDate = new Date(now.getTime() - dayOffset * 86400_000);
    const dow = dayDate.getDay(); // 0=Sun, 5=Fri, 6=Sat
    const isWeekend = dow === 5 || dow === 6;
    const txCount = Math.round((isWeekend ? 260 : 185) * (0.9 + rng() * 0.2));

    // Create 1 shift per day per register
    const shiftId = generateUuidV7();
    const shiftCashier = cashiers[dayOffset % cashiers.length];
    shiftRows.push({
      id: shiftId,
      registerCode: dayOffset % 2 === 0 ? "REG-01" : "REG-02",
      cashierName: shiftCashier.name,
      openedAt: new Date(dayDate.setHours(8, 0, 0, 0)),
      closedAt: dayOffset === 0 ? null : new Date(dayDate.setHours(21, 30, 0, 0)),
      openingFloatCents: 30000,
      cashDropsCents: 80000,
      blindCountedCashCents: dayOffset === 0 ? null : 42500 + Math.round((rng() - 0.5) * 600),
      expectedCashCents: dayOffset === 0 ? null : 42500,
      varianceCents: dayOffset === 0 ? null : Math.round((rng() - 0.5) * 600),
      zReportNo: dayOffset === 0 ? null : `Z-${String(60 - dayOffset).padStart(4, "0")}`,
    });

    for (let t = 0; t < txCount; t++) {
      const saleId = generateUuidV7();
      const cashier = cashiers[Math.floor(rng() * cashiers.length)];
      const regCode = rng() < 0.6 ? "REG-01" : "REG-02";

      // Peak hours: 12-13 lunch & 17-20 after-work beverage/snack rush
      const hourBucket = rng();
      const hour =
        hourBucket < 0.14
          ? 8 + Math.floor(rng() * 3)
          : hourBucket < 0.42
            ? 11 + Math.floor(rng() * 3)
            : hourBucket < 0.85
              ? 16 + Math.floor(rng() * 4)
              : 20 + Math.floor(rng() * 2);
      const soldAt = new Date(
        dayDate.getFullYear(),
        dayDate.getMonth(),
        dayDate.getDate(),
        hour,
        Math.floor(rng() * 60),
        Math.floor(rng() * 60)
      );

      // Build basket with realistic co-purchase affinities
      const chosen = new Map<string, (typeof allProducts)[number]>();
      const pattern = rng();
      if (pattern < 0.24 && topBeer.length && topChips.length) {
        // Beer + Chips/Nuts party basket
        const b = topBeer[Math.floor(rng() * topBeer.length)];
        const c = topChips[Math.floor(rng() * topChips.length)];
        chosen.set(b.id, b);
        chosen.set(c.id, c);
        if (rng() < 0.45 && topSoda.length) {
          const s = topSoda[Math.floor(rng() * topSoda.length)];
          chosen.set(s.id, s);
        }
      } else if (pattern < 0.45 && topNoodles.length && topSoda.length) {
        // Instant Noodles + Soda (+ Canned Tuna)
        const n = topNoodles[Math.floor(rng() * topNoodles.length)];
        const s = topSoda[Math.floor(rng() * topSoda.length)];
        chosen.set(n.id, n);
        chosen.set(s.id, s);
        if (rng() < 0.35 && topPantry.length) {
          const p = topPantry[Math.floor(rng() * topPantry.length)];
          chosen.set(p.id, p);
        }
      } else if (pattern < 0.58 && topEnergy.length && topSweets.length) {
        // Energy Drink + Chocolate/Candy
        const e = topEnergy[Math.floor(rng() * topEnergy.length)];
        const sw = topSweets[Math.floor(rng() * topSweets.length)];
        chosen.set(e.id, e);
        chosen.set(sw.id, sw);
      }

      const targetItems = 1 + Math.floor(rng() * 5);
      while (chosen.size < targetItems) {
        const p = pickWeightedProduct();
        chosen.set(p.id, p);
      }

      const isVoid = rng() < cashier.voidProb;
      const isRefund = !isVoid && rng() < 0.006;
      const kind = isVoid ? "void" : isRefund ? "refund" : "sale";

      let subtotal = 0;
      let discountTotal = 0;
      let taxTotal = 0;
      let costTotal = 0;
      let hasAgeCheck = false;

      for (const prod of chosen.values()) {
        // Occasionally scan 6-pack/5-pack or full case!
        const scanRoll = rng();
        let barcode = prod._singleBarcode;
        let packQty = 1;
        let packLabel = `Single ${prod.baseUnitLabel}`;
        let unitPrice = prod._singlePriceCents;
        let qtyPacks = 1 + (rng() < 0.35 ? Math.floor(rng() * 3) : 0);

        if (prod._multiBarcode && scanRoll > 0.72 && scanRoll <= 0.96) {
          barcode = prod._multiBarcode.barcode;
          packQty = prod._multiBarcode.qty;
          packLabel = prod._multiBarcode.label;
          unitPrice = prod._multiBarcode.price;
          qtyPacks = 1;
        } else if (prod._caseBarcode && scanRoll > 0.96) {
          barcode = prod._caseBarcode.barcode;
          packQty = prod._caseBarcode.qty;
          packLabel = prod._caseBarcode.label;
          unitPrice = prod._caseBarcode.price;
          qtyPacks = 1;
        }

        const lineGross = unitPrice * qtyPacks;
        const lineDisc = rng() < 0.1 ? Math.round(lineGross * 0.08) : 0;
        const netAfterDisc = lineGross - lineDisc;
        const lineTax =
          prod._taxRateBp > 0
            ? netAfterDisc - Math.round((netAfterDisc * 10000) / (10000 + prod._taxRateBp))
            : 0;
        const baseUnitsSold = packQty * qtyPacks;
        const lineCost = prod.avgCostCents * baseUnitsSold;

        subtotal += lineGross;
        discountTotal += lineDisc;
        taxTotal += lineTax;
        costTotal += lineCost;
        if (prod.requiresAgeCheck) hasAgeCheck = true;

        saleLineRows.push({
          id: generateUuidV7(),
          saleId,
          productId: prod.id,
          scannedBarcode: barcode,
          packLabel,
          packQty,
          qtyPacks,
          baseUnitsSold,
          unitPriceCents: unitPrice,
          unitCostCents: prod.avgCostCents,
          discountCents: lineDisc,
          taxRateBp: prod._taxRateBp,
          taxCents: lineTax,
          lineTotalCents: netAfterDisc,
        });
      }

      const grandTotal = subtotal - discountTotal;
      saleRows.push({
        id: saleId,
        registerCode: regCode,
        shiftId,
        receiptNo: `${regCode}-${String(receiptCounter++)}`,
        kind,
        cashierName: cashier.name,
        subtotalCents: subtotal,
        discountCents: discountTotal,
        taxCents: taxTotal,
        totalCents: grandTotal,
        totalCostCents: costTotal,
        ageVerified: hasAgeCheck,
        soldAt,
      });

      const method = rng() < 0.56 ? "card" : rng() < 0.88 ? "cash" : "mobile_pay";
      salePaymentRows.push({
        id: generateUuidV7(),
        saleId,
        method,
        amountCents: grandTotal,
        tenderedCents: method === "cash" ? Math.ceil(grandTotal / 500) * 500 : grandTotal,
        changeCents:
          method === "cash" ? Math.ceil(grandTotal / 500) * 500 - grandTotal : 0,
      });
    }
  }

  // Add realistic no-sale drawer open audit events + small shrinkage/spoilage movements
  for (const c of cashiers) {
    for (let k = 0; k < c.noSaleRate * 3; k++) {
      auditRows.push({
        actor: c.name,
        action: "no_sale_drawer",
        entityType: "register",
        entityId: "REG-01",
        detailsJson: { reason: "change_request" },
        createdAt: new Date(now.getTime() - Math.floor(rng() * 55) * 86400_000),
      });
    }
  }

  const shrinkMovements: (typeof stockMovements.$inferInsert)[] = [];
  for (let i = 0; i < 65; i++) {
    const prod = allProducts[Math.floor(rng() * allProducts.length)];
    const qtyLost = 2 + Math.floor(rng() * 14);
    shrinkMovements.push({
      id: generateUuidV7(),
      productId: prod.id,
      qtyDelta: -qtyLost,
      unitCostCents: prod.avgCostCents,
      reason: rng() < 0.55 ? "spoilage" : rng() < 0.85 ? "damage" : "count_adj",
      folded: true,
      createdAt: new Date(now.getTime() - Math.floor(rng() * 58) * 86400_000),
    });
  }

  console.log(
    `Inserting ${saleRows.length} receipts and ${saleLineRows.length} sale line items...`
  );
  await chunkInsert(shiftRows, 100, (c) => db.insert(posShifts).values(c));
  await chunkInsert(saleRows, 500, (c) => db.insert(sales).values(c));
  await chunkInsert(saleLineRows, 1000, (c) => db.insert(saleLines).values(c));
  await chunkInsert(salePaymentRows, 1000, (c) => db.insert(salePayments).values(c));
  await chunkInsert(auditRows, 200, (c) => db.insert(auditLogs).values(c));
  await chunkInsert(shrinkMovements, 200, (c) => db.insert(stockMovements).values(c));

  await seedShiftTelemetryAndDaypart(rng);
  await seedRetailExpansionData(rng);
  await seedFreshDepartmentsAndBom();
  await applyDatabaseConstraintsAndViews();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `Seed completed in ${elapsed}s: ${allProducts.length} SKUs, ${allBarcodes.length} barcodes, ${saleRows.length} receipts.`
  );
  await pool.end();
}

/**
 * Idempotently seeds morning-daypart promotion, hourly_stock_snapshots (08:00 OOS + 11:00 restock),
 * 15-min store_footfall door counter telemetry, and a baseline DiD shift experiment.
 */
async function seedShiftTelemetryAndDaypart(rng: () => number) {
  const now = new Date();
  const in90Days = new Date(now.getTime() + 90 * 86400_000);

  // A. Morning Daypart Promotion (08:00-11:59 Coffee + Biscuit Commuter Combo)
  const existingDaypart = await db
    .select({ id: promotions.id })
    .from(promotions)
    .where(isNotNull(promotions.daypartStartHour))
    .limit(1);

  if (existingDaypart.length === 0) {
    const coffeeCats = await db
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(
        sql`${categories.name} IN ('RTD Coffee & Instant Mixes', 'Cookies, Wafers & Biscuits')`
      );
    const catIds = coffeeCats.map((c) => c.id);
    if (catIds.length > 0) {
      await db.insert(promotions).values({
        name: "Morning Commuter Combo: Coffee + Biscuit $3.49 (08:00-11:59)",
        promoType: "mix_and_match",
        priority: 8,
        combinable: false,
        minMarginGuardBp: 1500,
        daypartStartHour: 8,
        daypartEndHour: 12,
        startsAt: new Date(now.getTime() - 14 * 86400_000),
        endsAt: in90Days,
        active: true,
        rulesJson: {
          categoryIds: catIds,
          requiredQty: 2,
          bundlePriceCents: 349,
        },
      });
      console.log("Seeded morning daypart promotion (08:00-11:59).");
    }
  }

  // B. Hourly Stock Snapshots (60 complete days x top 80 active SKUs x hours 8 & 11)
  const [{ count: snapCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(hourlyStockSnapshots);

  const dayMorningOosRatio = new Map<string, number>();

  if (snapCount === 0) {
    const topSkusRes = await db.execute(sql`
      SELECT
        p.id::text AS product_id,
        d.code AS dept_code,
        COALESCE(SUM(sl.base_units_sold), 0)::int AS units_60d
      FROM products p
      JOIN categories c ON c.id = p.category_id
      JOIN departments d ON d.id = c.department_id
      LEFT JOIN sale_lines sl ON sl.product_id = p.id
      LEFT JOIN sales s ON s.id = sl.sale_id AND s.kind = 'sale' AND s.sold_at >= CURRENT_DATE - interval '60 days'
      WHERE p.active = true
      GROUP BY p.id, d.code
      ORDER BY units_60d DESC
      LIMIT 80
    `);

    const topSkus = topSkusRes.rows.map((r: Record<string, unknown>) => ({
      productId: String(r.product_id),
      deptCode: String(r.dept_code),
    }));

    const morningPriorityDepts = new Set(["SWET", "ENRG", "SNCK", "NDLS", "SODA"]);
    const morningOosPool = topSkus.filter((s) => morningPriorityDepts.has(s.deptCode)).slice(0, 24);
    const oosIds = new Set(morningOosPool.map((s) => s.productId));
    // Backfill to 24 if needed
    for (const s of topSkus) {
      if (oosIds.size >= 24) break;
      oosIds.add(s.productId);
    }

    const snapRows: (typeof hourlyStockSnapshots.$inferInsert)[] = [];
    for (let dayOffset = 60; dayOffset >= 1; dayOffset--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOffset);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate()
      ).padStart(2, "0")}`;
      const prevDow = (d.getDay() + 6) % 7; // yesterday 0=Sun..6=Sat
      const afterRush = prevDow === 5 || prevDow === 6; // post-Fri/Sat evening depletion

      let dayOosCount = 0;
      for (const sku of topSkus) {
        const isTargetOos = oosIds.has(sku.productId);
        const oosProb = isTargetOos ? (afterRush ? 0.46 : 0.30) : 0.05;
        const isOos8 = rng() < oosProb;
        if (isOos8) dayOosCount++;

        snapRows.push({
          id: generateUuidV7(),
          snapshotDate: dateStr,
          snapshotHour: 8,
          productId: sku.productId,
          onHandUnits: isOos8 ? 0 : 12 + Math.floor(rng() * 55),
          isOos: isOos8,
          restockedAtHour: isOos8 ? (rng() < 0.7 ? 11 : 10) : null,
        });
        snapRows.push({
          id: generateUuidV7(),
          snapshotDate: dateStr,
          snapshotHour: 11,
          productId: sku.productId,
          onHandUnits: isOos8 ? 36 + Math.floor(rng() * 60) : 18 + Math.floor(rng() * 60),
          isOos: false,
          restockedAtHour: isOos8 ? 11 : null,
        });
      }
      dayMorningOosRatio.set(dateStr, topSkus.length > 0 ? dayOosCount / topSkus.length : 0);
    }

    await chunkInsert(snapRows, 1000, (c) => db.insert(hourlyStockSnapshots).values(c));
    console.log(`Seeded ${snapRows.length} hourly_stock_snapshots rows.`);
  }

  // C. 15-min Store Footfall Counter Data (aligned with active trading hours)
  const [{ count: footfallCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(storeFootfall);

  if (footfallCount === 0) {
    const bucketRes = await db.execute(sql`
      SELECT
        to_char(sold_at, 'YYYY-MM-DD') AS day_str,
        EXTRACT(HOUR FROM sold_at)::int AS hr,
        (FLOOR(EXTRACT(MINUTE FROM sold_at) / 15)::int * 15) AS qtr_min,
        COUNT(*) FILTER (WHERE kind = 'sale')::int AS sale_receipts
      FROM sales
      WHERE sold_at >= CURRENT_DATE - interval '60 days'
      GROUP BY 1, 2, 3
    `);

    const receiptMap = new Map<string, number>();
    for (const r of bucketRes.rows as Record<string, unknown>[]) {
      const k = `${r.day_str}|${Number(r.hr)}|${Number(r.qtr_min)}`;
      receiptMap.set(k, Number(r.sale_receipts));
    }

    const activeHours = [8, 9, 10, 11, 12, 13, 16, 17, 18, 19, 20, 21];
    const footfallRows: (typeof storeFootfall.$inferInsert)[] = [];

    for (let dayOffset = 60; dayOffset >= 0; dayOffset--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOffset);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate()
      ).padStart(2, "0")}`;
      const dow = d.getDay();
      const isWeekend = dow === 0 || dow === 5 || dow === 6;
      const weatherRain = rng() < 0.18;
      const morningSingleLane = rng() < 0.74; // Most mornings only keep 1 lane open until 11:00
      const oosRatio = dayMorningOosRatio.get(dateStr) ?? 0.12;

      for (const hr of activeHours) {
        const isEarlyMorning = hr < 11;
        const openLanes = isEarlyMorning
          ? morningSingleLane
            ? 1
            : 2
          : hr >= 17 && isWeekend
            ? 3
            : 2;

        for (const qtr of [0, 15, 30, 45]) {
          const receipts = receiptMap.get(`${dateStr}|${hr}|${qtr}`) ?? 0;
          if (dayOffset === 0 && hr > now.getHours()) continue;

          let targetConv = 0.82;
          if (isEarlyMorning) {
            targetConv =
              0.74 -
              0.22 * oosRatio -
              (openLanes === 1 && receipts >= 3 ? 0.14 : 0.0) -
              (weatherRain ? 0.04 : 0.0) +
              (rng() - 0.5) * 0.06;
            targetConv = Math.max(0.42, Math.min(0.86, targetConv));
          } else if (hr === 11) {
            targetConv = 0.78 + (rng() - 0.5) * 0.05;
          } else if (hr < 17) {
            targetConv = 0.81 - (weatherRain ? 0.02 : 0) + (rng() - 0.5) * 0.05;
          } else {
            targetConv = 0.85 + (rng() - 0.5) * 0.05;
          }

          const baseDemand = receipts > 0 ? receipts : isEarlyMorning ? 2 : 1;
          const entries = Math.max(receipts, Math.round(baseDemand / targetConv));
          const exits = Math.max(0, entries + Math.round((rng() - 0.5) * 2));
          const queueSaturated = isEarlyMorning && openLanes === 1 && entries >= 6;
          const avgDwellSec = queueSaturated
            ? Math.round(145 + rng() * 65)
            : Math.round((isEarlyMorning ? 260 : 380) + rng() * 140);

          const bucketStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hr, qtr, 0, 0);
          footfallRows.push({
            id: generateUuidV7(),
            bucketStart,
            entries,
            exits,
            avgDwellSec,
            openLanes,
            weatherRain,
            source: "door_sensor",
          });
        }
      }
    }

    await chunkInsert(footfallRows, 1000, (c) =>
      db.insert(storeFootfall).values(c).onConflictDoNothing({ target: storeFootfall.bucketStart })
    );
    console.log(`Seeded ${footfallRows.length} store_footfall 15-min buckets.`);
  }

  // D. Baseline DiD Shift Experiment
  const [{ count: expCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(shiftExperiments);

  if (expCount === 0) {
    const fmtDate = (daysAgo: number) => {
      const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo);
      return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(
        dt.getDate()
      ).padStart(2, "0")}`;
    };
    await db.insert(shiftExperiments).values({
      name: "Morning Commuter Combo & 07:45 Class-A Restock Pilot",
      hypothesis:
        "Restocking top 24 overnight-depleted Class-A SKUs by 07:45 and activating the 08:00-11:59 Coffee+Biscuit bundle will lift morning conversion without cannibalizing afternoon sales.",
      interventionType: "pre_open_restock",
      targetShift: "morning",
      controlShift: "afternoon",
      preStartDate: fmtDate(43),
      preEndDate: fmtDate(16),
      postStartDate: fmtDate(15),
      postEndDate: fmtDate(2),
      status: "evaluated",
      createdBy: "Priya Patel (Manager)",
    });
    console.log("Seeded baseline shift DiD experiment.");
  }
}

/**
 * Idempotently seeds Milestone 1-3 operational expansion data:
 * - Sample pending shelf_tag_queue items (M1)
 * - Historical POs, GRNs & 3-way dock variances for Supplier OTIF Scorecards (M2)
 * - Loyalty customers, ledger points, sale links & targeted coupons (M3)
 */
async function seedRetailExpansionData(rng: () => number) {
  const now = new Date();

  // 1. Loyalty Customers, Ledger & Targeted Coupons
  const [{ count: custCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(customers);

  if (custCount === 0) {
    const firstNames = [
      "Hannah", "Noah", "Chloe", "Lucas", "Maya", "Ethan", "Zoe", "Owen",
      "Nora", "Leo", "Ruby", "Caleb", "Sienna", "Isaac", "Grace", "Julian",
      "Aria", "Gabriel", "Hazel", "Felix", "Naomi", "Miles", "Clara", "Toby",
    ];
    const lastNames = [
      "Kim", "Patel", "Nguyen", "Santos", "O'Brien", "Tanaka", "Hernandez", "Ali",
      "Kowalski", "Wright", "Bhat", "Park", "Rossi", "Diaz", "Murray", "Lin",
      "Garcia", "Cho", "Turner", "Bennett", "Hayes", "Singh", "Reed", "Foster",
    ];

    const customerRows: (typeof customers.$inferInsert & { id: string })[] = [];
    for (let i = 0; i < 24; i++) {
      const id = generateUuidV7();
      customerRows.push({
        id,
        phone: `0412555${String(101 + i).padStart(3, "0")}`,
        fullName: `${firstNames[i]} ${lastNames[i]}`,
        email: `${firstNames[i].toLowerCase()}.${lastNames[i].toLowerCase().replace(/[^a-z]/g, "")}@example.local`,
        pointsBalance: 120 + Math.floor(rng() * 1400),
        lifetimeSpendCents: 0,
        visits60d: 0,
        rfmSegment: "New",
        lastVisitAt: null,
      });
    }
    await db.insert(customers).values(customerRows);

    // Link ~28% of recent historical receipts to loyalty customers cleanly
    const recentSalesRes = await db.execute(sql`
      SELECT id::text AS id, total_cents::bigint AS total_cents, sold_at
      FROM sales
      WHERE kind = 'sale' AND customer_id IS NULL
      ORDER BY sold_at DESC
      LIMIT 4200
    `);

    const ledgerRows: (typeof loyaltyLedger.$inferInsert)[] = [];
    const spendByCust = new Map<string, { spend: number; visits: number; lastVisit: Date; pts: number }>();

    const updateBatches: { saleId: string; customerId: string }[] = [];
    for (const row of recentSalesRes.rows as Record<string, unknown>[]) {
      if (rng() > 0.30) continue;
      // Bias early indices so we naturally get Champions, Loyal, At-Risk, and Hibernating clusters
      const tierRoll = rng();
      const custIdx =
        tierRoll < 0.35
          ? Math.floor(rng() * 6)
          : tierRoll < 0.7
            ? 6 + Math.floor(rng() * 8)
            : 14 + Math.floor(rng() * 10);
      const cust = customerRows[custIdx];
      const soldAt = new Date(String(row.sold_at));
      const daysAgo = (now.getTime() - soldAt.getTime()) / 86400_000;
      // Leave customers 18..23 mostly untouched in the last 22 days so they appear At-Risk / Hibernating
      if (custIdx >= 18 && daysAgo < 22) continue;

      const totalCents = Number(row.total_cents);
      const ptsEarned = Math.max(1, Math.floor(totalCents / 100));
      updateBatches.push({ saleId: String(row.id), customerId: cust.id });
      ledgerRows.push({
        id: generateUuidV7(),
        customerId: cust.id,
        saleId: String(row.id),
        pointsDelta: ptsEarned,
        reason: "earn",
        createdAt: soldAt,
      });

      const agg = spendByCust.get(cust.id) ?? {
        spend: 0,
        visits: 0,
        lastVisit: new Date(0),
        pts: 50,
      };
      agg.spend += totalCents;
      agg.visits += 1;
      agg.pts += ptsEarned;
      if (soldAt > agg.lastVisit) agg.lastVisit = soldAt;
      spendByCust.set(cust.id, agg);
    }

    // Batch update sales.customer_id with VALUES list
    for (let i = 0; i < updateBatches.length; i += 250) {
      const slice = updateBatches.slice(i, i + 250);
      const valuesSql = sql.join(
        slice.map((u) => sql`(${u.saleId}::uuid, ${u.customerId}::uuid)`),
        sql`, `
      );
      await db.execute(sql`
        UPDATE sales AS s
        SET customer_id = v.cid
        FROM (VALUES ${valuesSql}) AS v(sid, cid)
        WHERE s.id = v.sid
      `);
    }

    await chunkInsert(ledgerRows, 500, (c) => db.insert(loyaltyLedger).values(c));

    for (const [cid, agg] of spendByCust.entries()) {
      await db.execute(sql`
        UPDATE customers
        SET
          points_balance = ${agg.pts},
          lifetime_spend_cents = ${agg.spend},
          visits_60d = ${agg.visits},
          last_visit_at = ${agg.lastVisit}
        WHERE id = ${cid}::uuid
      `);
    }

    const in30Days = new Date(now.getTime() + 30 * 86400_000);
    await db.insert(targetedCoupons).values([
      {
        code: "WELCOME5",
        rfmSegment: "New",
        discountCents: 500,
        minBasketCents: 2500,
        validFrom: now,
        validUntil: in30Days,
      },
      {
        code: "COMEBACK8",
        rfmSegment: "At-Risk",
        discountCents: 800,
        minBasketCents: 3000,
        validFrom: now,
        validUntil: in30Days,
      },
      {
        code: "WINBACK10",
        rfmSegment: "Hibernating",
        discountCents: 1000,
        minBasketCents: 3500,
        validFrom: now,
        validUntil: in30Days,
      },
      {
        code: "CHAMPVIP5",
        rfmSegment: "Champions",
        discountCents: 500,
        minBasketCents: 2000,
        validFrom: now,
        validUntil: in30Days,
      },
    ]);
    console.log(
      `Seeded ${customerRows.length} loyalty customers, ${updateBatches.length} customer-linked sales, and 4 segment coupons.`
    );
  }

  // 2. Historical POs, Linked GRNs & 3-Way Variances (for Supplier OTIF Scorecards & Dock Audit)
  const [{ count: poCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(purchaseOrders);

  if (poCount < 10) {
    const allSuppliers = await db.select().from(suppliers);
    const supProducts = await db.select().from(supplierProducts).limit(600);
    const bySup = new Map<string, (typeof supProducts)>();
    for (const sp of supProducts) {
      const arr = bySup.get(sp.supplierId) ?? [];
      arr.push(sp);
      bySup.set(sp.supplierId, arr);
    }

    for (let sIdx = 0; sIdx < allSuppliers.length; sIdx++) {
      const sup = allSuppliers[sIdx];
      const items = (bySup.get(sup.id) ?? []).slice(0, 6);
      if (items.length < 3) continue;

      // Seed 2 historical PO -> GRN cycles per supplier over last 60 days
      for (let cycle = 0; cycle < 2; cycle++) {
        const poCreated = new Date(now.getTime() - (50 - cycle * 22 - sIdx * 2) * 86400_000);
        // Intentionally give SUP-NDL / SUP-HSH slight delays & short shipments so grade variance shows clearly
        const delayDays = sup.code === "SUP-NDL" || sup.code === "SUP-HSH" ? sup.defaultLeadTimeDays + 2 : sup.defaultLeadTimeDays;
        const grnReceived = new Date(poCreated.getTime() + delayDays * 86400_000);
        const isPartialLast = sIdx === 0 && cycle === 1;

        const chosen = items.slice(cycle * 2, cycle * 2 + 2);
        const totalCases = chosen.reduce((acc, _it) => acc + (isPartialLast ? 10 : 8), 0);
        const estCost = chosen.reduce(
          (acc, it) => acc + (isPartialLast ? 10 : 8) * it.caseCostCents,
          0
        );

        const poId = generateUuidV7();
        const poNumber = `PO-HIST-${sup.code.replace("SUP-", "")}-${cycle + 1}`;
        const existingPo = await db
          .select({ id: purchaseOrders.id })
          .from(purchaseOrders)
          .where(sql`${purchaseOrders.poNumber} = ${poNumber}`)
          .limit(1);
        if (existingPo.length > 0) continue;

        await db.insert(purchaseOrders).values({
          id: poId,
          poNumber,
          supplierId: sup.id,
          status: isPartialLast ? "partially_received" : "received",
          totalCases,
          estimatedCostCents: estCost,
          createdBy: "Priya Patel (Manager)",
          approvedBy: "Alex Rivera (Owner)",
          notes: "Historical delivery seeded for supplier OTIF scorecard baseline",
          createdAt: poCreated,
          approvedAt: poCreated,
        });

        const grnId = generateUuidV7();
        let grnInvoiceTotal = 0;
        const varianceQueue: (typeof grnVariances.$inferInsert)[] = [];
        const grnLineInserts: (typeof grnLines.$inferInsert)[] = [];

        for (let k = 0; k < chosen.length; k++) {
          const item = chosen[k];
          const orderedCases = isPartialLast ? 10 : 8;
          const receivedCases = isPartialLast && k === 0 ? 7 : sup.code === "SUP-HSH" && k === 0 ? 6 : orderedCases;
          const overchargePerCase = sup.code === "SUP-SNK" && k === 1 && cycle === 0 ? 220 : 0;
          const invLineTotal = receivedCases * (item.caseCostCents + overchargePerCase);
          grnInvoiceTotal += invLineTotal;

          await db.insert(purchaseOrderLines).values({
            poId,
            productId: item.productId,
            caseQty: item.caseQty,
            orderedCases,
            receivedCases,
            unitCostCents: item.caseCostCents,
            lineTotalCents: orderedCases * item.caseCostCents,
          });

          const baseUnits = receivedCases * item.caseQty;
          const effUnitCost = baseUnits > 0 ? Math.round(invLineTotal / baseUnits) : 0;
          const bestBefore = new Date(grnReceived.getTime() + 180 * 86400_000)
            .toISOString()
            .slice(0, 10);

          grnLineInserts.push({
            grnId,
            productId: item.productId,
            caseQty: item.caseQty,
            paidCases: receivedCases,
            freeBonusCases: 0,
            baseUnitsReceived: baseUnits,
            invoiceLineTotalCents: invLineTotal,
            effectiveUnitCostCents: effUnitCost,
            bestBeforeDate: bestBefore,
          });

          const poUnitCostCents = Math.round(item.caseCostCents / Math.max(1, item.caseQty));
          const orderedUnits = orderedCases * item.caseQty;
          if (receivedCases < orderedCases) {
            varianceQueue.push({
              grnId,
              poId,
              supplierId: sup.id,
              productId: item.productId,
              varianceType: "short_delivery",
              orderedQtyUnits: orderedUnits,
              receivedQtyUnits: baseUnits,
              poUnitCostCents,
              invoiceUnitCostCents: effUnitCost,
              financialImpactCents: (orderedUnits - baseUnits) * poUnitCostCents,
              status: sIdx === 0 ? "open" : "disputed",
              resolutionNote:
                sIdx === 0 ? null : "Awaiting supplier credit memo confirmation",
              createdAt: grnReceived,
            });
          } else if (overchargePerCase > 0) {
            varianceQueue.push({
              grnId,
              poId,
              supplierId: sup.id,
              productId: item.productId,
              varianceType: "cost_overcharge",
              orderedQtyUnits: orderedUnits,
              receivedQtyUnits: baseUnits,
              poUnitCostCents,
              invoiceUnitCostCents: effUnitCost,
              financialImpactCents: receivedCases * overchargePerCase,
              status: "open",
              createdAt: grnReceived,
            });
          }
        }

        await db.insert(goodsReceipts).values({
          id: grnId,
          supplierId: sup.id,
          poId,
          invoiceNumber: `INV-${sup.code.replace("SUP-", "")}-${cycle + 1}04`,
          receivedBy: "Marcus Chen (Stock Clerk)",
          totalInvoiceCents: grnInvoiceTotal,
          notes: "Dock GRN synced against PO",
          receivedAt: grnReceived,
        });
        await db.insert(grnLines).values(grnLineInserts);
        if (varianceQueue.length > 0) {
          await db.insert(grnVariances).values(varianceQueue);
        }
      }
    }
    console.log("Seeded historical PO -> GRN deliveries and 3-way dock variances.");
  }

  // 3. Initial Pending Shelf Tags (from open margin alerts / near-expiry items)
  const [{ count: tagCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(shelfTagQueue);

  if (tagCount === 0) {
    const sampleTagsRes = await db.execute(sql`
      SELECT
        p.id::text AS product_id,
        pb.barcode AS barcode,
        pb.sell_price_cents::bigint AS current_price_cents
      FROM products p
      JOIN product_barcodes pb ON pb.product_id = p.id AND pb.is_primary = true
      WHERE p.active = true
      ORDER BY p.sku
      LIMIT 8
    `);
    const tagInserts = (sampleTagsRes.rows as Record<string, unknown>[]).map((r, idx) => {
      const oldPrice = Number(r.current_price_cents);
      const isClearance = idx >= 4;
      const newPrice = isClearance
        ? Math.max(99, Math.round(oldPrice * 0.75))
        : oldPrice + 25;
      return {
        productId: String(r.product_id),
        barcode: String(r.barcode),
        oldPriceCents: oldPrice,
        newPriceCents: newPrice,
        reason: isClearance ? "clearance" : "cost_change",
        status: "pending",
      };
    });
    if (tagInserts.length > 0) {
      await db.insert(shelfTagQueue).values(tagInserts);
      console.log(`Seeded ${tagInserts.length} pending shelf tags for 07:30 batch printing.`);
    }
  }
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
