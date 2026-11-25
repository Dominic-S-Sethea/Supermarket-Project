import { GoogleGenAI } from "@google/genai";
import { COPILOT_TOOLS, executeCopilotTool, type CopilotToolContext } from "./tools.js";

const SYSTEM_INSTRUCTION = `You are SupermarketOS Copilot, an analytical retail operations AI embedded inside a 3,120+ SKU packaged-goods supermarket platform.
Rules:
1. Always ground answers in real store numbers by calling your read tools before stating figures.
2. Never invent SKUs, sales, stock counts, or supplier names.
3. All money is integer cents in the database; present formatted USD amounts and net margins clearly.
4. For any state-changing operation (creating a Purchase Order, updating retail prices, or launching a promotion/clearance), ALWAYS use your proposal tools (propose_purchase_order, propose_price_update, propose_promotion). These create Human-in-the-Loop approval cards in the UI and never mutate operational tables without manager confirmation.
5. Keep answers concise, structured with bullet points or short tables, and actionable.`;

export interface ToolTraceItem {
  tool: string;
  args: Record<string, unknown>;
  summary: string;
}

export interface CopilotRunResult {
  replyText: string;
  mode: "gemini" | "local_fallback";
  model: string;
  interactionId: string | null;
  toolTraces: ToolTraceItem[];
}

export type CopilotStreamEvent =
  | { type: "status"; text: string }
  | { type: "tool_call"; tool: string; args: Record<string, unknown> }
  | { type: "tool_result"; tool: string; summary: string }
  | { type: "delta"; text: string }
  | { type: "error"; error: string };

export function isGeminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

function sanitizeGeminiError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const redacted = raw
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, "[REDACTED_KEY]")
    .replace(/(api[_-]?key|token|key)=[^\s&"']+/gi, "$1=[REDACTED]")
    .replace(/\s+/g, " ")
    .trim();
  return redacted.length > 140 ? `${redacted.slice(0, 137)}...` : redacted || "upstream error";
}

export async function runCopilotTurn(
  userMessage: string,
  previousInteractionId: string | null,
  ctx: CopilotToolContext
): Promise<CopilotRunResult> {
  if (isGeminiConfigured()) {
    try {
      return await runGeminiInteractionsTurn(userMessage, previousInteractionId, ctx);
    } catch (err) {
      const fallback = await runLocalFallbackTurn(userMessage, ctx);
      const errMsg = sanitizeGeminiError(err);
      return {
        ...fallback,
        replyText: `> Gemini API unavailable (${errMsg}). Switched to Local Tool Mode.\n\n${fallback.replyText}`,
      };
    }
  }
  return runLocalFallbackTurn(userMessage, ctx);
}

export async function runCopilotTurnStream(
  userMessage: string,
  previousInteractionId: string | null,
  ctx: CopilotToolContext,
  emit: (event: CopilotStreamEvent) => void
): Promise<CopilotRunResult> {
  if (isGeminiConfigured()) {
    try {
      return await runGeminiInteractionsTurnStream(userMessage, previousInteractionId, ctx, emit);
    } catch (err) {
      const errMsg = sanitizeGeminiError(err);
      emit({ type: "delta", text: `> Gemini API unavailable (${errMsg}). Switched to Local Tool Mode.\n\n` });
      const fallback = await runLocalFallbackTurn(userMessage, ctx, emit);
      await streamTextChunks(fallback.replyText, emit);
      return {
        ...fallback,
        replyText: `> Gemini API unavailable (${errMsg}). Switched to Local Tool Mode.\n\n${fallback.replyText}`,
      };
    }
  }
  const fallback = await runLocalFallbackTurn(userMessage, ctx, emit);
  await streamTextChunks(fallback.replyText, emit);
  return fallback;
}

async function streamTextChunks(
  text: string,
  emit: (event: CopilotStreamEvent) => void
): Promise<void> {
  const words = text.split(/(\s+)/);
  const chunkSize = 6;
  for (let i = 0; i < words.length; i += chunkSize) {
    emit({ type: "delta", text: words.slice(i, i + chunkSize).join("") });
    await new Promise((r) => setTimeout(r, 8));
  }
}

async function runGeminiInteractionsTurn(
  userMessage: string,
  previousInteractionId: string | null,
  ctx: CopilotToolContext
): Promise<CopilotRunResult> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!.trim() });
  const model = "gemini-4-hydrogen";
  const toolTraces: ToolTraceItem[] = [];

  let interaction = await ai.interactions.create({
    model,
    input: userMessage,
    system_instruction: SYSTEM_INSTRUCTION,
    tools: COPILOT_TOOLS as unknown as Parameters<typeof ai.interactions.create>[0]["tools"],
    previous_interaction_id: previousInteractionId ?? undefined,
    store: true,
  });

  for (let round = 0; round < 6; round++) {
    const fnCalls = (interaction.steps ?? []).filter(
      (s): s is Extract<NonNullable<typeof interaction.steps>[number], { type: "function_call" }> =>
        s.type === "function_call"
    );
    if (fnCalls.length === 0) break;

    const resultsInput = [];
    for (const fc of fnCalls) {
      const args = (fc.arguments ?? {}) as Record<string, unknown>;
      const result = await executeCopilotTool(fc.name, args, ctx);
      toolTraces.push({
        tool: fc.name,
        args,
        summary: summarizeToolResult(fc.name, result),
      });
      resultsInput.push({
        type: "function_result" as const,
        call_id: fc.id,
        name: fc.name,
        result: JSON.stringify(result),
      });
    }

    interaction = await ai.interactions.create({
      model,
      input: resultsInput,
      system_instruction: SYSTEM_INSTRUCTION,
      tools: COPILOT_TOOLS as unknown as Parameters<typeof ai.interactions.create>[0]["tools"],
      previous_interaction_id: interaction.id,
      store: true,
    });
  }

  return {
    replyText:
      interaction.output_text?.trim() ||
      "I checked the live store ledger and prepared the requested items.",
    mode: "gemini",
    model,
    interactionId: interaction.id ?? null,
    toolTraces,
  };
}

