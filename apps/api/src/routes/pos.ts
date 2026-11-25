import type { FastifyInstance } from "fastify";
import { generateUuidV7, PosSaleUploadSchema } from "@supermarket/shared";
import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  analyticsBasketRules,
  auditLogs,
  categories,
  db,
  inventoryBatches,
  posShifts,
  productBarcodes,
  products,
  promotions,
  saleLines,
  salePayments,
  sales,
  stockMovements,
  taxRates,
} from "../db/index.js";
import { requireAuth, requireRole } from "../plugins/auth.js";

export async function posRoutes(app: FastifyInstance) {
  // Lightweight offline-first bootstrap payload (includes basket upsell rules)
  app.get("/api/pos/bootstrap", { preHandler: [requireAuth] }, async () => {
    const [prods, bcs, promos, taxes, cats, rules] = await Promise.all([
      db
        .select({
          id: products.id,
          sku: products.sku,
          name: products.name,
          brand: products.brand,
          categoryId: products.categoryId,
          taxRateId: products.taxRateId,
          baseUnitLabel: products.baseUnitLabel,
          avgCostCents: products.avgCostCents,
          requiresAgeCheck: products.requiresAgeCheck,
          aisleLocation: products.aisleLocation,
        })
        .from(products)
        .where(eq(products.active, true)),
      db
        .select({
          id: productBarcodes.id,
          productId: productBarcodes.productId,
          barcode: productBarcodes.barcode,
          packQty: productBarcodes.packQty,
          packLabel: productBarcodes.packLabel,
          sellPriceCents: productBarcodes.sellPriceCents,
          isPrimary: productBarcodes.isPrimary,
        })
        .from(productBarcodes),
      db.select().from(promotions).where(eq(promotions.active, true)),
      db.select().from(taxRates),
      db.select().from(categories),
      db
        .select({
          shiftBucket: analyticsBasketRules.shiftBucket,
          antecedentProductId: analyticsBasketRules.antecedentProductId,
          consequentProductId: analyticsBasketRules.consequentProductId,
          consequentName: analyticsBasketRules.consequentName,
          confidence: analyticsBasketRules.confidence,
          lift: analyticsBasketRules.lift,
        })
        .from(analyticsBasketRules)
        .orderBy(desc(analyticsBasketRules.lift))
        .limit(65),
    ]);

    return {
      syncedAt: new Date().toISOString(),
      productCount: prods.length,
      barcodeCount: bcs.length,
      products: prods,
      barcodes: bcs,
      promotions: promos,
      taxRates: taxes,
      categories: cats,
      basketRules: rules,
    };
  });

  // Idempotent append-only POS sale upload (validates totals/payments, decrements FEFO batches)
  app.post(
    "/api/pos/sales",
    { preHandler: [requireRole(["owner", "manager", "cashier"])] },
    async (req, reply) => {
      const parsed = PosSaleUploadSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const payload = parsed.data;
      const actor = req.authUser!;

      if ((payload.kind === "refund" || payload.kind === "void") && !["owner", "manager"].includes(actor.role)) {
        return reply.status(403).send({
          error: "Manager or Owner approval required to post refunds or voids.",
        });
      }

      for (const l of payload.lines) {
        const lineGross = l.unitPriceCents * l.qtyPacks;
        if (l.discountCents > lineGross || l.lineTotalCents > lineGross) {
          return reply.status(400).send({
            error: `Invalid line pricing/discount on product ${l.productId}`,
          });
        }
      }

      const subtotalCents = payload.lines.reduce(
        (s, l) => s + l.unitPriceCents * l.qtyPacks,
        0
      );
      const discountCents = payload.lines.reduce((s, l) => s + l.discountCents, 0);
      const taxCents = payload.lines.reduce((s, l) => s + l.taxCents, 0);
      const totalCents = payload.lines.reduce((s, l) => s + l.lineTotalCents, 0);
      const totalCostCents = payload.lines.reduce(
        (s, l) => s + l.unitCostCents * l.packQty * l.qtyPacks,
        0
      );

      const paidTotalCents = payload.payments.reduce((s, p) => s + p.amountCents, 0);
      if (payload.kind === "sale" && paidTotalCents < totalCents) {
        return reply.status(400).send({
          error: `Payment total (${paidTotalCents}c) is less than sale total (${totalCents}c).`,
        });
      }

      // Verify referenced products exist (and originalSaleId exists if provided)
      const uniquePids = Array.from(new Set(payload.lines.map((l) => l.productId)));
      const foundProds = await db
        .select({ id: products.id })
        .from(products)
        .where(inArray(products.id, uniquePids));
      if (foundProds.length !== uniquePids.length) {
        return reply.status(400).send({ error: "One or more line productId values do not exist." });
      }

      if (payload.originalSaleId) {
        const [orig] = await db
          .select({ id: sales.id })
          .from(sales)
          .where(eq(sales.id, payload.originalSaleId))
          .limit(1);
        if (!orig) {
          return reply.status(404).send({ error: "Referenced originalSaleId not found." });
        }
      }

      const sign = payload.kind === "refund" || payload.kind === "void" ? 1 : -1;
      let duplicate = false;

      try {
        await db.transaction(async (tx) => {
          // Idempotent insert by client UUIDv7 primary key
          const inserted = await tx
            .insert(sales)
            .values({
              id: payload.id,
              registerCode: payload.registerCode,
              shiftId: payload.shiftId ?? null,
              receiptNo: payload.receiptNo,
              kind: payload.kind,
              originalSaleId: payload.originalSaleId ?? null,
              cashierName: actor.fullName,
              subtotalCents,
              discountCents,
              taxCents,
              totalCents,
              totalCostCents,
              ageVerified: payload.ageVerified,
              soldAt: new Date(payload.soldAt),
            })
            .onConflictDoNothing({ target: sales.id })
            .returning({ id: sales.id });

          if (inserted.length === 0) {
            duplicate = true;
            return;
          }

          await tx.insert(saleLines).values(
            payload.lines.map((l) => ({
              id: l.id,
              saleId: payload.id,
              productId: l.productId,
              scannedBarcode: l.scannedBarcode,
              packLabel: l.packLabel,
              packQty: l.packQty,
              qtyPacks: l.qtyPacks,
              baseUnitsSold: l.packQty * l.qtyPacks,
              unitPriceCents: l.unitPriceCents,
              unitCostCents: l.unitCostCents,
              discountCents: l.discountCents,
              taxRateBp: l.taxRateBp,
              taxCents: l.taxCents,
              lineTotalCents: l.lineTotalCents,
            }))
          );

          await tx.insert(salePayments).values(
            payload.payments.map((p) => ({
              id: p.id,
              saleId: payload.id,
              method: p.method,
              amountCents: p.amountCents,
              tenderedCents: p.tenderedCents ?? p.amountCents,
              changeCents: p.changeCents ?? 0,
            }))
          );

          // Append immutable inventory ledger rows + FEFO batch depletion on sales
          const movementRows: (typeof stockMovements.$inferInsert)[] = [];
          for (const l of payload.lines) {
            const baseUnits = l.packQty * l.qtyPacks;
            if (sign === -1) {
              let remainingToAllocate = baseUnits;
              const fefoBatches = await tx
                .select()
                .from(inventoryBatches)
                .where(
                  and(
                    eq(inventoryBatches.productId, l.productId),
                    gt(inventoryBatches.qtyRemaining, 0),
                    sql`${inventoryBatches.status} IN ('active', 'clearance')`
                  )
                )
                .orderBy(asc(inventoryBatches.bestBeforeDate));

              for (const batch of fefoBatches) {
                if (remainingToAllocate <= 0) break;
                const take = Math.min(remainingToAllocate, batch.qtyRemaining);
                const nextQty = batch.qtyRemaining - take;
                await tx
                  .update(inventoryBatches)
                  .set({
                    qtyRemaining: nextQty,
                    status: nextQty === 0 ? "depleted" : batch.status,
                  })
                  .where(eq(inventoryBatches.id, batch.id));

                movementRows.push({
                  id: generateUuidV7(),
                  productId: l.productId,
                  batchId: batch.id,
                  qtyDelta: -take,
                  unitCostCents: l.unitCostCents,
                  reason: payload.kind,
                  refId: payload.id,
                  folded: false,
                  createdAt: new Date(payload.soldAt),
                });
                remainingToAllocate -= take;
              }

              if (remainingToAllocate > 0) {
                movementRows.push({
                  id: generateUuidV7(),
                  productId: l.productId,
                  batchId: null,
                  qtyDelta: -remainingToAllocate,
                  unitCostCents: l.unitCostCents,
                  reason: payload.kind,
                  refId: payload.id,
                  folded: false,
                  createdAt: new Date(payload.soldAt),
                });
              }
            } else {
              movementRows.push({
                id: generateUuidV7(),
                productId: l.productId,
                batchId: null,
                qtyDelta: baseUnits,
                unitCostCents: l.unitCostCents,
                reason: payload.kind,
                refId: payload.id,
                folded: false,
                createdAt: new Date(payload.soldAt),
              });
            }
          }

          if (movementRows.length > 0) {
            await tx.insert(stockMovements).values(movementRows);
          }
        });
      } catch (err: unknown) {
        const pgErr = err as { code?: string };
        if (pgErr?.code === "23505") {
          return reply.status(409).send({
            error: `Receipt number "${payload.receiptNo}" already exists for a different sale ID.`,
          });
        }
        throw err;
      }

      return reply.status(duplicate ? 200 : 201).send({
        id: payload.id,
        receiptNo: payload.receiptNo,
        duplicate,
        totalCents,
      });
    }
  );

  // Recent POS receipts feed
  app.get("/api/pos/recent-sales", { preHandler: [requireAuth] }, async () => {
    const recent = await db
      .select()
      .from(sales)
      .orderBy(desc(sales.soldAt))
      .limit(25);
    return { sales: recent };
  });

  // Atomic stock ledger folding (rolls unfolded stock_movements into stock_baselines)
  app.post(
    "/api/pos/fold-ledger",
    { preHandler: [requireRole(["owner", "manager"])] },
    async () => {
      const result = await db.execute(sql`
        WITH batch AS (
          UPDATE stock_movements
          SET folded = true
          WHERE folded = false
          RETURNING product_id, qty_delta
        ),
        agg AS (
          SELECT product_id, SUM(qty_delta)::int AS total_delta, COUNT(*)::int AS moved_rows
          FROM batch
          GROUP BY product_id
        ),
        upserted AS (
          INSERT INTO stock_baselines (product_id, quantity, updated_at)
          SELECT product_id, total_delta, now() FROM agg
          ON CONFLICT (product_id)
          DO UPDATE SET
            quantity = stock_baselines.quantity + EXCLUDED.quantity,
            updated_at = now()
          RETURNING product_id
        )
        SELECT
          (SELECT count(*)::int FROM batch) AS movements_folded,
          (SELECT count(*)::int FROM upserted) AS products_updated;
      `);
      return result.rows[0];
    }
  );

  // Shift listing, opening & blind cash closeout
  app.get(
    "/api/pos/shifts",
    { preHandler: [requireRole(["owner", "manager", "cashier"])] },
    async () => {
      const rows = await db
        .select()
        .from(posShifts)
        .orderBy(desc(posShifts.openedAt))
        .limit(20);
      return { shifts: rows };
    }
  );

  app.post(
    "/api/pos/shifts/open",
    { preHandler: [requireRole(["owner", "manager", "cashier"])] },
    async (req, reply) => {
      const schema = z.object({
        registerCode: z.string().default("REG-01"),
        openingFloatCents: z.number().int().min(0).default(30000),
      });
      const parsed = schema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const [existingOpen] = await db
        .select()
        .from(posShifts)
        .where(
          and(
            eq(posShifts.registerCode, parsed.data.registerCode),
            isNull(posShifts.closedAt)
          )
        )
        .limit(1);

      if (existingOpen) {
        return existingOpen;
      }

      const [created] = await db
        .insert(posShifts)
        .values({
          id: generateUuidV7(),
          registerCode: parsed.data.registerCode,
          cashierName: req.authUser!.fullName,
          openingFloatCents: parsed.data.openingFloatCents,
        })
        .returning();

      return reply.status(201).send(created);
    }
  );

  app.post(
    "/api/pos/shifts/close",
    { preHandler: [requireRole(["owner", "manager", "cashier"])] },
    async (req, reply) => {
      const schema = z.object({
        registerCode: z.string().default("REG-01"),
        openingFloatCents: z.number().int().min(0).default(30000),
        cashDropsCents: z.number().int().min(0).default(0),
        blindCountedCashCents: z.number().int().min(0),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const actorName = req.authUser!.fullName;
      const [openShift] = await db
        .select()
        .from(posShifts)
        .where(
          and(
            eq(posShifts.registerCode, parsed.data.registerCode),
            isNull(posShifts.closedAt)
          )
        )
        .orderBy(desc(posShifts.openedAt))
        .limit(1);

      const windowStart =
        openShift?.openedAt ?? new Date(new Date().setHours(0, 0, 0, 0));
      const effectiveOpeningFloat =
        openShift?.openingFloatCents ?? parsed.data.openingFloatCents;

      // Net cash drawer movement = cash sales minus cash refunds/voids since shift opened
      const [cashAgg] = await db
        .select({
          cashNet: sql<number>`coalesce(sum(CASE WHEN ${sales.kind} = 'sale' THEN ${salePayments.amountCents} ELSE -${salePayments.amountCents} END), 0)::bigint`,
        })
        .from(salePayments)
        .innerJoin(sales, eq(salePayments.saleId, sales.id))
        .where(
          sql`${salePayments.method} = 'cash' AND ${sales.registerCode} = ${parsed.data.registerCode} AND ${sales.soldAt} >= ${windowStart}`
        );

      const expectedCash =
        effectiveOpeningFloat +
        Number(cashAgg?.cashNet ?? 0) -
        parsed.data.cashDropsCents;
      const variance = parsed.data.blindCountedCashCents - expectedCash;
      const zReportNo = `Z-${Date.now().toString().slice(-6)}`;

      const closedShift = openShift
        ? (
            await db
              .update(posShifts)
              .set({
                cashierName: actorName,
                closedAt: new Date(),
                cashDropsCents: parsed.data.cashDropsCents,
                blindCountedCashCents: parsed.data.blindCountedCashCents,
                expectedCashCents: expectedCash,
                varianceCents: variance,
                zReportNo,
              })
              .where(eq(posShifts.id, openShift.id))
              .returning()
          )[0]
        : (
            await db
              .insert(posShifts)
              .values({
                id: generateUuidV7(),
                registerCode: parsed.data.registerCode,
                cashierName: actorName,
                openedAt: windowStart,
                closedAt: new Date(),
                openingFloatCents: effectiveOpeningFloat,
                cashDropsCents: parsed.data.cashDropsCents,
                blindCountedCashCents: parsed.data.blindCountedCashCents,
                expectedCashCents: expectedCash,
                varianceCents: variance,
                zReportNo,
              })
              .returning()
          )[0];

      await db.insert(auditLogs).values({
        actor: actorName,
        action: "z_report_close",
        entityType: "pos_shift",
        entityId: closedShift.id,
        detailsJson: {
          zReportNo,
          expectedCash,
          blindCount: parsed.data.blindCountedCashCents,
          variance,
        },
      });

      return closedShift;
    }
  );
}
