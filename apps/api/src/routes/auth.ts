import { LoginSchema, type UserRole } from "@supermarket/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { env } from "../config/env.js";
import { db, userSessions, users } from "../db/index.js";
import { SESSION_COOKIE_NAME, signSessionToken, verifyPin } from "../plugins/auth.js";
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

    if (!found || !(await verifyPin(parsed.data.pin, found.pinHash))) {
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
}
