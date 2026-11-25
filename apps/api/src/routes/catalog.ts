import type { FastifyInstance } from "fastify";
import {
  computeNetMarginBp,
  CreateProductSchema,
  CreatePromotionSchema,
  formatMoney,
  generateUuidV7,
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
  stockMovements,
  suppliers,
  taxRates,
  users,
} from "../db/index.js";
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
  // Metadata bootstrap for dropdowns, promos, and filters
  app.get("/api/meta", { preHandler: [requireAuth] }, async (req) => {
    const [depts, cats, taxes, sups, promos, staff] = await Promise.all([
      db.select().from(departments).orderBy(asc(departments.name)),
      db.select().from(categories).orderBy(asc(categories.name)),
      db.select().from(taxRates).orderBy(asc(taxRates.rateBp)),
      db.select().from(suppliers).orderBy(asc(suppliers.name)),
      db
        .select()
        .from(promotions)
        .where(eq(promotions.active, true))
        .orderBy(asc(promotions.priority)),
      req.authUser?.role === "owner" || req.authUser?.role === "manager"
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
    const page = Number.isFinite(rawPage) ? Math.max(1, Math.trunc(rawPage)) : 1;
    const pageSize = Number.isFinite(rawPageSize)
      ? Math.min(100, Math.max(10, Math.trunc(rawPageSize)))
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
          avgCostCents: products.avgCostCents,
          minMarginBp: products.minMarginBp,
          requiresAgeCheck: products.requiresAgeCheck,
          trackExpiry: products.trackExpiry,
          expiryAlertDays: products.expiryAlertDays,
          aisleLocation: products.aisleLocation,
          active: products.active,
          baselineQty: sql<number>`coalesce(${stockBaselines.quantity}, 0)::int`,
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
    const [bcs, nextBatches, unfoldedRows] = await Promise.all([
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
      db
        .select({
          productId: stockMovements.productId,
          delta: sql<number>`coalesce(sum(${stockMovements.qtyDelta}), 0)::int`,
        })
        .from(stockMovements)
        .where(
          and(
            eq(stockMovements.folded, false),
            inArray(stockMovements.productId, pIds)
          )
        )
        .groupBy(stockMovements.productId),
    ]);

    const bcMap = new Map<string, (typeof bcs)[number][]>();
    for (const bc of bcs) {
      const list = bcMap.get(bc.productId) ?? [];
      list.push(bc);
      bcMap.set(bc.productId, list);
    }
    const expiryMap = new Map(nextBatches.map((b) => [b.productId, b.earliestExpiry]));
    const unfoldedMap = new Map(unfoldedRows.map((u) => [u.productId, Number(u.delta ?? 0)]));

    const items = rows.map((r) => {
      const barcodes = bcMap.get(r.id) ?? [];
      const primaryBc = barcodes.find((b) => b.isPrimary) ?? barcodes[0];
      const primarySell = primaryBc?.sellPriceCents ?? 0;
      const primaryPackQty = primaryBc?.packQty ?? 1;
      const onHandUnits = Number(r.baselineQty ?? 0) + (unfoldedMap.get(r.id) ?? 0);
      const marginBp = computeNetMarginBp(
        primarySell,
        r.avgCostCents * primaryPackQty,
        r.taxRateBp,
        r.taxInclusive
      );
      const { baselineQty: _baselineQty, ...rest } = r;
      return {
        ...rest,
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

  // Sub-5ms POS barcode resolution (single consistent query for live stock)
  app.get("/api/products/scan/:barcode", { preHandler: [requireAuth] }, async (req, reply) => {
    const { barcode } = req.params as { barcode: string };
    const clean = barcode.trim();

    const [found] = await db
      .select({
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
      })
      .from(productBarcodes)
      .innerJoin(products, eq(productBarcodes.productId, products.id))
      .innerJoin(taxRates, eq(products.taxRateId, taxRates.id))
      .leftJoin(stockBaselines, eq(products.id, stockBaselines.productId))
      .where(eq(productBarcodes.barcode, clean))
      .limit(1);

    if (!found) {
      return reply.status(404).send({ error: "Barcode not found", barcode: clean });
    }

    return found;
  });

  // Create new product with Multi-UOM barcodes
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
      const allForProduct = await db
        .select()
        .from(productBarcodes)
        .where(eq(productBarcodes.productId, id));

      const target = allForProduct.find((b) => b.id === barcodeId);
      if (!target) {
        return reply.status(404).send({ error: "Barcode not found" });
      }
      if (allForProduct.length <= 1) {
        return reply.status(409).send({
          error: "Cannot delete the last remaining barcode on a product.",
        });
      }
      if (target.isPrimary) {
        return reply.status(409).send({
          error: "Cannot delete the primary barcode directly. Assign another primary barcode first.",
        });
      }

      await db
        .delete(productBarcodes)
        .where(and(eq(productBarcodes.id, barcodeId), eq(productBarcodes.productId, id)));
      return { deleted: true, barcodeId };
    }
  );

  // Bulk CSV Onboarding Preview & Validation (RFC-4180 parser + GS1 check digits + net margin)
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

      const existingBarcodes = new Set(
        (await db.select({ barcode: productBarcodes.barcode }).from(productBarcodes)).map(
          (b) => b.barcode
        )
      );

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
          marginBp: computeNetMarginBp(sellPriceCents, unitCostCents * packQty, 1000, true),
          categoryName,
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

  // Commit validated CSV import rows into PostgreSQL (re-validates GS1 + margin server-side)
  app.post(
    "/api/import/commit",
    { preHandler: [requireRole(["owner", "manager"]), importLimiter] },
    async (req, reply) => {
      const schema = z.object({
        rows: z.array(
          z.object({
            sku: z.string().min(1),
            name: z.string().min(1),
            brand: z.string().min(1),
            barcode: z.string().min(4),
            packQty: z.number().int().min(1),
            packLabel: z.string().min(1),
            unitCostCents: z.number().int().min(0),
            sellPriceCents: z.number().int().min(1),
            categoryName: z.string().optional(),
          })
        ),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const [allCats, allTaxes] = await Promise.all([
        db.select().from(categories),
        db.select().from(taxRates),
      ]);
      const defaultCat = allCats[0];
      const defaultTax = allTaxes.find((t) => t.code === "STD") ?? allTaxes[0];

      let imported = 0;
      let skipped = 0;
      const errors: { sku: string; reason: string }[] = [];

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

        const cat =
          allCats.find((c) => c.name.toLowerCase() === (r.categoryName ?? "").toLowerCase()) ??
          defaultCat;
        const productId = generateUuidV7();
        try {
          await db.transaction(async (tx) => {
            await tx.insert(products).values({
              id: productId,
              sku: r.sku,
              name: r.name,
              brand: r.brand,
              categoryId: cat.id,
              taxRateId: defaultTax.id,
              avgCostCents: r.unitCostCents,
              baseUnitLabel: "unit",
            });
            await tx.insert(productBarcodes).values({
              productId,
              barcode: bcCheck.normalized,
              packQty: r.packQty,
              packLabel: r.packLabel,
              sellPriceCents: r.sellPriceCents,
              isPrimary: true,
            });
            await tx.insert(stockBaselines).values({ productId, quantity: 0 });
          });
          imported++;
        } catch (err) {
          skipped++;
          errors.push({
            sku: r.sku,
            reason: err instanceof Error ? err.message : "Database conflict",
          });
        }
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

  // Open Food Facts Barcode Auto-Enrichment Helper
  app.get(
    "/api/lookup/barcode/:barcode",
    { preHandler: [requireRole(["owner", "manager", "stock_clerk"])] },
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
          barcode: productBarcodes.barcode,
          packLabel: productBarcodes.packLabel,
          sellPriceCents: productBarcodes.sellPriceCents,
        })
        .from(products)
        .innerJoin(productBarcodes, eq(products.id, productBarcodes.productId))
        .where(
          and(inArray(products.id, parsed.data.productIds), eq(productBarcodes.isPrimary, true))
        );

      const zplBlocks = rows.map(
        (r) => `^XA
^PW460
^LL240
^CF0,28
^FO20,18^FD${sanitizeZpl(r.name).slice(0, 34)}^FS
^CF0,20
^FO20,54^FD${sanitizeZpl(r.sku)}  |  ${sanitizeZpl(r.packLabel)}  |  Aisle ${sanitizeZpl(r.aisle)}^FS
^CF0,56
^FO20,86^FD${formatMoney(r.sellPriceCents)}^FS
^BY2,2,52
${buildZplBarcodeCommand(r.barcode)}
^XZ`
      );

      return {
        labelCount: zplBlocks.length,
        zpl: zplBlocks.join("\n"),
      };
    }
  );
}
