import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  computeInventoryValueCents,
  computeTaxCents,
  computeWeightedPriceCents,
  deriveWeightFromPriceGrams,
  evaluateCart,
  generateUuidV7,
  normalizePluCode,
  parseScaleBarcode,
  PosSaleUploadSchema,
  type CartInputLine,
  type PromotionRule,
  type UnitMode,
} from "@supermarket/shared";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { recordPosSaleMetric } from "../plugins/metrics.js";
import {
  analyticsBasketRules,
  auditLogs,
  categories,
  customers,
  db,
  inventoryBatches,
  loyaltyLedger,
  paymentIntents,
  posShifts,
  productBarcodes,
  products,
  promotions,
  saleLines,
  salePayments,
  sales,
  stockMovements,
  supervisorOverrides,
  targetedCoupons,
  taxRates,
} from "../db/index.js";
import { getPgErrorCode } from "../app.js";
import { env } from "../config/env.js";
import { getHourInTimezone, validateSoldAtBounds } from "../lib/helpers.js";
import { depleteFefoBatchesTx } from "../lib/stockLedger.js";
import { requireRole } from "../plugins/auth.js";
import { getOrCreateStoreSettings } from "../services/payments.js";
import { posParkedRoutes } from "./posParked.js";
import { posPaymentRoutes } from "./posPayments.js";
import { posShiftRoutes } from "./posShifts.js";