async function runGeminiInteractionsTurnStream(
  userMessage: string,
  previousInteractionId: string | null,
  ctx: CopilotToolContext,
  emit: (event: CopilotStreamEvent) => void
): Promise<CopilotRunResult> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!.trim() });
  const model = "gemini-4-hydrogen";
  const toolTraces: ToolTraceItem[] = [];
  let currentPrevId = previousInteractionId ?? undefined;
  let currentInput: Parameters<typeof ai.interactions.create>[0]["input"] = userMessage;
  let fullText = "";

  for (let round = 0; round < 6; round++) {
    let roundInteractionId: string | null = null;
    let roundFnCalls: { id: string; name: string; arguments: Record<string, unknown> }[] = [];

    const stream = await ai.interactions.create({
      model,
      input: currentInput,
      system_instruction: SYSTEM_INSTRUCTION,
      tools: COPILOT_TOOLS as unknown as Parameters<typeof ai.interactions.create>[0]["tools"],
      previous_interaction_id: currentPrevId,
      store: true,
      stream: true,
    });

    for await (const event of stream) {
      if (event.event_type === "step.delta" && event.delta.type === "text" && event.delta.text) {
        fullText += event.delta.text;
        emit({ type: "delta", text: event.delta.text });
      } else if (event.event_type === "interaction.completed") {
        roundInteractionId = event.interaction.id ?? null;
        const steps = event.interaction.steps ?? [];
        roundFnCalls = steps
          .filter(
            (s): s is Extract<NonNullable<typeof steps>[number], { type: "function_call" }> =>
              s.type === "function_call"
          )
          .map((fc) => ({
            id: fc.id,
            name: fc.name,
            arguments: (fc.arguments ?? {}) as Record<string, unknown>,
          }));
      }
    }

    if (roundInteractionId) currentPrevId = roundInteractionId;
    if (roundFnCalls.length === 0) break;

    const resultsInput = [];
    for (const fc of roundFnCalls) {
      emit({ type: "tool_call", tool: fc.name, args: fc.arguments });
      const result = await executeCopilotTool(fc.name, fc.arguments, ctx);
      const summary = summarizeToolResult(fc.name, result);
      toolTraces.push({ tool: fc.name, args: fc.arguments, summary });
      emit({ type: "tool_result", tool: fc.name, summary });
      resultsInput.push({
        type: "function_result" as const,
        call_id: fc.id,
        name: fc.name,
        result: JSON.stringify(result),
      });
    }
    currentInput = resultsInput;
  }

  return {
    replyText:
      fullText.trim() ||
      "I checked the live store ledger and prepared the requested items.",
    mode: "gemini",
    model,
    interactionId: currentPrevId ?? null,
    toolTraces,
  };
}

