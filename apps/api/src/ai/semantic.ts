import crypto from "node:crypto";
import { GoogleGenAI } from "@google/genai";
import { computeNetMarginBp } from "@supermarket/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  analyticsAbcXyz,
  categories,
  db,
  departments,
  inventoryBatches,
  productBarcodes,
  productEmbeddings,
  products,
  stockBaselines,
  stockMovements,
  taxRates,
} from "../db/index.js";
import { isGeminiConfigured } from "./copilot.js";

const DIM = 256;

// Retail domain synonym expansion so queries like "alcohol free beer" match "0.0 Alcohol-Free" SKUs
const INTENT_SYNONYMS: [RegExp, string[]][] = [
  [/\balcohol[\s-]*free\b|\bnon[\s-]*alcoholic\b|\bzero[\s-]*alc\b|\b0\.0\b/i, ["0.0", "alcohol-free", "zero-alc", "beer", "non-alcoholic"]],
  [/\bzero[\s-]*sugar\b|\bsugar[\s-]*free\b|\bdiet\b|\bno[\s-]*sugar\b/i, ["zero", "sugar", "free", "unsweetened", "diet"]],
  [/\bspicy\b|\bhot\b|\bchili\b|\bchilli\b|\bbuldak\b|\bmala\b/i, ["spicy", "hot", "chili", "buldak", "jalapeno", "mala", "tom", "yum"]],
  [/\bdry\s+noodle|\bstir[\s-]*fry\b|\bmi\s+goreng\b/i, ["stir-fry", "dry", "goreng", "yakisoba", "noodles"]],
  [/\bbeer\b|\blager\b|\bipa\b|\bale\b|\bstout\b|\bcider\b/i, ["beer", "lager", "ipa", "ale", "stout", "cider", "can", "bottle"]],
  [/\benergy\b|\bcaffeine\b|\bpreworkout\b|\bhydration\b|\bisotonic\b/i, ["energy", "red", "bull", "monster", "celsius", "isotonic", "sports"]],
  [/\bchip|\bcrisp|\bsnack|\btortilla\b/i, ["chips", "potato", "tortilla", "doritos", "lays", "pringles", "snacks"]],
  [/\bcoffee\b|\blatte\b|\bespresso\b|\bmocha\b|\bcappuccino\b/i, ["coffee", "latte", "espresso", "mocha", "nescafe", "rtd"]],
  [/\bwater\b|\bsparkling\b|\bspring\b/i, ["water", "spring", "sparkling", "mineral", "evian", "perrier"]],
];

