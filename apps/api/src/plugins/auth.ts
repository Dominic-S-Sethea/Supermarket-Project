import crypto from "node:crypto";
import { promisify } from "node:util";
import type { UserRole } from "@supermarket/shared";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { env } from "../config/env.js";
import { db, userSessions, users } from "../db/index.js";
import { parseCookies } from "./security.js";

const scryptAsync = promisify(crypto.scrypt);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DUMMY_SALT = "00000000000000000000000000000000";

export interface AuthUser {
  id: string;
  username: string;
  fullName: string;
  role: UserRole;
}

declare module "fastify" {
  interface FastifyRequest {
    authUser: AuthUser | null;
    sessionJti: string | null;
  }
}

export const SESSION_COOKIE_NAME = "smos_session";

export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = (await scryptAsync(pin, salt, 64)) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const parts = stored.split(":");
  if (parts.length !== 2) return false;
  const [salt, hashHex] = parts;
  if (!salt || !hashHex || !/^[0-9a-f]+$/i.test(hashHex)) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = (await scryptAsync(pin, salt, 64)) as Buffer;
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

/**
 * Perform dummy scrypt work when a login username is unknown to reduce timing-based user enumeration.
 */
export async function runDummyPinWork(pin: string): Promise<void> {
  await scryptAsync(pin, DUMMY_SALT, 64);
}

interface SessionPayload {
  jti: string;
  sub: string;
  username: string;
  fullName: string;
  role: UserRole;
  exp: number;
}

export function signSessionToken(
  user: AuthUser,
  ttlSeconds = 43200,
  jti = crypto.randomUUID()
): { token: string; jti: string; expiresAt: Date } {
  const expSec = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload: SessionPayload = {
    jti,
    sub: user.id,
    username: user.username,
    fullName: user.fullName,
    role: user.role,
    exp: expSec,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", env.authSecret).update(encoded).digest("base64url");
  return {
    token: `${encoded}.${sig}`,
    jti,
    expiresAt: new Date(expSec * 1000),
  };
}

export function verifySessionToken(
  token: string
): { user: AuthUser; jti: string } | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const encoded = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!encoded || !sig) return null;

  const expectedSig = crypto
    .createHmac("sha256", env.authSecret)
    .update(encoded)
    .digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SessionPayload;
    if (!parsed.jti || !parsed.sub || !parsed.username || !parsed.role) return null;
    if (!UUID_RE.test(parsed.jti) || !UUID_RE.test(parsed.sub)) return null;
    if (typeof parsed.exp !== "number" || parsed.exp < Math.floor(Date.now() / 1000)) return null;
    return {
      jti: parsed.jti,
      user: {
        id: parsed.sub,
        username: parsed.username,
        fullName: parsed.fullName,
        role: parsed.role,
      },
    };
  } catch {
    return null;
  }
}

export async function extractSession(
  req: FastifyRequest
): Promise<{ user: AuthUser; jti: string } | null> {
  let rawToken: string | null = null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    rawToken = authHeader.slice(7).trim() || null;
  } else {
    const cookies = parseCookies(req.headers.cookie);
    rawToken = cookies[SESSION_COOKIE_NAME] || null;
  }
  if (!rawToken) return null;

  const verified = verifySessionToken(rawToken);
  if (!verified) return null;

  const [session] = await db
    .select({
      jti: userSessions.jti,
      userId: users.id,
      username: users.username,
      fullName: users.fullName,
      role: users.role,
    })
    .from(userSessions)
    .innerJoin(users, eq(userSessions.userId, users.id))
    .where(
      and(
        eq(userSessions.jti, verified.jti),
        eq(userSessions.userId, verified.user.id),
        eq(users.active, true),
        isNull(userSessions.revokedAt),
        gt(userSessions.expiresAt, new Date())
      )
    )
    .limit(1);

  if (!session) return null;
  return {
    jti: session.jti,
    user: {
      id: session.userId,
      username: session.username,
      fullName: session.fullName,
      role: session.role as UserRole,
    },
  };
}

export function registerAuthHook(app: FastifyInstance) {
  app.decorateRequest("authUser", null);
  app.decorateRequest("sessionJti", null);
  app.addHook("onRequest", async (req) => {
    const res = await extractSession(req);
    req.authUser = res?.user ?? null;
    req.sessionJti = res?.jti ?? null;
  });
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  if (!req.authUser) {
    return reply.status(401).send({ error: "Authentication required. Please sign in." });
  }
}

export function requireRole(allowed: UserRole[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.authUser) {
      return reply.status(401).send({ error: "Authentication required. Please sign in." });
    }
    if (!allowed.includes(req.authUser.role)) {
      return reply.status(403).send({
        error: `Forbidden for role "${req.authUser.role}". Allowed: ${allowed.join(", ")}`,
      });
    }
  };
}
