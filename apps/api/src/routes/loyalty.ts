import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { CreateCouponSchema, CreateCustomerSchema } from "@supermarket/shared";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getPgErrorCode } from "../app.js";
import { auditLogs, customers, db, targetedCoupons } from "../db/index.js";
import { escapeLikePattern } from "../lib/helpers.js";
import { requireRole } from "../plugins/auth.js";

const UuidSchema = z.string().uuid();

function generateCouponCode(discountCents: number): string {
  const dollars = Math.max(1, Math.round(discountCents / 100));
  const suffix = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `SAVE${dollars}-${suffix}`;
}

export async function loyaltyRoutes(app: FastifyInstance) {
  // =========================================================================
  // LOYALTY CRM CUSTOMERS
  // =========================================================================
  app.get(
    "/api/loyalty/customers",
    { preHandler: [requireRole(["owner", "manager", "cashier", "accountant"])] },
    async (req) => {
      const q = req.query as { search?: string; segment?: string };
      const isCashier = req.authUser?.role === "cashier";
      const conditions = [];
      const search = (q.search ?? "").trim();
      if (isCashier && search.length < 3) {
        return { summary: null, customers: [] };
      }
      if (search.length > 0) {
        const pattern = `%${escapeLikePattern(search)}%`;
        conditions.push(
          isCashier
            ? or(ilike(customers.phone, pattern), ilike(customers.fullName, pattern))
            : or(
                ilike(customers.phone, pattern),
                ilike(customers.fullName, pattern),
                ilike(customers.email, pattern)
              )
        );
      }
      if (!isCashier && q.segment && q.segment !== "all") {
        conditions.push(eq(customers.rfmSegment, q.segment));
      }

      if (isCashier) {
        const rows = await db
          .select({
            id: customers.id,
            phone: customers.phone,
            fullName: customers.fullName,
            pointsBalance: customers.pointsBalance,
            rfmSegment: customers.rfmSegment,
          })
          .from(customers)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(customers.createdAt))
          .limit(10);

        return {
          summary: null,
          customers: rows.map((r) => ({
            ...r,
            phone: r.phone.length >= 4 ? `***-${r.phone.slice(-4)}` : "***",
          })),
        };
      }

      const rows = await db
        .select({
          id: customers.id,
          phone: customers.phone,
          fullName: customers.fullName,
          email: customers.email,
          pointsBalance: customers.pointsBalance,
          lifetimeSpendCents: customers.lifetimeSpendCents,
          visits60d: customers.visits60d,
          rfmSegment: customers.rfmSegment,
          lastVisitAt: customers.lastVisitAt,
          createdAt: customers.createdAt,
        })
        .from(customers)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(customers.lifetimeSpendCents), desc(customers.createdAt))
        .limit(100);

      const segRows = await db
        .select({
          rfmSegment: customers.rfmSegment,
          cnt: sql<number>`count(*)::int`,
          ptsSum: sql<number>`coalesce(sum(${customers.pointsBalance}), 0)::bigint`,
          spendSum: sql<number>`coalesce(sum(${customers.lifetimeSpendCents}), 0)::bigint`,
        })
        .from(customers)
        .groupBy(customers.rfmSegment);

      let totalCustomers = 0;
      let totalPoints = 0;
      let totalSpendCents = 0;
      const segmentCounts: Record<string, number> = {};
      for (const s of segRows) {
        const cnt = Number(s.cnt);
        totalCustomers += cnt;
        totalPoints += Number(s.ptsSum);
        totalSpendCents += Number(s.spendSum);
        segmentCounts[s.rfmSegment] = cnt;
      }

      return {
        summary: {
          totalCustomers,
          totalPoints,
          avgLifetimeSpendCents:
            totalCustomers > 0 ? Math.round(totalSpendCents / totalCustomers) : 0,
          segmentCounts,
        },
        customers: rows,
      };
    }
  );

  app.post(
    "/api/loyalty/customers",
    { preHandler: [requireRole(["owner", "manager", "cashier"])] },
    async (req, reply) => {
      const parsed = CreateCustomerSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      try {
        const actor = req.authUser!;
        const created = await db.transaction(async (tx) => {
          const [row] = await tx
            .insert(customers)
            .values({
              phone: parsed.data.phone.trim(),
              fullName: parsed.data.fullName.trim(),
              email: parsed.data.email ?? null,
              pointsBalance: 0,
              lifetimeSpendCents: 0,
              visits60d: 0,
              rfmSegment: "New",
            })
            .returning();

          await tx.insert(auditLogs).values({
            actor: actor.fullName,
            actorUserId: actor.id,
            action: "customer_enroll",
            entityType: "customer",
            entityId: row.id,
            detailsJson: { phone: row.phone, fullName: row.fullName },
          });
          return row;
        });

        return reply.status(201).send({ customer: created });
      } catch (err) {
        if (getPgErrorCode(err) === "23505") {
          return reply.status(409).send({
            error: `A loyalty customer with phone "${parsed.data.phone}" already exists.`,
          });
        }
        throw err;
      }
    }
  );

  // =========================================================================
  // TARGETED SINGLE-USE LOYALTY COUPONS
  // =========================================================================
  app.get(
    "/api/loyalty/coupons",
    { preHandler: [requireRole(["owner", "manager", "accountant"])] },
    async (req, reply) => {
      const q = req.query as { status?: string };
      if (q.status && !["all", "active", "redeemed", "expired"].includes(q.status)) {
        return reply.status(400).send({ error: "Invalid coupon status filter." });
      }

      const now = new Date();
      let statusCondition;
      if (q.status === "redeemed") {
        statusCondition = sql`${targetedCoupons.redeemedSaleId} IS NOT NULL`;
      } else if (q.status === "expired") {
        statusCondition = sql`${targetedCoupons.redeemedSaleId} IS NULL AND ${targetedCoupons.validUntil} < ${now}`;
      } else if (q.status === "active") {
        statusCondition = sql`${targetedCoupons.redeemedSaleId} IS NULL AND ${targetedCoupons.validUntil} >= ${now}`;
      }

      const [rows, summaryRes] = await Promise.all([
        db
          .select({
            id: targetedCoupons.id,
            code: targetedCoupons.code,
            customerId: targetedCoupons.customerId,
            customerName: customers.fullName,
            customerPhone: customers.phone,
            rfmSegment: targetedCoupons.rfmSegment,
            discountCents: targetedCoupons.discountCents,
            minBasketCents: targetedCoupons.minBasketCents,
            validFrom: targetedCoupons.validFrom,
            validUntil: targetedCoupons.validUntil,
            redeemedSaleId: targetedCoupons.redeemedSaleId,
            redeemedAt: targetedCoupons.redeemedAt,
            createdAt: targetedCoupons.createdAt,
          })
          .from(targetedCoupons)
          .leftJoin(customers, eq(targetedCoupons.customerId, customers.id))
          .where(statusCondition)
          .orderBy(desc(targetedCoupons.createdAt))
          .limit(150),
        db.execute(sql`
          SELECT
            COUNT(*) FILTER (WHERE redeemed_sale_id IS NOT NULL)::int AS redeemed_count,
            COUNT(*) FILTER (WHERE redeemed_sale_id IS NULL AND valid_until < ${now})::int AS expired_count,
            COUNT(*) FILTER (WHERE redeemed_sale_id IS NULL AND valid_until >= ${now})::int AS active_count,
            COALESCE(SUM(discount_cents) FILTER (WHERE redeemed_sale_id IS NULL AND valid_until >= ${now}), 0)::bigint AS active_value_cents
          FROM targeted_coupons
        `),
      ]);

      const nowMs = now.getTime();
      const coupons = rows.map((r) => {
        const status: "active" | "redeemed" | "expired" = r.redeemedSaleId
          ? "redeemed"
          : new Date(r.validUntil).getTime() < nowMs
            ? "expired"
            : "active";
        return { ...r, status };
      });

      const agg = (summaryRes.rows[0] ?? {}) as Record<string, unknown>;
      return {
        summary: {
          activeCount: Number(agg.active_count ?? 0),
          redeemedCount: Number(agg.redeemed_count ?? 0),
          expiredCount: Number(agg.expired_count ?? 0),
          totalActiveValueCents: Number(agg.active_value_cents ?? 0),
        },
        coupons,
      };
    }
  );

  app.post(
    "/api/loyalty/coupons",
    { preHandler: [requireRole(["owner", "manager"])] },
    async (req, reply) => {
      const parsed = CreateCouponSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const data = parsed.data;
      if (data.customerId) {
        const [cust] = await db
          .select({ id: customers.id })
          .from(customers)
          .where(eq(customers.id, data.customerId))
          .limit(1);
        if (!cust) return reply.status(404).send({ error: "Referenced customerId not found." });
      }

      const code = (data.code ? data.code.trim().toUpperCase() : generateCouponCode(data.discountCents));
      const now = new Date();
      const validUntil = new Date(now.getTime() + data.validDays * 86400_000);

      try {
        const actor = req.authUser!;
        const created = await db.transaction(async (tx) => {
          const [row] = await tx
            .insert(targetedCoupons)
            .values({
              code,
              customerId: data.customerId ?? null,
              rfmSegment: data.rfmSegment ?? null,
              discountCents: data.discountCents,
              minBasketCents: data.minBasketCents,
              validFrom: now,
              validUntil,
            })
            .returning();

          await tx.insert(auditLogs).values({
            actor: actor.fullName,
            actorUserId: actor.id,
            action: "coupon_issue",
            entityType: "targeted_coupon",
            entityId: row.id,
            detailsJson: {
              code: row.code,
              discountCents: row.discountCents,
              minBasketCents: row.minBasketCents,
              customerId: row.customerId,
              rfmSegment: row.rfmSegment,
            },
          });
          return row;
        });

        return reply.status(201).send({ coupon: created });
      } catch (err) {
        if (getPgErrorCode(err) === "23505") {
          return reply.status(409).send({
            error: `Coupon code "${code}" already exists.`,
          });
        }
        throw err;
      }
    }
  );

  // Live POS coupon lookup & eligibility validation (enforces customerId + rfmSegment)
  app.get(
    "/api/loyalty/coupons/validate/:code",
    { preHandler: [requireRole(["owner", "manager", "cashier"])] },
    async (req) => {
      const { code } = req.params as { code: string };
      const q = req.query as { basketCents?: string; customerId?: string };
      const normalized = code.trim().toUpperCase();
      if (!normalized) {
        return { valid: false, reason: "Coupon code is required." };
      }

      const [coupon] = await db
        .select()
        .from(targetedCoupons)
        .where(sql`upper(${targetedCoupons.code}) = ${normalized}`)
        .limit(1);

      if (!coupon) {
        return { valid: false, reason: `Coupon "${normalized}" not found.` };
      }

      const now = Date.now();
      if (coupon.redeemedSaleId) {
        return { valid: false, reason: `Coupon "${coupon.code}" has already been redeemed.` };
      }
      if (now < new Date(coupon.validFrom).getTime()) {
        return { valid: false, reason: `Coupon "${coupon.code}" is not active yet.` };
      }
      if (now > new Date(coupon.validUntil).getTime()) {
        return { valid: false, reason: `Coupon "${coupon.code}" has expired.` };
      }
      if (coupon.customerId) {
        if (!q.customerId || !UuidSchema.safeParse(q.customerId).success || q.customerId !== coupon.customerId) {
          return {
            valid: false,
            reason: `Coupon "${coupon.code}" is restricted to a specific loyalty customer.`,
          };
        }
      }
      if (coupon.rfmSegment) {
        if (!q.customerId || !UuidSchema.safeParse(q.customerId).success) {
          return {
            valid: false,
            reason: `Coupon "${coupon.code}" requires a loyalty member in segment "${coupon.rfmSegment}".`,
          };
        }
        const [cust] = await db
          .select({ rfmSegment: customers.rfmSegment })
          .from(customers)
          .where(eq(customers.id, q.customerId))
          .limit(1);
        if (!cust || cust.rfmSegment !== coupon.rfmSegment) {
          return {
            valid: false,
            reason: `Coupon "${coupon.code}" is restricted to loyalty segment "${coupon.rfmSegment}".`,
          };
        }
      }
      if (q.basketCents !== undefined) {
        const basketCents = Number(q.basketCents);
        if (Number.isFinite(basketCents) && basketCents < coupon.minBasketCents) {
          return {
            valid: false,
            reason: `Minimum basket of $${(coupon.minBasketCents / 100).toFixed(2)} required for "${coupon.code}".`,
          };
        }
      }

      return {
        valid: true,
        coupon: {
          id: coupon.id,
          code: coupon.code,
          discountCents: coupon.discountCents,
          minBasketCents: coupon.minBasketCents,
          customerId: coupon.customerId,
          rfmSegment: coupon.rfmSegment,
          validUntil: coupon.validUntil,
        },
      };
    }
  );
}
