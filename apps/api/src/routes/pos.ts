import type { FastifyInstance } from "fastify";
import { generateUuidV7, PosSaleUploadSchema } from "@supermarket/shared";
import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  analyticsBasketRules,
  auditLogs,
  categories,
  customers,
  db,
  inventoryBatches,
  loyaltyLedger,
  posShifts,
  productBarcodes,
  products,
  promotions,
  saleLines,
  salePayments,
  sales,
  stockMovements,
  targetedCoupons,
  taxRates,
} from "../db/index.js";
import { getPgErrorCode } from "../app.js";
import { requireRole } from "../plugins/auth.js";

export async function posRoutes(app: FastifyInstance) {
  // Lightweight offline-first bootstrap payload (includes basket upsell rules)
  app.get(
    "/api/pos/bootstrap",
    { preHandler: [requireRole(["owner", "manager", "cashier"])] },
    async () => {
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
    }
  );

  // Idempotent append-only POS sale upload (validates totals/payments/tax/age, locks & decrements FEFO batches)
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

      if (
        (payload.kind === "refund" || payload.kind === "void") &&
        !["owner", "manager"].includes(actor.role)
      ) {
        return reply.status(403).send({
          error: "Manager or Owner approval required to post refunds or voids.",
        });
      }

      // Verify referenced products exist and load authoritative tax/age-check metadata
      const uniquePids = Array.from(new Set(payload.lines.map((l) => l.productId)));
      const foundProds = await db
        .select({
          id: products.id,
          requiresAgeCheck: products.requiresAgeCheck,
          taxInclusive: taxRates.isInclusive,
          taxRateBp: taxRates.rateBp,
        })
        .from(products)
        .innerJoin(taxRates, eq(products.taxRateId, taxRates.id))
        .where(inArray(products.id, uniquePids));
      if (foundProds.length !== uniquePids.length) {
        return reply.status(400).send({ error: "One or more line productId values do not exist." });
      }
      const prodMetaMap = new Map(foundProds.map((p) => [p.id, p]));

      let cartRequiresAgeCheck = false;
      for (const l of payload.lines) {
        const meta = prodMetaMap.get(l.productId)!;
        if (meta.requiresAgeCheck) cartRequiresAgeCheck = true;

        const lineGross = l.unitPriceCents * l.qtyPacks;
        if (l.discountCents > lineGross) {
          return reply.status(400).send({
            error: `Discount exceeds gross amount on product ${l.productId}`,
          });
        }
        const afterDiscount = lineGross - l.discountCents;
        const expectedLineTotal = meta.taxInclusive ? afterDiscount : afterDiscount + l.taxCents;
        if (l.lineTotalCents !== expectedLineTotal) {
          return reply.status(400).send({
            error: `Invalid line total on product ${l.productId} (expected ${expectedLineTotal}c, got ${l.lineTotalCents}c)`,
          });
        }
        if (meta.taxInclusive && l.taxCents > l.lineTotalCents) {
          return reply.status(400).send({
            error: `Included tax exceeds line total on product ${l.productId}`,
          });
        }
      }

      if (payload.kind === "sale" && cartRequiresAgeCheck && !payload.ageVerified) {
        return reply.status(400).send({
          error: "Age verification (18+) is required before completing a sale with age-restricted items.",
        });
      }

      for (const p of payload.payments) {
        if (p.tenderedCents !== undefined && p.tenderedCents < p.amountCents) {
          return reply.status(400).send({
            error: `Payment tendered (${p.tenderedCents}c) is less than payment amount (${p.amountCents}c).`,
          });
        }
        if (
          p.changeCents !== undefined &&
          p.tenderedCents !== undefined &&
          p.changeCents > p.tenderedCents - p.amountCents
        ) {
          return reply.status(400).send({
            error: `Payment change (${p.changeCents}c) exceeds over-tendered amount.`,
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

      if (payload.customerId) {
        const [cust] = await db
          .select({ id: customers.id })
          .from(customers)
          .where(eq(customers.id, payload.customerId))
          .limit(1);
        if (!cust) {
          return reply.status(404).send({ error: "Referenced customerId not found." });
        }
      }

      if (payload.originalSaleId) {
        const [orig] = await db
          .select({ id: sales.id, kind: sales.kind })
          .from(sales)
          .where(eq(sales.id, payload.originalSaleId))
          .limit(1);
        if (!orig) {
          return reply.status(404).send({ error: "Referenced originalSaleId not found." });
        }
        if (orig.kind !== "sale") {
          return reply.status(400).send({
            error: "Referenced originalSaleId must be a sale receipt.",
          });
        }
      }

      const sign = payload.kind === "refund" || payload.kind === "void" ? 1 : -1;
      let duplicate = false;
      let alreadyVoided = false;
      let couponRejection: { status: 400 | 409; message: string } | null = null;
      let pointsEarned = 0;

      try {
        await db.transaction(async (tx) => {
          // Idempotent insert by client UUIDv7 primary key
          const [existingById] = await tx
            .select({ id: sales.id })
            .from(sales)
            .where(eq(sales.id, payload.id))
            .limit(1);
          if (existingById) {
            duplicate = true;
            return;
          }

          if (payload.kind === "void" && payload.originalSaleId) {
            const [priorVoid] = await tx
              .select({ id: sales.id })
              .from(sales)
              .where(
                and(eq(sales.originalSaleId, payload.originalSaleId), eq(sales.kind, "void"))
              )
              .limit(1);
            if (priorVoid) {
              alreadyVoided = true;
              return;
            }
          }

          // Atomic single-use loyalty coupon validation & row lock (prevents concurrent double-redemption)
          let lockedCouponId: string | null = null;
          if (payload.kind === "sale" && payload.couponCode) {
            const normalizedCode = payload.couponCode.trim().toUpperCase();
            const [coupon] = await tx
              .select()
              .from(targetedCoupons)
              .where(sql`upper(${targetedCoupons.code}) = ${normalizedCode}`)
              .for("update");
            if (!coupon) {
              couponRejection = {
                status: 400,
                message: `Coupon code "${normalizedCode}" not found.`,
              };
              return;
            }
            if (coupon.redeemedSaleId) {
              couponRejection = {
                status: 409,
                message: `Coupon code "${coupon.code}" has already been redeemed.`,
              };
              return;
            }
            const soldMs = new Date(payload.soldAt).getTime();
            if (
              soldMs < new Date(coupon.validFrom).getTime() ||
              soldMs > new Date(coupon.validUntil).getTime()
            ) {
              couponRejection = {
                status: 400,
                message: `Coupon code "${coupon.code}" is expired or not yet valid.`,
              };
              return;
            }
            if (coupon.customerId && coupon.customerId !== payload.customerId) {
              couponRejection = {
                status: 400,
                message: `Coupon code "${coupon.code}" is restricted to a different loyalty customer.`,
              };
              return;
            }
            if (subtotalCents < coupon.minBasketCents) {
              couponRejection = {
                status: 400,
                message: `Basket subtotal (${subtotalCents}c) is below coupon minimum (${coupon.minBasketCents}c).`,
              };
              return;
            }
            lockedCouponId = coupon.id;
          }

          const inserted = await tx
            .insert(sales)
            .values({
              id: payload.id,
              registerCode: payload.registerCode,
              shiftId: payload.shiftId ?? null,
              customerId: payload.customerId ?? null,
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

          if (lockedCouponId) {
            await tx
              .update(targetedCoupons)
              .set({
                redeemedSaleId: payload.id,
                redeemedAt: new Date(),
              })
              .where(eq(targetedCoupons.id, lockedCouponId));
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

          // Append immutable inventory ledger rows + locked FEFO batch depletion on sales
          // Sort lines by productId for deterministic row-lock ordering across concurrent checkouts
          const orderedLines = [...payload.lines].sort((a, b) =>
            a.productId.localeCompare(b.productId)
          );
          const movementRows: (typeof stockMovements.$inferInsert)[] = [];
          for (const l of orderedLines) {
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
                .orderBy(asc(inventoryBatches.bestBeforeDate), asc(inventoryBatches.id))
                .for("update");

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

          // Customer loyalty points accrual (1 pt / $1) or refund/void clawback
          if (payload.customerId) {
            const [lockedCust] = await tx
              .select()
              .from(customers)
              .where(eq(customers.id, payload.customerId))
              .for("update");
            if (lockedCust) {
              const pts = Math.floor(totalCents / 100);
              if (payload.kind === "sale") {
                pointsEarned = pts;
                await tx
                  .update(customers)
                  .set({
                    pointsBalance: lockedCust.pointsBalance + pts,
                    lifetimeSpendCents: lockedCust.lifetimeSpendCents + totalCents,
                    visits60d: lockedCust.visits60d + 1,
                    lastVisitAt: new Date(payload.soldAt),
                  })
                  .where(eq(customers.id, lockedCust.id));
                if (pts > 0) {
                  await tx.insert(loyaltyLedger).values({
                    customerId: lockedCust.id,
                    saleId: payload.id,
                    pointsDelta: pts,
                    reason: "earn",
                  });
                }
              } else {
                pointsEarned = -pts;
                await tx
                  .update(customers)
                  .set({
                    pointsBalance: Math.max(0, lockedCust.pointsBalance - pts),
                    lifetimeSpendCents: Math.max(0, lockedCust.lifetimeSpendCents - totalCents),
                  })
                  .where(eq(customers.id, lockedCust.id));
                if (pts > 0) {
                  await tx.insert(loyaltyLedger).values({
                    customerId: lockedCust.id,
                    saleId: payload.id,
                    pointsDelta: -pts,
                    reason: "refund_clawback",
                  });
                }
              }
            }
          }
        });
      } catch (err: unknown) {
        if (getPgErrorCode(err) === "23505") {
          return reply.status(409).send({
            error: `Receipt number "${payload.receiptNo}" already exists for a different sale ID.`,
          });
        }
        throw err;
      }

      if (couponRejection) {
        const rej = couponRejection as { status: 400 | 409; message: string };
        return reply.status(rej.status).send({ error: rej.message });
      }

      if (alreadyVoided) {
        return reply.status(409).send({
          error: "Original sale has already been voided.",
        });
      }

      return reply.status(duplicate ? 200 : 201).send({
        id: payload.id,
        receiptNo: payload.receiptNo,
        duplicate,
        totalCents,
        pointsEarned,
      });
    }
  );

  // Recent POS receipts feed (enriched with lines, payments, and void status for POS Receipt Lookup)
  app.get(
    "/api/pos/recent-sales",
    { preHandler: [requireRole(["owner", "manager", "cashier", "accountant"])] },
    async () => {
      const recent = await db
        .select()
        .from(sales)
        .orderBy(desc(sales.soldAt))
        .limit(25);

      if (recent.length === 0) return { sales: [] };
      const saleIds = recent.map((r) => r.id);

      const [linesRows, payRows, voidChildRows] = await Promise.all([
        db
          .select({
            id: saleLines.id,
            saleId: saleLines.saleId,
            productId: saleLines.productId,
            productName: products.name,
            scannedBarcode: saleLines.scannedBarcode,
            packLabel: saleLines.packLabel,
            packQty: saleLines.packQty,
            qtyPacks: saleLines.qtyPacks,
            unitPriceCents: saleLines.unitPriceCents,
            unitCostCents: saleLines.unitCostCents,
            discountCents: saleLines.discountCents,
            taxRateBp: saleLines.taxRateBp,
            taxCents: saleLines.taxCents,
            lineTotalCents: saleLines.lineTotalCents,
          })
          .from(saleLines)
          .innerJoin(products, eq(saleLines.productId, products.id))
          .where(inArray(saleLines.saleId, saleIds)),
        db
          .select()
          .from(salePayments)
          .where(inArray(salePayments.saleId, saleIds)),
        db
          .select({ originalSaleId: sales.originalSaleId })
          .from(sales)
          .where(and(inArray(sales.originalSaleId, saleIds), eq(sales.kind, "void"))),
      ]);

      const linesBySale = new Map<string, typeof linesRows>();
      for (const l of linesRows) {
        const list = linesBySale.get(l.saleId) ?? [];
        list.push(l);
        linesBySale.set(l.saleId, list);
      }
      const payBySale = new Map<string, typeof payRows>();
      for (const p of payRows) {
        const list = payBySale.get(p.saleId) ?? [];
        list.push(p);
        payBySale.set(p.saleId, list);
      }
      const voidedSet = new Set(
        voidChildRows.map((v) => v.originalSaleId).filter((v): v is string => Boolean(v))
      );

      return {
        sales: recent.map((s) => ({
          ...s,
          alreadyVoided: voidedSet.has(s.id),
          lines: linesBySale.get(s.id) ?? [],
          payments: payBySale.get(s.id) ?? [],
        })),
      };
    }
  );

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
        registerCode: z.string().trim().min(1).max(32).default("REG-01"),
        openingFloatCents: z.number().int().min(0).default(30000),
      });
      const parsed = schema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const findOpen = () =>
        db
          .select()
          .from(posShifts)
          .where(
            and(
              eq(posShifts.registerCode, parsed.data.registerCode),
              isNull(posShifts.closedAt)
            )
          )
          .limit(1);

      const [existingOpen] = await findOpen();
      if (existingOpen) {
        return existingOpen;
      }

      try {
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
      } catch (err) {
        if (getPgErrorCode(err) === "23505") {
          const [raceExisting] = await findOpen();
          if (raceExisting) return raceExisting;
        }
        throw err;
      }
    }
  );

  app.post(
    "/api/pos/shifts/close",
    { preHandler: [requireRole(["owner", "manager", "cashier"])] },
    async (req, reply) => {
      const schema = z.object({
        registerCode: z.string().trim().min(1).max(32).default("REG-01"),
        openingFloatCents: z.number().int().min(0).default(30000),
        cashDropsCents: z.number().int().min(0).default(0),
        blindCountedCashCents: z.number().int().min(0),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const actorName = req.authUser!.fullName;
      const closedShift = await db.transaction(async (tx) => {
        const [openShift] = await tx
          .select()
          .from(posShifts)
          .where(
            and(
              eq(posShifts.registerCode, parsed.data.registerCode),
              isNull(posShifts.closedAt)
            )
          )
          .orderBy(desc(posShifts.openedAt))
          .limit(1)
          .for("update");

        const windowStart =
          openShift?.openedAt ?? new Date(new Date().setHours(0, 0, 0, 0));
        const effectiveOpeningFloat =
          openShift?.openingFloatCents ?? parsed.data.openingFloatCents;

        // Net cash drawer movement = cash sales minus cash refunds/voids since shift opened
        const [cashAgg] = await tx
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
        const zReportNo = `Z-${Date.now().toString().slice(-6)}-${generateUuidV7().slice(-4).toUpperCase()}`;

        const saved = openShift
          ? (
              await tx
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
              await tx
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

        await tx.insert(auditLogs).values({
          actor: actorName,
          action: "z_report_close",
          entityType: "pos_shift",
          entityId: saved.id,
          detailsJson: {
            zReportNo,
            expectedCash,
            blindCount: parsed.data.blindCountedCashCents,
            variance,
          },
        });

        return saved;
      });

      return closedShift;
    }
  );
}
