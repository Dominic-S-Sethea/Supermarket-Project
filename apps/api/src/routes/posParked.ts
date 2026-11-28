import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { generateUuidV7, ParkBasketSchema } from "@supermarket/shared";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getPgErrorCode } from "../app.js";
import { auditLogs, db, parkedBaskets } from "../db/index.js";
import { requireRole } from "../plugins/auth.js";

const UuidSchema = z.string().uuid();

export async function posParkedRoutes(app: FastifyInstance) {
  app.get(
    "/api/pos/parked-baskets",
    { preHandler: [requireRole(["owner", "manager", "cashier"])] },
    async () => {
      const baskets = await db
        .select()
        .from(parkedBaskets)
        .where(eq(parkedBaskets.status, "parked"))
        .orderBy(desc(parkedBaskets.parkedAt))
        .limit(50);
      return { baskets };
    }
  );

  app.post(
    "/api/pos/parked-baskets",
    { preHandler: [requireRole(["owner", "manager", "cashier"])] },
    async (req, reply) => {
      const parsed = ParkBasketSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const data = parsed.data;
      const actor = req.authUser!;

      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        const id = generateUuidV7();
        const holdCode = `HOLD-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
        try {
          const basket = await db.transaction(async (tx) => {
            const [inserted] = await tx
              .insert(parkedBaskets)
              .values({
                id,
                holdCode,
                registerCode: data.registerCode,
                cashierName: actor.fullName,
                cashierUserId: actor.id,
                customerLabel: data.customerLabel ?? null,
                customerId: data.customerId ?? null,
                couponCode: data.couponCode ?? null,
                linesJson: data.lines,
                subtotalCents: data.subtotalCents,
                itemCount: data.lines.length,
                note: data.note ?? null,
                status: "parked",
              })
              .returning();

            await tx.insert(auditLogs).values({
              actor: actor.fullName,
              actorUserId: actor.id,
              action: "basket_park",
              entityType: "parked_basket",
              entityId: inserted.id,
              detailsJson: {
                holdCode: inserted.holdCode,
                registerCode: inserted.registerCode,
                itemCount: inserted.itemCount,
                subtotalCents: inserted.subtotalCents,
              },
            });

            return inserted;
          });
          return reply.status(201).send({ basket });
        } catch (err) {
          lastErr = err;
          if (getPgErrorCode(err) === "23505" && attempt < 2) {
            continue;
          }
          throw err;
        }
      }
      throw lastErr;
    }
  );

  app.post(
    "/api/pos/parked-baskets/:id/recall",
    { preHandler: [requireRole(["owner", "manager", "cashier"])] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UuidSchema.safeParse(id).success) {
        return reply.status(400).send({ error: "Invalid parked basket ID format." });
      }

      const actor = req.authUser!;
      const outcome = await db.transaction(async (tx) => {
        const [recalled] = await tx
          .update(parkedBaskets)
          .set({
            status: "recalled",
            recalledAt: new Date(),
            recalledBy: actor.fullName,
            recalledByUserId: actor.id,
          })
          .where(and(eq(parkedBaskets.id, id), eq(parkedBaskets.status, "parked")))
          .returning();

        if (!recalled) {
          const [existing] = await tx
            .select({ status: parkedBaskets.status })
            .from(parkedBaskets)
            .where(eq(parkedBaskets.id, id))
            .limit(1);
          if (!existing) return { status: 404 as const, error: "Parked basket not found." };
          return {
            status: 409 as const,
            error: `Basket has already been ${existing.status}.`,
          };
        }

        await tx.insert(auditLogs).values({
          actor: actor.fullName,
          actorUserId: actor.id,
          action: "basket_recall",
          entityType: "parked_basket",
          entityId: recalled.id,
          detailsJson: { holdCode: recalled.holdCode, recalledBy: actor.fullName },
        });

        return { status: 200 as const, basket: recalled };
      });

      if (outcome.status !== 200) {
        return reply.status(outcome.status).send({ error: outcome.error });
      }
      return { basket: outcome.basket };
    }
  );

  app.delete(
    "/api/pos/parked-baskets/:id",
    { preHandler: [requireRole(["owner", "manager", "cashier"])] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UuidSchema.safeParse(id).success) {
        return reply.status(400).send({ error: "Invalid parked basket ID format." });
      }
      const actor = req.authUser!;
      const cancelled = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(parkedBaskets)
          .set({ status: "cancelled" })
          .where(and(eq(parkedBaskets.id, id), eq(parkedBaskets.status, "parked")))
          .returning();
        if (!row) return null;

        await tx.insert(auditLogs).values({
          actor: actor.fullName,
          actorUserId: actor.id,
          action: "basket_cancel",
          entityType: "parked_basket",
          entityId: row.id,
          detailsJson: { holdCode: row.holdCode },
        });
        return row;
      });
      if (!cancelled) {
        return reply.status(404).send({ error: "Active parked basket not found." });
      }
      return { ok: true, id: cancelled.id };
    }
  );
}