function fnv1aHash(token: string, seed = 2166136261): number {
  let h = seed >>> 0;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

export function embedTextLocal(text: string): number[] {
  const vec = new Float64Array(DIM);
  const lower = text.toLowerCase();
  const baseTokens = lower.split(/[^a-z0-9.]+/).filter((t) => t.length >= 2);

  const expanded: string[] = [...baseTokens];
  for (const [pattern, syns] of INTENT_SYNONYMS) {
    if (pattern.test(lower)) {
      expanded.push(...syns);
    }
  }

  for (const tok of expanded) {
    const idx1 = fnv1aHash(tok) % DIM;
    const sign1 = fnv1aHash(`${tok}_s`) % 2 === 0 ? 1 : -1;
    vec[idx1] += 2.0 * sign1;

    // Character 3-grams for partial brand / flavor matches
    if (tok.length >= 4) {
      for (let i = 0; i <= tok.length - 3; i++) {
        const tri = tok.slice(i, i + 3);
        const idx2 = fnv1aHash(`g:${tri}`) % DIM;
        const sign2 = fnv1aHash(`gs:${tri}`) % 2 === 0 ? 1 : -1;
        vec[idx2] += 0.45 * sign2;
      }
    }
  }

  let normSq = 0;
  for (let i = 0; i < DIM; i++) normSq += vec[i] * vec[i];
  const norm = Math.sqrt(normSq) || 1;
  const out = new Array<number>(DIM);
  for (let i = 0; i < DIM; i++) {
    out[i] = Number((vec[i] / norm).toFixed(5));
  }
  return out;
}

function cosineSim(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot;
}

interface CachedEmbedEntry {
  productId: string;
  descriptor: string;
  model: string;
  vector: number[];
}

let memoryIndex: Map<string, CachedEmbedEntry> | null = null;

function buildProductDescriptor(p: {
  sku: string;
  brand: string;
  name: string;
  categoryName: string;
  departmentName: string;
  requiresAgeCheck: boolean;
}): string {
  const alcoholTag = p.requiresAgeCheck ? "alcoholic 18+" : "non-alcoholic alcohol-free";
  return `${p.sku} ${p.brand} ${p.name} ${p.categoryName} ${p.departmentName} ${alcoholTag}`;
}

export async function syncProductEmbeddings(force = false): Promise<{
  indexedCount: number;
  model: string;
}> {
  const rows = await db
    .select({
      productId: products.id,
      sku: products.sku,
      brand: products.brand,
      name: products.name,
      requiresAgeCheck: products.requiresAgeCheck,
      categoryName: categories.name,
      departmentName: departments.name,
    })
    .from(products)
    .innerJoin(categories, eq(products.categoryId, categories.id))
    .innerJoin(departments, eq(categories.departmentId, departments.id))
    .where(eq(products.active, true));

  const existingRows = await db.select().from(productEmbeddings);
  const existingMap = new Map(existingRows.map((e) => [e.productId, e]));

  const useGemini = isGeminiConfigured();
  const targetModel = useGemini ? "gemini-embedding-001" : "local-semantic-256d";

  const toEmbed: { productId: string; descriptor: string; textHash: string }[] = [];
  const nextCache = new Map<string, CachedEmbedEntry>();

  for (const r of rows) {
    const descriptor = buildProductDescriptor(r);
    const textHash = crypto.createHash("sha256").update(descriptor).digest("hex").slice(0, 16);
    const prev = existingMap.get(r.productId);
    if (!force && prev && prev.textHash === textHash && prev.embeddingModel === targetModel) {
      nextCache.set(r.productId, {
        productId: r.productId,
        descriptor,
        model: prev.embeddingModel,
        vector: prev.vectorJson as number[],
      });
    } else {
      toEmbed.push({ productId: r.productId, descriptor, textHash });
    }
  }

  let actualModel = targetModel;
  const upsertRows: (typeof productEmbeddings.$inferInsert)[] = [];

  if (toEmbed.length > 0 && useGemini) {
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!.trim() });
      const BATCH = 100;
      for (let i = 0; i < toEmbed.length; i += BATCH) {
        const slice = toEmbed.slice(i, i + BATCH);
        const resp = await ai.models.embedContent({
          model: "gemini-embedding-001",
          contents: slice.map((s) => s.descriptor),
          config: { outputDimensionality: DIM },
        });
        const embs = resp.embeddings ?? [];
        for (let j = 0; j < slice.length; j++) {
          const item = slice[j];
          const rawVec = embs[j]?.values ?? embedTextLocal(item.descriptor);
          const norm = Math.sqrt(rawVec.reduce((s, v) => s + v * v, 0)) || 1;
          const unitVec = rawVec.map((v) => Number((v / norm).toFixed(5)));
          upsertRows.push({
            productId: item.productId,
            embeddingModel: "gemini-embedding-001",
            textHash: item.textHash,
            vectorJson: unitVec,
          });
          nextCache.set(item.productId, {
            productId: item.productId,
            descriptor: item.descriptor,
            model: "gemini-embedding-001",
            vector: unitVec,
          });
        }
      }
    } catch {
      actualModel = "local-semantic-256d";
    }
  }

  if (toEmbed.length > 0 && upsertRows.length === 0) {
    actualModel = "local-semantic-256d";
    for (const item of toEmbed) {
      const unitVec = embedTextLocal(item.descriptor);
      upsertRows.push({
        productId: item.productId,
        embeddingModel: "local-semantic-256d",
        textHash: item.textHash,
        vectorJson: unitVec,
      });
      nextCache.set(item.productId, {
        productId: item.productId,
        descriptor: item.descriptor,
        model: "local-semantic-256d",
        vector: unitVec,
      });
    }
  }

  // Persist embeddings in chunks
  const CHUNK = 400;
  for (let i = 0; i < upsertRows.length; i += CHUNK) {
    const chunk = upsertRows.slice(i, i + CHUNK);
    await db
      .insert(productEmbeddings)
      .values(chunk)
      .onConflictDoUpdate({
        target: productEmbeddings.productId,
        set: {
          embeddingModel: sql`EXCLUDED.embedding_model`,
          textHash: sql`EXCLUDED.text_hash`,
          vectorJson: sql`EXCLUDED.vector_json`,
          updatedAt: new Date(),
        },
      });
  }

  memoryIndex = nextCache;
  return { indexedCount: nextCache.size, model: actualModel };
}