async function runLocalFallbackTurn(
  userMessage: string,
  ctx: CopilotToolContext,
  emit?: (event: CopilotStreamEvent) => void
): Promise<CopilotRunResult> {
  const q = userMessage.toLowerCase();
  const toolTraces: ToolTraceItem[] = [];
  const sections: string[] = [];

  const callAndTrace = async (name: string, args: Record<string, unknown> = {}) => {
    emit?.({ type: "tool_call", tool: name, args });
    const res = await executeCopilotTool(name, args, ctx);
    const summary = summarizeToolResult(name, res);
    toolTraces.push({ tool: name, args, summary });
    emit?.({ type: "tool_result", tool: name, summary });
    return res;
  };

  const wantsShiftDiag =
    q.includes("shift") ||
    q.includes("walk-in") ||
    q.includes("footfall") ||
    q.includes("conversion") ||
    (q.includes("morning") &&
      (q.includes("loss") ||
        q.includes("drop") ||
        q.includes("slow") ||
        q.includes("diagnos") ||
        q.includes("underperform") ||
        q.includes("why")));
  const wantsBriefing =
    !wantsShiftDiag &&
    (q.includes("brief") || q.includes("morning") || q.includes("overview") || q.includes("risk"));
  const wantsMargin = q.includes("margin") || q.includes("reprice") || q.includes("price hike");
  const wantsPo =
    q.includes("po") || q.includes("purchase order") || q.includes("reorder") || q.includes("stockout");
  const wantsExpiry = q.includes("expir") || q.includes("fefo") || q.includes("spoil");
  const wantsLp =
    q.includes("loss") && !wantsShiftDiag
      ? true
      : q.includes("cashier") || q.includes("void") || q.includes("dead");
  const wantsBasket =
    q.includes("basket") || q.includes("promo") || q.includes("bundle") || q.includes("upsell");
  const wantsSuppliers =
    q.includes("otif") || q.includes("supplier") || q.includes("scorecard") || q.includes("variance");
  const wantsPhantom =
    q.includes("phantom") || q.includes("ghost") || q.includes("silent");
  const wantsMarkdowns =
    q.includes("markdown") || q.includes("dynamic") || q.includes("clearance");
  const wantsTasks =
    q.includes("task") || q.includes("checklist") || q.includes("floor") || q.includes("restock");

  if (wantsShiftDiag) {
    const diag = await callAndTrace("diagnose_shift_performance");
    if (diag.error) {
      sections.push(String(diag.error));
    } else {
      const topOos = (diag.topOosSkus as Array<Record<string, unknown>>) ?? [];
      const topDrivers = (diag.topDrivers as Array<Record<string, unknown>>) ?? [];
      const morningRules = (diag.topMorningBasketRules as Array<Record<string, unknown>>) ?? [];
      sections.push(
        `### Morning Shift Diagnostic Breakdown\n` +
          `- **Primary Bottleneck:** ${diag.primaryBottleneck}\n` +
          `- **Funnel Conversion:** Morning **${diag.morningConversionPct}%** vs Afternoon **${diag.afternoonConversionPct}%** / Evening **${diag.eveningConversionPct}%** (Welch p=${diag.conversionPValue ?? "N/A"})\n` +
          `- **Estimated 08:00 OOS Lost Revenue (60d):** **${diag.morningEstLostRevenueUsd}** across Class-A/B SKUs (Queue knee: \`${diag.queueSaturationThreshold}\`).\n` +
          `- **Top Causal Drivers (Ridge Holdout WMAPE ${diag.holdoutWmapePct}% vs Baseline ${diag.baselineWmapePct}%):** ` +
          topDrivers
            .slice(0, 3)
            .map((d) => `${d.label} (${d.importancePct}%, ${Number(d.coefUsdPerSd) >= 0 ? "+" : ""}$${d.coefUsdPerSd}/SD)`)
            .join(" · ") +
          (topOos.length > 0
            ? `\n\n**Top Morning OOS Stockouts (Restocked @ ~${topOos[0].avgRestockHour}:00):**\n` +
              topOos
                .slice(0, 3)
                .map(
                  (o) =>
                    `- \`${o.sku}\` ${o.name} [${o.segment}]: ${o.oosDays} OOS mornings, **${o.estLostUsd}** est. lost (${o.supplierName})`
                )
                .join("\n")
            : "")
      );

      if (
        (q.includes("fix") ||
          q.includes("solve") ||
          q.includes("propose") ||
          q.includes("bundle") ||
          q.includes("promo")) &&
        morningRules[0]
      ) {
        const topRule = morningRules[0];
        const prop = await callAndTrace("propose_promotion", {
          name: `Morning Combo (08-12): ${String(topRule.antecedentName).slice(0, 18)} + ${String(topRule.consequentName).slice(0, 18)}`,
          promoType: "tier_price",
          productIds: [
            String(topRule.antecedentProductId),
            String(topRule.consequentProductId),
          ],
          requiredQty: 2,
          discountBp: 1200,
          minMarginGuardBp: 1200,
          daypartStartHour: 8,
          daypartEndHour: 12,
        });
        if (!prop.error) {
          sections.push(
            `Simulated & staged a **08:00–12:00 Daypart Morning Combo** approval card (${prop.daypartWindow}, sample discount ${prop.sampleDiscountUsd}, net margin ${prop.simulatedNetMargin}).`
          );
        }
      }
    }
  }

  if (
    wantsBriefing ||
    (!wantsShiftDiag &&
      !wantsMargin &&
      !wantsPo &&
      !wantsExpiry &&
      !wantsLp &&
      !wantsBasket &&
      !wantsSuppliers &&
      !wantsPhantom &&
      !wantsMarkdowns &&
      !wantsTasks)
  ) {
    const kpis = await callAndTrace("get_store_kpis", { days: 30 });
    const reorders = await callAndTrace("get_reorder_alerts", { urgency: "critical", limit: 5 });
    const expiry = await callAndTrace("get_expiry_risks", { days: 30, limit: 5 });
    const margins = await callAndTrace("get_margin_alerts");
    const lp = await callAndTrace("get_loss_prevention_report");

    const criticalList = (reorders.items as Array<Record<string, unknown>>) ?? [];
    const batchList = (expiry.batches as Array<Record<string, unknown>>) ?? [];
    const alertList = (margins.alerts as Array<Record<string, unknown>>) ?? [];
    const cashiers = ((lp.cashierAnomalies as Array<Record<string, unknown>>) ?? []).filter(
      (c) => c.riskLevel !== "normal"
    );

    sections.push(
      `### Morning Store Risk Briefing (30-Day Window)\n` +
        `- **Sales & Margin:** ${kpis.netSalesUsd} net sales across ${kpis.receiptCount} receipts (${kpis.grossMarginPct} gross margin, ${kpis.grossProfitUsd} profit).\n` +
        `- **Critical Stockouts:** ${criticalList.length} urgent SKUs — top: ${
          criticalList[0] ? `${criticalList[0].sku} (${criticalList[0].name}, ${criticalList[0].currentStock} left)` : "None"
        }.\n` +
        `- **FEFO Expiry Risk (30d):** ${batchList.length} batches — earliest: ${
          batchList[0] ? `${batchList[0].name} (${batchList[0].bestBeforeDate}, ${batchList[0].atRiskCostUsd} at risk)` : "None"
        }.\n` +
        `- **Vendor Margin Alerts:** ${alertList.length} unresolved cost-hike alerts.\n` +
        `- **Loss Prevention:** ${cashiers.length} flagged cashier(s) (${
          cashiers.map((c) => `${c.cashier}: ${c.voidRatePct}% void, Z=${c.robustZScore}`).join("; ") || "All normal"
        }).`
    );

    if (q.includes("search") || (!wantsBriefing && q.trim().length >= 3)) {
      const cat = await callAndTrace("search_catalog", { query: userMessage.trim(), limit: 5 });
      const items = (cat.items as Array<Record<string, unknown>>) ?? [];
      if (items.length > 0) {
        sections.push(
          `**Catalog Matches:**\n` +
            items
              .map(
                (i) =>
                  `- \`${i.sku}\` ${i.name} — Price ${i.sellPrice}, Cost ${i.cost}, Net Margin ${i.netMargin}, Stock ${i.onHandUnits}`
              )
              .join("\n")
        );
      }
    }
  }

  if (wantsMargin) {
    const margins = await callAndTrace("get_margin_alerts");
    const alerts = (margins.alerts as Array<Record<string, unknown>>) ?? [];
    if (alerts.length === 0) {
      sections.push("No unresolved margin erosion alerts were found.");
    } else {
      sections.push(
        `### Vendor Margin Erosion Alerts (${alerts.length} Open)\n` +
          alerts
            .slice(0, 5)
            .map(
              (a) =>
                `- \`${a.sku}\` **${a.name}**: Cost ${a.oldCost} → ${a.newCost}, Current ${a.currentPrice} (${a.resultingMargin} vs ${a.floorMargin} floor) → Suggested **${a.suggestedPrice}**`
            )
            .join("\n")
      );
      if (q.includes("fix") || q.includes("propose") || q.includes("draft") || q.includes("reprice")) {
        const first = alerts[0];
        const prop = await callAndTrace("propose_price_update", {
          skuOrProductId: String(first.sku),
          reason: "Restore category net margin floor after supplier cost hike",
        });
        if (!prop.error) {
          sections.push(
            `Created an approval card below to reprice \`${prop.sku}\` from ${prop.oldPriceUsd} to **${prop.newPriceUsd}** (net margin ${prop.currentNetMargin} → ${prop.newNetMargin}).`
          );
        }
      }
    }
  }

  if (wantsPo) {
    const reorders = await callAndTrace("get_reorder_alerts", { limit: 12 });
    const items = (reorders.items as Array<Record<string, unknown>>) ?? [];
    if (items.length > 0) {
      const topSupplier = String(items[0].supplierName);
      sections.push(
        `### Urgent Replenishment Queue\n` +
          items
            .slice(0, 6)
            .map(
              (r) =>
                `- [${String(r.urgency).toUpperCase()}] \`${r.sku}\` ${r.name}: ${r.currentStock} on hand (ROP ${r.reorderPoint}) → Order **${r.suggestedCases} cs** (${r.estCostUsd}) from *${r.supplierName}*`
            )
            .join("\n")
      );
      if (q.includes("draft") || q.includes("propose") || q.includes("create") || q.includes("po")) {
        const prop = await callAndTrace("propose_purchase_order", {
          supplierName: topSupplier,
          notes: "AI Copilot urgent replenishment draft",
        });
        if (!prop.error) {
          sections.push(
            `Prepared a Draft PO approval card for **${prop.supplierName}** (${prop.skuCount} SKUs, ${prop.totalCases} cases, Est. ${prop.estimatedCostUsd}).`
          );
        }
      }
    } else {
      sections.push("No SKUs currently require replenishment.");
    }
  }

  if (wantsExpiry) {
    const exp = await callAndTrace("get_expiry_risks", { days: 30, limit: 8 });
    const batches = (exp.batches as Array<Record<string, unknown>>) ?? [];
    sections.push(
      `### FEFO Near-Expiry Batches (Next 30 Days)\n` +
        (batches.length === 0
          ? "No near-expiry batches found."
          : batches
              .slice(0, 6)
              .map(
                (b) =>
                  `- \`${b.sku}\` ${b.name} — BBD **${b.bestBeforeDate}**, ${b.qtyRemaining} units (${b.atRiskCostUsd} at risk)`
              )
              .join("\n"))
    );
    if ((q.includes("promo") || q.includes("clearance") || q.includes("design")) && batches[0]) {
      const prop = await callAndTrace("propose_promotion", {
        name: `FEFO Clearance: ${String(batches[0].name).slice(0, 28)}`,
        promoType: "clearance",
        productIds: [String(batches[0].productId)],
        discountBp: 3000,
        minMarginGuardBp: 500,
      });
      if (!prop.error) {
        sections.push(
          `Simulated and staged a **30% Clearance** promo card (simulated net margin ${prop.simulatedNetMargin}).`
        );
      }
    }
  }

  if (wantsLp) {
    const lp = await callAndTrace("get_loss_prevention_report");
    const cashiers = (lp.cashierAnomalies as Array<Record<string, unknown>>) ?? [];
    const dead = (lp.topDeadStock as Array<Record<string, unknown>>) ?? [];
    sections.push(
      `### Loss Prevention & Dead-Stock Summary\n` +
        cashiers
          .slice(0, 5)
          .map(
            (c) =>
              `- **${c.cashier}** [${String(c.riskLevel).toUpperCase()}]: Void ${c.voidRatePct}%, Refunds ${c.refunds}, No-Sale Opens ${c.noSales}, Robust Z=${c.robustZScore}`
          )
          .join("\n") +
        (dead.length > 0
          ? `\n\n**Top Dead-Stock Capital Traps:**\n` +
            dead
              .slice(0, 3)
              .map((d) => `- \`${d.sku}\` ${d.name}: ${d.onHand} units (${d.tiedCapitalUsd} tied up)`)
              .join("\n")
          : "")
    );
  }

  if (wantsBasket) {
    const br = await callAndTrace("get_basket_associations", { limit: 6 });
    const rules = (br.rules as Array<Record<string, unknown>>) ?? [];
    sections.push(
      `### Top Market Basket Associations\n` +
        rules
          .slice(0, 5)
          .map(
            (r) =>
              `- **${r.antecedentName}** → **${r.consequentName}** (Lift **${r.lift}×**, Confidence ${r.confidencePct})`
          )
          .join("\n")
    );
    if ((q.includes("design") || q.includes("promo") || q.includes("bundle") || q.includes("propose")) && rules[0]) {
      const top = rules[0];
      const prop = await callAndTrace("propose_promotion", {
        name: `Weekend Combo: ${String(top.antecedentName).slice(0, 18)} + ${String(top.consequentName).slice(0, 18)}`,
        promoType: "tier_price",
        productIds: [String(top.antecedentProductId), String(top.consequentProductId)],
        requiredQty: 2,
        discountBp: 1000,
        minMarginGuardBp: 1200,
      });
      if (!prop.error) {
        sections.push(
          `Simulated & staged a **10% Combo Tier** promotion card (sample discount ${prop.sampleDiscountUsd}, simulated net margin ${prop.simulatedNetMargin}).`
        );
      }
    }
  }

  if (wantsSuppliers) {
    const sc = await callAndTrace("get_supplier_scorecards");
    const cards = (sc.scorecards as Array<Record<string, unknown>>) ?? [];
    sections.push(
      `### Supplier 90-Day OTIF Scorecards (${sc.openVarianceCount} Open Variances · ${sc.openVarianceImpactUsd})\n` +
        cards
          .slice(0, 6)
          .map(
            (c) =>
              `- **${c.supplierName}** [Grade **${c.grade}**]: OTIF ${c.otifPct}% (On-Time ${c.onTimePct}%, In-Full ${c.inFullPct}%), Lead ${c.leadTimeDays}`
          )
          .join("\n")
    );
  }

  if (wantsPhantom) {
    const ph = await callAndTrace("get_phantom_stock_alerts", { limit: 6 });
    const items = (ph.items as Array<Record<string, unknown>>) ?? [];
    sections.push(
      `### Phantom Stock Alerts (${ph.openAlerts} Open · ${ph.totalAtRiskUsd} at risk)\n` +
        (items.length === 0
          ? "No open phantom stock alerts."
          : items
              .map(
                (i) =>
                  `- \`${i.sku}\` **${i.name}** (Aisle ${i.aisle}): ${i.phantomProbPct}% prob, ${i.bookStock} book units, ${i.silentDays}d silent (${i.atRiskUsd})`
              )
              .join("\n"))
    );
  }

  if (wantsMarkdowns) {
    const md = await callAndTrace("get_dynamic_markdowns", { limit: 6 });
    const items = (md.items as Array<Record<string, unknown>>) ?? [];
    sections.push(
      `### Dynamic FEFO Markdown Recommendations (${md.recommendedCount} Batches · +${md.totalIncrementalRecoveryUsd} recovery lift)\n` +
        (items.length === 0
          ? "No pending dynamic markdown batches."
          : items
              .map(
                (m) =>
                  `- \`${m.sku}\` **${m.name}** (${m.daysLeft}d left, ${m.qtyRemaining} u): Apply **-${m.recommendedDiscount}** → ${m.promoPriceUsd} (+${m.incrementalRecoveryUsd} lift)`
              )
              .join("\n"))
    );
  }

  if (wantsTasks) {
    const ft = await callAndTrace("get_floor_tasks", { limit: 8 });
    const tasks = (ft.tasks as Array<Record<string, unknown>>) ?? [];
    sections.push(
      `### Pending Daily Floor Tasks (${ft.pendingTasks} Pending · ${ft.urgentCount} Urgent P1)\n` +
        (tasks.length === 0
          ? "All scheduled floor tasks are complete!"
          : tasks
              .map(
                (t) =>
                  `- [P${t.priority} ${String(t.taskType).toUpperCase()}] **${t.title}** (Aisle ${t.aisleLocation ?? "—"}, ${t.shiftBucket})`
              )
              .join("\n"))
    );
  }

  const footer =
    `\n\n---\n*Running in Local Tool Mode against live PostgreSQL — set \`GEMINI_API_KEY\` to enable Gemini 4 Hydrogen conversational reasoning.*`;

  return {
    replyText: sections.join("\n\n") + footer,
    mode: "local_fallback",
    model: "local-deterministic-tools",
    interactionId: null,
    toolTraces,
  };
}

