import { GoogleGenAI } from "@google/genai";
import { formatBp, formatMoney } from "@supermarket/shared";
import { desc, eq, sql } from "drizzle-orm";
import {
  aiBriefings,
  analyticsDemandForecasts,
  analyticsLpAnomalies,
  analyticsShiftDiagnostics,
  db,
  inventoryBatches,
  marginAlerts,
  products,
} from "../db/index.js";
import { isGeminiConfigured } from "./copilot.js";

export interface BriefingBullet {
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
  metric: string;
  targetTab: "operations" | "forecasting" | "abc-lp" | "catalog";
}

export interface DailyBriefingResult {
  briefingDate: string;
  headline: string;
  bullets: BriefingBullet[];
  model: string;
  generatedAt: string;
  cached: boolean;
}

export async function getOrCreateDailyBriefing(
  forceRefresh = false
): Promise<DailyBriefingResult> {
  const today = new Date().toISOString().slice(0, 10);

  if (!forceRefresh) {
    const [existing] = await db
      .select()
      .from(aiBriefings)
      .where(eq(aiBriefings.briefingDate, today))
      .limit(1);
    if (existing) {
      return {
        briefingDate: existing.briefingDate,
        headline: existing.headline,
        bullets: (existing.bulletsJson as BriefingBullet[]) ?? [],
        model: existing.model,
        generatedAt: existing.generatedAt.toISOString(),
        cached: true,
      };
    }
  }

  const cutoff30 = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);

  const [kpiRes, criticalForecasts, expiringBatches, openMargins, lpRows, shiftDiagRows] = await Promise.all([
    db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE kind = 'sale')::int AS receipt_count,
        COALESCE(SUM(total_cents - tax_cents) FILTER (WHERE kind = 'sale'), 0)::bigint AS net_sales_cents,
        COALESCE(SUM(total_cost_cents) FILTER (WHERE kind = 'sale'), 0)::bigint AS cogs_cents
      FROM sales
      WHERE sold_at >= now() - interval '30 days'
    `),
    db
      .select({
        sku: products.sku,
        name: products.name,
        currentStock: analyticsDemandForecasts.currentStockUnits,
        suggestedCases: analyticsDemandForecasts.suggestedOrderCases,
        supplierName: analyticsDemandForecasts.supplierName,
      })
      .from(analyticsDemandForecasts)
      .innerJoin(products, eq(analyticsDemandForecasts.productId, products.id))
      .where(eq(analyticsDemandForecasts.urgency, "critical"))
      .orderBy(desc(analyticsDemandForecasts.estimatedOrderCostCents))
      .limit(15),
    db
      .select({
        sku: products.sku,
        name: products.name,
        bestBeforeDate: inventoryBatches.bestBeforeDate,
        qtyRemaining: inventoryBatches.qtyRemaining,
        unitCostCents: inventoryBatches.unitCostCents,
      })
      .from(inventoryBatches)
      .innerJoin(products, eq(inventoryBatches.productId, products.id))
      .where(
        sql`${inventoryBatches.bestBeforeDate} <= ${cutoff30} AND ${inventoryBatches.qtyRemaining} > 0 AND ${inventoryBatches.status} IN ('active', 'clearance')`
      )
      .orderBy(sql`${inventoryBatches.bestBeforeDate} ASC`)
      .limit(50),
    db
      .select({
        sku: products.sku,
        name: products.name,
        resultingMarginBp: marginAlerts.resultingMarginBp,
        minMarginBp: marginAlerts.minMarginBp,
        suggestedSellPriceCents: marginAlerts.suggestedSellPriceCents,
      })
      .from(marginAlerts)
      .innerJoin(products, eq(marginAlerts.productId, products.id))
      .where(eq(marginAlerts.resolved, false))
      .orderBy(desc(marginAlerts.createdAt))
      .limit(20),
    db
      .select()
      .from(analyticsLpAnomalies)
      .orderBy(desc(analyticsLpAnomalies.zScore)),
    db
      .select()
      .from(analyticsShiftDiagnostics)
      .where(eq(analyticsShiftDiagnostics.id, "latest_60d"))
      .limit(1),
  ]);

  const k = kpiRes.rows[0] as Record<string, unknown>;
  const netSalesCents = Number(k.net_sales_cents ?? 0);
  const cogsCents = Number(k.cogs_cents ?? 0);
  const marginBp =
    netSalesCents > 0 ? Math.round(((netSalesCents - cogsCents) * 10000) / netSalesCents) : 0;

  const atRiskCents = expiringBatches.reduce(
    (s, b) => s + b.qtyRemaining * b.unitCostCents,
    0
  );
  const flaggedCashiers = lpRows.filter((c) => c.riskLevel !== "normal");

  const bullets: BriefingBullet[] = [
    {
      severity: criticalForecasts.length > 0 ? "critical" : "info",
      title: "Critical Stockout & Reorder Queue",
      detail:
        criticalForecasts.length > 0
          ? `${criticalForecasts.length} fast-moving SKU(s) face immediate stockout — lead item ${criticalForecasts[0].sku} (${criticalForecasts[0].name}, ${criticalForecasts[0].currentStock} units left, order ${criticalForecasts[0].suggestedCases} cs from ${criticalForecasts[0].supplierName}).`
          : "Zero critical stockout alerts across the active catalog.",
      metric: `${criticalForecasts.length} critical`,
      targetTab: "forecasting",
    },
    {
      severity: openMargins.length > 0 ? "warning" : "info",
      title: "Vendor Cost-Hike Margin Protection",
      detail:
        openMargins.length > 0
          ? `${openMargins.length} SKU(s) fell below category net margin floor after recent GRNs — ${openMargins[0].sku} (${openMargins[0].name}) compressed to ${formatBp(openMargins[0].resultingMarginBp)} vs ${formatBp(openMargins[0].minMarginBp)} floor.`
          : "All SKU retail prices satisfy category net margin floors.",
      metric: `${openMargins.length} open alert(s)`,
      targetTab: "operations",
    },
    {
      severity: expiringBatches.length > 0 ? "warning" : "info",
      title: "30-Day FEFO Best-Before Exposure",
      detail:
        expiringBatches.length > 0
          ? `${expiringBatches.length} active batch(es) totaling ${formatMoney(atRiskCents)} at cost expire within 30 days — earliest ${expiringBatches[0].sku} (${expiringBatches[0].bestBeforeDate}).`
          : "No active shelf batches expire within the next 30 days.",
      metric: formatMoney(atRiskCents),
      targetTab: "operations",
    },
    {
      severity: flaggedCashiers.some((c) => c.riskLevel === "high") ? "critical" : "info",
      title: "Cashier Loss-Prevention Triage",
      detail:
        flaggedCashiers.length > 0
          ? `${flaggedCashiers.length} cashier(s) flagged by robust MAD Z-score — ${flaggedCashiers[0].cashierName} at ${flaggedCashiers[0].voidRatePct}% void rate (${flaggedCashiers[0].noSaleDrawerCount} no-sale drawer opens, Z=${flaggedCashiers[0].zScore}).`
          : "All cashier void, refund, and drawer open metrics are within normal baselines.",
      metric: `${flaggedCashiers.length} flagged`,
      targetTab: "abc-lp",
    },
  ];

  const shiftDiag = shiftDiagRows[0];
  const shiftSnippet = shiftDiag
    ? ` Morning conv ${shiftDiag.morningConversionPct}% vs Afternoon ${shiftDiag.afternoonConversionPct}% (${formatMoney(Number(shiftDiag.morningEstLostRevenueCents))} 08:00 OOS loss).`
    : "";

  let headline = `Store 30d net sales ${formatMoney(netSalesCents)} (${formatBp(marginBp)} net margin) · ${criticalForecasts.length} stockouts, ${openMargins.length} margin alerts, ${formatMoney(atRiskCents)} FEFO exposure.${shiftSnippet}`;
  let model = "local-briefing-digest";

  if (isGeminiConfigured()) {
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!.trim() });
      const prompt = `Write a crisp 1-sentence executive morning headline (max 28 words) summarizing today's supermarket status from these exact facts, plus tighten the 4 bullet details without inventing numbers. Return ONLY valid JSON: {"headline":"...","details":["...","...","...","..."]}.\nFacts:\n- 30d Net Sales: ${formatMoney(netSalesCents)}, Net Margin: ${formatBp(marginBp)}, Receipts: ${k.receipt_count}\n- Bullets: ${JSON.stringify(bullets.map((b) => ({ title: b.title, detail: b.detail })))}`;
      const interaction = await ai.interactions.create({
        model: "gemini-3.5-flash-lite",
        input: prompt,
        store: false,
      });
      const text = interaction.output_text?.trim() ?? "";
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as { headline?: string; details?: string[] };
        if (parsed.headline) headline = parsed.headline;
        if (Array.isArray(parsed.details)) {
          parsed.details.forEach((d, idx) => {
            if (typeof d === "string" && d.trim() && bullets[idx]) {
              bullets[idx].detail = d.trim();
            }
          });
        }
        model = "gemini-3.5-flash-lite";
      }
    } catch {
      // Fall back cleanly to deterministic headline & bullets
    }
  }

  const [saved] = await db
    .insert(aiBriefings)
    .values({
      briefingDate: today,
      headline,
      bulletsJson: bullets,
      model,
    })
    .onConflictDoUpdate({
      target: aiBriefings.briefingDate,
      set: {
        headline,
        bulletsJson: bullets,
        model,
        generatedAt: new Date(),
      },
    })
    .returning();

  return {
    briefingDate: saved.briefingDate,
    headline: saved.headline,
    bullets: saved.bulletsJson as BriefingBullet[],
    model: saved.model,
    generatedAt: saved.generatedAt.toISOString(),
    cached: false,
  };
}
