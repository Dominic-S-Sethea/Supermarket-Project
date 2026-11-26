import type { FastifyInstance } from "fastify";
import {
  computeLegalUnitPrice,
  computeNetMarginBp,
  CreateProductSchema,
  CreatePromotionSchema,
  formatMoney,
  generateUuidV7,
  normalizePluCode,
  parseScaleBarcode,
  RecallProductSchema,
  validateBarcode,
} from "@supermarket/shared";
import { and, asc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  analyticsAbcXyz,
  auditLogs,
  categories,
  db,
  departments,
  inventoryBatches,
  productBarcodes,
  products,
  promotions,
  shelfTagQueue,
  stockBaselines,
  suppliers,
  taxRates,
  users,
} from "../db/index.js";
import { invalidateEmbeddingCache } from "../ai/semantic.js";
import { getPgErrorCode } from "../app.js";
import { env } from "../config/env.js";
import { buildZplBarcodeCommand, parseCsvRows, sanitizeZpl } from "../lib/helpers.js";
import { requireAuth, requireRole } from "../plugins/auth.js";
import { createRateLimiter } from "../plugins/security.js";

const UuidSchema = z.string().uuid();

export async function catalogRoutes(app: FastifyInstance) {
  const importLimiter = createRateLimiter({
    keyPrefix: "csv_import",
    windowMs: 60_000,
    max: env.isTest ? 200 : 12,
  });
  const lookupLimiter = createRateLimiter({
    keyPrefix: "barcode_lookup",
    windowMs: 60_000,
    max: env.isTest ? 200 : 30,
  });
  // Metadata bootstrap for dropdowns, promos, and filters
  app.get("/api/meta", { preHandler: [requireAuth] }, async (req) => {
    const role = req.authUser?.role;
    const canSeeSuppliers = role !== "cashier";
    const [depts, cats, taxes, sups, promos, staff] = await Promise.all([
      db.select().from(departments).orderBy(asc(departments.name)),
      db.select().from(categories).orderBy(asc(categories.name)),
      db.select().from(taxRates).orderBy(asc(taxRates.rateBp)),
      canSeeSuppliers
        ? db.select().from(suppliers).orderBy(asc(suppliers.name))
        : Promise.resolve([]),
      db
        .select()
        .from(promotions)
        .where(eq(promotions.active, true))
        .orderBy(asc(promotions.priority)),
      role === "owner" || role === "manager"
        ? db
            .select({
              id: users.id,
              username: users.username,
              fullName: users.fullName,
              role: users.role,
              active: users.active,
            })
            .from(users)
            .where(eq(users.active, true))
        : Promise.resolve([]),
    ]);

    return {
      departments: depts,
      categories: cats,
      taxRates: taxes,
      suppliers: sups,
      promotions: promos,
      staff,
    };
  });

  // Active & scheduled promotions
  app.get("/api/promotions", { preHandler: [requireAuth] }, async () => {
    const rows = await db
      .select()
      .from(promotions)
      .orderBy(asc(promotions.priority));
    return { promotions: rows };
  });

  app.post(
    "/api/promotions",
    { preHandler: [requireRole(["owner", "manager"])] },
    async (req, reply) => {
      const parsed = CreatePromotionSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;
      const now = new Date();
      const [created] = await db
        .insert(promotions)
        .values({
          name: data.name,
          promoType: data.promoType,
          priority: data.priority,
          combinable: data.combinable,
          minMarginGuardBp: data.minMarginGuardBp,
          daypartStartHour: data.daypartStartHour ?? null,
          daypartEndHour: data.daypartEndHour ?? null,
          startsAt: data.startsAt ? new Date(data.startsAt) : now,
          endsAt: data.endsAt ? new Date(data.endsAt) : new Date(now.getTime() + 30 * 86400_000),
          active: true,
          rulesJson: data.rulesJson,
        })
        .returning();

      await db.insert(auditLogs).values({
        actor: req.authUser!.fullName,
        action: "promo_create",
        entityType: "promotion",
        entityId: created.id,
        detailsJson: { name: created.name, promoType: created.promoType },
      });

      return reply.status(201).send(created);
    }
  );

  app.patch(
    "/api/promotions/:id",
    { preHandler: [requireRole(["owner", "manager"])] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UuidSchema.safeParse(id).success) {
        return reply.status(400).send({ error: "Invalid promotion ID format." });
      }
      const schema = z.object({
        active: z.boolean(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const [updated] = await db
        .update(promotions)
        .set({ active: parsed.data.active })
        .where(eq(promotions.id, id))
        .returning();
      if (!updated) return reply.status(404).send({ error: "Promotion not found." });

      await db.insert(auditLogs).values({
        actor: req.authUser!.fullName,
        action: "promo_toggle",
        entityType: "promotion",
        entityId: updated.id,
        detailsJson: { name: updated.name, active: updated.active },
      });

      return { promotion: updated };
    }
  );

  // High-speed paginated & searchable 3,000+ SKU catalog query (consistent live stock + net margin)
  app.get("/api/products", { preHandler: [requireAuth] }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const search = (q.search ?? "").trim();
    const departmentId = q.departmentId?.trim() || undefined;
    const categoryId = q.categoryId?.trim() || undefined;
    const segment = q.segment?.trim() || undefined;
    if (departmentId && !UuidSchema.safeParse(departmentId).success) {
      return reply.status(400).send({ error: "Invalid departmentId UUID format." });
    }
    if (categoryId && !UuidSchema.safeParse(categoryId).success) {
      return reply.status(400).send({ error: "Invalid categoryId UUID format." });
    }
    const rawPage = Number(q.page);
    const rawPageSize = Number(q.pageSize);
    const page = Number.isFinite(rawPage)
      ? Math.min(10_000, Math.max(1, Math.trunc(rawPage)))
      : 1;
    const pageSize = Number.isFinite(rawPageSize)
      ? Math.min(100, Math.max(1, Math.trunc(rawPageSize)))
      : 50;
    const offset = (page - 1) * pageSize;

    const conditions = [];
    if (categoryId) conditions.push(eq(products.categoryId, categoryId));
    if (departmentId) {
      const deptCats = await db
        .select({ id: categories.id })
        .from(categories)
        .where(eq(categories.departmentId, departmentId));
      const catIds = deptCats.map((c) => c.id);
      if (catIds.length === 0) {
        return { items: [], total: 0, page, pageSize };
      }
      conditions.push(inArray(products.categoryId, catIds));
    }

    if (segment) {
      const segRows = await db
        .select({ productId: analyticsAbcXyz.productId })
        .from(analyticsAbcXyz)
        .where(eq(analyticsAbcXyz.segment, segment));
      const pIds = segRows.map((r) => r.productId);
      if (pIds.length === 0) {
        return { items: [], total: 0, page, pageSize };
      }
      conditions.push(inArray(products.id, pIds));
    }

    if (search) {
      const barcodeMatches = await db
        .select({ productId: productBarcodes.productId })
        .from(productBarcodes)
        .where(ilike(productBarcodes.barcode, `%${search}%`))
        .limit(50);
      const bcProductIds = barcodeMatches.map((b) => b.productId);
      const searchCond =
        bcProductIds.length > 0
          ? or(
              ilike(products.name, `%${search}%`),
              ilike(products.sku, `%${search}%`),
              ilike(products.brand, `%${search}%`),
              inArray(products.id, bcProductIds)
            )
          : or(
              ilike(products.name, `%${search}%`),
              ilike(products.sku, `%${search}%`),
              ilike(products.brand, `%${search}%`)
            );
      conditions.push(searchCond!);
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [countRows, rows] = await Promise.all([
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(products)
        .where(whereClause),
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
          unitMode: products.unitMode,
          pluCode: products.pluCode,
          defaultTareGrams: products.defaultTareGrams,
          netContentAmount: products.netContentAmount,
          netContentUnit: products.netContentUnit,
          allergens: products.allergensJson,
          ingredientsText: products.ingredientsText,
          recalled: products.recalled,
          recallReason: products.recallReason,
          avgCostCents: products.avgCostCents,
          minMarginBp: products.minMarginBp,
          requiresAgeCheck: products.requiresAgeCheck,
          trackExpiry: products.trackExpiry,
          expiryAlertDays: products.expiryAlertDays,
          aisleLocation: products.aisleLocation,
          active: products.active,
          onHandUnits: sql<number>`(coalesce(${stockBaselines.quantity}, 0) + coalesce((
            SELECT sum(sm.qty_delta)
            FROM stock_movements sm
            WHERE sm.product_id = ${products.id} AND sm.folded = false
          ), 0))::int`,
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
        .leftJoin(analyticsAbcXyz, eq(products.id, analyticsAbcXyz.productId))
        .where(whereClause)
        .orderBy(asc(products.sku))
        .limit(pageSize)
        .offset(offset),
    ]);
    const total = countRows[0]?.total ?? 0;

    if (rows.length === 0) {
      return { items: [], total, page, pageSize };
    }

    const pIds = rows.map((r) => r.id);
    const [bcs, nextBatches] = await Promise.all([
      db
        .select()
        .from(productBarcodes)
        .where(inArray(productBarcodes.productId, pIds))
        .orderBy(asc(productBarcodes.packQty)),
      db
        .select({
          productId: inventoryBatches.productId,
          earliestExpiry: sql<string>`min(${inventoryBatches.bestBeforeDate})`,
        })
        .from(inventoryBatches)
        .where(
          and(
            inArray(inventoryBatches.productId, pIds),
            sql`${inventoryBatches.qtyRemaining} > 0`
          )
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

    const canSeeFinancials =
      req.authUser?.role === "owner" ||
      req.authUser?.role === "manager" ||
      req.authUser?.role === "accountant";

    const items = rows.map((r) => {
      const barcodes = bcMap.get(r.id) ?? [];
      const primaryBc = barcodes.find((b) => b.isPrimary) ?? barcodes[0];
      const primarySell = primaryBc?.sellPriceCents ?? 0;
      const primaryPackQty = primaryBc?.packQty ?? 1;
      const onHandUnits = Number(r.onHandUnits ?? 0);
      const marginBp = computeNetMarginBp(
        primarySell,
        r.avgCostCents * primaryPackQty,
        r.taxRateBp,
        r.taxInclusive
      );
      if (!canSeeFinancials) {
        const { avgCostCents: _c, minMarginBp: _mm, ...pub } = r;
        return {
          ...pub,
          onHandUnits,
          primaryBarcode: primaryBc?.barcode ?? "",
          primarySellPriceCents: primarySell,
          earliestExpiry: expiryMap.get(r.id) ?? null,
          barcodes,
        };
      }
      return {
        ...r,
        onHandUnits,
        primaryBarcode: primaryBc?.barcode ?? "",
        primarySellPriceCents: primarySell,
        marginBp,
        earliestExpiry: expiryMap.get(r.id) ?? null,
        barcodes,
      };
    });

    return { items, total, page, pageSize };
  });

  // Sub-5ms POS barcode, GS1 20-29 scale barcode, and 4-5 digit PLU resolution
  app.get("/api/products/scan/:barcode", { preHandler: [requireAuth] }, async (req, reply) => {
    const { barcode } = req.params as { barcode: string };
    const clean = barcode.trim();
    const canSeeFinancials =
      req.authUser?.role === "owner" ||
      req.authUser?.role === "manager" ||
      req.authUser?.role === "accountant";

    const scaleParsed = parseScaleBarcode(clean);
    const pluLookupCandidates = scaleParsed
      ? scaleParsed.pluCandidates
      : /^\d{4,5}$/.test(clean)
        ? Array.from(new Set([clean, normalizePluCode(clean)]))
        : [];

    const selectShape = {
      barcodeId: productBarcodes.id,
      barcode: productBarcodes.barcode,
      packQty: productBarcodes.packQty,
      packLabel: productBarcodes.packLabel,
      sellPriceCents: productBarcodes.sellPriceCents,
      productId: products.id,
      sku: products.sku,
      name: products.name,
      brand: products.brand,
      categoryId: products.categoryId,
      baseUnitLabel: products.baseUnitLabel,
      unitMode: products.unitMode,
      pluCode: products.pluCode,
      defaultTareGrams: products.defaultTareGrams,
      allergens: products.allergensJson,
      recalled: products.recalled,
      recallReason: products.recallReason,
      avgCostCents: products.avgCostCents,
      requiresAgeCheck: products.requiresAgeCheck,
      taxRateBp: taxRates.rateBp,
      taxInclusive: taxRates.isInclusive,
      onHandUnits: sql<number>`(
        coalesce(${stockBaselines.quantity}, 0) +
        coalesce((
          SELECT sum(sm.qty_delta)::int
          FROM stock_movements sm
          WHERE sm.folded = false AND sm.product_id = ${products.id}
        ), 0)
      )::int`,
    };

    let [found] = await db
      .select(selectShape)
      .from(productBarcodes)
      .innerJoin(products, eq(productBarcodes.productId, products.id))
      .innerJoin(taxRates, eq(products.taxRateId, taxRates.id))
      .leftJoin(stockBaselines, eq(products.id, stockBaselines.productId))
      .where(eq(productBarcodes.barcode, clean))
      .limit(1);

    if (!found && pluLookupCandidates.length > 0) {
      [found] = await db
        .select(selectShape)
        .from(products)
        .innerJoin(
          productBarcodes,
          and(eq(productBarcodes.productId, products.id), eq(productBarcodes.isPrimary, true))
        )
        .innerJoin(taxRates, eq(products.taxRateId, taxRates.id))
        .leftJoin(stockBaselines, eq(products.id, stockBaselines.productId))
        .where(inArray(products.pluCode, pluLookupCandidates))
        .limit(1);
    }

    if (!found) {
      return reply.status(404).send({ error: "Barcode or PLU not found", barcode: clean });
    }

    const payload = {
      ...found,
      scaleParsed,
    };

    if (!canSeeFinancials) {
      const { avgCostCents: _c, ...pub } = payload;
      return pub;
    }
    return payload;
  });

  // Create new product with Multi-UOM barcodes & fresh/EU allergen metadata
  app.post(
    "/api/products",
    { preHandler: [requireRole(["owner", "manager"])] },
    async (req, reply) => {
      const parsed = CreateProductSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const data = parsed.data;
      const seenBarcodes = new Set<string>();
      const normalizedBarcodes: typeof data.barcodes = [];
      for (const b of data.barcodes) {
        const validation = validateBarcode(b.barcode);
        if (!validation.valid) {
          return reply.status(400).send({ error: validation.error ?? `Invalid barcode: ${b.barcode}` });
        }
        if (seenBarcodes.has(validation.normalized)) {
          return reply.status(400).send({ error: `Duplicate barcode in request: ${validation.normalized}` });
        }
        seenBarcodes.add(validation.normalized);
        normalizedBarcodes.push({ ...b, barcode: validation.normalized });
      }
      const primaryIdx = Math.max(0, normalizedBarcodes.findIndex((b) => b.isPrimary));
      const productId = generateUuidV7();

      await db.transaction(async (tx) => {
        await tx.insert(products).values({
          id: productId,
          sku: data.sku.trim(),
          name: data.name.trim(),
          brand: data.brand.trim(),
          categoryId: data.categoryId,
          taxRateId: data.taxRateId,
          baseUnitLabel: data.baseUnitLabel,
          unitMode: data.unitMode ?? "each",
          pluCode: data.pluCode ?? null,
          defaultTareGrams: data.defaultTareGrams ?? 0,
          netContentAmount: data.netContentAmount ?? null,
          netContentUnit: data.netContentUnit ?? null,
          allergensJson: data.allergens ?? [],
          ingredientsText: data.ingredientsText ?? null,
          avgCostCents: data.avgCostCents,
          minMarginBp: data.minMarginBp,
          requiresAgeCheck: data.requiresAgeCheck,
          trackExpiry: data.trackExpiry,
          expiryAlertDays: data.expiryAlertDays,
        });

        await tx.insert(productBarcodes).values(
          normalizedBarcodes.map((b, idx) => ({
            productId,
            barcode: b.barcode,
            packQty: b.packQty,
            packLabel: b.packLabel,
            sellPriceCents: b.sellPriceCents,
            isPrimary: idx === primaryIdx,
            isOrderableCase: b.isOrderableCase,
          }))
        );

        await tx.insert(stockBaselines).values({ productId, quantity: 0 });
      });

      invalidateEmbeddingCache();
      return reply.status(201).send({ id: productId });
    }
  );

  // Add or update a Multi-UOM barcode tier on an existing product
  app.post(
    "/api/products/:id/barcodes",
    { preHandler: [requireRole(["owner", "manager"])] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UuidSchema.safeParse(id).success) {
        return reply.status(400).send({ error: "Invalid product ID format." });
      }
      const schema = z.object({
        barcode: z.string().min(4).max(32),
        packQty: z.number().int().min(1),
        packLabel: z.string().min(1).max(64),
        sellPriceCents: z.number().int().min(1),
        isPrimary: z.boolean().optional().default(false),
        isOrderableCase: z.boolean().optional().default(false),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const validation = validateBarcode(parsed.data.barcode);
      if (!validation.valid) {
        return reply.status(400).send({ error: validation.error });
      }

      const [existingProd] = await db
        .select({ id: products.id })
        .from(products)
        .where(eq(products.id, id))
        .limit(1);
      if (!existingProd) {
        return reply.status(404).send({ error: "Product not found" });
      }

      const created = await db.transaction(async (tx) => {
        if (parsed.data.isPrimary) {
          await tx
            .update(productBarcodes)
            .set({ isPrimary: false })
            .where(and(eq(productBarcodes.productId, id), eq(productBarcodes.isPrimary, true)));
        }
        const [inserted] = await tx
          .insert(productBarcodes)
          .values({
            productId: id,
            barcode: validation.normalized,
            packQty: parsed.data.packQty,
            packLabel: parsed.data.packLabel,
            sellPriceCents: parsed.data.sellPriceCents,
            isPrimary: parsed.data.isPrimary,
            isOrderableCase: parsed.data.isOrderableCase,
          })
          .returning();
        return inserted;
      });

      return reply.status(201).send(created);
    }
  );

  app.patch(
    "/api/products/:id/barcodes/:barcodeId",
    { preHandler: [requireRole(["owner", "manager"])] },
    async (req, reply) => {
      const { id, barcodeId } = req.params as { id: string; barcodeId: string };
      if (!UuidSchema.safeParse(id).success || !UuidSchema.safeParse(barcodeId).success) {
        return reply.status(400).send({ error: "Invalid product or barcode ID format." });
      }
      const schema = z
        .object({
          packLabel: z.string().min(1).max(64).optional(),
          packQty: z.number().int().min(1).optional(),
          sellPriceCents: z.number().int().min(1).optional(),
        })
        .refine(
          (d) =>
            d.packLabel !== undefined || d.packQty !== undefined || d.sellPriceCents !== undefined,
          { message: "At least one updatable field is required." }
        );
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const updated = await db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(productBarcodes)
          .where(and(eq(productBarcodes.id, barcodeId), eq(productBarcodes.productId, id)))
          .for("update");
        if (!existing) return null;

        const [row] = await tx
          .update(productBarcodes)
          .set(parsed.data)
          .where(and(eq(productBarcodes.id, barcodeId), eq(productBarcodes.productId, id)))
          .returning();

        if (
          parsed.data.sellPriceCents !== undefined &&
          parsed.data.sellPriceCents !== existing.sellPriceCents
        ) {
          await tx.insert(shelfTagQueue).values({
            productId: id,
            barcode: row.barcode,
            oldPriceCents: existing.sellPriceCents,
            newPriceCents: row.sellPriceCents,
            reason: "manual",
            status: "pending",
          });
        }
        return row;
      });

      if (!updated) return reply.status(404).send({ error: "Barcode not found" });
      return updated;
    }
  );

  app.delete(
    "/api/products/:id/barcodes/:barcodeId",
    { preHandler: [requireRole(["owner", "manager"])] },
    async (req, reply) => {
      const { id, barcodeId } = req.params as { id: string; barcodeId: string };
      if (!UuidSchema.safeParse(id).success || !UuidSchema.safeParse(barcodeId).success) {
        return reply.status(400).send({ error: "Invalid product or barcode ID format." });
      }

      // Lock all barcodes for this product inside a transaction so concurrent DELETEs cannot orphan the product (M-10)
      const outcome = await db.transaction(async (tx) => {
        const allForProduct = await tx
          .select()
          .from(productBarcodes)
          .where(eq(productBarcodes.productId, id))
          .orderBy(asc(productBarcodes.id))
          .for("update");

        const target = allForProduct.find((b) => b.id === barcodeId);
        if (!target) {
          return { errorStatus: 404 as const, error: "Barcode not found" };
        }
        if (allForProduct.length <= 1) {
          return {
            errorStatus: 409 as const,
            error: "Cannot delete the last remaining barcode on a product.",
          };
        }
        if (target.isPrimary) {
          return {
            errorStatus: 409 as const,
            error:
              "Cannot delete the primary barcode directly. Assign another primary barcode first.",
          };
        }

        await tx
          .delete(productBarcodes)
          .where(and(eq(productBarcodes.id, barcodeId), eq(productBarcodes.productId, id)));
        return { errorStatus: null };
      });

      if (outcome.errorStatus) {
        return reply.status(outcome.errorStatus).send({ error: outcome.error });
      }
      return { deleted: true, barcodeId };
    }
  );

  // Bulk CSV Onboarding Preview & Validation (RFC-4180 parser + GS1 check digits + DB tax_rates net margin)
  app.post(
    "/api/import/preview",
    { preHandler: [requireRole(["owner", "manager"]), importLimiter] },
    async (req, reply) => {
      const schema = z.object({
        csvText: z.string().min(1).max(5_000_000),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: "csvText required" });

      const parsedRows = parseCsvRows(parsed.data.csvText);
      if (parsedRows.length < 2) {
        return reply
          .status(400)
          .send({ error: "CSV must contain a header row and at least 1 data row" });
      }

      const headers = parsedRows[0].map((h) => h.trim().toLowerCase());
      const idx = (names: string[]) => headers.findIndex((h) => names.includes(h));
      const iSku = idx(["sku", "item_code"]);
      const iName = idx(["name", "product_name", "title"]);
      const iBrand = idx(["brand", "manufacturer"]);
      const iBarcode = idx(["barcode", "ean", "upc", "gtin"]);
      const iPackQty = idx(["pack_qty", "uom_qty", "qty"]);
      const iPackLabel = idx(["pack_label", "uom"]);
      const iCost = idx(["unit_cost", "cost", "cost_usd"]);
      const iPrice = idx(["sell_price", "price", "retail_price"]);
      const iCat = idx(["category"]);
      const iTaxCode = idx(["tax_code", "tax"]);

      const [existingBarcodeRows, allTaxRates] = await Promise.all([
        db.select({ barcode: productBarcodes.barcode }).from(productBarcodes),
        db.select().from(taxRates),
      ]);
      const existingBarcodes = new Set(existingBarcodeRows.map((b) => b.barcode));
      const taxByCode = new Map(allTaxRates.map((t) => [t.code.toUpperCase(), t]));
      const defaultTax = taxByCode.get("STD") ?? allTaxRates[0] ?? {
        rateBp: 0,
        isInclusive: true,
        code: "STD",
      };

      const MAX_PREVIEW_ROWS = 2000;
      const dataSlice = parsedRows.slice(1, 1 + MAX_PREVIEW_ROWS);
      const seenInFile = new Set<string>();

      const rows = dataSlice.map((cols, rowNum) => {
        const barcode = iBarcode >= 0 ? cols[iBarcode] ?? "" : "";
        const bcCheck = validateBarcode(barcode);
        const sku =
          iSku >= 0 && cols[iSku] ? cols[iSku] : `IMP-${String(rowNum + 1).padStart(4, "0")}`;
        const name = iName >= 0 ? cols[iName] ?? "" : "";
        const brand = iBrand >= 0 && cols[iBrand] ? cols[iBrand] : "Generic";
        const packQty = Math.max(1, Number(iPackQty >= 0 ? cols[iPackQty] : 1) || 1);
        const packLabel =
          iPackLabel >= 0 && cols[iPackLabel]
            ? cols[iPackLabel]
            : packQty === 1
              ? "Single"
              : `${packQty}-Pack`;
        const unitCostCents = Math.round((Number(iCost >= 0 ? cols[iCost] : 0) || 0) * 100);
        const sellPriceCents = Math.round((Number(iPrice >= 0 ? cols[iPrice] : 0) || 0) * 100);
        const categoryName = iCat >= 0 && cols[iCat] ? cols[iCat] : "Cola & Sparkling Soda";
        const taxCodeHint = iTaxCode >= 0 && cols[iTaxCode] ? cols[iTaxCode].trim().toUpperCase() : "";
        const matchedTax = (taxCodeHint ? taxByCode.get(taxCodeHint) : undefined) ?? defaultTax;

        const issues: string[] = [];
        if (!name) issues.push("Missing product name");
        if (!bcCheck.valid) issues.push(bcCheck.error ?? "Invalid barcode");
        if (sellPriceCents <= 0) issues.push("Sell price must be > $0");
        if (sellPriceCents > 0 && unitCostCents * packQty >= sellPriceCents) {
          issues.push("Negative margin (cost >= sell price)");
        }
        if (bcCheck.normalized && seenInFile.has(bcCheck.normalized)) {
          issues.push("Duplicate barcode in CSV");
        }
        if (bcCheck.normalized) seenInFile.add(bcCheck.normalized);

        const existsInDb = existingBarcodes.has(bcCheck.normalized);

        return {
          rowNum: rowNum + 2,
          sku,
          name,
          brand,
          barcode: bcCheck.normalized,
          barcodeFormat: bcCheck.format,
          packQty,
          packLabel,
          unitCostCents,
          sellPriceCents,
          marginBp: computeNetMarginBp(
            sellPriceCents,
            unitCostCents * packQty,
            matchedTax.rateBp,
            matchedTax.isInclusive
          ),
          categoryName,
          taxCode: matchedTax.code,
          status: issues.length > 0 ? "error" : existsInDb ? "duplicate" : "ready",
          issues,
        };
      });

      return {
        totalRows: parsedRows.length - 1,
        truncated: parsedRows.length - 1 > MAX_PREVIEW_ROWS,
        readyCount: rows.filter((r) => r.status === "ready").length,
        duplicateCount: rows.filter((r) => r.status === "duplicate").length,
        errorCount: rows.filter((r) => r.status === "error").length,
        rows,
      };
    }
  );

  function sanitizeImportDbError(err: unknown): string {
    const code = getPgErrorCode(err);
    if (code === "23505") return "Duplicate SKU or barcode already exists in catalog.";
    if (code === "23503") return "Invalid category or tax rate reference.";
    if (code === "23514") return "Row violates catalog price or quantity constraints.";
    if (code === "22P02") return "Invalid data format in import row.";
    return "Could not import row due to a database conflict.";
  }

  // Commit validated CSV import rows into PostgreSQL (batched inserts + sanitized errors - H-06, H-11)
  app.post(
    "/api/import/commit",
    { preHandler: [requireRole(["owner", "manager"]), importLimiter] },
    async (req, reply) => {
      const schema = z.object({
        rows: z
          .array(
            z.object({
              sku: z.string().trim().min(1).max(64),
              name: z.string().trim().min(1).max(200),
              brand: z.string().trim().min(1).max(120),
              barcode: z.string().trim().min(4).max(32),
              packQty: z.number().int().min(1),
              packLabel: z.string().trim().min(1).max(64),
              unitCostCents: z.number().int().min(0),
              sellPriceCents: z.number().int().min(1),
              categoryName: z.string().optional(),
              taxCode: z.string().optional(),
            })
          )
          .max(2000),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const [allCats, allTaxes] = await Promise.all([
        db.select().from(categories),
        db.select().from(taxRates),
      ]);
      const defaultCat = allCats[0];
      const catByLower = new Map(allCats.map((c) => [c.name.toLowerCase(), c]));
      const taxByCode = new Map(allTaxes.map((t) => [t.code.toUpperCase(), t]));
      const defaultTax = taxByCode.get("STD") ?? allTaxes[0];

      // Pre-validate all rows and batch-check existing SKUs & barcodes in 2 queries (eliminates N+1)
      const normalizedCandidates: {
        productId: string;
        sku: string;
        name: string;
        brand: string;
        barcode: string;
        packQty: number;
        packLabel: string;
        unitCostCents: number;
        sellPriceCents: number;
        categoryId: string;
        taxRateId: string;
      }[] = [];

      let imported = 0;
      let skipped = 0;
      const errors: { sku: string; reason: string }[] = [];
      const seenSkus = new Set<string>();
      const seenBarcodes = new Set<string>();

      for (const r of parsed.data.rows) {
        const bcCheck = validateBarcode(r.barcode);
        if (!bcCheck.valid) {
          skipped++;
          errors.push({ sku: r.sku, reason: bcCheck.error ?? "Invalid barcode" });
          continue;
        }
        if (r.unitCostCents * r.packQty >= r.sellPriceCents) {
          skipped++;
          errors.push({ sku: r.sku, reason: "Negative margin (cost >= sell price)" });
          continue;
        }
        if (seenSkus.has(r.sku)) {
          skipped++;
          errors.push({ sku: r.sku, reason: "Duplicate SKU within import batch." });
          continue;
        }
        if (seenBarcodes.has(bcCheck.normalized)) {
          skipped++;
          errors.push({ sku: r.sku, reason: "Duplicate barcode within import batch." });
          continue;
        }
        seenSkus.add(r.sku);
        seenBarcodes.add(bcCheck.normalized);

        const cat =
          catByLower.get((r.categoryName ?? "").trim().toLowerCase()) ?? defaultCat;
        const tax =
          taxByCode.get((r.taxCode ?? "").trim().toUpperCase()) ?? defaultTax;
        normalizedCandidates.push({
          productId: generateUuidV7(),
          sku: r.sku,
          name: r.name,
          brand: r.brand,
          barcode: bcCheck.normalized,
          packQty: r.packQty,
          packLabel: r.packLabel,
          unitCostCents: r.unitCostCents,
          sellPriceCents: r.sellPriceCents,
          categoryId: cat.id,
          taxRateId: tax.id,
        });
      }

      if (normalizedCandidates.length > 0) {
        const candidateSkus = normalizedCandidates.map((c) => c.sku);
        const candidateBarcodes = normalizedCandidates.map((c) => c.barcode);
        const [existingSkuRows, existingBcRows] = await Promise.all([
          db.select({ sku: products.sku }).from(products).where(inArray(products.sku, candidateSkus)),
          db
            .select({ barcode: productBarcodes.barcode })
            .from(productBarcodes)
            .where(inArray(productBarcodes.barcode, candidateBarcodes)),
        ]);
        const existingSkuSet = new Set(existingSkuRows.map((x) => x.sku));
        const existingBcSet = new Set(existingBcRows.map((x) => x.barcode));

        const readyToInsert = [];
        for (const c of normalizedCandidates) {
          if (existingSkuSet.has(c.sku)) {
            skipped++;
            errors.push({ sku: c.sku, reason: "Duplicate SKU already exists in catalog." });
            continue;
          }
          if (existingBcSet.has(c.barcode)) {
            skipped++;
            errors.push({ sku: c.sku, reason: "Duplicate barcode already exists in catalog." });
            continue;
          }
          readyToInsert.push(c);
        }

        const CHUNK_SIZE = 100;
        for (let i = 0; i < readyToInsert.length; i += CHUNK_SIZE) {
          const chunk = readyToInsert.slice(i, i + CHUNK_SIZE);
          try {
            await db.transaction(async (tx) => {
              await tx.insert(products).values(
                chunk.map((c) => ({
                  id: c.productId,
                  sku: c.sku,
                  name: c.name,
                  brand: c.brand,
                  categoryId: c.categoryId,
                  taxRateId: c.taxRateId,
                  avgCostCents: c.unitCostCents,
                  baseUnitLabel: "unit",
                }))
              );
              await tx.insert(productBarcodes).values(
                chunk.map((c) => ({
                  productId: c.productId,
                  barcode: c.barcode,
                  packQty: c.packQty,
                  packLabel: c.packLabel,
                  sellPriceCents: c.sellPriceCents,
                  isPrimary: true,
                }))
              );
              await tx.insert(stockBaselines).values(
                chunk.map((c) => ({ productId: c.productId, quantity: 0 }))
              );
            });
            imported += chunk.length;
          } catch {
            // Fall back to row-level savepoints only if a concurrent conflict hit this chunk
            for (const c of chunk) {
              try {
                await db.transaction(async (tx) => {
                  await tx.insert(products).values({
                    id: c.productId,
                    sku: c.sku,
                    name: c.name,
                    brand: c.brand,
                    categoryId: c.categoryId,
                    taxRateId: c.taxRateId,
                    avgCostCents: c.unitCostCents,
                    baseUnitLabel: "unit",
                  });
                  await tx.insert(productBarcodes).values({
                    productId: c.productId,
                    barcode: c.barcode,
                    packQty: c.packQty,
                    packLabel: c.packLabel,
                    sellPriceCents: c.sellPriceCents,
                    isPrimary: true,
                  });
                  await tx.insert(stockBaselines).values({ productId: c.productId, quantity: 0 });
                });
                imported++;
              } catch (rowErr) {
                skipped++;
                errors.push({ sku: c.sku, reason: sanitizeImportDbError(rowErr) });
              }
            }
          }
        }
      }

      if (imported > 0) {
        invalidateEmbeddingCache();
      }

      await db.insert(auditLogs).values({
        actor: req.authUser!.fullName,
        action: "csv_import",
        entityType: "catalog",
        detailsJson: { imported, skipped },
      });

      return { imported, skipped, errors };
    }
  );

  // Open Food Facts Barcode Auto-Enrichment Helper (strictly validated & rate-limited - M-12)
  app.get(
    "/api/lookup/barcode/:barcode",
    { preHandler: [requireRole(["owner", "manager", "stock_clerk"]), lookupLimiter] },
    async (req, reply) => {
      const { barcode } = req.params as { barcode: string };
      const clean = barcode.trim();
      if (!/^\d{8,14}$/.test(clean)) {
        return reply.status(400).send({ error: "Barcode must be 8-14 digits (EAN/UPC/ITF)." });
      }
      try {
        const res = await fetch(
          `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(clean)}.json`,
          { signal: AbortSignal.timeout(4000) }
        );
        if (!res.ok) return reply.status(404).send({ found: false });
        const data = (await res.json()) as {
          status?: number;
          product?: {
            product_name?: string;
            brands?: string;
            quantity?: string;
            categories?: string;
            image_front_small_url?: string;
          };
        };
        if (data.status !== 1 || !data.product) return { found: false };
        return {
          found: true,
          source: "Open Food Facts (ODbL)",
          name: data.product.product_name ?? "",
          brand: data.product.brands ?? "",
          sizeLabel: data.product.quantity ?? "",
          categories: data.product.categories ?? "",
          imageUrl: data.product.image_front_small_url ?? null,
        };
      } catch {
        return { found: false, offline: true };
      }
    }
  );

  // Generate sanitized ZPL thermal shelf-tag labels with proper GS1 symbology
  app.post(
    "/api/labels/zpl",
    { preHandler: [requireRole(["owner", "manager", "stock_clerk"])] },
    async (req, reply) => {
      const schema = z.object({
        productIds: z.array(z.string().uuid()).min(1).max(100),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const rows = await db
        .select({
          sku: products.sku,
          name: products.name,
          aisle: products.aisleLocation,
          unitMode: products.unitMode,
          pluCode: products.pluCode,
          netContentAmount: products.netContentAmount,
          netContentUnit: products.netContentUnit,
          allergens: products.allergensJson,
          barcode: productBarcodes.barcode,
          packLabel: productBarcodes.packLabel,
          sellPriceCents: productBarcodes.sellPriceCents,
        })
        .from(products)
        .innerJoin(productBarcodes, eq(products.id, productBarcodes.productId))
        .where(
          and(inArray(products.id, parsed.data.productIds), eq(productBarcodes.isPrimary, true))
        );

      const zplBlocks = rows.map((r) => {
        const unitPrice = computeLegalUnitPrice(
          r.sellPriceCents,
          r.netContentAmount,
          (r.netContentUnit as "g" | "ml" | "ea" | null) ?? null,
          (r.unitMode as "each" | "weight_g" | "volume_ml") ?? "each"
        );
        const allergenLine =
          Array.isArray(r.allergens) && r.allergens.length > 0
            ? `ALLERGENS: ${r.allergens.map((a) => a.toUpperCase()).join(", ")}`
            : "";
        const pluPart = r.pluCode ? `  |  PLU ${sanitizeZpl(r.pluCode)}` : "";
        return `^XA
^PW460
^LL280
^CF0,26
^FO20,14^FD${sanitizeZpl(r.name).slice(0, 34)}^FS
^CF0,18
^FO20,46^FD${sanitizeZpl(r.sku)}  |  ${sanitizeZpl(r.packLabel)}${pluPart}  |  ${sanitizeZpl(r.aisle)}^FS
^CF0,50
^FO20,74^FD${formatMoney(r.sellPriceCents)}^FS${
          unitPrice ? `\n^CF0,18\n^FO250,94^FD(${sanitizeZpl(unitPrice)})^FS` : ""
        }${
          allergenLine
            ? `\n^CF0,16\n^FO20,130^FD${sanitizeZpl(allergenLine).slice(0, 48)}^FS`
            : ""
        }
^BY2,2,48
${buildZplBarcodeCommand(r.barcode)}
^XZ`;
      });

      return {
        labelCount: zplBlocks.length,
        zpl: zplBlocks.join("\n"),
      };
    }
  );

  // One-Click Food-Safety Product Recall POS-Block (owner/manager only)
  app.patch(
    "/api/products/:id/recall",
    { preHandler: [requireRole(["owner", "manager"])] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UuidSchema.safeParse(id).success) {
        return reply.status(400).send({ error: "Invalid product ID format." });
      }
      const parsed = RecallProductSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }

      const [existing] = await db
        .select({ id: products.id, sku: products.sku, name: products.name })
        .from(products)
        .where(eq(products.id, id))
        .limit(1);
      if (!existing) {
        return reply.status(404).send({ error: "Product not found." });
      }

      const nextRecalled = parsed.data.recalled;
      const nextReason = nextRecalled ? (parsed.data.reason?.trim() ?? "Food-safety recall") : null;

      const [updated] = await db
        .update(products)
        .set({
          recalled: nextRecalled,
          recallReason: nextReason,
          recalledAt: nextRecalled ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(eq(products.id, id))
        .returning({
          id: products.id,
          sku: products.sku,
          name: products.name,
          recalled: products.recalled,
          recallReason: products.recallReason,
          recalledAt: products.recalledAt,
        });

      await db.insert(auditLogs).values({
        actor: req.authUser!.fullName,
        action: nextRecalled ? "product_recall_activate" : "product_recall_clear",
        entityType: "product",
        entityId: updated.id,
        detailsJson: { sku: updated.sku, name: updated.name, reason: nextReason },
      });

      return { product: updated };
    }
  );
}