function summarizeToolResult(name: string, result: Record<string, unknown>): string {
  if (result.error) return `Error: ${String(result.error)}`;
  switch (name) {
    case "get_store_kpis":
      return `${String(result.netSalesUsd)} net (${String(result.grossMarginPct)} margin)`;
    case "get_margin_alerts":
      return `${String(result.openAlerts ?? 0)} open alert(s)`;
    case "get_reorder_alerts":
      return `${Array.isArray(result.items) ? result.items.length : 0} SKU(s) queued`;
    case "get_expiry_risks":
      return `${Array.isArray(result.batches) ? result.batches.length : 0} expiring batch(es)`;
    case "diagnose_shift_performance":
      return `Morning conv ${String(result.morningConversionPct ?? 0)}% · OOS loss ${String(result.morningEstLostRevenueUsd ?? "$0")}`;
    case "get_supplier_scorecards":
      return `${String(result.supplierCount ?? 0)} suppliers · ${String(result.openVarianceCount ?? 0)} open variance(s)`;
    case "get_phantom_stock_alerts":
      return `${String(result.openAlerts ?? 0)} ghost SKU(s) · ${String(result.totalAtRiskUsd ?? "$0")} at risk`;
    case "get_dynamic_markdowns":
      return `${String(result.recommendedCount ?? 0)} batch(es) · +${String(result.totalIncrementalRecoveryUsd ?? "$0")} lift`;
    case "get_floor_tasks":
      return `${String(result.pendingTasks ?? 0)} pending (${String(result.urgentCount ?? 0)} P1)`;
    case "propose_purchase_order":
      return `Staged PO (${String(result.totalCases ?? 0)} cases)`;
    case "propose_price_update":
      return `Staged price ${String(result.newPriceUsd ?? "")}`;
    case "propose_promotion":
      return `Simulated margin ${String(result.simulatedNetMargin ?? "")}`;
    default:
      return "OK";
  }
}
