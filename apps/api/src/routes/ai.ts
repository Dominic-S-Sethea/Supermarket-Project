import {
  AiChatRequestSchema,
  AiTriageRequestSchema,
  computeSuggestedSellPriceCents,
  ParseInvoiceSchema,
} from "@supermarket/shared";
import { and, asc, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
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
  taxRates,
} from "../db/index.js";
import { requireAuth, requireRole } from "../plugins/auth.js";

export async function aiRoutes(app: FastifyInstance) {
  const managerOnly = [requireRole(["owner", "manager"])];

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

  // Daily Morning Executive Briefing
  app.get("/api/ai/briefing", { preHandler: [requireAuth] }, async () => {
    return getOrCreateDailyBriefing(false);
  });

  app.post("/api/ai/briefing/refresh", { preHandler: managerOnly }, async () => {
    return getOrCreateDailyBriefing(true);
  });

  // Semantic Catalog Search + Embeddings Sync
  app.post("/api/ai/embeddings/sync", { preHandler: managerOnly }, async (req) => {
    const body = (req.body ?? {}) as { force?: boolean };
    return syncProductEmbeddings(Boolean(body.force));
  });

  app.get("/api/ai/search/semantic", { preHandler: [requireAuth] }, async (req, reply) => {
    const q = req.query as { q?: string; limit?: string };
    const query = (q.q ?? "").trim();
    if (!query) {
      return reply.status(400).send({ error: "Query parameter q is required." });
    }
    const limit = Math.min(60, Math.max(5, Number(q.limit ?? 30) || 30));
    return semanticSearchProducts(query, limit);
  });

  // Multimodal Supplier Invoice / Delivery Note -> GRN Scanner
  app.post("/api/ai/grn/parse-invoice", { preHandler: managerOnly }, async (req, reply) => {
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

  app.delete("/api/ai/conversations/:id", { preHandler: managerOnly }, async (req) => {
    const { id } = req.params as { id: string };
    await db
      .delete(aiConversations)
      .where(and(eq(aiConversations.id, id), eq(aiConversations.userId, req.authUser!.id)));
    return { deleted: true };
  });

  // Standard unary chat endpoint
  app.post("/api/ai/chat", { preHandler: managerOnly }, async (req, reply) => {
    const parsed = AiChatRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

    const user = req.authUser!;
    const msgText = parsed.data.message.trim();
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
  app.post("/api/ai/chat/stream", { preHandler: managerOnly }, async (req, reply) => {
    const parsed = AiChatRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

    const user = req.authUser!;
    const msgText = parsed.data.message.trim();
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
    };
    if (origin) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Credentials"] = "true";
    }
    rawRes.writeHead(200, headers);

    const sendSse = (payload: unknown) => {
      if (!rawRes.writableEnded) {
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
      sendSse({
        type: "error",
        error: err instanceof Error ? err.message : "Streaming error",
      });
    } finally {
      if (!rawRes.writableEnded) {
        rawRes.end();
      }
    }
  });

  // Human-in-the-Loop Execution of an AI-Proposed Action
  app.post("/api/ai/actions/:id/execute", { preHandler: managerOnly }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const actor = req.authUser!;

    const [action] = await db
      .select()
      .from(aiProposedActions)
      .where(eq(aiProposedActions.id, id))
      .limit(1);
    if (!action) return reply.status(404).send({ error: "Proposed action not found" });
    if (action.status !== "pending") {
      return reply.status(409).send({ error: `Action is already "${action.status}".` });
    }

    const payload = action.payloadJson as Record<string, unknown>;
    let executionResult: Record<string, unknown> = {};

    await db.transaction(async (tx) => {
      if (action.actionType === "create_po") {
        const lines = (payload.lines as Array<{
          productId: string;
          caseQty: number;
          orderedCases: number;
          unitCostCents: number;
        }>) ?? [];
        const totalCases = lines.reduce((s, l) => s + l.orderedCases, 0);
        const estimatedCostCents = lines.reduce(
          (s, l) => s + l.orderedCases * l.caseQty * l.unitCostCents,
          0
        );
        const poNumber = `PO-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${String(
          Math.floor(1000 + Math.random() * 9000)
        )}`;

        const [po] = await tx
          .insert(purchaseOrders)
          .values({
            poNumber,
            supplierId: String(payload.supplierId),
            status: "approved",
            totalCases,
            estimatedCostCents,
            createdBy: actor.fullName,
            approvedBy: actor.fullName,
            approvedAt: new Date(),
            notes: String(payload.notes ?? "Approved via AI Copilot"),
          })
          .returning();

        await tx.insert(purchaseOrderLines).values(
          lines.map((l) => ({
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
        const productId = String(payload.productId);
        const newSellPrice = Number(payload.newSellPriceCents);
        const alertId = payload.alertId ? String(payload.alertId) : null;

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

        const allBcs = await tx
          .select()
          .from(productBarcodes)
          .where(eq(productBarcodes.productId, productId));
        const primary = allBcs.find((b) => b.isPrimary) ?? allBcs[0];
        const ratio = newSellPrice / Math.max(1, primary?.sellPriceCents ?? newSellPrice);

        for (const bc of allBcs) {
          if (bc.isPrimary) {
            await tx
              .update(productBarcodes)
              .set({ sellPriceCents: newSellPrice })
              .where(eq(productBarcodes.id, bc.id));
          } else {
            const scaled = Math.ceil((bc.sellPriceCents * ratio) / 5) * 5;
            const floor = prod
              ? computeSuggestedSellPriceCents(
                  prod.avgCostCents * bc.packQty,
                  prod.minMarginBp,
                  prod.taxRateBp,
                  prod.taxInclusive,
                  5
                )
              : scaled;
            await tx
              .update(productBarcodes)
              .set({ sellPriceCents: Math.max(scaled, floor) })
              .where(eq(productBarcodes.id, bc.id));
          }
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
        executionResult = { productId, newSellPriceCents: newSellPrice, updatedBarcodes: allBcs.length };
      } else if (action.actionType === "create_promo") {
        const now = new Date();
        const [promo] = await tx
          .insert(promotions)
          .values({
            name: String(payload.name),
            promoType: String(payload.promoType),
            priority: Number(payload.priority ?? 15),
            combinable: Boolean(payload.combinable ?? false),
            minMarginGuardBp:
              payload.minMarginGuardBp !== undefined && payload.minMarginGuardBp !== null
                ? Number(payload.minMarginGuardBp)
                : 1000,
            daypartStartHour:
              typeof payload.daypartStartHour === "number" ? payload.daypartStartHour : null,
            daypartEndHour:
              typeof payload.daypartEndHour === "number" ? payload.daypartEndHour : null,
            startsAt: now,
            endsAt: new Date(now.getTime() + 14 * 86400_000),
            active: true,
            rulesJson: (payload.rulesJson as Record<string, unknown>) ?? {},
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
      }

      await tx
        .update(aiProposedActions)
        .set({
          status: "executed",
          executedBy: actor.fullName,
          executedAt: new Date(),
          executionResultJson: executionResult,
        })
        .where(eq(aiProposedActions.id, action.id));
    });

    const [updated] = await db
      .select()
      .from(aiProposedActions)
      .where(eq(aiProposedActions.id, id));

    return { action: updated, result: executionResult };
  });

  app.post("/api/ai/actions/:id/reject", { preHandler: managerOnly }, async (req, reply) => {
    const { id } = req.params as { id: string };
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
