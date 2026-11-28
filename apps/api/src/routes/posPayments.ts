import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  CreatePaymentIntentSchema,
  generateQrMatrix,
  generateUuidV7,
  PaymentWebhookSchema,
} from "@supermarket/shared";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { env } from "../config/env.js";
import { auditLogs, db, paymentIntents } from "../db/index.js";
import { requireRole } from "../plugins/auth.js";
import { createRateLimiter } from "../plugins/security.js";
import {
  generateExternalSettlementRef,
  getOrCreateStoreSettings,
  PaymentConfigError,
  resolvePaymentAdapter,
  verifyWebhookSignature,
} from "../services/payments.js";

const UuidSchema = z.string().uuid();

export async function posPaymentRoutes(app: FastifyInstance) {
  app.post(
    "/api/pos/payment-intents",
    { preHandler: [requireRole(["owner", "manager", "cashier"])] },
    async (req, reply) => {
      const parsed = CreatePaymentIntentSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const data = parsed.data;
      const settings = await getOrCreateStoreSettings();
      const adapter = resolvePaymentAdapter(data.rail, settings.paymentProvider);
      const id = generateUuidV7();
      const billReference =
        data.billReference ??
        `${data.registerCode.replace(/[^A-Z0-9]/gi, "").slice(0, 6).toUpperCase()}-${id.slice(-8).toUpperCase()}`;
      const expiresAt = new Date(Date.now() + data.ttlSeconds * 1000);

      let built;
      try {
        built = await adapter.createIntent(
          {
            rail: data.rail,
            amountCents: data.amountCents,
            currencyCode: data.currencyCode,
            billReference,
            registerCode: data.registerCode,
            expiresAtMs: expiresAt.getTime(),
          },
          settings
        );
      } catch (err) {
        if (err instanceof PaymentConfigError) {
          return reply.status(400).send({ error: err.message });
        }
        throw err;
      }

      const [intent] = await db
        .insert(paymentIntents)
        .values({
          id,
          registerCode: data.registerCode,
          rail: data.rail,
          provider: built.provider,
          status: "pending",
          amountCents: data.amountCents,
          currencyCode: built.currencyCode,
          displayAmount: built.displayAmount,
          billReference,
          qrPayload: built.qrPayload,
          externalRef: built.externalRef,
          expiresAt,
          createdBy: req.authUser!.fullName,
        })
        .returning();

      const qrMatrix = intent.qrPayload ? generateQrMatrix(intent.qrPayload) : null;
      return reply.status(201).send({
        intent: {
          ...intent,
          foreignAmount: built.foreignAmount ?? null,
          fxRateUsed: built.fxRateUsed ?? null,
        },
        qrMatrix,
      });
    }
  );

  app.get(
    "/api/pos/payment-intents/:id",
    { preHandler: [requireRole(["owner", "manager", "cashier"])] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UuidSchema.safeParse(id).success) {
        return reply.status(400).send({ error: "Invalid payment intent ID format." });
      }
      const [intent] = await db
        .select()
        .from(paymentIntents)
        .where(eq(paymentIntents.id, id))
        .limit(1);
      if (!intent) return reply.status(404).send({ error: "Payment intent not found." });

      if (intent.status === "pending" && new Date(intent.expiresAt).getTime() <= Date.now()) {
        const [expired] = await db
          .update(paymentIntents)
          .set({ status: "expired" })
          .where(and(eq(paymentIntents.id, id), eq(paymentIntents.status, "pending")))
          .returning();
        return { intent: expired ?? intent };
      }

      return { intent };
    }
  );

  app.post(
    "/api/pos/payment-intents/:id/simulate-settle",
    { preHandler: [requireRole(["owner", "manager", "cashier"])] },
    async (req, reply) => {
      if (!env.enableSandboxPaymentSimulation) {
        return reply
          .status(403)
          .send({ error: "Sandbox payment simulation is disabled in this environment." });
      }
      const { id } = req.params as { id: string };
      if (!UuidSchema.safeParse(id).success) {
        return reply.status(400).send({ error: "Invalid payment intent ID format." });
      }

      const result = await db.transaction(async (tx) => {
        const [intent] = await tx
          .select()
          .from(paymentIntents)
          .where(eq(paymentIntents.id, id))
          .for("update");
        if (!intent) return { status: 404 as const, error: "Payment intent not found." };
        if (intent.provider !== "mock_sandbox") {
          return {
            status: 403 as const,
            error: `Cannot simulate settlement for non-sandbox provider "${intent.provider}".`,
          };
        }

        if (intent.status === "paid") {
          return { status: 200 as const, intent, alreadyPaid: true };
        }
        if (intent.status !== "pending") {
          return {
            status: 409 as const,
            error: `Cannot settle payment intent in "${intent.status}" state.`,
          };
        }
        if (new Date(intent.expiresAt).getTime() <= Date.now()) {
          await tx
            .update(paymentIntents)
            .set({ status: "expired" })
            .where(eq(paymentIntents.id, id));
          return {
            status: 409 as const,
            error: "Payment intent has expired. Generate a fresh QR code.",
          };
        }

        const extRef = generateExternalSettlementRef(
          intent.rail as "khqr" | "promptpay" | "paynow" | "card_terminal"
        );
        const [settled] = await tx
          .update(paymentIntents)
          .set({
            status: "paid",
            externalRef: extRef,
            paidAt: new Date(),
          })
          .where(eq(paymentIntents.id, id))
          .returning();

        await tx.insert(auditLogs).values({
          actor: req.authUser!.fullName,
          actorUserId: req.authUser!.id,
          action: "payment_intent_settled",
          entityType: "payment_intent",
          entityId: settled.id,
          detailsJson: {
            rail: settled.rail,
            provider: settled.provider,
            billReference: settled.billReference,
            externalRef: extRef,
            amountCents: settled.amountCents,
            displayAmount: settled.displayAmount,
            mode: "sandbox_simulate",
          },
        });

        return { status: 200 as const, intent: settled, alreadyPaid: false };
      });

      if ("error" in result) {
        return reply.status(result.status).send({ error: result.error });
      }
      return { intent: result.intent, alreadyPaid: result.alreadyPaid };
    }
  );

  app.post(
    "/api/pos/payment-intents/:id/cancel",
    { preHandler: [requireRole(["owner", "manager", "cashier"])] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UuidSchema.safeParse(id).success) {
        return reply.status(400).send({ error: "Invalid payment intent ID format." });
      }
      const [updated] = await db
        .update(paymentIntents)
        .set({ status: "cancelled" })
        .where(and(eq(paymentIntents.id, id), eq(paymentIntents.status, "pending")))
        .returning();
      if (!updated) {
        const [existing] = await db
          .select()
          .from(paymentIntents)
          .where(eq(paymentIntents.id, id))
          .limit(1);
        if (!existing) return reply.status(404).send({ error: "Payment intent not found." });
        return reply
          .status(409)
          .send({ error: `Cannot cancel payment intent in "${existing.status}" state.` });
      }
      return { intent: updated };
    }
  );

  const paymentWebhookLimiter = createRateLimiter({
    keyPrefix: "payment_webhook",
    windowMs: 60_000,
    max: env.isTest ? 200 : 60,
  });

  await app.register(async function paymentWebhookScope(webhookApp) {
    webhookApp.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (req, body, done) => {
        const rawBody = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
        (req as FastifyRequest & { rawWebhookBody?: string }).rawWebhookBody = rawBody;
        if (!rawBody.trim()) {
          done(null, {});
          return;
        }
        try {
          done(null, JSON.parse(rawBody));
        } catch (err) {
          done(err as Error, undefined);
        }
      }
    );

    webhookApp.post(
      "/api/pos/payment-intents/webhook",
      { preHandler: [paymentWebhookLimiter] },
      async (req, reply) => {
        const rawBody =
          (req as FastifyRequest & { rawWebhookBody?: string }).rawWebhookBody ?? "";
        const rawSig = req.headers["x-payment-signature"];
        const sig = Array.isArray(rawSig) ? rawSig[0] : rawSig;
        const rawTs = req.headers["x-payment-timestamp"];
        const ts = Array.isArray(rawTs) ? rawTs[0] : rawTs;
        if (!verifyWebhookSignature(rawBody, sig, ts)) {
          return reply
            .status(401)
            .send({ error: "Invalid or expired payment webhook signature." });
        }
        const parsed = PaymentWebhookSchema.safeParse(req.body);
        if (!parsed.success) {
          return reply.status(400).send({ error: parsed.error.flatten() });
        }
        const data = parsed.data;

        const result = await db.transaction(async (tx) => {
          const [intent] = await tx
            .select()
            .from(paymentIntents)
            .where(eq(paymentIntents.billReference, data.billReference))
            .for("update");
          if (!intent) return { status: 404 as const, error: "Bill reference not found." };

          if (data.amountCents !== intent.amountCents) {
            return {
              status: 400 as const,
              error: `Webhook amount mismatch (expected ${intent.amountCents}c, got ${data.amountCents}c).`,
            };
          }
          if (intent.status === "paid") {
            return { status: 200 as const, intent, idempotent: true };
          }
          if (intent.status !== "pending") {
            return {
              status: 409 as const,
              error: `Cannot apply webhook to intent in "${intent.status}" state.`,
            };
          }
          if (new Date(intent.expiresAt).getTime() <= Date.now()) {
            await tx
              .update(paymentIntents)
              .set({ status: "expired" })
              .where(eq(paymentIntents.id, intent.id));
            return {
              status: 409 as const,
              error: "Payment intent has expired and cannot be settled via webhook.",
            };
          }

          const [updated] = await tx
            .update(paymentIntents)
            .set({
              status: data.status,
              externalRef: data.externalRef,
              paidAt: data.status === "paid" ? new Date() : null,
            })
            .where(eq(paymentIntents.id, intent.id))
            .returning();

          await tx.insert(auditLogs).values({
            actor: "payment_gateway_webhook",
            action: "payment_intent_webhook",
            entityType: "payment_intent",
            entityId: updated.id,
            detailsJson: {
              billReference: updated.billReference,
              externalRef: data.externalRef,
              status: data.status,
              rail: updated.rail,
            },
          });

          return { status: 200 as const, intent: updated, idempotent: false };
        });

        if ("error" in result) {
          return reply.status(result.status).send({ error: result.error });
        }
        return { intent: result.intent, idempotent: result.idempotent };
      }
    );
  });
}