async function ensureMemoryIndex(): Promise<Map<string, CachedEmbedEntry>> {
  if (memoryIndex && memoryIndex.size > 0) return memoryIndex;

  const [embRows, prodRows] = await Promise.all([
    db.select().from(productEmbeddings),
    db
      .select({
        productId: products.id,
        sku: products.sku,
        brand: products.brand,
        name: products.name,
        requiresAgeCheck: products.requiresAgeCheck,
        categoryName: categories.name,
        departmentName: departments.name,
      })
      .from(products)
      .innerJoin(categories, eq(products.categoryId, categories.id))
      .innerJoin(departments, eq(categories.departmentId, departments.id))
      .where(eq(products.active, true)),
  ]);

  if (embRows.length < Math.min(100, prodRows.length)) {
    await syncProductEmbeddings(false);
    return memoryIndex!;
  }

  const descMap = new Map(prodRows.map((p) => [p.productId, buildProductDescriptor(p)]));
  const loaded = new Map<string, CachedEmbedEntry>();
  for (const e of embRows) {
    loaded.set(e.productId, {
      productId: e.productId,
      descriptor: descMap.get(e.productId) ?? "",
      model: e.embeddingModel,
      vector: e.vectorJson as number[],
    });
  }
  memoryIndex = loaded;
  return loaded;
}

export async function getEmbeddingStats(): Promise<{
  indexedSkus: number;
  model: string | null;
}> {
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      model: sql<string | null>`max(${productEmbeddings.embeddingModel})`,
    })
    .from(productEmbeddings);
  return {
    indexedSkus: Number(row?.count ?? 0),
    model: row?.model ?? null,
  };
}

