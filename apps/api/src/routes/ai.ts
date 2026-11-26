import {
  AiChatRequestSchema,
  AiTriageRequestSchema,
  computeSuggestedSellPriceCents,
  generateUuidV7,
  ParseInvoiceSchema,
} from "@supermarket/shared";
import { and, asc, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { registerActiveSseResponse } from "../plugins/metrics.js";
import { getOrCreateDailyBriefing } from "../ai/briefing.js";
import { isGeminiConfigured, runCopilotTurn, runCopilotTurnStream } from "../ai/copilot.js";
import { parseSupplierInvoice } from "../ai/invoice.js";
import {
  getEmbeddingStats,
  semanticSearchProducts,
  syncProductEmbeddings,
} from "../ai/semantic.js";
import { runCalibratedTriage } from "../ai/triage.js";
import {
  aiConversations,
  aiMessages,
  aiProposedActions,
  auditLogs,
  db,
  marginAlerts,
  productBarcodes,
  products,
  promotions,
  purchaseOrderLines,
  purchaseOrders,
  shelfTagQueue,
  taxRates,
} from "../db/index.js";
import { env } from "../config/env.js";
import { requireRole } from "../plugins/auth.js";
import { createRateLimiter } from "../plugins/security.js";

const UuidSchema = z.string().uuid();

const ExecuteCreatePoPayloadSchema = z.object({
  supplierId: z.string().uuid(),
  notes: z.string().max(500).optional(),
  lines: z
    .array(
      z.object({
        productId: z.string().uuid(),
        caseQty: z.number().int().min(1),
        orderedCases: z.number().int().min(1),
        unitCostCents: z.number().int().min(0),
      })
    )
    .min(1),
});

const ExecuteUpdatePricePayloadSchema = z.object({
  productId: z.string().uuid(),
  newSellPriceCents: z.number().int().min(1).max(10_000_000),
  alertId: z.string().uuid().nullable().optional(),
});

const ExecuteCreatePromoPayloadSchema = z
  .object({
    name: z.string().min(2).max(160),
    promoType: z.enum(["mix_and_match", "bogo", "tier_price", "clearance", "basket_threshold"]),
    priority: z.number().int().min(1).max(1000).default(15),
    combinable: z.boolean().default(false),
    minMarginGuardBp: z.number().int().min(0).max(9500).nullable().optional().default(1000),
    daypartStartHour: z.number().int().min(0).max(23).nullable().optional(),
    daypartEndHour: z.number().int().min(1).max(24).nullable().optional(),
    rulesJson: z.record(z.string(), z.unknown()).default({}),
  })
  .refine(
    (d) =>
      (d.daypartStartHour == null && d.daypartEndHour == null) ||
      (d.daypartStartHour != null && d.daypartEndHour != null),
    { message: "Both daypartStartHour and daypartEndHour must be set together or both omitted." }
  );

export async function aiRoutes(app: FastifyInstance) {
  const aiComputeLimiter = createRateLimiter({
    keyPrefix: "ai_compute",
    windowMs: 60_000,
    max: env.isTest ? 300 : 25,
  });
  const managerOnly = [requireRole(["owner", "manager"])];
  const managerAiLimited = [requireRole(["owner", "manager"]), aiComputeLimiter];
  const executiveReadOnly = [requireRole(["owner", "manager", "accountant"])];

  app.get("/api/ai/status", { preHandler: managerOnly }, async () => {
    const embStats = await getEmbeddingStats();
    return {
      geminiConfigured: isGeminiConfigured(),
      model: isGeminiConfigured() ? "gemini-4-hydrogen" : "local-deterministic-tools",
      capabilities: [
        "copilot_sse",
        "briefing",
        "semantic_search",
        "invoice_scanner",
        "calibrated_triage",
      ],
      indexedSkus: embStats.indexedSkus,
      embeddingModel: embStats.model,
    };
  });

  // Daily Morning Executive Briefing (contains store financial & LP triage data -> executive roles only)
  app.get("/api/ai/briefing", { preHandler: executiveReadOnly }, async () => {
    return getOrCreateDailyBriefing(false);
  });

  app.post("/api/ai/briefing/refresh", { preHandler: managerAiLimited }, async () => {
    return getOrCreateDailyBriefing(true);
  });

  // Semantic Catalog Search + Embeddings Sync
  app.post("/api/ai/embeddings/sync", { preHandler: managerAiLimited }, async (req, reply) => {
    const schema = z.object({ force: z.boolean().optional().default(false) });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    return syncProductEmbeddings(parsed.data.force);
  });

  app.get(
    "/api/ai/search/semantic",
    { preHandler: [requireRole(["owner", "manager", "stock_clerk"]), aiComputeLimiter] },
    async (req, reply) => {
      const q = req.query as { q?: string; limit?: string };
      const query = (q.q ?? "").trim();
      if (!query) {
        return reply.status(400).send({ error: "Query parameter q is required." });
      }
      if (query.length > 500) {
        return reply.status(400).send({ error: "Query parameter q must be <= 500 characters." });
      }
      const rawLimit = Number(q.limit);
      const limit = Number.isFinite(rawLimit) ? Math.min(60, Math.max(5, Math.trunc(rawLimit))) : 30;
      const result = await semanticSearchProducts(query, limit);
      if (req.authUser?.role === "stock_clerk") {
        return {
          ...result,
          items: result.items.map(({ avgCostCents: _c, minMarginBp: _mm, marginBp: _m, ...pub }) => pub),
        };
      }
      return result;
    }
  );

  // Multimodal Supplier Invoice / Delivery Note -> GRN Scanner
  app.post("/api/ai/grn/parse-invoice", { preHandler: managerAiLimited }, async (req, reply) => {
    const parsed = ParseInvoiceSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    return parseSupplierInvoice(parsed.data);
  });

  // Calibrated Anomaly & Discrepancy Triage (Decisions API / calibrated local)
  app.post("/api/ai/triage", { preHandler: managerOnly }, async (req, reply) => {
    const parsed = AiTriageRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    return runCalibratedTriage(parsed.data.targetType, parsed.data.metrics);
  });

  app.get("/api/ai/conversations", { preHandler: managerOnly }, async (req) => {
    const rows = await db
      .select()
      .from(aiConversations)
      .where(eq(aiConversations.userId, req.authUser!.id))
      .orderBy(desc(aiConversations.updatedAt))
      .limit(20);
    return { conversations: rows };
  });

  app.get("/api/ai/conversations/:id", { preHandler: managerOnly }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UuidSchema.safeParse(id).success) {
      return reply.status(400).send({ error: "Invalid conversation ID format." });
    }
    const [conv] = await db
      .select()
      .from(aiConversations)
      .where(and(eq(aiConversations.id, id), eq(aiConversations.userId, req.authUser!.id)))
      .limit(1);
    if (!conv) return reply.status(404).send({ error: "Conversation not found" });

    const [messages, actions] = await Promise.all([
      db
        .select()
        .from(aiMessages)
        .where(eq(aiMessages.conversationId, id))
        .orderBy(asc(aiMessages.createdAt)),
      db
        .select()
        .from(aiProposedActions)
        .where(eq(aiProposedActions.conversationId, id))
        .orderBy(desc(aiProposedActions.createdAt)),
    ]);

    return { conversation: conv, messages, actions };
  });

  app.delete("/api/ai/conversations/:id", { preHandler: managerOnly }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UuidSchema.safeParse(id).success) {
      return reply.status(400).send({ error: "Invalid conversation ID format." });
    }
    await db
      .delete(aiConversations)
      .where(and(eq(aiConversations.id, id), eq(aiConversations.userId, req.authUser!.id)));
    return { deleted: true };
  });

  // Standard unary chat endpoint
  app.post("/api/ai/chat", { preHandler: managerAiLimited }, async (req, reply) => {
    const parsed = AiChatRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

    const user = req.authUser!;
    const msgText = parsed.data.message.trim();
    if (!msgText) return reply.status(400).send({ error: "Message cannot be empty." });
    let conversationId = parsed.data.conversationId ?? null;
    let previousInteractionId: string | null = null;

    if (conversationId) {
      const [existing] = await db
        .select()
        .from(aiConversations)
        .where(and(eq(aiConversations.id, conversationId), eq(aiConversations.userId, user.id)))
        .limit(1);
      if (!existing) return reply.status(404).send({ error: "Conversation not found" });
      previousInteractionId = existing.lastInteractionId;
    } else {
      const [created] = await db
        .insert(aiConversations)
        .values({
          userId: user.id,
          title: msgText.slice(0, 64),
          model: isGeminiConfigured() ? "gemini-4-hydrogen" : "local-deterministic-tools",
        })
        .returning();
      conversationId = created.id;
    }

    await db.insert(aiMessages).values({
      conversationId,
      role: "user",
      content: msgText,
    });

    const result = await runCopilotTurn(msgText, previousInteractionId, {
      conversationId,
      user,
    });

    const [assistantMsg] = await db
      .insert(aiMessages)
      .values({
        conversationId,
        role: "assistant",
        content: result.replyText,
        toolCallsJson: result.toolTraces,
      })
      .returning();

    await db
      .update(aiConversations)
      .set({
        lastInteractionId: result.interactionId,
        model: result.model,
        updatedAt: new Date(),
      })
      .where(eq(aiConversations.id, conversationId));

    const actions = await db
      .select()
      .from(aiProposedActions)
      .where(eq(aiProposedActions.conversationId, conversationId))
      .orderBy(desc(aiProposedActions.createdAt));

    return {
      conversationId,
      mode: result.mode,
      model: result.model,
      message: assistantMsg,
      toolTraces: result.toolTraces,
      actions,
    };
  });

  // Live SSE Streaming Copilot Endpoint
  app.post("/api/ai/chat/stream", { preHandler: managerAiLimited }, async (req, reply) => {
    const parsed = AiChatRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

    const user = req.authUser!;
    const msgText = parsed.data.message.trim();
    if (!msgText) return reply.status(400).send({ error: "Message cannot be empty." });
    let conversationId = parsed.data.conversationId ?? null;
    let previousInteractionId: string | null = null;

    if (conversationId) {
      const [existing] = await db
        .select()
        .from(aiConversations)
        .where(and(eq(aiConversations.id, conversationId), eq(aiConversations.userId, user.id)))
        .limit(1);
      if (!existing) return reply.status(404).send({ error: "Conversation not found" });
      previousInteractionId = existing.lastInteractionId;
    } else {
      const [created] = await db
        .insert(aiConversations)
        .values({
          userId: user.id,
          title: msgText.slice(0, 64),
          model: isGeminiConfigured() ? "gemini-4-hydrogen" : "local-deterministic-tools",
        })
        .returning();
      conversationId = created.id;
    }

    await db.insert(aiMessages).values({
      conversationId,
      role: "user",
      content: msgText,
    });

    reply.hijack();
    const rawRes = reply.raw;
    const origin = req.headers.origin;
    const headers: Record<string, string> = {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Request-Id": req.correlationId || generateUuidV7(),
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "same-origin",
    };
    if (origin && app.allowedOrigins.has(origin)) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Credentials"] = "true";
      headers.Vary = "Origin";
    }
    rawRes.writeHead(200, headers);
    const finishSseMetric = registerActiveSseResponse(rawRes);

    let clientClosed = false;
    let streamOutcome: "completed" | "error" | "aborted" = "completed";
    req.raw.on("close", () => {
      clientClosed = true;
      if (!rawRes.writableEnded) {
        streamOutcome = "aborted";
      }
    });

    const sendSse = (payload: unknown) => {
      if (!clientClosed && !rawRes.writableEnded) {
        rawRes.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    };

    try {
      sendSse({ type: "meta", conversationId });

      const result = await runCopilotTurnStream(
        msgText,
        previousInteractionId,
        { conversationId, user },
        (ev) => sendSse(ev)
      );

      const [assistantMsg] = await db
        .insert(aiMessages)
        .values({
          conversationId,
          role: "assistant",
          content: result.replyText,
          toolCallsJson: result.toolTraces,
        })
        .returning();

      await db
        .update(aiConversations)
        .set({
          lastInteractionId: result.interactionId,
          model: result.model,
          updatedAt: new Date(),
        })
        .where(eq(aiConversations.id, conversationId));

      const actions = await db
        .select()
        .from(aiProposedActions)
        .where(eq(aiProposedActions.conversationId, conversationId))
        .orderBy(desc(aiProposedActions.createdAt));

      sendSse({
        type: "done",
        conversationId,
        mode: result.mode,
        model: result.model,
        message: assistantMsg,
        toolTraces: result.toolTraces,
        actions,
      });
    } catch (err) {
      streamOutcome = "error";
      req.log.error({ err }, "SSE copilot streaming error");
      sendSse({
        type: "error",
        error: "Copilot streaming failed. Please retry.",
      });
    } finally {
      finishSseMetric(clientClosed && streamOutcome === "completed" ? "aborted" : streamOutcome);
      if (!rawRes.writableEnded) {
        rawRes.end();
      }
    }
  });

  // Human-in-the-Loop Execution of an AI-Proposed Action (atomic lock + Zod payload validation)
  app.post("/api/ai/actions/:id/execute", { preHandler: managerOnly }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UuidSchema.safeParse(id).success) {
      return reply.status(400).send({ error: "Invalid action ID format." });
    }
    const actor = req.authUser!;

    const outcome = await db.transaction(async (tx) => {
      const [action] = await tx
        .select()
        .from(aiProposedActions)
        .where(eq(aiProposedActions.id, id))
        .for("update");
      if (!action) return { status: 404 as const, error: "Proposed action not found" };
      const [ownerConv] = await tx
        .select({ id: aiConversations.id })
        .from(aiConversations)
        .where(and(eq(aiConversations.id, action.conversationId), eq(aiConversations.userId, actor.id)))
        .limit(1);
      if (!ownerConv) return { status: 404 as const, error: "Proposed action not found" };
      if (action.status !== "pending") {
        return { status: 409 as const, error: `Action is already "${action.status}".` };
      }

      const rawPayload = action.payloadJson as Record<string, unknown>;
      let executionResult: Record<string, unknown> = {};

      if (action.actionType === "create_po") {
        const parsed = ExecuteCreatePoPayloadSchema.safeParse(rawPayload);
        if (!parsed.success) {
          return { status: 400 as const, error: "Proposed PO payload failed validation." };
        }
        const payload = parsed.data;
        const totalCases = payload.lines.reduce((s, l) => s + l.orderedCases, 0);
        const estimatedCostCents = payload.lines.reduce(
          (s, l) => s + l.orderedCases * l.caseQty * l.unitCostCents,
          0
        );
        const poNumber = `PO-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${generateUuidV7()
          .slice(-6)
          .toUpperCase()}`;

        const [po] = await tx
          .insert(purchaseOrders)
          .values({
            poNumber,
            supplierId: payload.supplierId,
            status: "approved",
            totalCases,
            estimatedCostCents,
            createdBy: actor.fullName,
            approvedBy: actor.fullName,
            approvedAt: new Date(),
            notes: payload.notes ?? "Approved via AI Copilot",
          })
          .returning();

        await tx.insert(purchaseOrderLines).values(
          payload.lines.map((l) => ({
            poId: po.id,
            productId: l.productId,
            caseQty: l.caseQty,
            orderedCases: l.orderedCases,
            unitCostCents: l.unitCostCents,
            lineTotalCents: l.orderedCases * l.caseQty * l.unitCostCents,
          }))
        );

        await tx.insert(auditLogs).values({
          actor: actor.fullName,
          action: "ai_execute_po",
          entityType: "purchase_order",
          entityId: po.id,
          detailsJson: { actionId: action.id, poNumber, totalCases, estimatedCostCents },
        });
        executionResult = { poId: po.id, poNumber, totalCases, estimatedCostCents };
      } else if (action.actionType === "update_price") {
        const parsed = ExecuteUpdatePricePayloadSchema.safeParse(rawPayload);
        if (!parsed.success) {
          return { status: 400 as const, error: "Proposed price update payload failed validation." };
        }
        const { productId, newSellPriceCents: newSellPrice, alertId } = parsed.data;

        const [prod] = await tx
          .select({
            avgCostCents: products.avgCostCents,
            minMarginBp: products.minMarginBp,
            taxRateBp: taxRates.rateBp,
            taxInclusive: taxRates.isInclusive,
          })
          .from(products)
          .innerJoin(taxRates, eq(products.taxRateId, taxRates.id))
          .where(eq(products.id, productId));
        if (!prod) {
          return { status: 404 as const, error: "Target product no longer exists." };
        }

        const allBcs = await tx
          .select()
          .from(productBarcodes)
          .where(eq(productBarcodes.productId, productId))
          .for("update");
        const primary = allBcs.find((b) => b.isPrimary) ?? allBcs[0];
        if (!primary) {
          return { status: 404 as const, error: "Target product has no registered barcode." };
        }

        // Enforce floor-margin guard and max 40% single-step price-drop ceiling on primary barcode (blocks indirect prompt injection price drops)
        const primaryFloorCents = computeSuggestedSellPriceCents(
          prod.avgCostCents * primary.packQty,
          prod.minMarginBp,
          prod.taxRateBp,
          prod.taxInclusive,
          5
        );
        if (newSellPrice < primaryFloorCents) {
          return {
            status: 400 as const,
            error: `Proposed price (${newSellPrice}c) breaches product floor margin guard (minimum ${primaryFloorCents}c).`,
          };
        }
        const minAllowedStepPrice = Math.floor(primary.sellPriceCents * 0.6);
        if (primary.sellPriceCents > 0 && newSellPrice < minAllowedStepPrice) {
          return {
            status: 400 as const,
            error: `Proposed price (${newSellPrice}c) exceeds maximum 40% single-step drop from current shelf price (${primary.sellPriceCents}c).`,
          };
        }

        const ratio = newSellPrice / Math.max(1, primary.sellPriceCents);

        for (const bc of allBcs) {
          if (bc.isPrimary) {
            await tx
              .update(productBarcodes)
              .set({ sellPriceCents: newSellPrice })
              .where(eq(productBarcodes.id, bc.id));
          } else {
            const scaled = Math.ceil((bc.sellPriceCents * ratio) / 5) * 5;
            const floor = computeSuggestedSellPriceCents(
              prod.avgCostCents * bc.packQty,
              prod.minMarginBp,
              prod.taxRateBp,
              prod.taxInclusive,
              5
            );
            await tx
              .update(productBarcodes)
              .set({ sellPriceCents: Math.max(scaled, floor) })
              .where(eq(productBarcodes.id, bc.id));
          }
        }
        if (primary && newSellPrice !== primary.sellPriceCents) {
          await tx.insert(shelfTagQueue).values({
            productId,
            barcode: primary.barcode,
            oldPriceCents: primary.sellPriceCents,
            newPriceCents: newSellPrice,
            reason: "cost_change",
            status: "pending",
          });
        }
        if (alertId) {
          await tx
            .update(marginAlerts)
            .set({ resolved: true })
            .where(eq(marginAlerts.id, alertId));
        }

        await tx.insert(auditLogs).values({
          actor: actor.fullName,
          action: "ai_execute_price_update",
          entityType: "product",
          entityId: productId,
          detailsJson: { actionId: action.id, newSellPriceCents: newSellPrice },
        });
        executionResult = {
          productId,
          newSellPriceCents: newSellPrice,
          updatedBarcodes: allBcs.length,
        };
      } else if (action.actionType === "create_promo") {
        const parsed = ExecuteCreatePromoPayloadSchema.safeParse(rawPayload);
        if (!parsed.success) {
          return { status: 400 as const, error: "Proposed promotion payload failed validation." };
        }
        const payload = parsed.data;
        const now = new Date();
        const [promo] = await tx
          .insert(promotions)
          .values({
            name: payload.name,
            promoType: payload.promoType,
            priority: payload.priority,
            combinable: payload.combinable,
            minMarginGuardBp: payload.minMarginGuardBp ?? 1000,
            daypartStartHour: payload.daypartStartHour ?? null,
            daypartEndHour: payload.daypartEndHour ?? null,
            startsAt: now,
            endsAt: new Date(now.getTime() + 14 * 86400_000),
            active: true,
            rulesJson: payload.rulesJson,
          })
          .returning();

        await tx.insert(auditLogs).values({
          actor: actor.fullName,
          action: "ai_execute_promo",
          entityType: "promotion",
          entityId: promo.id,
          detailsJson: { actionId: action.id, name: promo.name },
        });
        executionResult = { promotionId: promo.id, name: promo.name };
      } else {
        return { status: 400 as const, error: `Unsupported action type "${action.actionType}".` };
      }

      const [updated] = await tx
        .update(aiProposedActions)
        .set({
          status: "executed",
          executedBy: actor.fullName,
          executedAt: new Date(),
          executionResultJson: executionResult,
        })
        .where(eq(aiProposedActions.id, action.id))
        .returning();

      return { status: 200 as const, action: updated, result: executionResult };
    });

    if (outcome.status !== 200) {
      return reply.status(outcome.status).send({ error: outcome.error });
    }
    return { action: outcome.action, result: outcome.result };
  });

  app.post("/api/ai/actions/:id/reject", { preHandler: managerOnly }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UuidSchema.safeParse(id).success) {
      return reply.status(400).send({ error: "Invalid action ID format." });
    }
    const [existing] = await db
      .select({
        id: aiProposedActions.id,
        status: aiProposedActions.status,
        userId: aiConversations.userId,
      })
      .from(aiProposedActions)
      .innerJoin(aiConversations, eq(aiProposedActions.conversationId, aiConversations.id))
      .where(eq(aiProposedActions.id, id))
      .limit(1);
    if (!existing || existing.userId !== req.authUser!.id || existing.status !== "pending") {
      return reply.status(404).send({ error: "Pending action not found" });
    }
    const [updated] = await db
      .update(aiProposedActions)
      .set({
        status: "rejected",
        executedBy: req.authUser!.fullName,
        executedAt: new Date(),
      })
      .where(and(eq(aiProposedActions.id, id), eq(aiProposedActions.status, "pending")))
      .returning();
    if (!updated) return reply.status(404).send({ error: "Pending action not found" });
    return { action: updated };
  });
}
