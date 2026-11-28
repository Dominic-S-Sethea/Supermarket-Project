import type { FastifyInstance } from "fastify";
import { generateUuidV7 } from "@supermarket/shared";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getPgErrorCode } from "../app.js";
import { auditLogs, db, posCashDrops, posShifts, salePayments, sales } from "../db/index.js";
import { foldStockLedger } from "../lib/stockLedger.js";
import { requireRole } from "../plugins/auth.js";

const UuidSchema = z.string().uuid();

export async function posShiftRoutes(app: FastifyInstance) {
  // Atomic stock ledger folding (rolls unfolded stock_movements into stock_baselines)
  app.post(
    "/api/pos/fold-ledger",
    { preHandler: [requireRole(["owner", "manager"])] },
    async () => {
      return foldStockLedger(db);
    }
  );

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

  app.get(
    "/api/pos/shifts/active",
    { preHandler: [requireRole(["owner", "manager", "cashier"])] },
    async (req) => {
      const q = req.query as { registerCode?: string };
      const registerCode = (q.registerCode ?? "REG-01").trim() || "REG-01";
      const [activeShift] = await db
        .select()
        .from(posShifts)
        .where(and(eq(posShifts.registerCode, registerCode), isNull(posShifts.closedAt)))
        .orderBy(desc(posShifts.openedAt))
        .limit(1);
      return { shift: activeShift ?? null };
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
            cashierUserId: req.authUser!.id,
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
    "/api/pos/shifts/:id/cash-drop",
    { preHandler: [requireRole(["owner", "manager", "cashier"])] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UuidSchema.safeParse(id).success) {
        return reply.status(400).send({ error: "Invalid shift ID format." });
      }
      const schema = z.object({
        amountCents: z.number().int().min(1).max(100_000_000),
        note: z.string().trim().max(240).optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const actor = req.authUser!;
      const outcome = await db.transaction(async (tx) => {
        const [lockedShift] = await tx
          .select()
          .from(posShifts)
          .where(eq(posShifts.id, id))
          .for("update");
        if (!lockedShift) return { status: 404 as const, error: "Shift not found." };
        if (lockedShift.closedAt !== null) {
          return {
            status: 409 as const,
            error: "Cannot record a cash drop on an already closed shift.",
          };
        }

        const [drop] = await tx
          .insert(posCashDrops)
          .values({
            shiftId: lockedShift.id,
            registerCode: lockedShift.registerCode,
            amountCents: parsed.data.amountCents,
            recordedBy: actor.fullName,
            recordedByUserId: actor.id,
            note: parsed.data.note ?? null,
          })
          .returning();

        const [updatedShift] = await tx
          .update(posShifts)
          .set({
            cashDropsCents: lockedShift.cashDropsCents + parsed.data.amountCents,
          })
          .where(eq(posShifts.id, lockedShift.id))
          .returning();

        await tx.insert(auditLogs).values({
          actor: actor.fullName,
          actorUserId: actor.id,
          action: "pos_cash_drop",
          entityType: "pos_shift",
          entityId: lockedShift.id,
          detailsJson: {
            dropId: drop.id,
            registerCode: lockedShift.registerCode,
            amountCents: parsed.data.amountCents,
            note: parsed.data.note ?? null,
          },
        });

        return { status: 201 as const, drop, shift: updatedShift };
      });

      if (outcome.status !== 201) {
        return reply.status(outcome.status).send({ error: outcome.error });
      }
      return reply.status(201).send({ drop: outcome.drop, shift: outcome.shift });
    }
  );

  app.post(
    "/api/pos/shifts/close",
    { preHandler: [requireRole(["owner", "manager", "cashier"])] },
    async (req, reply) => {
      const schema = z.object({
        registerCode: z.string().trim().min(1).max(32).default("REG-01"),
        openingFloatCents: z.number().int().min(0).default(30000),
        cashDropsCents: z.number().int().min(0).optional(),
        blindCountedCashCents: z.number().int().min(0),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const actor = req.authUser!;
      const outcome = await db.transaction(async (tx) => {
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

        if (!openShift) {
          return {
            status: 409 as const,
            error: `No open shift found for register ${parsed.data.registerCode}. Open a shift before closing Z-report.`,
          };
        }

        const [dropsAgg] = await tx
          .select({
            totalDrops: sql<number>`coalesce(sum(${posCashDrops.amountCents}), 0)::bigint`,
          })
          .from(posCashDrops)
          .where(eq(posCashDrops.shiftId, openShift.id));

        const recordedDrops = Math.max(
          Number(dropsAgg?.totalDrops ?? 0),
          Number(openShift.cashDropsCents ?? 0)
        );
        const requestedDrops = parsed.data.cashDropsCents;
        let effectiveDrops = recordedDrops;

        if (requestedDrops !== undefined && requestedDrops !== recordedDrops) {
          if (requestedDrops < recordedDrops) {
            return {
              status: 409 as const,
              error: `Declared cash drops (${requestedDrops}c) cannot be less than audited cash drops (${recordedDrops}c).`,
            };
          }
          if (!["owner", "manager"].includes(actor.role)) {
            return {
              status: 403 as const,
              error: "Only a manager or owner can declare unrecorded cash drops during shift closeout.",
            };
          }
          const delta = requestedDrops - recordedDrops;
          await tx.insert(posCashDrops).values({
            shiftId: openShift.id,
            registerCode: openShift.registerCode,
            amountCents: delta,
            recordedBy: actor.fullName,
            recordedByUserId: actor.id,
            note: "Declared at shift closeout",
          });
          effectiveDrops = requestedDrops;
        }

        const effectiveOpeningFloat = openShift.openingFloatCents;
        const cashScope = sql`${salePayments.method} = 'cash' AND (
          ${sales.shiftId} = ${openShift.id}
          OR (${sales.shiftId} IS NULL AND ${sales.registerCode} = ${parsed.data.registerCode} AND ${sales.soldAt} >= ${openShift.openedAt})
        )`;

        const [cashAgg] = await tx
          .select({
            cashNet: sql<number>`coalesce(sum(CASE WHEN ${sales.kind} = 'sale' THEN ${salePayments.amountCents} ELSE -${salePayments.amountCents} END), 0)::bigint`,
          })
          .from(salePayments)
          .innerJoin(sales, eq(salePayments.saleId, sales.id))
          .where(cashScope);

        const expectedCash =
          effectiveOpeningFloat + Number(cashAgg?.cashNet ?? 0) - effectiveDrops;
        const variance = parsed.data.blindCountedCashCents - expectedCash;
        const zReportNo = `Z-${Date.now().toString().slice(-6)}-${generateUuidV7().slice(-4).toUpperCase()}`;

        const [saved] = await tx
          .update(posShifts)
          .set({
            closedBy: actor.fullName,
            closedByUserId: actor.id,
            closedAt: new Date(),
            cashDropsCents: effectiveDrops,
            blindCountedCashCents: parsed.data.blindCountedCashCents,
            expectedCashCents: expectedCash,
            varianceCents: variance,
            zReportNo,
          })
          .where(eq(posShifts.id, openShift.id))
          .returning();

        await tx.insert(auditLogs).values({
          actor: actor.fullName,
          actorUserId: actor.id,
          action: "z_report_close",
          entityType: "pos_shift",
          entityId: saved.id,
          detailsJson: {
            zReportNo,
            openedBy: openShift.cashierName,
            closedBy: actor.fullName,
            expectedCash,
            cashDropsCents: effectiveDrops,
            blindCount: parsed.data.blindCountedCashCents,
            variance,
          },
        });

        return { status: 200 as const, shift: saved };
      });

      if (outcome.status !== 200) {
        return reply.status(outcome.status).send({ error: outcome.error });
      }
      return outcome.shift;
    }
  );
}