export async function posRoutes(app: FastifyInstance) {
  await posShiftRoutes(app);
  await posPaymentRoutes(app);
  await posParkedRoutes(app);

  // Lightweight offline-first bootstrap payload (includes fresh PLU/allergen/recall metadata, store settings, basket upsells & ETag)
  app.get(
    "/api/pos/bootstrap",
    { preHandler: [requireRole(["owner", "manager", "cashier"])] },
    async (req, reply) => {
      const settings = await getOrCreateStoreSettings();
      const verRes = await db.execute(sql`
        SELECT
          (SELECT count(*)::text || ':' || coalesce(max(updated_at)::text, '') || ':' || count(*) FILTER (WHERE recalled = true)::text FROM products WHERE active = true) AS p_ver,
          (SELECT count(*)::text || ':' || coalesce(sum(pb.sell_price_cents)::text, '0') || ':' || coalesce(sum(pb.pack_qty)::text, '0') FROM product_barcodes pb JOIN products p ON p.id = pb.product_id WHERE p.active = true) AS b_ver,
          (SELECT count(*)::text || ':' || coalesce(max(starts_at)::text, '') || ':' || coalesce(max(ends_at)::text, '') FROM promotions WHERE active = true) AS pr_ver,
          (SELECT count(*)::text FROM tax_rates) AS t_ver,
          (SELECT count(*)::text FROM categories) AS c_ver,
          (SELECT coalesce(max(computed_at)::text, '') FROM analytics_basket_rules) AS r_ver,
          (SELECT coalesce(max(updated_at)::text, '') FROM store_settings) AS s_ver
      `);
      const vRow = (verRes.rows[0] ?? {}) as Record<string, string>;
      const etagHash = crypto
        .createHash("sha256")
        .update(
          `pos|${vRow.p_ver}|${vRow.b_ver}|${vRow.pr_ver}|${vRow.t_ver}|${vRow.c_ver}|${vRow.r_ver}|${vRow.s_ver}`
        )
        .digest("hex")
        .slice(0, 24);
      const etag = `"pos-boot-${etagHash}"`;

      reply.header("ETag", etag);
      reply.header("Cache-Control", "private, no-cache");
      reply.header("Vary", "Cookie, Authorization");
      if (req.headers["if-none-match"] === etag) {
        return reply.status(304).send();
      }

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
            unitMode: products.unitMode,
            pluCode: products.pluCode,
            defaultTareGrams: products.defaultTareGrams,
            netContentAmount: products.netContentAmount,
            netContentUnit: products.netContentUnit,
            allergens: products.allergensJson,
            recalled: products.recalled,
            recallReason: products.recallReason,
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
          .from(productBarcodes)
          .innerJoin(products, eq(productBarcodes.productId, products.id))
          .where(eq(products.active, true)),
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
        storeSettings: settings,
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

      // Early idempotency check before live price/recall/coupon validations so offline retries stay immune to catalog edits
      const [alreadySaved] = await db
        .select({
          id: sales.id,
          receiptNo: sales.receiptNo,
          totalCents: sales.totalCents,
        })
        .from(sales)
        .where(eq(sales.id, payload.id))
        .limit(1);
      if (alreadySaved) {
        return reply.status(200).send({
          id: alreadySaved.id,
          receiptNo: alreadySaved.receiptNo,
          duplicate: true,
          totalCents: alreadySaved.totalCents,
          pointsEarned: 0,
        });
      }

      if (payload.supervisorOverrideBy && !payload.supervisorOverrideId) {
        return reply.status(400).send({
          error:
            "Supervisor overrides require a server-issued supervisorOverrideId from /api/auth/verify-override.",
        });
      }

      if (payload.kind === "sale") {
        const bounds = validateSoldAtBounds(
          payload.soldAt,
          Date.now(),
          env.posMaxBackdateHours,
          env.posMaxFutureSkewSec
        );
        if (!bounds.ok) {
          return reply.status(400).send({ error: bounds.error });
        }
      }

      // Verify referenced products, barcodes, and authoritative cost/price/tax/age/recall/weight metadata
      const uniquePids = Array.from(new Set(payload.lines.map((l) => l.productId)));
      const [foundProds, foundBarcodes, activePromos, storeSettingsRow] = await Promise.all([
        db
          .select({
            id: products.id,
            sku: products.sku,
            name: products.name,
            categoryId: products.categoryId,
            unitMode: products.unitMode,
            pluCode: products.pluCode,
            recalled: products.recalled,
            recallReason: products.recallReason,
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
            isPrimary: productBarcodes.isPrimary,
          })
          .from(productBarcodes)
          .where(inArray(productBarcodes.productId, uniquePids)),
        payload.kind === "sale"
          ? db.select().from(promotions).where(eq(promotions.active, true))
          : Promise.resolve([]),
        getOrCreateStoreSettings(),
      ]);

      if (foundProds.length !== uniquePids.length) {
        return reply.status(400).send({ error: "One or more line productId values do not exist." });
      }
      const prodMetaMap = new Map(foundProds.map((p) => [p.id, p]));
      const barcodeMap = new Map(
        foundBarcodes.map((b) => [`${b.productId}::${b.barcode}`, b])
      );
      const primaryBarcodeByProduct = new Map<string, (typeof foundBarcodes)[number]>();
      for (const b of foundBarcodes) {
        if (b.isPrimary || !primaryBarcodeByProduct.has(b.productId)) {
          primaryBarcodeByProduct.set(b.productId, b);
        }
      }

      let cartRequiresAgeCheck = false;
      type NormalizedSaleLine = (typeof payload.lines)[number] & {
        baseUnitsSold: number;
        lineGrossCents: number;
        lineCostCents: number;
        unitMode: UnitMode;
        embeddedPriceCents: number | null;
      };
      const normalizedLines: NormalizedSaleLine[] = [];

      for (const l of payload.lines) {
        const meta = prodMetaMap.get(l.productId)!;
        if (meta.requiresAgeCheck) cartRequiresAgeCheck = true;

        // Hard food-safety recall block across every checkout lane
        if (payload.kind === "sale" && meta.recalled) {
          return reply.status(409).send({
            error: `FOOD-SAFETY RECALL BLOCK: ${meta.sku} (${meta.name}) is recalled (${meta.recallReason ?? "Do not sell"}).`,
          });
        }

        const unitMode = (meta.unitMode as UnitMode) ?? "each";
        const isMeasured = unitMode === "weight_g" || unitMode === "volume_ml";
        const scaleParsed = parseScaleBarcode(l.scannedBarcode);
        const normalizedMetaPlu = meta.pluCode ? normalizePluCode(meta.pluCode) : null;
        const scaleMatchesProduct = Boolean(
          scaleParsed &&
            normalizedMetaPlu &&
            scaleParsed.pluCandidates.includes(normalizedMetaPlu)
        );

        let effectiveWeightGrams: number | null =
          typeof l.weightGrams === "number" && l.weightGrams > 0 ? l.weightGrams : null;
        let embeddedPriceCents: number | null = null;
        let lineGross = l.unitPriceCents * l.qtyPacks;
        let baseUnitsSold = l.packQty * l.qtyPacks;
        let lineCostCents = meta.avgCostCents * baseUnitsSold;

        if (payload.kind === "sale") {
          const authBarcode =
            barcodeMap.get(`${l.productId}::${l.scannedBarcode}`) ??
            (scaleMatchesProduct ? primaryBarcodeByProduct.get(l.productId) : undefined);

          if (!authBarcode) {
            return reply.status(400).send({
              error: `Barcode "${l.scannedBarcode}" is not registered for product ${meta.sku}.`,
            });
          }

          if (isMeasured) {
            if (scaleParsed?.kind === "weight" && scaleParsed.weightGrams) {
              effectiveWeightGrams = scaleParsed.weightGrams;
            } else if (
              scaleParsed?.kind === "price" &&
              scaleParsed.embeddedPriceCents &&
              !effectiveWeightGrams
            ) {
              effectiveWeightGrams = deriveWeightFromPriceGrams(
                scaleParsed.embeddedPriceCents,
                authBarcode.sellPriceCents
              );
            }
            if (!effectiveWeightGrams || effectiveWeightGrams < 1) {
              return reply.status(400).send({
                error: `Measured product ${meta.sku} requires weightGrams >= 1.`,
              });
            }
            if (scaleParsed?.kind === "price" && scaleParsed.embeddedPriceCents) {
              if (typeof l.weightGrams === "number" && l.weightGrams > 0) {
                const expectedEmbeddedCents = computeWeightedPriceCents(
                  l.weightGrams,
                  authBarcode.sellPriceCents
                );
                if (Math.abs(scaleParsed.embeddedPriceCents - expectedEmbeddedCents) > 1) {
                  return reply.status(400).send({
                    error: `Scale barcode embedded price (${scaleParsed.embeddedPriceCents}c) conflicts with weight ${l.weightGrams}g at unit price ${authBarcode.sellPriceCents}c.`,
                  });
                }
              }
              embeddedPriceCents = scaleParsed.embeddedPriceCents;
              lineGross = embeddedPriceCents;
            } else {
              if (l.unitPriceCents !== authBarcode.sellPriceCents) {
                return reply.status(400).send({
                  error: `Per-kg/L unit price mismatch for ${meta.sku} (expected ${authBarcode.sellPriceCents}c, got ${l.unitPriceCents}c).`,
                });
              }
              lineGross = computeWeightedPriceCents(effectiveWeightGrams, authBarcode.sellPriceCents);
            }
            baseUnitsSold = effectiveWeightGrams;
            lineCostCents = computeWeightedPriceCents(effectiveWeightGrams, meta.avgCostCents);
          } else {
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
            lineGross = l.unitPriceCents * l.qtyPacks;
            baseUnitsSold = l.packQty * l.qtyPacks;
            lineCostCents = meta.avgCostCents * baseUnitsSold;
          }
        } else if (isMeasured) {
          if (!effectiveWeightGrams && scaleParsed?.kind === "weight" && scaleParsed.weightGrams) {
            effectiveWeightGrams = scaleParsed.weightGrams;
          } else if (
            !effectiveWeightGrams &&
            scaleParsed?.kind === "price" &&
            scaleParsed.embeddedPriceCents
          ) {
            effectiveWeightGrams = deriveWeightFromPriceGrams(
              scaleParsed.embeddedPriceCents,
              l.unitPriceCents
            );
          }
          if (!effectiveWeightGrams || effectiveWeightGrams < 1) {
            return reply.status(400).send({
              error: `Measured product ${meta.sku} reversal requires weightGrams >= 1.`,
            });
          }
          if (
            scaleParsed?.kind === "price" &&
            scaleParsed.embeddedPriceCents &&
            typeof l.weightGrams === "number" &&
            l.weightGrams > 0
          ) {
            const expectedEmbeddedCents = computeWeightedPriceCents(
              l.weightGrams,
              l.unitPriceCents
            );
            if (Math.abs(scaleParsed.embeddedPriceCents - expectedEmbeddedCents) > 1) {
              return reply.status(400).send({
                error: `Scale barcode embedded price (${scaleParsed.embeddedPriceCents}c) conflicts with weight ${l.weightGrams}g at unit price ${l.unitPriceCents}c.`,
              });
            }
          }
          lineGross =
            scaleParsed?.kind === "price" && scaleParsed.embeddedPriceCents
              ? scaleParsed.embeddedPriceCents
              : computeWeightedPriceCents(effectiveWeightGrams, l.unitPriceCents);
          baseUnitsSold = effectiveWeightGrams;
          lineCostCents = computeInventoryValueCents(
            effectiveWeightGrams,
            meta.avgCostCents,
            unitMode
          );
        }

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
          weightGrams: effectiveWeightGrams,
          tareGrams: l.tareGrams ?? null,
          baseUnitsSold,
          lineGrossCents: lineGross,
          lineCostCents,
          unitMode,
          embeddedPriceCents,
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

      const subtotalCents = normalizedLines.reduce((s, l) => s + l.lineGrossCents, 0);
      const discountCents = normalizedLines.reduce((s, l) => s + l.discountCents, 0);
      const taxCents = normalizedLines.reduce((s, l) => s + l.taxCents, 0);
      const totalCents = normalizedLines.reduce((s, l) => s + l.lineTotalCents, 0);
      let totalCostCents = normalizedLines.reduce((s, l) => s + l.lineCostCents, 0);

      const paidTotalCents = payload.payments.reduce((s, p) => s + p.amountCents, 0);
      if (payload.kind === "sale" && paidTotalCents < totalCents) {
        return reply.status(400).send({
          error: `Payment total (${paidTotalCents}c) is less than sale total (${totalCents}c).`,
        });
      }
      if (payload.kind !== "sale" && paidTotalCents !== totalCents) {
        return reply.status(400).send({
          error: `Reversal payment total (${paidTotalCents}c) must exactly equal reversal total (${totalCents}c).`,
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
      let persistedReceiptNo = payload.receiptNo;
      let persistedTotalCents = totalCents;
      let txRejection: { status: 400 | 403 | 404 | 409; message: string } | null = null;
      let pointsEarned = 0;

      try {
        await db.transaction(async (tx) => {
          let effectiveCustomerId: string | null =
            payload.kind === "sale" ? (payload.customerId ?? null) : null;
          let pointsToRestore = 0;
          // Idempotent insert by client UUIDv7 primary key
          const [existingById] = await tx
            .select({
              id: sales.id,
              receiptNo: sales.receiptNo,
              totalCents: sales.totalCents,
            })
            .from(sales)
            .where(eq(sales.id, payload.id))
            .limit(1);
          if (existingById) {
            duplicate = true;
            persistedReceiptNo = existingById.receiptNo;
            persistedTotalCents = existingById.totalCents;
            return;
          }

          if (payload.shiftId) {
            const [refShift] = await tx
              .select({
                id: posShifts.id,
                registerCode: posShifts.registerCode,
                closedAt: posShifts.closedAt,
              })
              .from(posShifts)
              .where(eq(posShifts.id, payload.shiftId))
              .limit(1);
            if (!refShift) {
              txRejection = { status: 404, message: "Referenced shiftId was not found." };
              return;
            }
            if (refShift.closedAt !== null) {
              txRejection = {
                status: 409,
                message: "Cannot attach a sale or reversal to an already closed shift.",
              };
              return;
            }
            if (refShift.registerCode !== payload.registerCode) {
              txRejection = {
                status: 409,
                message: `Referenced shift belongs to register "${refShift.registerCode}", not "${payload.registerCode}".`,
              };
              return;
            }
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
            effectiveCustomerId = orig.customerId ?? null;

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

            // Aggregate original and already-refunded quantities (including weighed baseUnitsSold) per (productId, scannedBarcode)
            const origAgg = new Map<
              string,
              {
                qtyPacks: number;
                baseUnitsSold: number;
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
                cur.baseUnitsSold += ol.baseUnitsSold;
                cur.lineTotalCents += ol.lineTotalCents;
              } else {
                origAgg.set(key, {
                  qtyPacks: ol.qtyPacks,
                  baseUnitsSold: ol.baseUnitsSold,
                  packQty: ol.packQty,
                  unitPriceCents: ol.unitPriceCents,
                  unitCostCents: ol.unitCostCents,
                  lineTotalCents: ol.lineTotalCents,
                });
              }
            }

            const refundedAgg = new Map<
              string,
              { qtyPacks: number; baseUnitsSold: number; lineTotalCents: number }
            >();
            for (const rl of priorRefundLines) {
              const key = `${rl.productId}::${rl.scannedBarcode}`;
              const cur = refundedAgg.get(key) ?? {
                qtyPacks: 0,
                baseUnitsSold: 0,
                lineTotalCents: 0,
              };
              cur.qtyPacks += rl.qtyPacks;
              cur.baseUnitsSold += rl.baseUnitsSold;
              cur.lineTotalCents += rl.lineTotalCents;
              refundedAgg.set(key, cur);
            }

            const reqAgg = new Map<
              string,
              { qtyPacks: number; baseUnitsSold: number; lineTotalCents: number }
            >();
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
              if (l.unitPriceCents !== origItem.unitPriceCents) {
                txRejection = {
                  status: 400,
                  message: `Unit price mismatch for reversal item "${l.scannedBarcode}" (expected ${origItem.unitPriceCents}c, got ${l.unitPriceCents}c).`,
                };
                return;
              }
              // Use original sale cost-at-sale on restock movements & scale weighted units properly
              l.unitCostCents = origItem.unitCostCents;
              l.lineCostCents = computeInventoryValueCents(
                l.baseUnitsSold,
                l.unitCostCents,
                l.unitMode
              );
              const cur = reqAgg.get(key) ?? { qtyPacks: 0, baseUnitsSold: 0, lineTotalCents: 0 };
              cur.qtyPacks += l.qtyPacks;
              cur.baseUnitsSold += l.baseUnitsSold;
              cur.lineTotalCents += l.lineTotalCents;
              reqAgg.set(key, cur);
            }

            for (const [key, reqItem] of reqAgg.entries()) {
              const origItem = origAgg.get(key)!;
              const prevRef = refundedAgg.get(key) ?? {
                qtyPacks: 0,
                baseUnitsSold: 0,
                lineTotalCents: 0,
              };
              const remainingQty = origItem.qtyPacks - prevRef.qtyPacks;
              if (reqItem.qtyPacks > remainingQty) {
                txRejection = {
                  status: 409,
                  message: `Reversal quantity (${reqItem.qtyPacks}) exceeds remaining refundable quantity (${remainingQty}) on receipt ${orig.receiptNo}.`,
                };
                return;
              }
              const remainingBaseUnits = origItem.baseUnitsSold - prevRef.baseUnitsSold;
              if (reqItem.baseUnitsSold > remainingBaseUnits) {
                txRejection = {
                  status: 409,
                  message: `Reversal base units (${reqItem.baseUnitsSold}) exceeds remaining refundable units (${remainingBaseUnits}) on receipt ${orig.receiptNo}.`,
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

            if (effectiveCustomerId) {
              const origLoyaltyRows = await tx
                .select({ amountCents: salePayments.amountCents })
                .from(salePayments)
                .where(
                  and(
                    eq(salePayments.saleId, orig.id),
                    eq(salePayments.method, "loyalty_points")
                  )
                );
              const origLoyaltyRedeemed = origLoyaltyRows.reduce(
                (s, r) => s + Number(r.amountCents ?? 0),
                0
              );
              if (origLoyaltyRedeemed > 0) {
                let alreadyRestored = 0;
                if (priorRefundIds.length > 0) {
                  const priorRestoreRows = await tx
                    .select({ pointsDelta: loyaltyLedger.pointsDelta })
                    .from(loyaltyLedger)
                    .where(
                      and(
                        inArray(loyaltyLedger.saleId, priorRefundIds),
                        eq(loyaltyLedger.reason, "refund_restore")
                      )
                    );
                  alreadyRestored = priorRestoreRows.reduce(
                    (s, r) => s + Math.max(0, Number(r.pointsDelta ?? 0)),
                    0
                  );
                }
                const remainingRestorable = Math.max(0, origLoyaltyRedeemed - alreadyRestored);
                if (
                  payload.kind === "void" ||
                  priorRefundedTotalCents + totalCents >= orig.totalCents
                ) {
                  pointsToRestore = remainingRestorable;
                } else if (orig.totalCents > 0) {
                  pointsToRestore = Math.min(
                    remainingRestorable,
                    Math.round((origLoyaltyRedeemed * totalCents) / orig.totalCents)
                  );
                }
              }
            }

            totalCostCents = normalizedLines.reduce((s, l) => s + l.lineCostCents, 0);
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
                unitMode: l.unitMode,
                weightGrams: l.weightGrams ?? null,
                tareGrams: l.tareGrams ?? null,
                embeddedPriceCents: l.embeddedPriceCents,
                unitPriceCents: l.unitPriceCents,
                unitCostCents: meta.avgCostCents,
                taxRateBp: meta.taxRateBp,
                taxInclusive: meta.taxInclusive,
                requiresAgeCheck: meta.requiresAgeCheck,
              };
            });
            const soldDate = new Date(payload.soldAt);
            const storeTz = storeSettingsRow.storeTimezone || env.storeTimezone;
            const serverEval = evaluateCart(cartInputs, mappedActivePromos, {
              evalNow: soldDate,
              evalHour: getHourInTimezone(soldDate, storeTz),
              couponDiscountCents: lockedCouponDiscountCents,
            });
            if (discountCents > serverEval.totalDiscountCents) {
              txRejection = {
                status: 400,
                message: `Total discount (${discountCents}c) exceeds maximum authorized promotion and coupon discount (${serverEval.totalDiscountCents}c).`,
              };
              return;
            }
            const evalLineByKey = new Map(serverEval.lines.map((el) => [el.lineKey, el]));
            for (const line of normalizedLines) {
              const allowedLineDiscount = evalLineByKey.get(line.id)?.discountCents ?? 0;
              if (line.discountCents > allowedLineDiscount) {
                txRejection = {
                  status: 400,
                  message: `Line discount (${line.discountCents}c) for ${line.scannedBarcode} exceeds authorized discount (${allowedLineDiscount}c).`,
                };
                return;
              }
            }
          }

          // Verify all EMVCo QR / terminal payment intents are present, settled, unlinked, and match leg amount & rail
          const rawIntentIds = payload.payments
            .map((p) => p.paymentIntentId)
            .filter((id): id is string => Boolean(id));
          const referencedIntentIds = Array.from(new Set(rawIntentIds)).sort();
          if (payload.kind === "sale") {
            const missingIntentLeg = payload.payments.find(
              (p) =>
                (p.method === "khqr" || p.method === "promptpay" || p.method === "paynow") &&
                !p.paymentIntentId
            );
            if (missingIntentLeg) {
              txRejection = {
                status: 400,
                message: `Payment method "${missingIntentLeg.method}" requires a settled paymentIntentId.`,
              };
              return;
            }
            if (referencedIntentIds.length !== rawIntentIds.length) {
              txRejection = {
                status: 400,
                message:
                  "Duplicate paymentIntentId across multiple tender legs in the same sale is not allowed.",
              };
              return;
            }
          }
          if (payload.kind === "sale" && referencedIntentIds.length > 0) {
            const lockedIntents = await tx
              .select()
              .from(paymentIntents)
              .where(inArray(paymentIntents.id, referencedIntentIds))
              .orderBy(asc(paymentIntents.id))
              .for("update");
            if (lockedIntents.length !== referencedIntentIds.length) {
              txRejection = { status: 400, message: "Referenced paymentIntentId was not found." };
              return;
            }
            const intentById = new Map(lockedIntents.map((intent) => [intent.id, intent]));
            for (const leg of payload.payments) {
              if (!leg.paymentIntentId) continue;
              const intent = intentById.get(leg.paymentIntentId)!;
              if (intent.status !== "paid") {
                txRejection = {
                  status: 409,
                  message: `Payment intent ${intent.billReference} is "${intent.status}" and must be settled ("paid") before finalizing checkout.`,
                };
                return;
              }
              if (intent.saleId && intent.saleId !== payload.id) {
                txRejection = {
                  status: 409,
                  message: `Payment intent ${intent.billReference} has already been linked to another receipt.`,
                };
                return;
              }
              if (leg.amountCents !== intent.amountCents) {
                txRejection = {
                  status: 400,
                  message: `Tender leg amount (${leg.amountCents}c) does not match settled payment intent ${intent.billReference} (${intent.amountCents}c).`,
                };
                return;
              }
              const expectedMethod = intent.rail === "card_terminal" ? "card" : intent.rail;
              if (leg.method !== expectedMethod) {
                txRejection = {
                  status: 400,
                  message: `Tender method "${leg.method}" does not match payment intent rail "${intent.rail}".`,
                };
                return;
              }
            }
          }

          // Validate loyalty_points tender leg requires customerId & sufficient balance (1 pt = 1 cent)
          const loyaltyRedeemCents =
            payload.kind === "sale"
              ? payload.payments
                  .filter((p) => p.method === "loyalty_points")
                  .reduce((s, p) => s + p.amountCents, 0)
              : 0;
          if (loyaltyRedeemCents > 0) {
            if (!payload.customerId) {
              txRejection = {
                status: 400,
                message: "Loyalty points tender requires a linked loyalty customer.",
              };
              return;
            }
            const [checkCust] = await tx
              .select({ pointsBalance: customers.pointsBalance })
              .from(customers)
              .where(eq(customers.id, payload.customerId))
              .for("update");
            if (!checkCust || checkCust.pointsBalance < loyaltyRedeemCents) {
              txRejection = {
                status: 400,
                message: `Insufficient loyalty points balance (available: ${checkCust?.pointsBalance ?? 0} pts, requested: ${loyaltyRedeemCents} pts).`,
              };
              return;
            }
          }

          // Verify & atomically consume single-use server-issued supervisorOverrideId (blocks client audit forgery)
          let verifiedOverride: typeof supervisorOverrides.$inferSelect | null = null;
          if (payload.supervisorOverrideId) {
            const [ov] = await tx
              .select()
              .from(supervisorOverrides)
              .where(eq(supervisorOverrides.id, payload.supervisorOverrideId))
              .for("update");
            if (!ov) {
              txRejection = {
                status: 400,
                message: "Referenced supervisorOverrideId was not found.",
              };
              return;
            }
            if (ov.cashierUserId !== actor.id) {
              txRejection = {
                status: 403,
                message: "Supervisor override token belongs to a different cashier session.",
              };
              return;
            }
            if (ov.consumedBySaleId) {
              txRejection = {
                status: 409,
                message: "Supervisor override token has already been consumed.",
              };
              return;
            }
            if (new Date(ov.expiresAt).getTime() <= Date.now()) {
              txRejection = {
                status: 409,
                message: "Supervisor override token has expired.",
              };
              return;
            }
            verifiedOverride = ov;
          }

          const inserted = await tx
            .insert(sales)
            .values({
              id: payload.id,
              registerCode: payload.registerCode,
              shiftId: payload.shiftId ?? null,
              customerId: effectiveCustomerId,
              receiptNo: payload.receiptNo,
              kind: payload.kind,
              originalSaleId: payload.originalSaleId ?? null,
              cashierName: actor.fullName,
              cashierUserId: actor.id,
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
            const [raceExisting] = await tx
              .select({ receiptNo: sales.receiptNo, totalCents: sales.totalCents })
              .from(sales)
              .where(eq(sales.id, payload.id))
              .limit(1);
            duplicate = true;
            if (raceExisting) {
              persistedReceiptNo = raceExisting.receiptNo;
              persistedTotalCents = raceExisting.totalCents;
            }
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

          // Release single-use loyalty coupon if the original sale is fully voided (H-10)
          if (payload.kind === "void" && payload.originalSaleId) {
            await tx
              .update(targetedCoupons)
              .set({
                redeemedSaleId: null,
                redeemedAt: null,
              })
              .where(eq(targetedCoupons.redeemedSaleId, payload.originalSaleId));
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
              weightGrams: l.weightGrams ?? null,
              tareGrams: l.tareGrams ?? null,
              baseUnitsSold: l.baseUnitsSold,
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
              externalRef: p.externalRef ?? null,
              paymentIntentId: payload.kind === "sale" ? (p.paymentIntentId ?? null) : null,
              currencyCode: p.currencyCode ?? "USD",
              foreignAmount: p.foreignAmount ?? null,
              fxRateUsed: p.fxRateUsed ?? null,
            }))
          );

          if (payload.kind === "sale" && referencedIntentIds.length > 0) {
            await tx
              .update(paymentIntents)
              .set({ saleId: payload.id })
              .where(inArray(paymentIntents.id, referencedIntentIds));
          }

          if (verifiedOverride) {
            await tx
              .update(supervisorOverrides)
              .set({
                consumedBySaleId: payload.id,
                consumedAt: new Date(),
              })
              .where(eq(supervisorOverrides.id, verifiedOverride.id));

            await tx.insert(auditLogs).values({
              actor: verifiedOverride.supervisorName,
              action: "pos_sale_supervisor_override",
              entityType: "sale",
              entityId: payload.id,
              detailsJson: {
                overrideId: verifiedOverride.id,
                receiptNo: payload.receiptNo,
                cashier: actor.fullName,
                supervisorId: verifiedOverride.supervisorUserId,
                supervisor: verifiedOverride.supervisorName,
                supervisorRole: verifiedOverride.supervisorRole,
                reason: verifiedOverride.reason,
              },
            });
          }

          // Append immutable inventory ledger rows + locked FEFO batch depletion/restoration
          // Sort lines by productId for deterministic row-lock ordering across concurrent checkouts
          const orderedLines = [...normalizedLines].sort((a, b) =>
            a.productId.localeCompare(b.productId)
          );
          const movementRows: (typeof stockMovements.$inferInsert)[] = [];

          // For voids/refunds, compute restorable batch capacity from the original sale's FEFO movements (H-10)
          const restorableBatchesByProduct = new Map<
            string,
            { batchId: string; remainingRestore: number }[]
          >();
          if (sign === 1 && payload.originalSaleId) {
            const origMovements = await tx
              .select({
                productId: stockMovements.productId,
                batchId: stockMovements.batchId,
                qtyDelta: stockMovements.qtyDelta,
              })
              .from(stockMovements)
              .where(
                and(
                  eq(stockMovements.refId, payload.originalSaleId),
                  sql`${stockMovements.batchId} IS NOT NULL`,
                  sql`${stockMovements.qtyDelta} < 0`
                )
              );

            if (origMovements.length > 0) {
              const priorRevSales = await tx
                .select({ id: sales.id })
                .from(sales)
                .where(
                  and(
                    eq(sales.originalSaleId, payload.originalSaleId),
                    sql`${sales.id} <> ${payload.id}`
                  )
                );
              const priorRevIds = priorRevSales.map((r) => r.id);
              const alreadyRestoredByBatch = new Map<string, number>();
              if (priorRevIds.length > 0) {
                const priorRestores = await tx
                  .select({
                    productId: stockMovements.productId,
                    batchId: stockMovements.batchId,
                    qtyDelta: stockMovements.qtyDelta,
                  })
                  .from(stockMovements)
                  .where(
                    and(
                      inArray(stockMovements.refId, priorRevIds),
                      sql`${stockMovements.batchId} IS NOT NULL`,
                      sql`${stockMovements.qtyDelta} > 0`
                    )
                  );
                for (const pr of priorRestores) {
                  if (!pr.batchId) continue;
                  const k = `${pr.productId}::${pr.batchId}`;
                  alreadyRestoredByBatch.set(k, (alreadyRestoredByBatch.get(k) ?? 0) + pr.qtyDelta);
                }
              }

              const origByKey = new Map<string, { productId: string; batchId: string; depleted: number }>();
              for (const om of origMovements) {
                if (!om.batchId) continue;
                const k = `${om.productId}::${om.batchId}`;
                const prev = origByKey.get(k);
                if (prev) {
                  prev.depleted += Math.abs(om.qtyDelta);
                } else {
                  origByKey.set(k, {
                    productId: om.productId,
                    batchId: om.batchId,
                    depleted: Math.abs(om.qtyDelta),
                  });
                }
              }

              for (const [k, entry] of origByKey.entries()) {
                const restorable = entry.depleted - (alreadyRestoredByBatch.get(k) ?? 0);
                if (restorable > 0) {
                  const list = restorableBatchesByProduct.get(entry.productId) ?? [];
                  list.push({ batchId: entry.batchId, remainingRestore: restorable });
                  restorableBatchesByProduct.set(entry.productId, list);
                }
              }
            }
          }

          for (const l of orderedLines) {
            const baseUnits = l.baseUnitsSold;
            if (sign === -1) {
              const fefoRes = await depleteFefoBatchesTx(tx, l.productId, baseUnits);
              for (const alloc of fefoRes.allocations) {
                movementRows.push({
                  id: generateUuidV7(),
                  productId: l.productId,
                  batchId: alloc.batchId,
                  qtyDelta: -alloc.qty,
                  unitCostCents: l.unitCostCents,
                  reason: payload.kind,
                  refId: payload.id,
                  folded: false,
                  createdAt: new Date(payload.soldAt),
                });
                if (alloc.depletedClearance) {
                  await tx
                    .update(promotions)
                    .set({ active: false })
                    .where(
                      and(
                        eq(promotions.promoType, "clearance"),
                        eq(promotions.active, true),
                        sql`${promotions.rulesJson}->>'batchId' = ${alloc.batchId}`
                      )
                    );
                }
              }

              if (fefoRes.unbatchedRemainder > 0) {
                movementRows.push({
                  id: generateUuidV7(),
                  productId: l.productId,
                  batchId: null,
                  qtyDelta: -fefoRes.unbatchedRemainder,
                  unitCostCents: l.unitCostCents,
                  reason: payload.kind,
                  refId: payload.id,
                  folded: false,
                  createdAt: new Date(payload.soldAt),
                });
              }
            } else {
              let remainingToRestore = baseUnits;
              const batchSlots = restorableBatchesByProduct.get(l.productId) ?? [];
              const batchIds = batchSlots
                .filter((s) => s.remainingRestore > 0)
                .map((s) => s.batchId)
                .sort();
              if (batchIds.length > 0) {
                const lockedBatches = await tx
                  .select()
                  .from(inventoryBatches)
                  .where(inArray(inventoryBatches.id, batchIds))
                  .orderBy(asc(inventoryBatches.id))
                  .for("update");
                const batchById = new Map(lockedBatches.map((b) => [b.id, b]));

                const todayIso = new Date().toISOString().slice(0, 10);
                for (const slot of batchSlots) {
                  if (remainingToRestore <= 0 || slot.remainingRestore <= 0) continue;
                  const batch = batchById.get(slot.batchId);
                  if (!batch) continue;
                  const restoreQty = Math.min(remainingToRestore, slot.remainingRestore);
                  const isExpiredBatch =
                    batch.status === "expired" ||
                    (Boolean(batch.bestBeforeDate) && batch.bestBeforeDate < todayIso);
                  if (isExpiredBatch) {
                    if (batch.status !== "expired") {
                      await tx
                        .update(inventoryBatches)
                        .set({ status: "expired" })
                        .where(eq(inventoryBatches.id, batch.id));
                      batch.status = "expired";
                    }
                    slot.remainingRestore -= restoreQty;
                    remainingToRestore -= restoreQty;

                    // Record physical return and immediate expired-batch quarantine spoilage so sellable stock stays unaffected
                    movementRows.push(
                      {
                        id: generateUuidV7(),
                        productId: l.productId,
                        batchId: batch.id,
                        qtyDelta: restoreQty,
                        unitCostCents: l.unitCostCents,
                        reason: payload.kind,
                        refId: payload.id,
                        folded: false,
                        createdAt: new Date(payload.soldAt),
                      },
                      {
                        id: generateUuidV7(),
                        productId: l.productId,
                        batchId: batch.id,
                        qtyDelta: -restoreQty,
                        unitCostCents: l.unitCostCents,
                        reason: "spoilage",
                        refId: payload.id,
                        folded: false,
                        createdAt: new Date(payload.soldAt),
                      }
                    );
                    await tx.insert(auditLogs).values({
                      actor: actor.fullName,
                      action: "expired_return_quarantined",
                      entityType: "inventory_batch",
                      entityId: batch.id,
                      detailsJson: {
                        saleId: payload.id,
                        originalSaleId: payload.originalSaleId ?? null,
                        productId: l.productId,
                        qtyQuarantined: restoreQty,
                        bestBeforeDate: batch.bestBeforeDate,
                      },
                    });
                    continue;
                  }

                  const nextQty = batch.qtyRemaining + restoreQty;
                  const nextStatus = batch.status === "depleted" ? "active" : batch.status;
                  await tx
                    .update(inventoryBatches)
                    .set({ qtyRemaining: nextQty, status: nextStatus })
                    .where(eq(inventoryBatches.id, batch.id));
                  batch.qtyRemaining = nextQty;
                  batch.status = nextStatus;
                  slot.remainingRestore -= restoreQty;
                  remainingToRestore -= restoreQty;

                  movementRows.push({
                    id: generateUuidV7(),
                    productId: l.productId,
                    batchId: batch.id,
                    qtyDelta: restoreQty,
                    unitCostCents: l.unitCostCents,
                    reason: payload.kind,
                    refId: payload.id,
                    folded: false,
                    createdAt: new Date(payload.soldAt),
                  });
                }
              }

              if (remainingToRestore > 0) {
                movementRows.push({
                  id: generateUuidV7(),
                  productId: l.productId,
                  batchId: null,
                  qtyDelta: remainingToRestore,
                  unitCostCents: l.unitCostCents,
                  reason: payload.kind,
                  refId: payload.id,
                  folded: false,
                  createdAt: new Date(payload.soldAt),
                });
              }
            }
          }

          if (movementRows.length > 0) {
            await tx.insert(stockMovements).values(movementRows);
          }

          // Customer loyalty points accrual (1 pt / $1) or refund/void clawback + redeemed-points restoration
          if (effectiveCustomerId) {
            const [lockedCust] = await tx
              .select()
              .from(customers)
              .where(eq(customers.id, effectiveCustomerId))
              .for("update");
            if (lockedCust) {
              const pts = Math.floor(totalCents / 100);
              if (payload.kind === "sale") {
                pointsEarned = pts;
                await tx
                  .update(customers)
                  .set({
                    pointsBalance: Math.max(0, lockedCust.pointsBalance - loyaltyRedeemCents + pts),
                    lifetimeSpendCents: lockedCust.lifetimeSpendCents + totalCents,
                    visits60d: lockedCust.visits60d + 1,
                    lastVisitAt: new Date(payload.soldAt),
                  })
                  .where(eq(customers.id, lockedCust.id));
                if (loyaltyRedeemCents > 0) {
                  await tx.insert(loyaltyLedger).values({
                    customerId: lockedCust.id,
                    saleId: payload.id,
                    pointsDelta: -loyaltyRedeemCents,
                    reason: "redeem",
                  });
                }
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
                    pointsBalance: Math.max(0, lockedCust.pointsBalance - pts + pointsToRestore),
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
                if (pointsToRestore > 0) {
                  await tx.insert(loyaltyLedger).values({
                    customerId: lockedCust.id,
                    saleId: payload.id,
                    pointsDelta: pointsToRestore,
                    reason: "refund_restore",
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
        const rej = txRejection as { status: 400 | 403 | 404 | 409; message: string };
        return reply.status(rej.status).send({ error: rej.message });
      }

      if (!duplicate) {
        recordPosSaleMetric(payload.kind);
      }

      return reply.status(duplicate ? 200 : 201).send({
        id: payload.id,
        receiptNo: persistedReceiptNo,
        duplicate,
        totalCents: persistedTotalCents,
        pointsEarned,
      });
    }
  );

  // Recent POS receipts feed (enriched with lines, payments, and void status for POS Receipt Lookup)
  app.get(
    "/api/pos/recent-sales",
    { preHandler: [requireRole(["owner", "manager", "cashier", "accountant"])] },
    async (req) => {
      const isCashier = req.authUser?.role === "cashier";
      const recent = await db
        .select()
        .from(sales)
        .where(
          isCashier
            ? or(
                eq(sales.cashierUserId, req.authUser!.id),
                and(isNull(sales.cashierUserId), eq(sales.cashierName, req.authUser!.fullName))
              )
            : undefined
        )
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
            weightGrams: saleLines.weightGrams,
            tareGrams: saleLines.tareGrams,
            baseUnitsSold: saleLines.baseUnitsSold,
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

      const linesBySale = new Map<string, Record<string, unknown>[]>();
      for (const l of linesRows) {
        const list = linesBySale.get(l.saleId) ?? [];
        if (isCashier) {
          const { unitCostCents: _c, ...pubLine } = l;
          list.push(pubLine);
        } else {
          list.push(l);
        }
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
        sales: recent.map((s) => {
          const base = isCashier
            ? (({ totalCostCents: _tc, ...rest }) => rest)(s)
            : s;
          return {
            ...base,
            alreadyVoided: voidedSet.has(s.id),
            lines: linesBySale.get(s.id) ?? [],
            payments: payBySale.get(s.id) ?? [],
          };
        }),
      };
    }
  );
}

