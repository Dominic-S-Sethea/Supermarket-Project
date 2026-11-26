import type { FastifyInstance } from "fastify";
import {
  computeTaxCents,
  evaluateCart,
  generateUuidV7,
  PosSaleUploadSchema,
  type CartInputLine,
  type PromotionRule,
} from "@supermarket/shared";
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

      if ((payload.kind === "refund" || payload.kind === "void") && !payload.originalSaleId) {
        return reply.status(400).send({
          error: "originalSaleId is required for voids and refunds.",
        });
      }

      // Verify referenced products, barcodes, and authoritative cost/price/tax/age metadata
      const uniquePids = Array.from(new Set(payload.lines.map((l) => l.productId)));
      const [foundProds, foundBarcodes, activePromos] = await Promise.all([
        db
          .select({
            id: products.id,
            sku: products.sku,
            name: products.name,
            categoryId: products.categoryId,
            avgCostCents: products.avgCostCents,
            requiresAgeCheck: products.requiresAgeCheck,
            taxInclusive: taxRates.isInclusive,
            taxRateBp: taxRates.rateBp,
          })
          .from(products)
          .innerJoin(taxRates, eq(products.taxRateId, taxRates.id))
          .where(inArray(products.id, uniquePids)),
        db
          .select({
            productId: productBarcodes.productId,
            barcode: productBarcodes.barcode,
            packQty: productBarcodes.packQty,
            packLabel: productBarcodes.packLabel,
            sellPriceCents: productBarcodes.sellPriceCents,
          })
          .from(productBarcodes)
          .where(inArray(productBarcodes.productId, uniquePids)),
        payload.kind === "sale"
          ? db.select().from(promotions).where(eq(promotions.active, true))
          : Promise.resolve([]),
      ]);

      if (foundProds.length !== uniquePids.length) {
        return reply.status(400).send({ error: "One or more line productId values do not exist." });
      }
      const prodMetaMap = new Map(foundProds.map((p) => [p.id, p]));
      const barcodeMap = new Map(
        foundBarcodes.map((b) => [`${b.productId}::${b.barcode}`, b])
      );

      let cartRequiresAgeCheck = false;
      const normalizedLines: (typeof payload.lines[number])[] = [];

      for (const l of payload.lines) {
        const meta = prodMetaMap.get(l.productId)!;
        if (meta.requiresAgeCheck) cartRequiresAgeCheck = true;

        if (payload.kind === "sale") {
          const authBarcode = barcodeMap.get(`${l.productId}::${l.scannedBarcode}`);
          if (!authBarcode) {
            return reply.status(400).send({
              error: `Barcode "${l.scannedBarcode}" is not registered for product ${meta.sku}.`,
            });
          }
          if (l.packQty !== authBarcode.packQty) {
            return reply.status(400).send({
              error: `Pack quantity mismatch for barcode "${l.scannedBarcode}" (expected ${authBarcode.packQty}, got ${l.packQty}).`,
            });
          }
          if (l.unitPriceCents !== authBarcode.sellPriceCents) {
            return reply.status(400).send({
              error: `Unit price mismatch for barcode "${l.scannedBarcode}" (expected ${authBarcode.sellPriceCents}c, got ${l.unitPriceCents}c).`,
            });
          }
        }

        const lineGross = l.unitPriceCents * l.qtyPacks;
        if (l.discountCents > lineGross) {
          return reply.status(400).send({
            error: `Discount exceeds gross amount on product ${l.productId}`,
          });
        }
        const afterDiscount = lineGross - l.discountCents;
        const authoritativeTaxCents = computeTaxCents(
          afterDiscount,
          meta.taxRateBp,
          meta.taxInclusive
        ).taxCents;
        const expectedLineTotal = meta.taxInclusive
          ? afterDiscount
          : afterDiscount + authoritativeTaxCents;
        if (l.lineTotalCents !== expectedLineTotal) {
          return reply.status(400).send({
            error: `Invalid line total on product ${l.productId} (expected ${expectedLineTotal}c, got ${l.lineTotalCents}c)`,
          });
        }
        if (meta.taxInclusive && authoritativeTaxCents > l.lineTotalCents) {
          return reply.status(400).send({
            error: `Included tax exceeds line total on product ${l.productId}`,
          });
        }

        normalizedLines.push({
          ...l,
          unitCostCents: meta.avgCostCents,
          taxRateBp: meta.taxRateBp,
          taxCents: authoritativeTaxCents,
          lineTotalCents: expectedLineTotal,
        });
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

      const subtotalCents = normalizedLines.reduce(
        (s, l) => s + l.unitPriceCents * l.qtyPacks,
        0
      );
      const discountCents = normalizedLines.reduce((s, l) => s + l.discountCents, 0);
      const taxCents = normalizedLines.reduce((s, l) => s + l.taxCents, 0);
      const totalCents = normalizedLines.reduce((s, l) => s + l.lineTotalCents, 0);
      let totalCostCents = normalizedLines.reduce(
        (s, l) => s + l.unitCostCents * l.packQty * l.qtyPacks,
        0
      );

      const paidTotalCents = payload.payments.reduce((s, p) => s + p.amountCents, 0);
      if (payload.kind === "sale" && paidTotalCents < totalCents) {
        return reply.status(400).send({
          error: `Payment total (${paidTotalCents}c) is less than sale total (${totalCents}c).`,
        });
      }

      let customerSegment: string | null = null;
      if (payload.customerId) {
        const [cust] = await db
          .select({ id: customers.id, rfmSegment: customers.rfmSegment })
          .from(customers)
          .where(eq(customers.id, payload.customerId))
          .limit(1);
        if (!cust) {
          return reply.status(404).send({ error: "Referenced customerId not found." });
        }
        customerSegment = cust.rfmSegment;
      }

      const mappedActivePromos: PromotionRule[] = activePromos.map((pr) => ({
        ...((pr.rulesJson ?? {}) as Record<string, unknown>),
        id: pr.id,
        name: pr.name,
        promoType: pr.promoType as PromotionRule["promoType"],
        priority: pr.priority,
        combinable: pr.combinable,
        minMarginGuardBp: pr.minMarginGuardBp,
        startsAt: pr.startsAt ? pr.startsAt.toISOString() : null,
        endsAt: pr.endsAt ? pr.endsAt.toISOString() : null,
        daypartStartHour: pr.daypartStartHour,
        daypartEndHour: pr.daypartEndHour,
      }));

      const sign = payload.kind === "refund" || payload.kind === "void" ? 1 : -1;
      let duplicate = false;
      let txRejection: { status: 400 | 404 | 409; message: string } | null = null;
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

          // Row-lock original sale for voids/refunds to eliminate concurrent double-void and over-refund races
          if ((payload.kind === "void" || payload.kind === "refund") && payload.originalSaleId) {
            const [orig] = await tx
              .select()
              .from(sales)
              .where(eq(sales.id, payload.originalSaleId))
              .for("update");
            if (!orig) {
              txRejection = { status: 404, message: "Referenced originalSaleId not found." };
              return;
            }
            if (orig.kind !== "sale") {
              txRejection = {
                status: 400,
                message: "Referenced originalSaleId must be a sale receipt.",
              };
              return;
            }

            const priorReversals = await tx
              .select({ id: sales.id, kind: sales.kind, totalCents: sales.totalCents })
              .from(sales)
              .where(eq(sales.originalSaleId, payload.originalSaleId));

            if (priorReversals.some((r) => r.kind === "void")) {
              txRejection = { status: 409, message: "Original sale has already been voided." };
              return;
            }

            const priorRefunds = priorReversals.filter((r) => r.kind === "refund");
            if (payload.kind === "void" && priorRefunds.length > 0) {
              txRejection = {
                status: 409,
                message:
                  "Original sale already has partial refunds and cannot be voided; post a refund for remaining items instead.",
              };
              return;
            }

            const origLines = await tx
              .select()
              .from(saleLines)
              .where(eq(saleLines.saleId, orig.id));

            const priorRefundIds = priorRefunds.map((r) => r.id);
            const priorRefundLines =
              priorRefundIds.length > 0
                ? await tx
                    .select()
                    .from(saleLines)
                    .where(inArray(saleLines.saleId, priorRefundIds))
                : [];

            // Aggregate original and already-refunded quantities per (productId, scannedBarcode)
            const origAgg = new Map<
              string,
              {
                qtyPacks: number;
                packQty: number;
                unitPriceCents: number;
                unitCostCents: number;
                lineTotalCents: number;
              }
            >();
            for (const ol of origLines) {
              const key = `${ol.productId}::${ol.scannedBarcode}`;
              const cur = origAgg.get(key);
              if (cur) {
                cur.qtyPacks += ol.qtyPacks;
                cur.lineTotalCents += ol.lineTotalCents;
              } else {
                origAgg.set(key, {
                  qtyPacks: ol.qtyPacks,
                  packQty: ol.packQty,
                  unitPriceCents: ol.unitPriceCents,
                  unitCostCents: ol.unitCostCents,
                  lineTotalCents: ol.lineTotalCents,
                });
              }
            }

            const refundedAgg = new Map<string, { qtyPacks: number; lineTotalCents: number }>();
            for (const rl of priorRefundLines) {
              const key = `${rl.productId}::${rl.scannedBarcode}`;
              const cur = refundedAgg.get(key) ?? { qtyPacks: 0, lineTotalCents: 0 };
              cur.qtyPacks += rl.qtyPacks;
              cur.lineTotalCents += rl.lineTotalCents;
              refundedAgg.set(key, cur);
            }

            const reqAgg = new Map<string, { qtyPacks: number; lineTotalCents: number }>();
            for (const l of normalizedLines) {
              const key = `${l.productId}::${l.scannedBarcode}`;
              const origItem = origAgg.get(key);
              if (!origItem) {
                txRejection = {
                  status: 400,
                  message: `Item "${l.scannedBarcode}" was not part of original receipt ${orig.receiptNo}.`,
                };
                return;
              }
              if (l.packQty !== origItem.packQty) {
                txRejection = {
                  status: 400,
                  message: `Pack quantity mismatch for reversal item "${l.scannedBarcode}".`,
                };
                return;
              }
              // Use original sale cost-at-sale on restock movements
              l.unitCostCents = origItem.unitCostCents;
              const cur = reqAgg.get(key) ?? { qtyPacks: 0, lineTotalCents: 0 };
              cur.qtyPacks += l.qtyPacks;
              cur.lineTotalCents += l.lineTotalCents;
              reqAgg.set(key, cur);
            }

            for (const [key, reqItem] of reqAgg.entries()) {
              const origItem = origAgg.get(key)!;
              const prevRef = refundedAgg.get(key) ?? { qtyPacks: 0, lineTotalCents: 0 };
              const remainingQty = origItem.qtyPacks - prevRef.qtyPacks;
              if (reqItem.qtyPacks > remainingQty) {
                txRejection = {
                  status: 409,
                  message: `Reversal quantity (${reqItem.qtyPacks}) exceeds remaining refundable quantity (${remainingQty}) on receipt ${orig.receiptNo}.`,
                };
                return;
              }
              const remainingLineCents = Math.max(0, origItem.lineTotalCents - prevRef.lineTotalCents);
              if (reqItem.lineTotalCents > remainingLineCents + 1) {
                txRejection = {
                  status: 400,
                  message: `Reversal amount (${reqItem.lineTotalCents}c) exceeds remaining refundable line value (${remainingLineCents}c).`,
                };
                return;
              }
            }

            const priorRefundedTotalCents = priorRefunds.reduce((s, r) => s + r.totalCents, 0);
            if (priorRefundedTotalCents + totalCents > orig.totalCents) {
              txRejection = {
                status: 409,
                message: `Cumulative refund/void total (${priorRefundedTotalCents + totalCents}c) exceeds original sale total (${orig.totalCents}c).`,
              };
              return;
            }

            totalCostCents = normalizedLines.reduce(
              (s, l) => s + l.unitCostCents * l.packQty * l.qtyPacks,
              0
            );
          }

          // Atomic single-use loyalty coupon validation & row lock (prevents concurrent double-redemption)
          let lockedCouponId: string | null = null;
          let lockedCouponDiscountCents = 0;
          if (payload.kind === "sale" && payload.couponCode) {
            const normalizedCode = payload.couponCode.trim().toUpperCase();
            const [coupon] = await tx
              .select()
              .from(targetedCoupons)
              .where(sql`upper(${targetedCoupons.code}) = ${normalizedCode}`)
              .for("update");
            if (!coupon) {
              txRejection = {
                status: 400,
                message: `Coupon code "${normalizedCode}" not found.`,
              };
              return;
            }
            if (coupon.redeemedSaleId) {
              txRejection = {
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
              txRejection = {
                status: 400,
                message: `Coupon code "${coupon.code}" is expired or not yet valid.`,
              };
              return;
            }
            if (coupon.customerId && coupon.customerId !== payload.customerId) {
              txRejection = {
                status: 400,
                message: `Coupon code "${coupon.code}" is restricted to a different loyalty customer.`,
              };
              return;
            }
            if (coupon.rfmSegment && customerSegment !== coupon.rfmSegment) {
              txRejection = {
                status: 400,
                message: `Coupon code "${coupon.code}" requires loyalty segment "${coupon.rfmSegment}".`,
              };
              return;
            }
            if (subtotalCents < coupon.minBasketCents) {
              txRejection = {
                status: 400,
                message: `Basket subtotal (${subtotalCents}c) is below coupon minimum (${coupon.minBasketCents}c).`,
              };
              return;
            }
            lockedCouponId = coupon.id;
            lockedCouponDiscountCents = coupon.discountCents;
          }

          // Authoritative server-side discount validation via shared promotion engine (blocks forged discounts)
          if (payload.kind === "sale" && discountCents > 0) {
            const cartInputs: CartInputLine[] = normalizedLines.map((l) => {
              const meta = prodMetaMap.get(l.productId)!;
              return {
                lineKey: l.id,
                productId: l.productId,
                categoryId: meta.categoryId,
                sku: meta.sku,
                name: meta.name,
                scannedBarcode: l.scannedBarcode,
                packLabel: l.packLabel,
                packQty: l.packQty,
                qtyPacks: l.qtyPacks,
                unitPriceCents: l.unitPriceCents,
                unitCostCents: meta.avgCostCents,
                taxRateBp: meta.taxRateBp,
                taxInclusive: meta.taxInclusive,
                requiresAgeCheck: meta.requiresAgeCheck,
              };
            });
            const soldDate = new Date(payload.soldAt);
            const serverEval = evaluateCart(cartInputs, mappedActivePromos, {
              evalNow: soldDate,
              evalHour: soldDate.getHours(),
              couponDiscountCents: lockedCouponDiscountCents,
            });
            if (discountCents > serverEval.totalDiscountCents) {
              txRejection = {
                status: 400,
                message: `Total discount (${discountCents}c) exceeds maximum authorized promotion and coupon discount (${serverEval.totalDiscountCents}c).`,
              };
              return;
            }
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
            normalizedLines.map((l) => ({
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
          const orderedLines = [...normalizedLines].sort((a, b) =>
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
          const constraint =
            (err as { constraint?: string; cause?: { constraint?: string } }).constraint ??
            (err as { cause?: { constraint?: string } }).cause?.constraint;
          if (constraint === "uq_sales_single_void_per_original") {
            return reply.status(409).send({
              error: "Original sale has already been voided.",
            });
          }
          return reply.status(409).send({
            error: `Receipt number "${payload.receiptNo}" already exists for a different sale ID.`,
          });
        }
        throw err;
      }

      if (txRejection) {
        const rej = txRejection as { status: 400 | 404 | 409; message: string };
        return reply.status(rej.status).send({ error: rej.message });
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
