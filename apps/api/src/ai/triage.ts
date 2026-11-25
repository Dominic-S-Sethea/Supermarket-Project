import { GoogleGenAI } from "@google/genai";
import { isGeminiConfigured } from "./copilot.js";

export type TriageTargetType = "cashier_anomaly" | "invoice_discrepancy" | "expiry_batch";

export interface TriageQuestionResult {
  key: string;
  label: string;
  probability: number;
  confidence: number;
  verdict: "yes" | "no";
}

export interface CalibratedTriageResult {
  model: string;
  mode: "gemini_decision" | "calibrated_local";
  targetType: TriageTargetType;
  questions: TriageQuestionResult[];
  recommendedAction: string;
  summary: string;
}

function safeNum(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function logistic(x: number, midpoint: number, steepness: number): number {
  const safeX = Number.isFinite(x) ? x : midpoint;
  const p = 1 / (1 + Math.exp(-steepness * (safeX - midpoint)));
  return Math.min(0.99, Math.max(0.01, Number(p.toFixed(3))));
}

function runLocalCalibratedTriage(
  targetType: TriageTargetType,
  metrics: Record<string, unknown>
): CalibratedTriageResult {
  if (targetType === "cashier_anomaly") {
    const voidRate = Math.max(0, safeNum(metrics.voidRatePct, 0));
    const zScore = safeNum(metrics.zScore, 0);
    const noSales = Math.max(0, safeNum(metrics.noSaleDrawerCount, 0));
    const refunds = Math.max(0, safeNum(metrics.refundCount, 0));
    const totalTx = Math.max(1, safeNum(metrics.totalSalesCount, 100));
    const cashier = String(metrics.cashierName ?? "Cashier");

    const compositeSignal = zScore * 0.8 + voidRate * 0.45 + (noSales / totalTx) * 40;
    const pAudit = logistic(compositeSignal, 2.2, 1.35);
    const pPolicy = logistic(voidRate + (refunds / totalTx) * 100, 3.8, 1.1);
    const pTraining = logistic(zScore + noSales / 25, 1.4, 1.0);

    const questions: TriageQuestionResult[] = [
      {
        key: "immediate_audit_needed",
        label: "Immediate Manager Cash & CCTV Audit Required?",
        probability: pAudit,
        confidence: Number(Math.max(pAudit, 1 - pAudit).toFixed(3)),
        verdict: pAudit >= 0.5 ? "yes" : "no",
      },
      {
        key: "likely_policy_breach",
        label: "Elevated Risk of Sweethearting / Unauthorized Drawer Opens?",
        probability: pPolicy,
        confidence: Number(Math.max(pPolicy, 1 - pPolicy).toFixed(3)),
        verdict: pPolicy >= 0.5 ? "yes" : "no",
      },
      {
        key: "pos_retraining_needed",
        label: "Cashier POS Void/Refund Retraining Recommended?",
        probability: pTraining,
        confidence: Number(Math.max(pTraining, 1 - pTraining).toFixed(3)),
        verdict: pTraining >= 0.5 ? "yes" : "no",
      },
    ];

    const recommendedAction =
      pAudit >= 0.7
        ? `Schedule immediate blind drawer reconciliation and review ${cashier}'s last 10 void/no-sale timestamps on register CCTV.`
        : pAudit >= 0.4
          ? `Place ${cashier} on 7-day supervisory watch and require manager PIN override on voids over $15.`
          : `No audit escalation required — ${cashier} operates within normal store variance.`;

    return {
      model: "calibrated-local-logistic",
      mode: "calibrated_local",
      targetType,
      questions,
      recommendedAction,
      summary: `${cashier}: P(Immediate Audit)=${Math.round(pAudit * 100)}%, P(Policy Breach)=${Math.round(pPolicy * 100)}%.`,
    };
  }

  if (targetType === "invoice_discrepancy") {
    const maxCostDelta = safeNum(metrics.maxCostDeltaPct, 0);
    const unmatchedCount = Math.max(0, safeNum(metrics.unmatchedLines, 0));
    const lineCount = Math.max(1, safeNum(metrics.lineCount, 1));
    const bonusCases = Math.max(0, safeNum(metrics.totalBonusCases, 0));

    const pMarginRisk = logistic(maxCostDelta, 8.0, 0.35);
    const pVerify = logistic(unmatchedCount * 3 + Math.max(0, maxCostDelta - 5) * 0.4, 3.0, 0.65);

    const questions: TriageQuestionResult[] = [
      {
        key: "margin_erosion_risk",
        label: "Wholesale Cost Creep Likely to Compress Retail Margin?",
        probability: pMarginRisk,
        confidence: Number(Math.max(pMarginRisk, 1 - pMarginRisk).toFixed(3)),
        verdict: pMarginRisk >= 0.5 ? "yes" : "no",
      },
      {
        key: "invoice_verification_needed",
        label: "Manual Line-by-Line Receiving Inspection Required?",
        probability: pVerify,
        confidence: Number(Math.max(pVerify, 1 - pVerify).toFixed(3)),
        verdict: pVerify >= 0.5 ? "yes" : "no",
      },
    ];

    const recommendedAction =
      pMarginRisk >= 0.6
        ? "Post GRN and immediately review triggered Margin Erosion Alerts to reprice affected SKUs."
        : unmatchedCount > 0
          ? `Verify ${unmatchedCount} of ${lineCount} line(s) manually before committing to stock ledger.`
          : `Invoice lines match catalog cleanly (${bonusCases} bonus case(s) accounted for in effective cost). Ready to post GRN.`;

    return {
      model: "calibrated-local-logistic",
      mode: "calibrated_local",
      targetType,
      questions,
      recommendedAction,
      summary: `Max unit cost delta ${maxCostDelta.toFixed(1)}% across ${lineCount} line(s); P(Margin Erosion)=${Math.round(pMarginRisk * 100)}%.`,
    };
  }

  // expiry_batch
  const daysLeft = safeNum(metrics.daysLeft, 30);
  const atRiskUsd = Math.max(0, safeNum(metrics.atRiskCostCents, 0)) / 100;
  const pMarkdown = logistic(30 - daysLeft + atRiskUsd * 0.04, 15, 0.25);
  const pSpoilage = logistic(14 - daysLeft, 4, 0.4);

  return {
    model: "calibrated-local-logistic",
    mode: "calibrated_local",
    targetType,
    questions: [
      {
        key: "immediate_markdown_needed",
        label: "Apply 30% FEFO Clearance Markdown Now?",
        probability: pMarkdown,
        confidence: Number(Math.max(pMarkdown, 1 - pMarkdown).toFixed(3)),
        verdict: pMarkdown >= 0.5 ? "yes" : "no",
      },
      {
        key: "spoilage_writeoff_risk",
        label: "High Risk of Unrecoverable Spoilage Write-Off?",
        probability: pSpoilage,
        confidence: Number(Math.max(pSpoilage, 1 - pSpoilage).toFixed(3)),
        verdict: pSpoilage >= 0.5 ? "yes" : "no",
      },
    ],
    recommendedAction:
      pSpoilage >= 0.6
        ? "Pull batch from primary shelf immediately or apply 40–50% end-cap clearance."
        : "Move batch to front-facing FEFO position and trigger 30% clearance tag.",
    summary: `${daysLeft}d remaining ($${atRiskUsd.toFixed(2)} at risk) — P(Markdown)=${Math.round(pMarkdown * 100)}%.`,
  };
}

export async function runCalibratedTriage(
  targetType: TriageTargetType,
  metrics: Record<string, unknown>
): Promise<CalibratedTriageResult> {
  const local = runLocalCalibratedTriage(targetType, metrics);

  if (!isGeminiConfigured()) {
    return local;
  }

  try {
    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY!.trim(),
      apiVersion: "v1beta",
    });

    const inputText = `SupermarketOS Triage Context (${targetType}):\n${JSON.stringify(metrics, null, 2)}`;
    const questionsPayload: Record<
      string,
      { type: "noul"; instructions: string }
    > = {};
    for (const q of local.questions) {
      questionsPayload[q.key] = {
        type: "noul",
        instructions: q.label,
      };
    }

    const decision = await ai.decisions.create({
      model: "gemini-decision-1",
      input: inputText,
      questions: questionsPayload,
    });

    const mergedQuestions: TriageQuestionResult[] = local.questions.map((q) => {
      const ans = decision.answers?.[q.key];
      if (ans && ans.type === "noul") {
        const prob = Number(ans.noul.toFixed(3));
        return {
          ...q,
          probability: prob,
          confidence: Number(ans.confidence.toFixed(3)),
          verdict: prob >= 0.5 ? "yes" : "no",
        };
      }
      return q;
    });

    return {
      ...local,
      model: "gemini-decision-1",
      mode: "gemini_decision",
      questions: mergedQuestions,
    };
  } catch {
    return local;
  }
}
