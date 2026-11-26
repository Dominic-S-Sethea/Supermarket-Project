import type { FastifyInstance } from "fastify";
import { CreateUserSchema, UpdateStoreSettingsSchema, UpdateUserSchema } from "@supermarket/shared";
import { and, desc, eq, gt, ilike, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getPgErrorCode } from "../app.js";
import { env } from "../config/env.js";
import {
  analyticsPipelineRuns,
  auditLogs,
  db,
  posShifts,
  storeSettings,
  userSessions,
  users,
} from "../db/index.js";
import { hashPin, requireAuth, requireRole } from "../plugins/auth.js";
import { createRateLimiter } from "../plugins/security.js";
import { getOrCreateStoreSettings } from "../services/payments.js";

const UuidSchema = z.string().uuid();

export async function adminRoutes(app: FastifyInstance) {
  const adminMutationLimiter = createRateLimiter({
    keyPrefix: "admin_mutations",
    windowMs: 60_000,
    max: env.isTest ? 200 : 30,
  });
  // =========================================================================
  // STAFF USER GOVERNANCE & SESSION REVOCATION (OWNER ONLY)
  // =========================================================================
  app.get(
    "/api/admin/users",
    { preHandler: [requireRole(["owner"])] },
    async () => {
      const now = new Date();
      const [userRows, sessRows] = await Promise.all([
        db
          .select({
            id: users.id,
            username: users.username,
            fullName: users.fullName,
            role: users.role,
            active: users.active,
            createdAt: users.createdAt,
          })
          .from(users)
          .orderBy(desc(users.active), users.role, users.username),
        db
          .select({
            userId: userSessions.userId,
            activeCount: sql<number>`count(*) FILTER (WHERE ${userSessions.revokedAt} IS NULL AND ${userSessions.expiresAt} > ${now})::int`,
            lastLoginAt: sql<string | null>`max(${userSessions.createdAt})::text`,
          })
          .from(userSessions)
          .groupBy(userSessions.userId),
      ]);

      const sessMap = new Map(
        sessRows.map((s) => [
          s.userId,
          { activeSessions: Number(s.activeCount ?? 0), lastLoginAt: s.lastLoginAt },
        ])
      );

      return {
        users: userRows.map((u) => {
          const st = sessMap.get(u.id) ?? { activeSessions: 0, lastLoginAt: null };
          return { ...u, ...st };
        }),
      };
    }
  );

  app.post(
    "/api/admin/users",
    { preHandler: [requireRole(["owner"]), adminMutationLimiter] },
    async (req, reply) => {
      const parsed = CreateUserSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const username = parsed.data.username.trim().toLowerCase();
      const pinHash = await hashPin(parsed.data.pin);

      try {
        const [created] = await db
          .insert(users)
          .values({
            username,
            fullName: parsed.data.fullName.trim(),
            role: parsed.data.role,
            pinHash,
            active: true,
          })
          .returning({
            id: users.id,
            username: users.username,
            fullName: users.fullName,
            role: users.role,
            active: users.active,
            createdAt: users.createdAt,
          });

        await db.insert(auditLogs).values({
          actor: req.authUser!.fullName,
          action: "user_create",
          entityType: "user",
          entityId: created.id,
          detailsJson: { username: created.username, role: created.role },
        });

        return reply.status(201).send({ user: created });
      } catch (err) {
        if (getPgErrorCode(err) === "23505") {
          return reply.status(409).send({ error: `Username "${username}" already exists.` });
        }
        throw err;
      }
    }
  );

  app.patch(
    "/api/admin/users/:id",
    { preHandler: [requireRole(["owner"]), adminMutationLimiter] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UuidSchema.safeParse(id).success) {
        return reply.status(400).send({ error: "Invalid user ID format." });
      }
      const parsed = UpdateUserSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const data = parsed.data;
      if (
        data.fullName === undefined &&
        data.role === undefined &&
        data.active === undefined &&
        data.pin === undefined
      ) {
        return reply.status(400).send({ error: "Provide at least one field to update." });
      }

      const [existing] = await db.select().from(users).where(eq(users.id, id)).limit(1);
      if (!existing) return reply.status(404).send({ error: "Staff user not found." });

      const nextRole = (data.role ?? existing.role) as import("@supermarket/shared").UserRole;
      if (data.pin !== undefined) {
        const { validateCredentialStrength } = await import("@supermarket/shared");
        const credErr = validateCredentialStrength(data.pin, nextRole);
        if (credErr) return reply.status(400).send({ error: credErr });
      }

      const patch: Partial<typeof users.$inferInsert> = {};
      if (data.fullName !== undefined) patch.fullName = data.fullName.trim();
      if (data.role !== undefined) patch.role = data.role;
      if (data.active !== undefined) patch.active = data.active;
      if (data.pin !== undefined) patch.pinHash = await hashPin(data.pin);

      const roleChanged = data.role !== undefined && data.role !== existing.role;
      const shouldRevokeSessions = data.active === false || data.pin !== undefined || roleChanged;

      const txResult = await db.transaction(async (tx) => {
        const [lockedTarget] = await tx
          .select()
          .from(users)
          .where(eq(users.id, id))
          .for("update");
        if (!lockedTarget) return { status: 404 as const, error: "Staff user not found." };

        // Lock active owner rows inside the transaction to prevent concurrent last-owner lockout TOCTOU
        const demotingOrDisablingOwner =
          lockedTarget.role === "owner" &&
          lockedTarget.active &&
          (data.active === false || (data.role !== undefined && data.role !== "owner"));
        if (demotingOrDisablingOwner) {
          const activeOwners = await tx
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.role, "owner"), eq(users.active, true)))
            .for("update");
          if (activeOwners.length <= 1) {
            return {
              status: 409 as const,
              error: "Cannot deactivate or demote the last active owner account.",
            };
          }
        }

        const [row] = await tx
          .update(users)
          .set(patch)
          .where(eq(users.id, id))
          .returning({
            id: users.id,
            username: users.username,
            fullName: users.fullName,
            role: users.role,
            active: users.active,
            createdAt: users.createdAt,
          });

        let revokedCount = 0;
        if (shouldRevokeSessions) {
          const revoked = await tx
            .update(userSessions)
            .set({ revokedAt: new Date() })
            .where(and(eq(userSessions.userId, id), isNull(userSessions.revokedAt)))
            .returning({ jti: userSessions.jti });
          revokedCount = revoked.length;
        }

        await tx.insert(auditLogs).values({
          actor: req.authUser!.fullName,
          action: data.pin !== undefined ? "user_pin_reset" : "user_update",
          entityType: "user",
          entityId: id,
          detailsJson: {
            username: row.username,
            role: row.role,
            active: row.active,
            pinReset: data.pin !== undefined,
            roleChanged,
            sessionsRevoked: revokedCount,
          },
        });

        return { status: 200 as const, user: row, sessionsRevoked: revokedCount };
      });

      if (txResult.status !== 200) {
        return reply.status(txResult.status).send({ error: txResult.error });
      }
      return { user: txResult.user, sessionsRevoked: txResult.sessionsRevoked };
    }
  );

  app.post(
    "/api/admin/users/:id/revoke-sessions",
    { preHandler: [requireRole(["owner"]), adminMutationLimiter] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UuidSchema.safeParse(id).success) {
        return reply.status(400).send({ error: "Invalid user ID format." });
      }
      const [target] = await db
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      if (!target) return reply.status(404).send({ error: "Staff user not found." });

      const now = new Date();
      const revoked = await db
        .update(userSessions)
        .set({ revokedAt: now })
        .where(
          and(
            eq(userSessions.userId, id),
            isNull(userSessions.revokedAt),
            gt(userSessions.expiresAt, now)
          )
        )
        .returning({ jti: userSessions.jti });

      await db.insert(auditLogs).values({
        actor: req.authUser!.fullName,
        action: "user_sessions_revoke",
        entityType: "user",
        entityId: id,
        detailsJson: { username: target.username, sessionsRevoked: revoked.length },
      });

      return { userId: id, sessionsRevoked: revoked.length };
    }
  );

  // =========================================================================
  // IMMUTABLE AUDIT LOG EXPLORER
  // =========================================================================
  app.get(
    "/api/admin/audit-logs",
    { preHandler: [requireRole(["owner", "manager", "accountant"])] },
    async (req) => {
      const q = req.query as {
        actor?: string;
        action?: string;
        entityType?: string;
        search?: string;
        page?: string;
        pageSize?: string;
      };
      const rawPage = Number(q.page);
      const rawSize = Number(q.pageSize);
      const page = Number.isFinite(rawPage) ? Math.max(1, Math.trunc(rawPage)) : 1;
      const pageSize = Number.isFinite(rawSize)
        ? Math.min(100, Math.max(10, Math.trunc(rawSize)))
        : 30;
      const offset = (page - 1) * pageSize;

      const conditions = [];
      if (q.actor?.trim()) conditions.push(ilike(auditLogs.actor, `%${q.actor.trim()}%`));
      if (q.action?.trim() && q.action !== "all") conditions.push(eq(auditLogs.action, q.action.trim()));
      if (q.entityType?.trim() && q.entityType !== "all") {
        conditions.push(eq(auditLogs.entityType, q.entityType.trim()));
      }
      if (q.search?.trim()) {
        const pat = `%${q.search.trim()}%`;
        conditions.push(
          or(
            ilike(auditLogs.actor, pat),
            ilike(auditLogs.action, pat),
            ilike(auditLogs.entityType, pat),
            sql`${auditLogs.detailsJson}::text ILIKE ${pat}`
          )
        );
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
      const [rows, countRes, facetActions, facetEntities] = await Promise.all([
        db
          .select()
          .from(auditLogs)
          .where(whereClause)
          .orderBy(desc(auditLogs.createdAt))
          .limit(pageSize)
          .offset(offset),
        db
          .select({ total: sql<number>`count(*)::int` })
          .from(auditLogs)
          .where(whereClause),
        db
          .selectDistinct({ action: auditLogs.action })
          .from(auditLogs)
          .orderBy(auditLogs.action),
        db
          .selectDistinct({ entityType: auditLogs.entityType })
          .from(auditLogs)
          .orderBy(auditLogs.entityType),
      ]);

      return {
        page,
        pageSize,
        total: Number(countRes[0]?.total ?? 0),
        facets: {
          actions: facetActions.map((a) => a.action),
          entityTypes: facetEntities.map((e) => e.entityType),
        },
        logs: rows,
      };
    }
  );

  // =========================================================================
  // Z-REPORT SHIFT RECONCILIATION SUMMARY
  // =========================================================================
  app.get(
    "/api/pos/shifts/summary",
    { preHandler: [requireRole(["owner", "manager", "accountant"])] },
    async () => {
      const shifts = await db
        .select()
        .from(posShifts)
        .orderBy(desc(posShifts.openedAt))
        .limit(50);

      const closed = shifts.filter((s) => s.closedAt !== null);
      const totalVarianceCents = closed.reduce((sum, s) => sum + (s.varianceCents ?? 0), 0);
      const flaggedShifts = closed.filter((s) => Math.abs(s.varianceCents ?? 0) >= 500).length;

      const byCashierMap = new Map<
        string,
        { cashierName: string; closedShifts: number; netVarianceCents: number; maxAbsVarianceCents: number }
      >();
      for (const s of closed) {
        const cur = byCashierMap.get(s.cashierName) ?? {
          cashierName: s.cashierName,
          closedShifts: 0,
          netVarianceCents: 0,
          maxAbsVarianceCents: 0,
        };
        const v = s.varianceCents ?? 0;
        cur.closedShifts += 1;
        cur.netVarianceCents += v;
        cur.maxAbsVarianceCents = Math.max(cur.maxAbsVarianceCents, Math.abs(v));
        byCashierMap.set(s.cashierName, cur);
      }

      return {
        summary: {
          totalShifts: shifts.length,
          openShifts: shifts.length - closed.length,
          closedShifts: closed.length,
          flaggedShifts,
          netVarianceCents: totalVarianceCents,
        },
        byCashier: Array.from(byCashierMap.values()).sort(
          (a, b) => b.maxAbsVarianceCents - a.maxAbsVarianceCents
        ),
        shifts,
      };
    }
  );

  // =========================================================================
  // ML PIPELINE RUN TELEMETRY & 12-CHECK DATA-QUALITY CONTRACTS
  // =========================================================================
  app.get(
    "/api/admin/pipeline-runs",
    { preHandler: [requireRole(["owner", "manager", "accountant"])] },
    async () => {
      const runs = await db
        .select()
        .from(analyticsPipelineRuns)
        .orderBy(desc(analyticsPipelineRuns.finishedAt))
        .limit(20);

      const latest = runs[0] ?? null;
      return {
        latest,
        runs,
      };
    }
  );

  // =========================================================================
  // FLAGSHIP STORE SETTINGS (MULTI-CURRENCY, DUAL-CASH FX & SE ASIA QR RAILS)
  // =========================================================================
  app.get("/api/store-settings", { preHandler: [requireAuth] }, async () => {
    const settings = await getOrCreateStoreSettings();
    return { settings };
  });

  app.patch(
    "/api/store-settings",
    { preHandler: [requireRole(["owner", "manager"]), adminMutationLimiter] },
    async (req, reply) => {
      const parsed = UpdateStoreSettingsSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const updates = parsed.data;
      if (Object.keys(updates).length === 0) {
        return reply.status(400).send({ error: "Provide at least one setting field to update." });
      }

      const existing = await getOrCreateStoreSettings();
      const [updated] = await db
        .update(storeSettings)
        .set({
          ...updates,
          updatedAt: new Date(),
        })
        .where(eq(storeSettings.id, existing.id))
        .returning();

      await db.insert(auditLogs).values({
        actor: req.authUser!.fullName,
        action: "store_settings_update",
        entityType: "store_settings",
        entityId: updated.id,
        detailsJson: { updatedFields: Object.keys(updates) },
      });

      return { settings: updated };
    }
  );
}

