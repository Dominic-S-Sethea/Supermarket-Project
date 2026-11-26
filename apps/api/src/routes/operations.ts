import type { FastifyInstance } from "fastify";
import {
  ApplyDynamicMarkdownSchema,
  CompleteFloorTaskSchema,
  computeSuggestedSellPriceCents,
  formatMoney,
  GenerateStaffingPlanSchema,
  generateUuidV7,
  PrintShelfTagBatchSchema,
  UpdateStaffingPlanSchema,
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
  sales,
  shelfTagQueue,
  shiftRosters,
  stockBaselines,
  stockMovements,
  storeFootfall,
  storeTasks,
  taxRates,
  users,
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

        const [lockedMd] = await tx
          .select()
          .from(analyticsDynamicMarkdowns)
          .where(eq(analyticsDynamicMarkdowns.batchId, batchId))
          .for("update");
        if (lockedMd && lockedMd.status === "applied") {
          return {
            errorStatus: 409 as const,
            error: "Dynamic markdown has already been applied to this batch.",
          };
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
        // Synchronize effective promotion discountBp with the clamped shelf price so POS matches shelf tag
        const effectiveDiscountBp = Math.max(
          0,
          Math.min(
            parsed.data.discountBp,
            Math.round(((basePriceCents - promoPriceCents) * 10000) / Math.max(1, basePriceCents))
          )
        );

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
        const discountPctLabel = Math.round(effectiveDiscountBp / 100);
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
              discountBp: effectiveDiscountBp,
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
            requestedDiscountBp: parsed.data.discountBp,
            discountBp: effectiveDiscountBp,
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
          discountBp: effectiveDiscountBp,
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

  // =========================================================================
  // MILESTONE 3: HOURLY LANE STAFFING PLANNER
  // =========================================================================
  app.get(
    "/api/operations/staffing-plan",
    { preHandler: [requireRole(["owner", "manager", "accountant"])] },
    async (req, reply) => {
      const q = req.query as { date?: string };
      const planDate = q.date?.trim() || new Date().toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(planDate)) {
        return reply.status(400).send({ error: "Invalid date format (expected YYYY-MM-DD)." });
      }

      const [slots, staffOptions] = await Promise.all([
        db
          .select()
          .from(shiftRosters)
          .where(eq(shiftRosters.planDate, planDate))
          .orderBy(asc(shiftRosters.hour)),
        db
          .select({
            id: users.id,
            fullName: users.fullName,
            role: users.role,
          })
          .from(users)
          .where(and(eq(users.active, true), inArray(users.role, ["cashier", "manager", "owner"])))
          .orderBy(asc(users.role), asc(users.fullName)),
      ]);

      const peakLanes = slots.reduce((m, s) => Math.max(m, s.recommendedLanes), 0);
      const totalPredictedEntries = Math.round(
        slots.reduce((s, r) => s + r.predictedEntries, 0)
      );
      const assignedSlots = slots.filter((s) => Boolean(s.assignedStaffId || s.assignedCashierName)).length;
      const confirmedSlots = slots.filter(
        (s) => s.status === "confirmed" || s.status === "completed"
      ).length;

      return {
        planDate,
        summary: {
          totalHours: slots.length,
          peakLanes,
          totalPredictedEntries,
          assignedSlots,
          confirmedSlots,
        },
        staffOptions,
        slots,
      };
    }
  );

  app.post(
    "/api/operations/staffing-plan/generate",
    { preHandler: [requireRole(["owner", "manager"])] },
    async (req, reply) => {
      const parsed = GenerateStaffingPlanSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const { planDate, shiftBucket } = parsed.data;
      const cutoff = new Date(Date.now() - 28 * 86400_000);

      // Compute trailing 28-day hourly averages for door entries and POS receipts
      const [ffRows, txRows] = await Promise.all([
        db.execute(sql`
          SELECT
            EXTRACT(HOUR FROM ${storeFootfall.bucketStart})::int AS hr,
            coalesce(sum(${storeFootfall.entries})::double precision / NULLIF(count(DISTINCT date(${storeFootfall.bucketStart})), 0), 0) AS avg_entries
          FROM ${storeFootfall}
          WHERE ${storeFootfall.bucketStart} >= ${cutoff}
          GROUP BY 1
        `),
        db.execute(sql`
          SELECT
            EXTRACT(HOUR FROM ${sales.soldAt})::int AS hr,
            coalesce(count(*)::double precision / NULLIF(count(DISTINCT date(${sales.soldAt})), 0), 0) AS avg_txns
          FROM ${sales}
          WHERE ${sales.kind} = 'sale' AND ${sales.soldAt} >= ${cutoff}
          GROUP BY 1
        `),
      ]);

      const entriesByHour = new Map<number, number>();
      for (const r of ffRows.rows as { hr: number; avg_entries: number }[]) {
        entriesByHour.set(Number(r.hr), Number(r.avg_entries) || 0);
      }
      const txnsByHour = new Map<number, number>();
      for (const r of txRows.rows as { hr: number; avg_txns: number }[]) {
        txnsByHour.set(Number(r.hr), Number(r.avg_txns) || 0);
      }

      const hours = Array.from({ length: 14 }, (_, i) => i + 8).filter((h) => {
        if (!shiftBucket) return true;
        if (shiftBucket === "morning") return h >= 8 && h < 12;
        if (shiftBucket === "afternoon") return h >= 12 && h < 17;
        return h >= 17 && h <= 21;
      });

      const slots = await db.transaction(async (tx) => {
        const upserted = [];
        for (const hr of hours) {
          const bucket = hr < 12 ? "morning" : hr < 17 ? "afternoon" : "evening";
          const predEntries = Number((entriesByHour.get(hr) ?? (hr >= 17 ? 52 : hr < 12 ? 34 : 44)).toFixed(1));
          const predTxns = Number((txnsByHour.get(hr) ?? Math.max(6, predEntries * 0.62)).toFixed(1));
          const recLanes = Math.min(6, Math.max(1, Math.ceil(predEntries / 30)));

          const [row] = await tx
            .insert(shiftRosters)
            .values({
              planDate,
              hour: hr,
              shiftBucket: bucket,
              predictedEntries: predEntries,
              predictedTransactions: predTxns,
              recommendedLanes: recLanes,
              status: "planned",
            })
            .onConflictDoUpdate({
              target: [shiftRosters.planDate, shiftRosters.hour],
              set: {
                shiftBucket: bucket,
                predictedEntries: predEntries,
                predictedTransactions: predTxns,
                recommendedLanes: recLanes,
              },
            })
            .returning();
          upserted.push(row);
        }

        await tx.insert(auditLogs).values({
          actor: req.authUser!.fullName,
          action: "staffing_plan_generate",
          entityType: "shift_roster",
          entityId: upserted[0]?.id ?? null,
          detailsJson: { planDate, shiftBucket: shiftBucket ?? "all", slots: upserted.length },
        });
        return upserted;
      });

      return reply.status(201).send({ planDate, generatedCount: slots.length, slots });
    }
  );

  app.patch(
    "/api/operations/staffing-plan/:id",
    { preHandler: [requireRole(["owner", "manager"])] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UuidSchema.safeParse(id).success) {
        return reply.status(400).send({ error: "Invalid staffing slot ID format." });
      }
      const parsed = UpdateStaffingPlanSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const data = parsed.data;
      const patch: Partial<typeof shiftRosters.$inferInsert> = {};

      if (data.assignedStaffId !== undefined) {
        if (data.assignedStaffId === null) {
          patch.assignedStaffId = null;
          patch.assignedCashierName = data.assignedCashierName ?? null;
        } else {
          const [staff] = await db
            .select({ id: users.id, fullName: users.fullName })
            .from(users)
            .where(eq(users.id, data.assignedStaffId))
            .limit(1);
          if (!staff) return reply.status(404).send({ error: "Assigned staff user not found." });
          patch.assignedStaffId = staff.id;
          patch.assignedCashierName = data.assignedCashierName ?? staff.fullName;
        }
      } else if (data.assignedCashierName !== undefined) {
        patch.assignedCashierName = data.assignedCashierName;
      }

      if (data.status !== undefined) patch.status = data.status;
      if (data.recommendedLanes !== undefined) patch.recommendedLanes = data.recommendedLanes;

      if (Object.keys(patch).length === 0) {
        return reply.status(400).send({ error: "Provide at least one field to update." });
      }

      const [updated] = await db
        .update(shiftRosters)
        .set(patch)
        .where(eq(shiftRosters.id, id))
        .returning();

      if (!updated) return reply.status(404).send({ error: "Staffing slot not found." });

      await db.insert(auditLogs).values({
        actor: req.authUser!.fullName,
        action: "staffing_slot_update",
        entityType: "shift_roster",
        entityId: updated.id,
        detailsJson: patch,
      });

      return { slot: updated };
    }
  );

  // =========================================================================
  // MILESTONE 3: DAILY FLOOR TASK CHECKLIST (RESTOCK, COUNTS, TAGS, MARKDOWNS)
  // =========================================================================
  app.get(
    "/api/operations/tasks",
    { preHandler: [requireRole(["owner", "manager", "stock_clerk", "accountant"])] },
    async (req, reply) => {
      const q = req.query as { date?: string; status?: string; taskType?: string };
      const rawDate = q.date?.trim();
      const targetDate = rawDate && rawDate !== "all" ? rawDate : rawDate === "all" ? null : new Date().toISOString().slice(0, 10);
      if (targetDate && !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
        return reply.status(400).send({ error: "Invalid date format (expected YYYY-MM-DD or all)." });
      }

      const conditions = [];
      if (targetDate) conditions.push(eq(storeTasks.taskDate, targetDate));
      if (q.status && q.status !== "all") {
        if (!["pending", "completed", "skipped"].includes(q.status)) {
          return reply.status(400).send({ error: "Invalid task status filter." });
        }
        conditions.push(eq(storeTasks.status, q.status));
      }
      if (q.taskType && q.taskType !== "all") {
        if (!["restock", "cycle_count", "shelf_tag", "expiry_markdown"].includes(q.taskType)) {
          return reply.status(400).send({ error: "Invalid taskType filter." });
        }
        conditions.push(eq(storeTasks.taskType, q.taskType));
      }

      const tasks = await db
        .select({
          id: storeTasks.id,
          taskDate: storeTasks.taskDate,
          shiftBucket: storeTasks.shiftBucket,
          taskType: storeTasks.taskType,
          priority: storeTasks.priority,
          title: storeTasks.title,
          aisleLocation: storeTasks.aisleLocation,
          productId: storeTasks.productId,
          sku: products.sku,
          productName: products.name,
          targetQty: storeTasks.targetQty,
          status: storeTasks.status,
          completedBy: storeTasks.completedBy,
          completedAt: storeTasks.completedAt,
          completionNote: storeTasks.completionNote,
          createdAt: storeTasks.createdAt,
        })
        .from(storeTasks)
        .leftJoin(products, eq(storeTasks.productId, products.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(asc(storeTasks.status), asc(storeTasks.priority), desc(storeTasks.createdAt))
        .limit(120);

      const summary = {
        total: tasks.length,
        pending: tasks.filter((t) => t.status === "pending").length,
        completed: tasks.filter((t) => t.status === "completed").length,
        urgentPending: tasks.filter((t) => t.status === "pending" && t.priority === 1).length,
      };

      return { date: targetDate ?? "all", summary, tasks };
    }
  );

  app.post(
    "/api/operations/tasks/:id/complete",
    { preHandler: [requireRole(["owner", "manager", "stock_clerk"])] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UuidSchema.safeParse(id).success) {
        return reply.status(400).send({ error: "Invalid floor task ID format." });
      }
      const parsed = CompleteFloorTaskSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const actorName = req.authUser!.fullName;
      const result = await db.transaction(async (tx) => {
        const [task] = await tx
          .select()
          .from(storeTasks)
          .where(eq(storeTasks.id, id))
          .for("update");
        if (!task) return { errorStatus: 404 as const, error: "Floor task not found." };
        if (task.status === "completed") {
          return {
            errorStatus: 409 as const,
            error: "Floor task has already been completed.",
          };
        }

        let stockVarianceUnits: number | null = null;
        if (
          task.taskType === "cycle_count" &&
          parsed.data.actualQty !== undefined &&
          task.productId
        ) {
          const [lockedProd] = await tx
            .select({ id: products.id, avgCostCents: products.avgCostCents })
            .from(products)
            .where(eq(products.id, task.productId))
            .for("update");
          if (lockedProd) {
            const [baseline] = await tx
              .select({ quantity: stockBaselines.quantity })
              .from(stockBaselines)
              .where(eq(stockBaselines.productId, lockedProd.id))
              .limit(1);
            const [unfolded] = await tx
              .select({
                delta: sql<number>`coalesce(sum(${stockMovements.qtyDelta}), 0)::int`,
              })
              .from(stockMovements)
              .where(
                and(eq(stockMovements.productId, lockedProd.id), eq(stockMovements.folded, false))
              );
            const expected = Number(baseline?.quantity ?? 0) + Number(unfolded?.delta ?? 0);
            const variance = parsed.data.actualQty - expected;
            stockVarianceUnits = variance;
            if (variance !== 0) {
              await tx.insert(stockMovements).values({
                id: generateUuidV7(),
                productId: lockedProd.id,
                qtyDelta: variance,
                unitCostCents: lockedProd.avgCostCents,
                reason: "count_adj",
                folded: false,
              });
            }
            await tx
              .update(analyticsPhantomStock)
              .set({
                status: variance === 0 ? "verified_ok" : "recounted",
                bookStockUnits: parsed.data.actualQty,
                estimatedValueAtRiskCents: 0,
              })
              .where(eq(analyticsPhantomStock.productId, lockedProd.id));
          }
        }

        const [updated] = await tx
          .update(storeTasks)
          .set({
            status: "completed",
            completedBy: actorName,
            completedAt: new Date(),
            completionNote: parsed.data.note ?? null,
          })
          .where(eq(storeTasks.id, id))
          .returning();

        await tx.insert(auditLogs).values({
          actor: actorName,
          action: "floor_task_complete",
          entityType: "store_task",
          entityId: updated.id,
          detailsJson: {
            taskType: updated.taskType,
            title: updated.title,
            actualQty: parsed.data.actualQty ?? null,
            stockVarianceUnits,
            note: parsed.data.note ?? null,
          },
        });

        return { errorStatus: null, task: updated, stockVarianceUnits };
      });

      if (result.errorStatus) {
        return reply.status(result.errorStatus).send({ error: result.error });
      }
      return { task: result.task, stockVarianceUnits: result.stockVarianceUnits };
    }
  );
}
