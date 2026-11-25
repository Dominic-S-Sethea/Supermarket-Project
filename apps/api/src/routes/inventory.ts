import type { FastifyInstance } from "fastify";
import {
  computeEffectiveUnitCostCents,
  computeMovingWeightedAvgCostCents,
  computeNetMarginBp,
  computeSuggestedSellPriceCents,
  CreateGrnSchema,
  CreatePurchaseOrderSchema,
  generateUuidV7,
  UpdatePoStatusSchema,
} from "@supermarket/shared";
import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  analyticsDynamicMarkdowns,
  auditLogs,
  categories,
  db,
  departments,
  goodsReceipts,
  grnLines,
  grnVariances,
  inventoryBatches,
  marginAlerts,
  productBarcodes,
  products,
  promotions,
  purchaseOrderLines,
  purchaseOrders,
  shelfTagQueue,
  stockBaselines,
  stockMovements,
  suppliers,
  taxRates,
} from "../db/index.js";
import { requireRole } from "../plugins/auth.js";

export async function inventoryRoutes(app: FastifyInstance) {
  // FEFO Best-Before Expiry Alerts Console
  app.get(
    "/api/inventory/expiry-alerts",
    { preHandler: [requireRole(["owner", "manager", "stock_clerk"])] },
    async (req) => {
      const q = req.query as { days?: string };
      const horizonDays = Math.min(180, Math.max(7, Number(q.days ?? 60)));
      const cutoff = new Date(Date.now() + horizonDays * 86400_000)
        .toISOString()
        .slice(0, 10);

      const rows = await db
        .select({
          batchId: inventoryBatches.id,
          productId: products.id,
          sku: products.sku,
          name: products.name,
          brand: products.brand,
          departmentName: departments.name,
          aisleLocation: products.aisleLocation,
          lotCode: inventoryBatches.lotCode,
          bestBeforeDate: inventoryBatches.bestBeforeDate,
          qtyRemaining: inventoryBatches.qtyRemaining,
          unitCostCents: inventoryBatches.unitCostCents,
          status: inventoryBatches.status,
        })
        .from(inventoryBatches)
        .innerJoin(products, eq(inventoryBatches.productId, products.id))
        .innerJoin(categories, eq(products.categoryId, categories.id))
        .innerJoin(departments, eq(categories.departmentId, departments.id))
        .where(
          and(
            lte(inventoryBatches.bestBeforeDate, cutoff),
            sql`${inventoryBatches.qtyRemaining} > 0`,
            sql`${inventoryBatches.status} IN ('active', 'clearance')`
          )
        )
        .orderBy(asc(inventoryBatches.bestBeforeDate))
        .limit(120);

      const todayMs = Date.now();
      const items = rows.map((r) => {
        const daysLeft = Math.ceil(
          (new Date(r.bestBeforeDate).getTime() - todayMs) / 86400_000
        );
        return {
          ...r,
          daysLeft,
          atRiskCostCents: r.qtyRemaining * r.unitCostCents,
        };
      });

      return { horizonDays, items };
    }
  );

  // Act on a near-expiry batch: Mark for Clearance OR Write Off as Spoilage
  app.post(
    "/api/inventory/batches/:id/action",
    { preHandler: [requireRole(["owner", "manager"])] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const schema = z.object({
        action: z.enum(["clearance", "write_off"]),
        discountPct: z.number().int().min(5).max(80).optional().default(30),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const actorName = req.authUser!.fullName;
      const [batch] = await db
        .select()
        .from(inventoryBatches)
        .where(eq(inventoryBatches.id, id));
      if (!batch) return reply.status(404).send({ error: "Batch not found" });

      if (parsed.data.action === "clearance") {
        const discountPct = parsed.data.discountPct;
        const result = await db.transaction(async (tx) => {
          const [lockedBatch] = await tx
            .select()
            .from(inventoryBatches)
            .where(eq(inventoryBatches.id, id))
            .for("update");
          if (!lockedBatch || lockedBatch.qtyRemaining <= 0) {
            return { empty: true as const };
          }

          await tx
            .update(inventoryBatches)
            .set({ status: "clearance" })
            .where(eq(inventoryBatches.id, id));

          const [prod] = await tx
            .select({ id: products.id, name: products.name })
            .from(products)
            .where(eq(products.id, lockedBatch.productId))
            .limit(1);
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

          const now = new Date();
          const endsAt = new Date(
            Math.max(
              now.getTime() + 7 * 86400_000,
              new Date(lockedBatch.bestBeforeDate).getTime() + 86400_000
            )
          );
          const promoName = `Clearance ${discountPct}% Off: ${prod?.name ?? "Expiring Batch"}`;
          const [promo] = await tx
            .insert(promotions)
            .values({
              name: promoName,
              promoType: "clearance",
              priority: 5,
              combinable: false,
              minMarginGuardBp: 0,
              startsAt: now,
              endsAt,
              active: true,
              rulesJson: {
                productIds: [lockedBatch.productId],
                discountBp: discountPct * 100,
              },
            })
            .returning();

          if (primaryBc) {
            const newPromoPrice = Math.max(
              1,
              Math.round((primaryBc.sellPriceCents * (100 - discountPct)) / 100)
            );
            await tx.insert(shelfTagQueue).values({
              productId: lockedBatch.productId,
              barcode: primaryBc.barcode,
              oldPriceCents: primaryBc.sellPriceCents,
              newPriceCents: newPromoPrice,
              reason: "clearance",
              status: "pending",
            });
          }

          await tx
            .update(analyticsDynamicMarkdowns)
            .set({ status: "applied" })
            .where(eq(analyticsDynamicMarkdowns.batchId, id));

          await tx.insert(auditLogs).values({
            actor: actorName,
            action: "expiry_markdown",
            entityType: "inventory_batch",
            entityId: id,
            detailsJson: {
              discountPct,
              qty: lockedBatch.qtyRemaining,
              promotionId: promo.id,
            },
          });

          return { empty: false as const, promotionId: promo.id };
        });

        if (result.empty) {
          return reply.status(400).send({ error: "Batch has 0 remaining units" });
        }
        return { status: "clearance", batchId: id, promotionId: result.promotionId };
      }

      const writeOffRes = await db.transaction(async (tx) => {
        const [lockedBatch] = await tx
          .select()
          .from(inventoryBatches)
          .where(eq(inventoryBatches.id, id))
          .for("update");
        if (!lockedBatch || lockedBatch.qtyRemaining <= 0) {
          return null;
        }

        await tx
          .update(inventoryBatches)
          .set({ status: "expired", qtyRemaining: 0 })
          .where(eq(inventoryBatches.id, id));

        await tx.insert(stockMovements).values({
          id: generateUuidV7(),
          productId: lockedBatch.productId,
          batchId: lockedBatch.id,
          qtyDelta: -lockedBatch.qtyRemaining,
          unitCostCents: lockedBatch.unitCostCents,
          reason: "spoilage",
          refId: lockedBatch.id,
          folded: false,
        });

        await tx.insert(auditLogs).values({
          actor: actorName,
          action: "expiry_write_off",
          entityType: "inventory_batch",
          entityId: id,
          detailsJson: {
            qtyWrittenOff: lockedBatch.qtyRemaining,
            costCents: lockedBatch.qtyRemaining * lockedBatch.unitCostCents,
          },
        });

        return lockedBatch.qtyRemaining;
      });

      if (writeOffRes === null) {
        return reply.status(400).send({ error: "Batch already has 0 remaining units" });
      }
      return { status: "expired", writtenOffUnits: writeOffRes };
    }
  );

  // Margin Erosion Alerts
  app.get(
    "/api/inventory/margin-alerts",
    { preHandler: [requireRole(["owner", "manager"])] },
    async () => {
      const rows = await db
        .select({
          id: marginAlerts.id,
          productId: products.id,
          sku: products.sku,
          name: products.name,
          brand: products.brand,
          previousCostCents: marginAlerts.previousCostCents,
          newCostCents: marginAlerts.newCostCents,
          currentSellPriceCents: marginAlerts.currentSellPriceCents,
          resultingMarginBp: marginAlerts.resultingMarginBp,
          minMarginBp: marginAlerts.minMarginBp,
          suggestedSellPriceCents: marginAlerts.suggestedSellPriceCents,
          resolved: marginAlerts.resolved,
          createdAt: marginAlerts.createdAt,
        })
        .from(marginAlerts)
        .innerJoin(products, eq(marginAlerts.productId, products.id))
        .where(eq(marginAlerts.resolved, false))
        .orderBy(desc(marginAlerts.createdAt));

      return { alerts: rows };
    }
  );

  // Apply Suggested Retail Price + proportionally scale multi-pack & case prices
  app.post(
    "/api/inventory/margin-alerts/:id/apply-price",
    { preHandler: [requireRole(["owner", "manager"])] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as { customPriceCents?: number };
      const actorName = req.authUser!.fullName;

      const [alert] = await db
        .select()
        .from(marginAlerts)
        .where(eq(marginAlerts.id, id));
      if (!alert) return reply.status(404).send({ error: "Alert not found" });

      const [prod] = await db
        .select({
          id: products.id,
          avgCostCents: products.avgCostCents,
          minMarginBp: products.minMarginBp,
          taxRateBp: taxRates.rateBp,
          taxInclusive: taxRates.isInclusive,
        })
        .from(products)
        .innerJoin(taxRates, eq(products.taxRateId, taxRates.id))
        .where(eq(products.id, alert.productId));

      const newSellPrice = body.customPriceCents ?? alert.suggestedSellPriceCents;
      const allBarcodes = await db
        .select()
        .from(productBarcodes)
        .where(eq(productBarcodes.productId, alert.productId));
      const primaryBc = allBarcodes.find((b) => b.isPrimary) ?? allBarcodes[0];
      const oldPrimaryPrice = Math.max(1, primaryBc?.sellPriceCents ?? alert.currentSellPriceCents);
      const scaleRatio = newSellPrice / oldPrimaryPrice;

      const updatedRes = await db.transaction(async (tx) => {
        const [claimed] = await tx
          .update(marginAlerts)
          .set({ resolved: true })
          .where(and(eq(marginAlerts.id, id), eq(marginAlerts.resolved, false)))
          .returning();
        if (!claimed) return null;

        for (const bc of allBarcodes) {
          if (bc.isPrimary) {
            await tx
              .update(productBarcodes)
              .set({ sellPriceCents: newSellPrice })
              .where(eq(productBarcodes.id, bc.id));
          } else {
            const scaled = Math.ceil((bc.sellPriceCents * scaleRatio) / 5) * 5;
            const packFloor = prod
              ? computeSuggestedSellPriceCents(
                  Math.max(prod.avgCostCents, alert.newCostCents) * bc.packQty,
                  prod.minMarginBp,
                  prod.taxRateBp,
                  prod.taxInclusive,
                  5
                )
              : scaled;
            await tx
              .update(productBarcodes)
              .set({ sellPriceCents: Math.max(scaled, packFloor) })
              .where(eq(productBarcodes.id, bc.id));
          }
        }

        if (primaryBc && newSellPrice !== primaryBc.sellPriceCents) {
          await tx.insert(shelfTagQueue).values({
            productId: alert.productId,
            barcode: primaryBc.barcode,
            oldPriceCents: primaryBc.sellPriceCents,
            newPriceCents: newSellPrice,
            reason: "cost_change",
            status: "pending",
          });
        }

        await tx.insert(auditLogs).values({
          actor: actorName,
          action: "price_update_margin_alert",
          entityType: "product",
          entityId: alert.productId,
          detailsJson: {
            oldSellPriceCents: alert.currentSellPriceCents,
            newSellPriceCents: newSellPrice,
            updatedPackTiers: allBarcodes.length,
          },
        });
        return { updatedPackTiers: allBarcodes.length };
      });

      if (!updatedRes) {
        return reply.status(409).send({ error: "Margin alert is already resolved." });
      }

      return { resolved: true, newSellPriceCents: newSellPrice, updatedPackTiers: updatedRes.updatedPackTiers };
    }
  );

  // Persistent Purchase Orders
  app.get(
    "/api/purchasing/orders",
    { preHandler: [requireRole(["owner", "manager"])] },
    async () => {
      const rows = await db
        .select({
          id: purchaseOrders.id,
          poNumber: purchaseOrders.poNumber,
          supplierId: purchaseOrders.supplierId,
          supplierName: suppliers.name,
          status: purchaseOrders.status,
          totalCases: purchaseOrders.totalCases,
          estimatedCostCents: purchaseOrders.estimatedCostCents,
          createdBy: purchaseOrders.createdBy,
          approvedBy: purchaseOrders.approvedBy,
          notes: purchaseOrders.notes,
          createdAt: purchaseOrders.createdAt,
          approvedAt: purchaseOrders.approvedAt,
        })
        .from(purchaseOrders)
        .innerJoin(suppliers, eq(purchaseOrders.supplierId, suppliers.id))
        .orderBy(desc(purchaseOrders.createdAt))
        .limit(30);

      return { orders: rows };
    }
  );

  app.post(
    "/api/purchasing/orders",
    { preHandler: [requireRole(["owner", "manager"])] },
    async (req, reply) => {
      const parsed = CreatePurchaseOrderSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;
      const actorName = req.authUser!.fullName;
      const poNumber = `PO-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${generateUuidV7()
        .slice(-6)
        .toUpperCase()}`;

      const totalCases = data.lines.reduce((s, l) => s + l.orderedCases, 0);
      const estimatedCostCents = data.lines.reduce(
        (s, l) => s + l.orderedCases * l.caseQty * l.unitCostCents,
        0
      );

      const created = await db.transaction(async (tx) => {
        const [po] = await tx
          .insert(purchaseOrders)
          .values({
            poNumber,
            supplierId: data.supplierId,
            status: data.status,
            totalCases,
            estimatedCostCents,
            createdBy: actorName,
            approvedBy: data.status === "approved" ? actorName : null,
            approvedAt: data.status === "approved" ? new Date() : null,
            notes: data.notes ?? null,
          })
          .returning();

        await tx.insert(purchaseOrderLines).values(
          data.lines.map((l) => ({
            poId: po.id,
            productId: l.productId,
            caseQty: l.caseQty,
            orderedCases: l.orderedCases,
            unitCostCents: l.unitCostCents,
            lineTotalCents: l.orderedCases * l.caseQty * l.unitCostCents,
          }))
        );

        await tx.insert(auditLogs).values({
          actor: actorName,
          action: "po_create",
          entityType: "purchase_order",
          entityId: po.id,
          detailsJson: { poNumber, totalCases, estimatedCostCents },
        });

        return po;
      });

      return reply.status(201).send(created);
    }
  );

  app.patch(
    "/api/purchasing/orders/:id/status",
    { preHandler: [requireRole(["owner", "manager"])] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = UpdatePoStatusSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const actorName = req.authUser!.fullName;
      const updatePatch: Partial<typeof purchaseOrders.$inferInsert> = {
        status: parsed.data.status,
      };
      if (parsed.data.status === "approved") {
        updatePatch.approvedBy = actorName;
        updatePatch.approvedAt = new Date();
      }

      const [updated] = await db
        .update(purchaseOrders)
        .set(updatePatch)
        .where(eq(purchaseOrders.id, id))
        .returning();

      if (!updated) return reply.status(404).send({ error: "Purchase order not found" });

      await db.insert(auditLogs).values({
        actor: actorName,
        action: "po_status_update",
        entityType: "purchase_order",
        entityId: id,
        detailsJson: { poNumber: updated.poNumber, status: parsed.data.status },
      });

      return updated;
    }
  );

  // Goods Received Note (GRN) with Paid + Free Bonus Cases, consistent stock read, & Tax-Aware Net Margin Guard
  app.post(
    "/api/purchasing/grn",
    { preHandler: [requireRole(["owner", "manager"])] },
    async (req, reply) => {
      const parsed = CreateGrnSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;
      const actorName = req.authUser!.fullName;

      const totalInvoiceCents = data.lines.reduce(
        (s, l) => s + l.invoiceLineTotalCents,
        0
      );
      const createdAlerts: { productId: string; resultingMarginBp: number }[] = [];

      const grnId = await db.transaction(async (tx) => {
        const [grn] = await tx
          .insert(goodsReceipts)
          .values({
            supplierId: data.supplierId,
            poId: data.poId ?? null,
            invoiceNumber: data.invoiceNumber,
            receivedBy: actorName,
            totalInvoiceCents,
            notes: data.notes ?? null,
          })
          .returning();

        for (const line of data.lines) {
          const paidUnits = line.paidCases * line.caseQty;
          const freeUnits = line.freeBonusCases * line.caseQty;
          const totalUnits = paidUnits + freeUnits;
          if (totalUnits <= 0) continue;

          const effectiveUnitCost = computeEffectiveUnitCostCents(
            line.invoiceLineTotalCents,
            paidUnits,
            freeUnits
          );

          const unfoldedSq = tx
            .select({
              productId: stockMovements.productId,
              delta: sql<number>`coalesce(sum(${stockMovements.qtyDelta}), 0)::int`.as(
                "unfolded_delta"
              ),
            })
            .from(stockMovements)
            .where(and(eq(stockMovements.productId, line.productId), eq(stockMovements.folded, false)))
            .groupBy(stockMovements.productId)
            .as("unfolded_sq");

          const [prod] = await tx
            .select({
              id: products.id,
              avgCostCents: products.avgCostCents,
              minMarginBp: products.minMarginBp,
              taxRateBp: taxRates.rateBp,
              taxInclusive: taxRates.isInclusive,
              currentStock: sql<number>`(coalesce(${stockBaselines.quantity}, 0) + coalesce(${unfoldedSq.delta}, 0))::int`,
            })
            .from(products)
            .innerJoin(taxRates, eq(products.taxRateId, taxRates.id))
            .leftJoin(stockBaselines, eq(products.id, stockBaselines.productId))
            .leftJoin(unfoldedSq, eq(products.id, unfoldedSq.productId))
            .where(eq(products.id, line.productId));

          if (!prod) continue;

          const newAvgCost = computeMovingWeightedAvgCostCents(
            prod.currentStock,
            prod.avgCostCents,
            totalUnits,
            effectiveUnitCost
          );

          await tx.insert(grnLines).values({
            grnId: grn.id,
            productId: prod.id,
            caseQty: line.caseQty,
            paidCases: line.paidCases,
            freeBonusCases: line.freeBonusCases,
            baseUnitsReceived: totalUnits,
            invoiceLineTotalCents: line.invoiceLineTotalCents,
            effectiveUnitCostCents: effectiveUnitCost,
            bestBeforeDate: line.bestBeforeDate ?? null,
          });

          let batchId: string | null = null;
          if (line.bestBeforeDate) {
            const [batch] = await tx
              .insert(inventoryBatches)
              .values({
                productId: prod.id,
                lotCode: line.lotCode ?? `GRN-${data.invoiceNumber}`,
                bestBeforeDate: line.bestBeforeDate,
                unitCostCents: effectiveUnitCost,
                qtyReceived: totalUnits,
                qtyRemaining: totalUnits,
                status: "active",
              })
              .returning();
            batchId = batch.id;
          }

          // Both paid and free-bonus units carry the diluted effectiveUnitCost so ledger valuation matches totalInvoiceCents
          if (paidUnits > 0) {
            await tx.insert(stockMovements).values({
              id: generateUuidV7(),
              productId: prod.id,
              batchId,
              qtyDelta: paidUnits,
              unitCostCents: effectiveUnitCost,
              reason: "grn",
              refId: grn.id,
              folded: false,
            });
          }
          if (freeUnits > 0) {
            await tx.insert(stockMovements).values({
              id: generateUuidV7(),
              productId: prod.id,
              batchId,
              qtyDelta: freeUnits,
              unitCostCents: effectiveUnitCost,
              reason: "bonus_grn",
              refId: grn.id,
              folded: false,
            });
          }

          await tx
            .update(products)
            .set({ avgCostCents: newAvgCost, updatedAt: new Date() })
            .where(eq(products.id, prod.id));

          // Tax-aware net margin erosion check
          const [primaryBc] = await tx
            .select()
            .from(productBarcodes)
            .where(
              and(
                eq(productBarcodes.productId, prod.id),
                eq(productBarcodes.isPrimary, true)
              )
            );
          if (primaryBc) {
            const resultingMargin = computeNetMarginBp(
              primaryBc.sellPriceCents,
              effectiveUnitCost * primaryBc.packQty,
              prod.taxRateBp,
              prod.taxInclusive
            );
            if (resultingMargin < prod.minMarginBp) {
              const suggested = computeSuggestedSellPriceCents(
                effectiveUnitCost * primaryBc.packQty,
                prod.minMarginBp,
                prod.taxRateBp,
                prod.taxInclusive,
                5
              );
              await tx.insert(marginAlerts).values({
                productId: prod.id,
                grnId: grn.id,
                previousCostCents: prod.avgCostCents,
                newCostCents: effectiveUnitCost,
                currentSellPriceCents: primaryBc.sellPriceCents,
                resultingMarginBp: resultingMargin,
                minMarginBp: prod.minMarginBp,
                suggestedSellPriceCents: suggested,
                resolved: false,
              });
              createdAlerts.push({ productId: prod.id, resultingMarginBp: resultingMargin });
            }
          }
        }

        if (data.poId) {
          await tx
            .update(purchaseOrders)
            .set({ status: "received" })
            .where(eq(purchaseOrders.id, data.poId));
        }

        await tx.insert(auditLogs).values({
          actor: actorName,
          action: "grn_post",
          entityType: "goods_receipt",
          entityId: grn.id,
          detailsJson: {
            invoiceNumber: data.invoiceNumber,
            totalInvoiceCents,
            marginAlertsTriggered: createdAlerts.length,
          },
        });

        return grn.id;
      });

      return reply.status(201).send({
        grnId,
        totalInvoiceCents,
        marginAlertsTriggered: createdAlerts.length,
        createdAlerts,
      });
    }
  );

  app.get(
    "/api/purchasing/grns",
    { preHandler: [requireRole(["owner", "manager"])] },
    async () => {
      const rows = await db
        .select({
          id: goodsReceipts.id,
          invoiceNumber: goodsReceipts.invoiceNumber,
          supplierName: suppliers.name,
          receivedBy: goodsReceipts.receivedBy,
          totalInvoiceCents: goodsReceipts.totalInvoiceCents,
          notes: goodsReceipts.notes,
          receivedAt: goodsReceipts.receivedAt,
        })
        .from(goodsReceipts)
        .innerJoin(suppliers, eq(goodsReceipts.supplierId, suppliers.id))
        .orderBy(desc(goodsReceipts.receivedAt))
        .limit(20);
      return { grns: rows };
    }
  );

  // Blind ABC Cycle Count Adjustment
  app.post(
    "/api/inventory/cycle-count",
    { preHandler: [requireRole(["owner", "manager", "stock_clerk"])] },
    async (req, reply) => {
      const schema = z.object({
        productId: z.string().uuid(),
        countedBaseUnits: z.number().int().min(0),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const actorName = req.authUser!.fullName;
      const unfoldedSq = db
        .select({
          productId: stockMovements.productId,
          delta: sql<number>`coalesce(sum(${stockMovements.qtyDelta}), 0)::int`.as("unfolded_delta"),
        })
        .from(stockMovements)
        .where(
          and(
            eq(stockMovements.productId, parsed.data.productId),
            eq(stockMovements.folded, false)
          )
        )
        .groupBy(stockMovements.productId)
        .as("unfolded_sq");

      const [prod] = await db
        .select({
          id: products.id,
          avgCostCents: products.avgCostCents,
          expectedUnits: sql<number>`(coalesce(${stockBaselines.quantity}, 0) + coalesce(${unfoldedSq.delta}, 0))::int`,
        })
        .from(products)
        .leftJoin(stockBaselines, eq(products.id, stockBaselines.productId))
        .leftJoin(unfoldedSq, eq(products.id, unfoldedSq.productId))
        .where(eq(products.id, parsed.data.productId));

      if (!prod) return reply.status(404).send({ error: "Product not found" });

      const varianceUnits = parsed.data.countedBaseUnits - prod.expectedUnits;

      if (varianceUnits !== 0) {
        await db.insert(stockMovements).values({
          id: generateUuidV7(),
          productId: prod.id,
          qtyDelta: varianceUnits,
          unitCostCents: prod.avgCostCents,
          reason: "count_adj",
          folded: false,
        });
      }

      await db.insert(auditLogs).values({
        actor: actorName,
        action: "cycle_count",
        entityType: "product",
        entityId: prod.id,
        detailsJson: {
          expectedUnits: prod.expectedUnits,
          countedUnits: parsed.data.countedBaseUnits,
          varianceUnits,
        },
      });

      return {
        productId: prod.id,
        expectedUnits: prod.expectedUnits,
        countedUnits: parsed.data.countedBaseUnits,
        varianceUnits,
        varianceCostCents: varianceUnits * prod.avgCostCents,
      };
    }
  );
}