export async function semanticSearchProducts(query: string, limit = 30) {
  const index = await ensureMemoryIndex();
  const sampleEntry = index.values().next().value;
  const storedModel = sampleEntry?.model ?? "local-semantic-256d";

  let queryVec: number[];
  let engine = "local-semantic-256d";

  if (storedModel === "gemini-embedding-001" && isGeminiConfigured()) {
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!.trim() });
      const resp = await ai.models.embedContent({
        model: "gemini-embedding-001",
        contents: [query],
        config: { outputDimensionality: DIM },
      });
      const raw = resp.embeddings?.[0]?.values ?? embedTextLocal(query);
      const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0)) || 1;
      queryVec = raw.map((v) => v / norm);
      engine = "gemini-embedding-001";
    } catch {
      queryVec = embedTextLocal(query);
    }
  } else {
    queryVec = embedTextLocal(query);
  }

  const queryTokens = query
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .filter((t) => t.length >= 2);

  const scored: { productId: string; score: number }[] = [];
  for (const entry of index.values()) {
    let sim = cosineSim(queryVec, entry.vector);
    const descLower = entry.descriptor.toLowerCase();
    for (const qt of queryTokens) {
      if (descLower.includes(qt)) sim += 0.08;
    }
    scored.push({ productId: entry.productId, score: sim });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);
  const topIds = top.map((t) => t.productId);
  if (topIds.length === 0) {
    return { engine, totalIndexed: index.size, items: [] };
  }

  const scoreMap = new Map(top.map((t) => [t.productId, Math.min(0.99, Math.max(0.05, t.score))]));

  const unfoldedSq = db
    .select({
      productId: stockMovements.productId,
      delta: sql<number>`coalesce(sum(${stockMovements.qtyDelta}), 0)::int`.as("unfolded_delta"),
    })
    .from(stockMovements)
    .where(and(inArray(stockMovements.productId, topIds), eq(stockMovements.folded, false)))
    .groupBy(stockMovements.productId)
    .as("unfolded_sq");

  const [rows, bcs, nextBatches] = await Promise.all([
    db
      .select({
        id: products.id,
        sku: products.sku,
        name: products.name,
        brand: products.brand,
        sizeLabel: products.sizeLabel,
        categoryId: products.categoryId,
        categoryName: categories.name,
        departmentId: departments.id,
        departmentName: departments.name,
        taxRateId: products.taxRateId,
        taxRateBp: taxRates.rateBp,
        taxInclusive: taxRates.isInclusive,
        baseUnitLabel: products.baseUnitLabel,
        avgCostCents: products.avgCostCents,
        minMarginBp: products.minMarginBp,
        requiresAgeCheck: products.requiresAgeCheck,
        trackExpiry: products.trackExpiry,
        expiryAlertDays: products.expiryAlertDays,
        aisleLocation: products.aisleLocation,
        active: products.active,
        onHandUnits: sql<number>`(coalesce(${stockBaselines.quantity}, 0) + coalesce(${unfoldedSq.delta}, 0))::int`,
        abcClass: analyticsAbcXyz.abcClass,
        xyzClass: analyticsAbcXyz.xyzClass,
        segment: analyticsAbcXyz.segment,
        units60d: analyticsAbcXyz.units60d,
      })
      .from(products)
      .innerJoin(categories, eq(products.categoryId, categories.id))
      .innerJoin(departments, eq(categories.departmentId, departments.id))
      .innerJoin(taxRates, eq(products.taxRateId, taxRates.id))
      .leftJoin(stockBaselines, eq(products.id, stockBaselines.productId))
      .leftJoin(unfoldedSq, eq(products.id, unfoldedSq.productId))
      .leftJoin(analyticsAbcXyz, eq(products.id, analyticsAbcXyz.productId))
      .where(inArray(products.id, topIds)),
    db
      .select()
      .from(productBarcodes)
      .where(inArray(productBarcodes.productId, topIds))
      .orderBy(asc(productBarcodes.packQty)),
    db
      .select({
        productId: inventoryBatches.productId,
        earliestExpiry: sql<string>`min(${inventoryBatches.bestBeforeDate})`,
      })
      .from(inventoryBatches)
      .where(
        and(inArray(inventoryBatches.productId, topIds), sql`${inventoryBatches.qtyRemaining} > 0`)
      )
      .groupBy(inventoryBatches.productId),
  ]);

  const bcMap = new Map<string, (typeof bcs)[number][]>();
  for (const bc of bcs) {
    const list = bcMap.get(bc.productId) ?? [];
    list.push(bc);
    bcMap.set(bc.productId, list);
  }
  const expiryMap = new Map(nextBatches.map((b) => [b.productId, b.earliestExpiry]));

  const items = rows
    .map((r) => {
      const barcodes = bcMap.get(r.id) ?? [];
      const primaryBc = barcodes.find((b) => b.isPrimary) ?? barcodes[0];
      const primarySell = primaryBc?.sellPriceCents ?? 0;
      const primaryPackQty = primaryBc?.packQty ?? 1;
      return {
        ...r,
        primaryBarcode: primaryBc?.barcode ?? "",
        primarySellPriceCents: primarySell,
        marginBp: computeNetMarginBp(
          primarySell,
          r.avgCostCents * primaryPackQty,
          r.taxRateBp,
          r.taxInclusive
        ),
        earliestExpiry: expiryMap.get(r.id) ?? null,
        barcodes,
        similarityScore: Number((scoreMap.get(r.id) ?? 0).toFixed(3)),
      };
    })
    .sort((a, b) => b.similarityScore - a.similarityScore);

  return {
    engine,
    totalIndexed: index.size,
    items,
  };
}
