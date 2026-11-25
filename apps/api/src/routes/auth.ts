import { ChangePinSchema, LoginSchema, type UserRole } from "@supermarket/shared";
import { and, eq, isNull, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { env } from "../config/env.js";
import { auditLogs, db, userSessions, users } from "../db/index.js";
import {
  hashPin,
  requireAuth,
  runDummyPinWork,
  SESSION_COOKIE_NAME,
  signSessionToken,
  verifyPin,
} from "../plugins/auth.js";
import { createRateLimiter } from "../plugins/security.js";

export async function authRoutes(app: FastifyInstance) {
  const loginLimiter = createRateLimiter({
    keyPrefix: "auth_login",
    windowMs: 60_000,
    max: env.isTest ? 200 : 12,
  });

  app.post("/api/auth/login", { preHandler: [loginLimiter] }, async (req, reply) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const username = parsed.data.username.trim().toLowerCase();
    const [found] = await db
      .select()
      .from(users)
      .where(and(eq(users.username, username), eq(users.active, true)))
      .limit(1);

    if (!found) {
      await runDummyPinWork(parsed.data.pin);
      return reply.status(401).send({ error: "Invalid username or PIN." });
    }
    if (!(await verifyPin(parsed.data.pin, found.pinHash))) {
      return reply.status(401).send({ error: "Invalid username or PIN." });
    }

    const user = {
      id: found.id,
      username: found.username,
      fullName: found.fullName,
      role: found.role as UserRole,
    };
    const { token, jti, expiresAt } = signSessionToken(user);

    await db.insert(userSessions).values({
      jti,
      userId: found.id,
      expiresAt,
    });

    const secureAttr = env.isProduction || req.protocol === "https" ? "; Secure" : "";
    reply.header(
      "Set-Cookie",
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${secureAttr}`
    );

    return { user, token };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    if (req.sessionJti) {
      await db
        .update(userSessions)
        .set({ revokedAt: new Date() })
        .where(eq(userSessions.jti, req.sessionJti));
    }
    const secureAttr = env.isProduction || req.protocol === "https" ? "; Secure" : "";
    reply.header(
      "Set-Cookie",
      `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureAttr}`
    );
    return { ok: true };
  });

  app.get("/api/auth/me", async (req) => {
    return { user: req.authUser };
  });

  app.post(
    "/api/auth/change-pin",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const parsed = ChangePinSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      if (parsed.data.currentPin === parsed.data.newPin) {
        return reply.status(400).send({ error: "New PIN must be different from current PIN." });
      }

      const actor = req.authUser!;
      const [dbUser] = await db.select().from(users).where(eq(users.id, actor.id)).limit(1);
      if (!dbUser || !(await verifyPin(parsed.data.currentPin, dbUser.pinHash))) {
        return reply.status(401).send({ error: "Current PIN is incorrect." });
      }

      const nextHash = await hashPin(parsed.data.newPin);
      const revokedCount = await db.transaction(async (tx) => {
        await tx.update(users).set({ pinHash: nextHash }).where(eq(users.id, actor.id));
        const otherCond = req.sessionJti
          ? and(
              eq(userSessions.userId, actor.id),
              isNull(userSessions.revokedAt),
              ne(userSessions.jti, req.sessionJti)
            )
          : and(eq(userSessions.userId, actor.id), isNull(userSessions.revokedAt));
        const revoked = await tx
          .update(userSessions)
          .set({ revokedAt: new Date() })
          .where(otherCond)
          .returning({ jti: userSessions.jti });

        await tx.insert(auditLogs).values({
          actor: actor.fullName,
          action: "pin_change",
          entityType: "user",
          entityId: actor.id,
          detailsJson: { username: actor.username, otherSessionsRevoked: revoked.length },
        });
        return revoked.length;
      });

      return { ok: true, otherSessionsRevoked: revokedCount };
    }
  );
}
