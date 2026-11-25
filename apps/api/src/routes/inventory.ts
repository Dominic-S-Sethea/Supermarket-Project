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
  UpdateVarianceStatusSchema,
} from "@supermarket/shared";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  analyticsDynamicMarkdowns,
  analyticsSupplierScorecards,
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

const UuidSchema = z.string().uuid();

export async function inventoryRoutes(app: FastifyInstance) {
  // FEFO Best-Before Expiry Alerts Console
  app.get(
    "/api/inventory/expiry-alerts",
    { preHandler: [requireRole(["owner", "manager", "stock_clerk"])] },
    async (req) => {
      const q = req.query as { days?: string };
      const rawDays = Number(q.days);
      const horizonDays = Number.isFinite(rawDays)
        ? Math.min(180, Math.max(7, Math.trunc(rawDays)))
        : 60;
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
      if (!UuidSchema.safeParse(id).success) {
        return reply.status(400).send({ error: "Invalid batch ID format." });
      }
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
      if (!UuidSchema.safeParse(id).success) {
        return reply.status(400).send({ error: "Invalid alert ID format." });
      }
      const bodySchema = z.object({
        customPriceCents: z.number().int().min(1).max(10_000_000).optional(),
      });
      const parsedBody = bodySchema.safeParse(req.body ?? {});
      if (!parsedBody.success) {
        return reply.status(400).send({ error: parsedBody.error.flatten() });
      }
      const actorName = req.authUser!.fullName;

      const [alert] = await db
        .select()
        .from(marginAlerts)
        .where(eq(marginAlerts.id, id));
      if (!alert) return reply.status(404).send({ error: "Alert not found" });

      const newSellPrice = parsedBody.data.customPriceCents ?? alert.suggestedSellPriceCents;

      const updatedRes = await db.transaction(async (tx) => {
        const [claimed] = await tx
          .update(marginAlerts)
          .set({ resolved: true })
          .where(and(eq(marginAlerts.id, id), eq(marginAlerts.resolved, false)))
          .returning();
        if (!claimed) return null;

        const [prod] = await tx
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

        const allBarcodes = await tx
          .select()
          .from(productBarcodes)
          .where(eq(productBarcodes.productId, alert.productId))
          .for("update");
        const primaryBc = allBarcodes.find((b) => b.isPrimary) ?? allBarcodes[0];
        const oldPrimaryPrice = Math.max(1, primaryBc?.sellPriceCents ?? alert.currentSellPriceCents);
        const scaleRatio = newSellPrice / oldPrimaryPrice;

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

      return {
        resolved: true,
        newSellPriceCents: newSellPrice,
        updatedPackTiers: updatedRes.updatedPackTiers,
      };
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

      const [sup] = await db
        .select({ id: suppliers.id })
        .from(suppliers)
        .where(eq(suppliers.id, data.supplierId))
        .limit(1);
      if (!sup) return reply.status(404).send({ error: "Supplier not found." });

      const uniquePids = Array.from(new Set(data.lines.map((l) => l.productId)));
      const foundProds = await db
        .select({ id: products.id })
        .from(products)
        .where(inArray(products.id, uniquePids));
      if (foundProds.length !== uniquePids.length) {
        return reply.status(400).send({ error: "One or more line productId values do not exist." });
      }

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
      if (!UuidSchema.safeParse(id).success) {
        return reply.status(400).send({ error: "Invalid purchase order ID format." });
      }
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

  // Goods Received Note (GRN) with Paid + Free Bonus Cases, locked MWAC update, & Tax-Aware Net Margin Guard
  app.post(
    "/api/purchasing/grn",
    { preHandler: [requireRole(["owner", "manager"])] },
    async (req, reply) => {
      const parsed = CreateGrnSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;
      const actorName = req.authUser!.fullName;

      // Verify supplier, referenced products, and optional PO before opening GRN transaction
      const [sup] = await db
        .select({ id: suppliers.id })
        .from(suppliers)
        .where(eq(suppliers.id, data.supplierId))
        .limit(1);
      if (!sup) return reply.status(404).send({ error: "Supplier not found." });

      const uniquePids = Array.from(new Set(data.lines.map((l) => l.productId)));
      const foundProds = await db
        .select({ id: products.id })
        .from(products)
        .where(inArray(products.id, uniquePids));
      if (foundProds.length !== uniquePids.length) {
        return reply.status(400).send({ error: "One or more GRN line productId values do not exist." });
      }

      if (data.poId) {
        const [po] = await db
          .select({ id: purchaseOrders.id, status: purchaseOrders.status })
          .from(purchaseOrders)
          .where(eq(purchaseOrders.id, data.poId))
          .limit(1);
        if (!po) return reply.status(404).send({ error: "Referenced purchase order not found." });
        if (po.status === "cancelled") {
          return reply.status(409).send({ error: "Cannot receive goods against a cancelled purchase order." });
        }
      }

      const totalInvoiceCents = data.lines.reduce(
        (s, l) => s + l.invoiceLineTotalCents,
        0
      );
      const createdAlerts: { productId: string; resultingMarginBp: number }[] = [];

      const grnOutcome = await db.transaction(async (tx) => {
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

        // Sort lines by productId for deterministic FOR UPDATE lock ordering
        const orderedLines = [...data.lines].sort((a, b) =>
          a.productId.localeCompare(b.productId)
        );
        const receivedSummaryByProduct = new Map<
          string,
          { cases: number; totalUnits: number; invoiceCents: number }
        >();

        for (const line of orderedLines) {
          const paidUnits = line.paidCases * line.caseQty;
          const freeUnits = line.freeBonusCases * line.caseQty;
          const totalUnits = paidUnits + freeUnits;
          if (totalUnits <= 0) continue;

          const prevSum = receivedSummaryByProduct.get(line.productId) ?? {
            cases: 0,
            totalUnits: 0,
            invoiceCents: 0,
          };
          receivedSummaryByProduct.set(line.productId, {
            cases: prevSum.cases + line.paidCases + line.freeBonusCases,
            totalUnits: prevSum.totalUnits + totalUnits,
            invoiceCents: prevSum.invoiceCents + line.invoiceLineTotalCents,
          });

          const effectiveUnitCost = computeEffectiveUnitCostCents(
            line.invoiceLineTotalCents,
            paidUnits,
            freeUnits
          );

          // Lock product row to serialize Moving Weighted Average Cost updates
          const [lockedProd] = await tx
            .select({
              id: products.id,
              avgCostCents: products.avgCostCents,
              minMarginBp: products.minMarginBp,
              taxRateId: products.taxRateId,
            })
            .from(products)
            .where(eq(products.id, line.productId))
            .for("update");
          if (!lockedProd) continue;

          const [tax] = await tx
            .select({
              taxRateBp: taxRates.rateBp,
              taxInclusive: taxRates.isInclusive,
            })
            .from(taxRates)
            .where(eq(taxRates.id, lockedProd.taxRateId))
            .limit(1);

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
          const currentStock = Number(baseline?.quantity ?? 0) + Number(unfolded?.delta ?? 0);

          const newAvgCost = computeMovingWeightedAvgCostCents(
            currentStock,
            lockedProd.avgCostCents,
            totalUnits,
            effectiveUnitCost
          );

          await tx.insert(grnLines).values({
            grnId: grn.id,
            productId: lockedProd.id,
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
                productId: lockedProd.id,
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
              productId: lockedProd.id,
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
              productId: lockedProd.id,
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
            .where(eq(products.id, lockedProd.id));

          // Tax-aware net margin erosion check
          const [primaryBc] = await tx
            .select()
            .from(productBarcodes)
            .where(
              and(
                eq(productBarcodes.productId, lockedProd.id),
                eq(productBarcodes.isPrimary, true)
              )
            );
          if (primaryBc) {
            const taxRateBp = tax?.taxRateBp ?? 0;
            const taxInclusive = tax?.taxInclusive ?? true;
            const resultingMargin = computeNetMarginBp(
              primaryBc.sellPriceCents,
              effectiveUnitCost * primaryBc.packQty,
              taxRateBp,
              taxInclusive
            );
            if (resultingMargin < lockedProd.minMarginBp) {
              const suggested = computeSuggestedSellPriceCents(
                effectiveUnitCost * primaryBc.packQty,
                lockedProd.minMarginBp,
                taxRateBp,
                taxInclusive,
                5
              );
              await tx.insert(marginAlerts).values({
                productId: lockedProd.id,
                grnId: grn.id,
                previousCostCents: lockedProd.avgCostCents,
                newCostCents: effectiveUnitCost,
                currentSellPriceCents: primaryBc.sellPriceCents,
                resultingMarginBp: resultingMargin,
                minMarginBp: lockedProd.minMarginBp,
                suggestedSellPriceCents: suggested,
                resolved: false,
              });
              createdAlerts.push({ productId: lockedProd.id, resultingMarginBp: resultingMargin });
            }
          }
        }

        let variancesCreated = 0;
        if (data.poId) {
          const poLines = await tx
            .select()
            .from(purchaseOrderLines)
            .where(eq(purchaseOrderLines.poId, data.poId))
            .for("update");

          let allReceived = poLines.length > 0;
          for (const pl of poLines) {
            const summary = receivedSummaryByProduct.get(pl.productId);
            const added = summary?.cases ?? 0;
            const nextReceived = pl.receivedCases + added;
            if (added > 0) {
              await tx
                .update(purchaseOrderLines)
                .set({ receivedCases: nextReceived })
                .where(eq(purchaseOrderLines.id, pl.id));

              const orderedUnits = pl.orderedCases * pl.caseQty;
              const receivedUnitsTotal = nextReceived * pl.caseQty;
              const invUnitCost =
                summary && summary.totalUnits > 0
                  ? Math.round(summary.invoiceCents / summary.totalUnits)
                  : pl.unitCostCents;

              if (nextReceived !== pl.orderedCases) {
                const isShort = nextReceived < pl.orderedCases;
                const unitDiff = Math.abs(orderedUnits - receivedUnitsTotal);
                await tx.insert(grnVariances).values({
                  grnId: grn.id,
                  poId: data.poId,
                  supplierId: data.supplierId,
                  productId: pl.productId,
                  varianceType: isShort ? "short_delivery" : "over_delivery",
                  orderedQtyUnits: orderedUnits,
                  receivedQtyUnits: receivedUnitsTotal,
                  poUnitCostCents: pl.unitCostCents,
                  invoiceUnitCostCents: invUnitCost,
                  financialImpactCents: unitDiff * (isShort ? pl.unitCostCents : invUnitCost),
                  status: "open",
                });
                variancesCreated++;
              }

              const costDiff = invUnitCost - pl.unitCostCents;
              if (
                pl.unitCostCents > 0 &&
                Math.abs(costDiff) > Math.max(2, Math.round(pl.unitCostCents * 0.01))
              ) {
                await tx.insert(grnVariances).values({
                  grnId: grn.id,
                  poId: data.poId,
                  supplierId: data.supplierId,
                  productId: pl.productId,
                  varianceType: costDiff > 0 ? "cost_overcharge" : "cost_savings",
                  orderedQtyUnits: orderedUnits,
                  receivedQtyUnits: summary?.totalUnits ?? added * pl.caseQty,
                  poUnitCostCents: pl.unitCostCents,
                  invoiceUnitCostCents: invUnitCost,
                  financialImpactCents: Math.abs(costDiff) * (summary?.totalUnits ?? added * pl.caseQty),
                  status: "open",
                });
                variancesCreated++;
              }
            }
            if (nextReceived < pl.orderedCases) {
              allReceived = false;
            }
          }

          await tx
            .update(purchaseOrders)
            .set({ status: allReceived ? "received" : "partially_received" })
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
            variancesCreated,
          },
        });

        return { grnId: grn.id, variancesCreated };
      });

      return reply.status(201).send({
        grnId: grnOutcome.grnId,
        totalInvoiceCents,
        marginAlertsTriggered: createdAlerts.length,
        createdAlerts,
        variancesCreated: grnOutcome.variancesCreated,
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

  // Blind ABC Cycle Count Adjustment (atomic row-locked variance calculation)
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
      const result = await db.transaction(async (tx) => {
        const [lockedProd] = await tx
          .select({
            id: products.id,
            avgCostCents: products.avgCostCents,
          })
          .from(products)
          .where(eq(products.id, parsed.data.productId))
          .for("update");
        if (!lockedProd) return null;

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

        const expectedUnits = Number(baseline?.quantity ?? 0) + Number(unfolded?.delta ?? 0);
        const varianceUnits = parsed.data.countedBaseUnits - expectedUnits;

        if (varianceUnits !== 0) {
          await tx.insert(stockMovements).values({
            id: generateUuidV7(),
            productId: lockedProd.id,
            qtyDelta: varianceUnits,
            unitCostCents: lockedProd.avgCostCents,
            reason: "count_adj",
            folded: false,
          });
        }

        await tx.insert(auditLogs).values({
          actor: actorName,
          action: "cycle_count",
          entityType: "product",
          entityId: lockedProd.id,
          detailsJson: {
            expectedUnits,
            countedUnits: parsed.data.countedBaseUnits,
            varianceUnits,
          },
        });

        return {
          productId: lockedProd.id,
          expectedUnits,
          countedUnits: parsed.data.countedBaseUnits,
          varianceUnits,
          varianceCostCents: varianceUnits * lockedProd.avgCostCents,
        };
      });

      if (!result) return reply.status(404).send({ error: "Product not found" });
      return result;
    }
  );

  // Milestone 1: Supplier OTIF Scorecards (90-day performance + open variance exposure)
  app.get(
    "/api/purchasing/supplier-scorecards",
    { preHandler: [requireRole(["owner", "manager", "accountant"])] },
    async () => {
      const rows = await db
        .select({
          supplierId: suppliers.id,
          supplierName: suppliers.name,
          leadTimeDays: suppliers.defaultLeadTimeDays,
          paymentTermsDays: suppliers.paymentTermsDays,
          contactEmail: suppliers.contactEmail,
          poCount90d: analyticsSupplierScorecards.poCount90d,
          grnCount90d: analyticsSupplierScorecards.grnCount90d,
          onTimeRatePct: analyticsSupplierScorecards.onTimeRatePct,
          inFullRatePct: analyticsSupplierScorecards.inFullRatePct,
          otifRatePct: analyticsSupplierScorecards.otifRatePct,
          costVarianceRatePct: analyticsSupplierScorecards.costVarianceRatePct,
          avgLeadTimeDays: analyticsSupplierScorecards.avgLeadTimeDays,
          leadTimeStdDays: analyticsSupplierScorecards.leadTimeStdDays,
          totalVarianceCents: analyticsSupplierScorecards.totalVarianceCents,
          grade: analyticsSupplierScorecards.grade,
          computedAt: analyticsSupplierScorecards.computedAt,
        })
        .from(analyticsSupplierScorecards)
        .innerJoin(suppliers, eq(analyticsSupplierScorecards.supplierId, suppliers.id))
        .orderBy(asc(analyticsSupplierScorecards.otifRatePct));

      const openVarRows = await db
        .select({
          supplierId: grnVariances.supplierId,
          openCount: sql<number>`count(*)::int`,
          openImpactCents: sql<number>`coalesce(sum(${grnVariances.financialImpactCents}), 0)::bigint`,
        })
        .from(grnVariances)
        .where(inArray(grnVariances.status, ["open", "disputed"]))
        .groupBy(grnVariances.supplierId);

      const openVarMap = new Map(
        openVarRows.map((r) => [
          r.supplierId,
          { openCount: Number(r.openCount), openImpactCents: Number(r.openImpactCents) },
        ])
      );

      const scorecards = rows.map((r) => {
        const exposure = openVarMap.get(r.supplierId) ?? { openCount: 0, openImpactCents: 0 };
        return {
          ...r,
          paymentTerms: `Net ${r.paymentTermsDays}d`,
          contactEmail: r.contactEmail ?? "—",
          openVarianceCount: exposure.openCount,
          openVarianceImpactCents: exposure.openImpactCents,
        };
      });

      const avgOtifPct =
        scorecards.length > 0
          ? Number(
              (
                scorecards.reduce((s, r) => s + r.otifRatePct, 0) / scorecards.length
              ).toFixed(1)
            )
          : 0;

      return {
        summary: {
          supplierCount: scorecards.length,
          avgOtifPct,
          atRiskSuppliers: scorecards.filter((s) => s.grade === "C" || s.grade === "D").length,
          totalOpenVarianceImpactCents: scorecards.reduce(
            (s, r) => s + r.openVarianceImpactCents,
            0
          ),
        },
        scorecards,
      };
    }
  );

  // Milestone 1: 3-Way PO vs GRN vs Invoice Dock Variances
  app.get(
    "/api/purchasing/variances",
    { preHandler: [requireRole(["owner", "manager", "accountant"])] },
    async (req, reply) => {
      const q = req.query as { status?: string; supplierId?: string };
      const conditions = [];
      if (q.status && q.status !== "all") {
        const validStatuses = ["open", "disputed", "resolved_credit_note", "written_off"];
        if (!validStatuses.includes(q.status)) {
          return reply.status(400).send({ error: "Invalid variance status filter." });
        }
        conditions.push(eq(grnVariances.status, q.status));
      }
      if (q.supplierId) {
        if (!UuidSchema.safeParse(q.supplierId).success) {
          return reply.status(400).send({ error: "Invalid supplierId filter." });
        }
        conditions.push(eq(grnVariances.supplierId, q.supplierId));
      }

      const rows = await db
        .select({
          id: grnVariances.id,
          grnId: grnVariances.grnId,
          poId: grnVariances.poId,
          supplierId: grnVariances.supplierId,
          supplierName: suppliers.name,
          productId: grnVariances.productId,
          sku: products.sku,
          productName: products.name,
          invoiceNumber: goodsReceipts.invoiceNumber,
          poNumber: purchaseOrders.poNumber,
          varianceType: grnVariances.varianceType,
          orderedQtyUnits: grnVariances.orderedQtyUnits,
          receivedQtyUnits: grnVariances.receivedQtyUnits,
          poUnitCostCents: grnVariances.poUnitCostCents,
          invoiceUnitCostCents: grnVariances.invoiceUnitCostCents,
          financialImpactCents: grnVariances.financialImpactCents,
          status: grnVariances.status,
          resolutionNote: grnVariances.resolutionNote,
          createdAt: grnVariances.createdAt,
          resolvedAt: grnVariances.resolvedAt,
        })
        .from(grnVariances)
        .innerJoin(suppliers, eq(grnVariances.supplierId, suppliers.id))
        .innerJoin(products, eq(grnVariances.productId, products.id))
        .innerJoin(goodsReceipts, eq(grnVariances.grnId, goodsReceipts.id))
        .leftJoin(purchaseOrders, eq(grnVariances.poId, purchaseOrders.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(grnVariances.createdAt))
        .limit(120);

      const summaryRows = await db
        .select({
          status: grnVariances.status,
          cnt: sql<number>`count(*)::int`,
          impactCents: sql<number>`coalesce(sum(${grnVariances.financialImpactCents}), 0)::bigint`,
        })
        .from(grnVariances)
        .groupBy(grnVariances.status);

      const summary = {
        openCount: 0,
        disputedCount: 0,
        resolvedCount: 0,
        openImpactCents: 0,
      };
      for (const s of summaryRows) {
        const cnt = Number(s.cnt);
        const imp = Number(s.impactCents);
        if (s.status === "open") {
          summary.openCount += cnt;
          summary.openImpactCents += imp;
        } else if (s.status === "disputed") {
          summary.disputedCount += cnt;
          summary.openImpactCents += imp;
        } else {
          summary.resolvedCount += cnt;
        }
      }

      return { summary, variances: rows };
    }
  );

  // Resolve, Dispute, or Write Off a 3-Way GRN Dock Variance
  app.patch(
    "/api/purchasing/variances/:id",
    { preHandler: [requireRole(["owner", "manager"])] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UuidSchema.safeParse(id).success) {
        return reply.status(400).send({ error: "Invalid variance ID format." });
      }
      const parsed = UpdateVarianceStatusSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const actorName = req.authUser!.fullName;
      const isResolved =
        parsed.data.status === "resolved_credit_note" || parsed.data.status === "written_off";

      const [updated] = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(grnVariances)
          .set({
            status: parsed.data.status,
            resolutionNote: parsed.data.resolutionNote ?? null,
            resolvedAt: isResolved ? new Date() : null,
          })
          .where(eq(grnVariances.id, id))
          .returning();

        if (!row) return [];

        await tx.insert(auditLogs).values({
          actor: actorName,
          action: "grn_variance_update",
          entityType: "grn_variance",
          entityId: row.id,
          detailsJson: {
            status: parsed.data.status,
            resolutionNote: parsed.data.resolutionNote ?? null,
            financialImpactCents: row.financialImpactCents,
          },
        });

        return [row];
      });

      if (!updated) return reply.status(404).send({ error: "GRN variance not found." });
      return { variance: updated };
    }
  );
}
