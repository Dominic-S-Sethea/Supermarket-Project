import type { FastifyInstance } from "fastify";
import {
  ApplyDynamicMarkdownSchema,
  computeSuggestedSellPriceCents,
  formatMoney,
  generateUuidV7,
  PrintShelfTagBatchSchema,
} from "@supermarket/shared";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  analyticsDynamicMarkdowns,
  analyticsPhantomStock,
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
  taxRates,
} from "../db/index.js";
import { buildZplBarcodeCommand, sanitizeZpl } from "../lib/helpers.js";
import { requireRole } from "../plugins/auth.js";

const UuidSchema = z.string().uuid();

const VerifyPhantomStockSchema = z
  .object({
    countedBaseUnits: z.number().int().min(0).max(500_000).optional(),
    markVerifiedOk: z.boolean().optional(),
    note: z.string().max(300).optional(),
  })
  .refine((d) => d.markVerifiedOk === true || d.countedBaseUnits !== undefined, {
    message: "Provide countedBaseUnits or set markVerifiedOk: true",
  });

export async function operationsRoutes(app: FastifyInstance) {
  // =========================================================================
  // MILESTONE 2: PHANTOM STOCK DETECTOR & BLIND VERIFICATION
  // =========================================================================
  app.get(
    "/api/inventory/phantom-stock",
    { preHandler: [requireRole(["owner", "manager", "stock_clerk", "accountant"])] },
    async (req, reply) => {
      const q = req.query as { status?: string };
      const conditions = [];
      if (q.status && q.status !== "all") {
        if (!["open", "verified_ok", "recounted"].includes(q.status)) {
          return reply.status(400).send({ error: "Invalid phantom stock status filter." });
        }
        conditions.push(eq(analyticsPhantomStock.status, q.status));
      }

      const items = await db
        .select({
          productId: analyticsPhantomStock.productId,
          sku: products.sku,
          name: products.name,
          brand: products.brand,
          aisleLocation: products.aisleLocation,
          departmentName: departments.name,
          avgCostCents: products.avgCostCents,
          bookStockUnits: analyticsPhantomStock.bookStockUnits,
          avgDailyUnits: analyticsPhantomStock.avgDailyUnits,
          daysSinceLastSale: analyticsPhantomStock.daysSinceLastSale,
          voidRefundScore: analyticsPhantomStock.voidRefundScore,
          phantomProb: analyticsPhantomStock.phantomProb,
          estimatedValueAtRiskCents: analyticsPhantomStock.estimatedValueAtRiskCents,
          status: analyticsPhantomStock.status,
          computedAt: analyticsPhantomStock.computedAt,
        })
        .from(analyticsPhantomStock)
        .innerJoin(products, eq(analyticsPhantomStock.productId, products.id))
        .innerJoin(categories, eq(products.categoryId, categories.id))
        .innerJoin(departments, eq(categories.departmentId, departments.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(analyticsPhantomStock.phantomProb))
        .limit(80);

      const aggRows = await db
        .select({
          status: analyticsPhantomStock.status,
          cnt: sql<number>`count(*)::int`,
          atRiskCents: sql<number>`coalesce(sum(${analyticsPhantomStock.estimatedValueAtRiskCents}), 0)::bigint`,
          avgProb: sql<number>`coalesce(avg(${analyticsPhantomStock.phantomProb}), 0)::double precision`,
        })
        .from(analyticsPhantomStock)
        .groupBy(analyticsPhantomStock.status);

      let totalFlagged = 0;
      let openCount = 0;
      let openAtRiskCents = 0;
      let weightedProbSum = 0;
      for (const r of aggRows) {
        const cnt = Number(r.cnt);
        totalFlagged += cnt;
        weightedProbSum += Number(r.avgProb) * cnt;
        if (r.status === "open") {
          openCount += cnt;
          openAtRiskCents += Number(r.atRiskCents);
        }
      }

      return {
        summary: {
          totalFlagged,
          openCount,
          verifiedCount: totalFlagged - openCount,
          openAtRiskCents,
          avgPhantomProb: totalFlagged > 0 ? Number((weightedProbSum / totalFlagged).toFixed(3)) : 0,
        },
        items,
      };
    }
  );

  app.post(
    "/api/inventory/phantom-stock/:productId/verify",
    { preHandler: [requireRole(["owner", "manager", "stock_clerk"])] },
    async (req, reply) => {
      const { productId } = req.params as { productId: string };
      if (!UuidSchema.safeParse(productId).success) {
        return reply.status(400).send({ error: "Invalid productId format." });
      }
      const parsed = VerifyPhantomStockSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const actorName = req.authUser!.fullName;
      const result = await db.transaction(async (tx) => {
        const [lockedProd] = await tx
          .select({
            id: products.id,
            sku: products.sku,
            avgCostCents: products.avgCostCents,
          })
          .from(products)
          .where(eq(products.id, productId))
          .for("update");
        if (!lockedProd) return { notFound: "product" as const };

        const [phantom] = await tx
          .select()
          .from(analyticsPhantomStock)
          .where(eq(analyticsPhantomStock.productId, productId))
          .for("update");
        if (!phantom) return { notFound: "phantom" as const };

        const [baseline] = await tx
          .select({ quantity: stockBaselines.quantity })
          .from(stockBaselines)
          .where(eq(stockBaselines.productId, productId))
          .limit(1);
        const [unfolded] = await tx
          .select({
            delta: sql<number>`coalesce(sum(${stockMovements.qtyDelta}), 0)::int`,
          })
          .from(stockMovements)
          .where(and(eq(stockMovements.productId, productId), eq(stockMovements.folded, false)));

        const expectedUnits = Number(baseline?.quantity ?? 0) + Number(unfolded?.delta ?? 0);
        const countedUnits =
          parsed.data.markVerifiedOk && parsed.data.countedBaseUnits === undefined
            ? expectedUnits
            : parsed.data.countedBaseUnits!;
        const varianceUnits = countedUnits - expectedUnits;
        const nextStatus =
          parsed.data.markVerifiedOk || varianceUnits === 0 ? "verified_ok" : "recounted";

        if (varianceUnits !== 0) {
          await tx.insert(stockMovements).values({
            id: generateUuidV7(),
            productId,
            qtyDelta: varianceUnits,
            unitCostCents: lockedProd.avgCostCents,
            reason: "count_adj",
            folded: false,
          });
        }

        await tx
          .update(analyticsPhantomStock)
          .set({
            status: nextStatus,
            bookStockUnits: countedUnits,
            estimatedValueAtRiskCents: 0,
          })
          .where(eq(analyticsPhantomStock.productId, productId));

        await tx.insert(auditLogs).values({
          actor: actorName,
          action: "phantom_stock_verify",
          entityType: "product",
          entityId: productId,
          detailsJson: {
            sku: lockedProd.sku,
            expectedUnits,
            countedUnits,
            varianceUnits,
            status: nextStatus,
            note: parsed.data.note ?? null,
          },
        });

        return {
          notFound: null,
          productId,
          status: nextStatus,
          expectedUnits,
          countedUnits,
          varianceUnits,
          varianceCostCents: varianceUnits * lockedProd.avgCostCents,
        };
      });

      if (result.notFound === "product") {
        return reply.status(404).send({ error: "Product not found." });
      }
      if (result.notFound === "phantom") {
        return reply.status(404).send({ error: "Phantom stock alert not found for this SKU." });
      }
      return result;
    }
  );

  // =========================================================================
  // MILESTONE 2: DYNAMIC FEFO MARKDOWN OPTIMIZER
  // =========================================================================
  app.get(
    "/api/inventory/dynamic-markdowns",
    { preHandler: [requireRole(["owner", "manager", "stock_clerk", "accountant"])] },
    async (req, reply) => {
      const q = req.query as { status?: string };
      const conditions = [];
      if (q.status && q.status !== "all") {
        if (!["recommended", "applied"].includes(q.status)) {
          return reply.status(400).send({ error: "Invalid dynamic markdown status filter." });
        }
        conditions.push(eq(analyticsDynamicMarkdowns.status, q.status));
      }

      const rows = await db
        .select({
          batchId: analyticsDynamicMarkdowns.batchId,
          productId: analyticsDynamicMarkdowns.productId,
          sku: products.sku,
          name: products.name,
          brand: products.brand,
          aisleLocation: products.aisleLocation,
          departmentName: departments.name,
          lotCode: inventoryBatches.lotCode,
          bestBeforeDate: inventoryBatches.bestBeforeDate,
          daysLeft: analyticsDynamicMarkdowns.daysLeft,
          qtyRemaining: analyticsDynamicMarkdowns.qtyRemaining,
          currentSellPriceCents: analyticsDynamicMarkdowns.currentSellPriceCents,
          unitCostCents: analyticsDynamicMarkdowns.unitCostCents,
          recommendedDiscountBp: analyticsDynamicMarkdowns.recommendedDiscountBp,
          recommendedPromoPriceCents: analyticsDynamicMarkdowns.recommendedPromoPriceCents,
          predictedClearanceUnits: analyticsDynamicMarkdowns.predictedClearanceUnits,
          expectedRecoveryCents: analyticsDynamicMarkdowns.expectedRecoveryCents,
          baselineNoPromoRecoveryCents: analyticsDynamicMarkdowns.baselineNoPromoRecoveryCents,
          status: analyticsDynamicMarkdowns.status,
          computedAt: analyticsDynamicMarkdowns.computedAt,
        })
        .from(analyticsDynamicMarkdowns)
        .innerJoin(inventoryBatches, eq(analyticsDynamicMarkdowns.batchId, inventoryBatches.id))
        .innerJoin(products, eq(analyticsDynamicMarkdowns.productId, products.id))
        .innerJoin(categories, eq(products.categoryId, categories.id))
        .innerJoin(departments, eq(categories.departmentId, departments.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(asc(analyticsDynamicMarkdowns.daysLeft), desc(analyticsDynamicMarkdowns.expectedRecoveryCents))
        .limit(80);

      const items = rows.map((r) => ({
        ...r,
        incrementalRecoveryCents: r.expectedRecoveryCents - r.baselineNoPromoRecoveryCents,
      }));

      const aggRows = await db
        .select({
          status: analyticsDynamicMarkdowns.status,
          cnt: sql<number>`count(*)::int`,
          expectedSum: sql<number>`coalesce(sum(${analyticsDynamicMarkdowns.expectedRecoveryCents}), 0)::bigint`,
          baselineSum: sql<number>`coalesce(sum(${analyticsDynamicMarkdowns.baselineNoPromoRecoveryCents}), 0)::bigint`,
        })
        .from(analyticsDynamicMarkdowns)
        .groupBy(analyticsDynamicMarkdowns.status);

      let recommendedCount = 0;
      let appliedCount = 0;
      let incrementalRecoveryCents = 0;
      let totalRecommendedRecoveryCents = 0;
      for (const r of aggRows) {
        if (r.status === "recommended") {
          recommendedCount += Number(r.cnt);
          totalRecommendedRecoveryCents += Number(r.expectedSum);
          incrementalRecoveryCents += Number(r.expectedSum) - Number(r.baselineSum);
        } else if (r.status === "applied") {
          appliedCount += Number(r.cnt);
        }
      }

      return {
        summary: {
          recommendedCount,
          appliedCount,
          incrementalRecoveryCents,
          totalRecommendedRecoveryCents,
        },
        items,
      };
    }
  );

  app.post(
    "/api/inventory/dynamic-markdowns/:batchId/apply",
    { preHandler: [requireRole(["owner", "manager"])] },
    async (req, reply) => {
      const { batchId } = req.params as { batchId: string };
      if (!UuidSchema.safeParse(batchId).success) {
        return reply.status(400).send({ error: "Invalid batchId format." });
      }
      const parsed = ApplyDynamicMarkdownSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const actorName = req.authUser!.fullName;
      const outcome = await db.transaction(async (tx) => {
        const [lockedBatch] = await tx
          .select()
          .from(inventoryBatches)
          .where(eq(inventoryBatches.id, batchId))
          .for("update");
        if (!lockedBatch) return { errorStatus: 404 as const, error: "Inventory batch not found." };
        if (lockedBatch.qtyRemaining <= 0) {
          return { errorStatus: 400 as const, error: "Batch has 0 remaining units." };
        }

        const [prod] = await tx
          .select({
            id: products.id,
            sku: products.sku,
            name: products.name,
            avgCostCents: products.avgCostCents,
            taxRateId: products.taxRateId,
          })
          .from(products)
          .where(eq(products.id, lockedBatch.productId))
          .limit(1);
        if (!prod) return { errorStatus: 404 as const, error: "Batch product not found." };

        const [primaryBc] = await tx
          .select()
          .from(productBarcodes)
          .where(
            and(
              eq(productBarcodes.productId, lockedBatch.productId),
              eq(productBarcodes.isPrimary, true)
            )
          )
          .limit(1);
        const [tax] = await tx
          .select({ rateBp: taxRates.rateBp, isInclusive: taxRates.isInclusive })
          .from(taxRates)
          .where(eq(taxRates.id, prod.taxRateId))
          .limit(1);

        const basePriceCents = primaryBc?.sellPriceCents ?? Math.max(100, prod.avgCostCents * 2);
        let promoPriceCents = Math.max(
          1,
          Math.round((basePriceCents * (10000 - parsed.data.discountBp)) / 10000)
        );
        if (
          parsed.data.minMarginGuardBp !== undefined &&
          parsed.data.minMarginGuardBp !== null &&
          prod.avgCostCents > 0
        ) {
          const packCost = prod.avgCostCents * (primaryBc?.packQty ?? 1);
          const guardPrice = computeSuggestedSellPriceCents(
            packCost,
            parsed.data.minMarginGuardBp,
            tax?.rateBp ?? 0,
            tax?.isInclusive ?? true,
            1
          );
          if (promoPriceCents < guardPrice) {
            promoPriceCents = Math.min(basePriceCents, guardPrice);
          }
        }

        await tx
          .update(inventoryBatches)
          .set({ status: "clearance" })
          .where(eq(inventoryBatches.id, batchId));

        const now = new Date();
        const endsAt = new Date(
          Math.max(
            now.getTime() + 7 * 86400_000,
            new Date(lockedBatch.bestBeforeDate).getTime() + 86400_000
          )
        );
        const discountPctLabel = Math.round(parsed.data.discountBp / 100);
        const [promo] = await tx
          .insert(promotions)
          .values({
            name: `Dynamic FEFO Markdown ${discountPctLabel}% Off: ${prod.name}`,
            promoType: "clearance",
            priority: 4,
            combinable: false,
            minMarginGuardBp: parsed.data.minMarginGuardBp ?? 0,
            startsAt: now,
            endsAt,
            active: true,
            rulesJson: {
              productIds: [lockedBatch.productId],
              discountBp: parsed.data.discountBp,
            },
          })
          .returning();

        let shelfTagId: string | null = null;
        if (primaryBc) {
          const [tag] = await tx
            .insert(shelfTagQueue)
            .values({
              productId: lockedBatch.productId,
              barcode: primaryBc.barcode,
              oldPriceCents: primaryBc.sellPriceCents,
              newPriceCents: promoPriceCents,
              reason: "clearance",
              status: "pending",
            })
            .returning();
          shelfTagId = tag.id;
        }

        await tx
          .update(analyticsDynamicMarkdowns)
          .set({ status: "applied" })
          .where(eq(analyticsDynamicMarkdowns.batchId, batchId));

        await tx.insert(auditLogs).values({
          actor: actorName,
          action: "dynamic_markdown_apply",
          entityType: "inventory_batch",
          entityId: batchId,
          detailsJson: {
            sku: prod.sku,
            discountBp: parsed.data.discountBp,
            promoPriceCents,
            promotionId: promo.id,
            shelfTagId,
          },
        });

        return {
          errorStatus: null,
          batchId,
          promotionId: promo.id,
          shelfTagId,
          discountBp: parsed.data.discountBp,
          promoPriceCents,
          status: "applied" as const,
        };
      });

      if (outcome.errorStatus) {
        return reply.status(outcome.errorStatus).send({ error: outcome.error });
      }
      return reply.status(201).send(outcome);
    }
  );

  // =========================================================================
  // MILESTONE 2: 07:30 SHELF TAG PRINT QUEUE & ZEBRA ZPL BATCH OUTPUT
  // =========================================================================
  app.get(
    "/api/labels/queue",
    { preHandler: [requireRole(["owner", "manager", "stock_clerk"])] },
    async (req, reply) => {
      const q = req.query as { status?: string };
      const conditions = [];
      if (q.status && q.status !== "all") {
        if (!["pending", "printed"].includes(q.status)) {
          return reply.status(400).send({ error: "Invalid shelf tag queue status filter." });
        }
        conditions.push(eq(shelfTagQueue.status, q.status));
      }

      const tags = await db
        .select({
          id: shelfTagQueue.id,
          productId: shelfTagQueue.productId,
          sku: products.sku,
          name: products.name,
          aisleLocation: products.aisleLocation,
          barcode: shelfTagQueue.barcode,
          oldPriceCents: shelfTagQueue.oldPriceCents,
          newPriceCents: shelfTagQueue.newPriceCents,
          reason: shelfTagQueue.reason,
          status: shelfTagQueue.status,
          printedBy: shelfTagQueue.printedBy,
          printedAt: shelfTagQueue.printedAt,
          createdAt: shelfTagQueue.createdAt,
        })
        .from(shelfTagQueue)
        .innerJoin(products, eq(shelfTagQueue.productId, products.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(asc(shelfTagQueue.status), desc(shelfTagQueue.createdAt))
        .limit(150);

      const summaryRows = await db
        .select({
          status: shelfTagQueue.status,
          cnt: sql<number>`count(*)::int`,
        })
        .from(shelfTagQueue)
        .groupBy(shelfTagQueue.status);

      let pendingCount = 0;
      let printedCount = 0;
      for (const r of summaryRows) {
        if (r.status === "pending") pendingCount += Number(r.cnt);
        if (r.status === "printed") printedCount += Number(r.cnt);
      }

      return {
        summary: { pendingCount, printedCount },
        tags,
      };
    }
  );

  app.post(
    "/api/labels/queue/print",
    { preHandler: [requireRole(["owner", "manager", "stock_clerk"])] },
    async (req, reply) => {
      const parsed = PrintShelfTagBatchSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const actorName = req.authUser!.fullName;
      const now = new Date();

      const rows = await db
        .select({
          id: shelfTagQueue.id,
          productId: shelfTagQueue.productId,
          sku: products.sku,
          name: products.name,
          aisle: products.aisleLocation,
          barcode: shelfTagQueue.barcode,
          oldPriceCents: shelfTagQueue.oldPriceCents,
          newPriceCents: shelfTagQueue.newPriceCents,
          reason: shelfTagQueue.reason,
        })
        .from(shelfTagQueue)
        .innerJoin(products, eq(shelfTagQueue.productId, products.id))
        .where(inArray(shelfTagQueue.id, parsed.data.tagIds));

      if (rows.length === 0) {
        return reply.status(404).send({ error: "No matching shelf tags found in queue." });
      }

      const foundIds = rows.map((r) => r.id);
      const zplBlocks = rows.map((r) => {
        const badge =
          r.reason === "clearance"
            ? "CLEARANCE"
            : r.reason === "promo"
              ? "PROMO"
              : r.reason === "cost_change"
                ? "PRICE UPD"
                : "SHELF TAG";
        const wasLine =
          r.oldPriceCents !== r.newPriceCents ? `WAS ${formatMoney(r.oldPriceCents)}  ` : "";
        return `^XA
^PW460
^LL240
^CF0,26
^FO20,16^FD${sanitizeZpl(r.name).slice(0, 34)}^FS
^CF0,18
^FO20,48^FD${sanitizeZpl(r.sku)} | Aisle ${sanitizeZpl(r.aisle)} | ${badge}^FS
^CF0,50
^FO20,76^FD${formatMoney(r.newPriceCents)}^FS
^CF0,18
^FO240,96^FD${sanitizeZpl(wasLine)}^FS
^BY2,2,50
${buildZplBarcodeCommand(r.barcode)}
^XZ`;
      });

      await db.transaction(async (tx) => {
        await tx
          .update(shelfTagQueue)
          .set({
            status: "printed",
            printedBy: actorName,
            printedAt: now,
          })
          .where(inArray(shelfTagQueue.id, foundIds));

        await tx.insert(auditLogs).values({
          actor: actorName,
          action: "shelf_tag_batch_print",
          entityType: "shelf_tag_queue",
          entityId: foundIds[0],
          detailsJson: {
            printedCount: foundIds.length,
            tagIds: foundIds,
          },
        });
      });

      return {
        printedCount: foundIds.length,
        printedBy: actorName,
        printedAt: now.toISOString(),
        tagIds: foundIds,
        zpl: zplBlocks.join("\n"),
      };
    }
  );
}
