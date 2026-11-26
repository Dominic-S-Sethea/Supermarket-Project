import crypto from "node:crypto";
import type { UserRole } from "@supermarket/shared";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { env } from "../config/env.js";
import { db, userSessions, users } from "../db/index.js";
import { parseCookies } from "./security.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DUMMY_SALT = "00000000000000000000000000000000";
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const TOKEN_VERSION = "v1";

function scryptDerive(
  secret: string,
  salt: string,
  keylen: number,
  options?: crypto.ScryptOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (options) {
      crypto.scrypt(secret, salt, keylen, options, (err, derived) => {
        if (err) reject(err);
        else resolve(derived);
      });
    } else {
      crypto.scrypt(secret, salt, keylen, (err, derived) => {
        if (err) reject(err);
        else resolve(derived);
      });
    }
  });
}

function keyIdFor(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("base64url").slice(0, 8);
}

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

/**
 * Versioned scrypt hash format: scrypt$N=32768,r=8,p=1$<saltHex>$<hashHex>
 */
export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = await scryptDerive(pin, salt, 64, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${salt}$${derived.toString("hex")}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  // Versioned scrypt format: scrypt$N=...,r=...,p=...$<salt>$<hashHex>
  if (stored.startsWith("scrypt$")) {
    const parts = stored.split("$");
    if (parts.length !== 4) return false;
    const [, paramStr, salt, hashHex] = parts;
    if (!salt || !hashHex || !/^[0-9a-f]+$/i.test(hashHex)) return false;
    const params = Object.fromEntries(
      paramStr.split(",").map((kv) => {
        const [k, v] = kv.split("=");
        return [k, Number(v)];
      })
    );
    const N = Number.isInteger(params.N) && params.N >= 16384 ? params.N : SCRYPT_N;
    const r = Number.isInteger(params.r) && params.r >= 1 ? params.r : SCRYPT_R;
    const p = Number.isInteger(params.p) && params.p >= 1 ? params.p : SCRYPT_P;
    const expected = Buffer.from(hashHex, "hex");
    const actual = await scryptDerive(pin, salt, expected.length, {
      N,
      r,
      p,
      maxmem: Math.max(SCRYPT_MAXMEM, 128 * N * r * 2),
    });
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  }

  // Backward-compatible legacy unversioned format: <salt>:<hashHex>
  const parts = stored.split(":");
  if (parts.length !== 2) return false;
  const [salt, hashHex] = parts;
  if (!salt || !hashHex || !/^[0-9a-f]+$/i.test(hashHex)) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scryptDerive(pin, salt, 64);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

/**
 * Perform dummy scrypt work when a login username is unknown to reduce timing-based user enumeration.
 */
export async function runDummyPinWork(pin: string): Promise<void> {
  await scryptDerive(pin, DUMMY_SALT, 64, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
}

interface SessionPayload {
  jti: string;
  sub: string;
  username: string;
  fullName: string;
  role: UserRole;
  iat: number;
  exp: number;
}

export function signSessionToken(
  user: AuthUser,
  ttlSeconds = 43200,
  jti = crypto.randomUUID(),
  secret = env.authSecret
): { token: string; jti: string; expiresAt: Date } {
  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = nowSec + ttlSeconds;
  const payload: SessionPayload = {
    jti,
    sub: user.id,
    username: user.username,
    fullName: user.fullName,
    role: user.role,
    iat: nowSec,
    exp: expSec,
  };
  const kid = keyIdFor(secret);
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signingInput = `${TOKEN_VERSION}.${kid}.${encoded}`;
  const sig = crypto.createHmac("sha256", secret).update(signingInput).digest("base64url");
  return {
    token: `${signingInput}.${sig}`,
    jti,
    expiresAt: new Date(expSec * 1000),
  };
}

function verifyHmacWithSecrets(signingInput: string, presentedSig: string): boolean {
  const secrets = [env.authSecret, env.authSecretPrevious].filter(
    (s): s is string => Boolean(s)
  );
  const sigBuf = Buffer.from(presentedSig);
  for (const secret of secrets) {
    const expectedSig = crypto
      .createHmac("sha256", secret)
      .update(signingInput)
      .digest("base64url");
    const expectedBuf = Buffer.from(expectedSig);
    if (sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return true;
    }
  }
  return false;
}

export function verifySessionToken(
  token: string
): { user: AuthUser; jti: string } | null {
  const segments = token.split(".");
  let encoded = "";
  let signingInput = "";
  let sig = "";

  if (segments.length === 4 && segments[0] === TOKEN_VERSION) {
    const [ver, kid, payloadPart, sigPart] = segments;
    if (!kid || !payloadPart || !sigPart) return null;
    encoded = payloadPart;
    signingInput = `${ver}.${kid}.${payloadPart}`;
    sig = sigPart;
  } else if (segments.length === 2) {
    // Legacy format fallback during rolling upgrades
    const [payloadPart, sigPart] = segments;
    if (!payloadPart || !sigPart) return null;
    encoded = payloadPart;
    signingInput = payloadPart;
    sig = sigPart;
  } else {
    return null;
  }

  if (!verifyHmacWithSecrets(signingInput, sig)) {
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
      req.log.warn(
        { userId: req.authUser.id, role: req.authUser.role, requiredRoles: allowed, url: req.url },
        "RBAC authorization denied"
      );
      return reply.status(403).send({
        error: "Insufficient permissions for this action.",
      });
    }
  };
}
