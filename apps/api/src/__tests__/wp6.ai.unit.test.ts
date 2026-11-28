import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AiTriageRequestSchema } from "@supermarket/shared";
import { afterEach, describe, expect, it } from "vitest";
import { raceWithTimeoutAndAbort, sanitizeGeminiError } from "../ai/copilot.js";
import { parsePlainTextInvoice } from "../ai/invoice.js";
import { MAX_PROPOSALS_PER_TURN, executeCopilotTool } from "../ai/tools.js";
import { runCalibratedTriage } from "../ai/triage.js";
import { env } from "../config/env.js";
import type { AuthUser } from "../plugins/auth.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(dirname, "../..");

const mockManager: AuthUser = {
  id: "01950000-0000-7000-8000-000000000010",
  username: "manager_test",
  fullName: "Test Manager",
  role: "manager",
};

describe("WP-6 AI copilot, safety rails, and analytics hardening", () => {
  const prevKey = process.env.GEMINI_API_KEY;

  afterEach(() => {
    if (prevKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = prevKey;
    }
  });

  it("uses configurable Gemini model names and removes speculative hardcoded model strings", () => {
    expect(env.geminiCopilotModel).toBeTruthy();
    expect(env.geminiFastModel).toBeTruthy();
    expect(env.geminiEmbedModel).toBeTruthy();
    expect(env.geminiDecisionModel).toBeTruthy();
    expect(env.geminiTimeoutMs).toBeGreaterThanOrEqual(5_000);
    expect(env.aiMaxPromoDiscountBp).toBeGreaterThanOrEqual(500);
    expect(env.aiActionTtlHours).toBeGreaterThanOrEqual(1);

    const files = [
      path.join(apiRoot, "src", "ai", "copilot.ts"),
      path.join(apiRoot, "src", "ai", "briefing.ts"),
      path.join(apiRoot, "src", "ai", "invoice.ts"),
      path.join(apiRoot, "src", "ai", "semantic.ts"),
      path.join(apiRoot, "src", "ai", "triage.ts"),
      path.join(apiRoot, "src", "routes", "ai.ts"),
    ];
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      expect(src).not.toMatch(/gemini-4-hydrogen/i);
      expect(src).not.toMatch(/Gemini 4 Hydrogen/i);
      expect(src).not.toContain('"gemini-3.5-flash-lite"');
      expect(src).not.toContain('"gemini-decision-1"');
    }
  });

  it("redacts API keys/tokens in sanitizeGeminiError and honors AbortSignal and timeout", async () => {
    const rawErr = new Error("Request failed for AIzaSyDummySecretKey1234567890?key=abc123&token=xyz999");
    const sanitized = sanitizeGeminiError(rawErr);
    expect(sanitized).not.toContain("AIzaSyDummySecretKey");
    expect(sanitized).not.toContain("abc123");
    expect(sanitized).not.toContain("xyz999");
    expect(sanitized).toContain("[REDACTED_KEY]");

    const ac = new AbortController();
    const neverResolves = new Promise<string>(() => {});
    const abortedPromise = raceWithTimeoutAndAbort(neverResolves, 10_000, ac.signal);
    ac.abort();
    await expect(abortedPromise).rejects.toMatchObject({ name: "AbortError" });

    await expect(
      raceWithTimeoutAndAbort(new Promise<string>(() => {}), 25)
    ).rejects.toThrow(/timed out/i);
  });

  it("enforces flat primitive bounded metrics in AiTriageRequestSchema and runs calibrated local triage cleanly", async () => {
    delete process.env.GEMINI_API_KEY;

    expect(
      AiTriageRequestSchema.safeParse({
        targetType: "cashier_anomaly",
        subjectId: "x".repeat(121),
        metrics: { voidRatePct: 2.1 },
      }).success
    ).toBe(false);

    expect(
      AiTriageRequestSchema.safeParse({
        targetType: "cashier_anomaly",
        metrics: { nested: { inject: true } },
      }).success
    ).toBe(false);

    const manyMetrics: Record<string, number> = {};
    for (let i = 0; i < 25; i++) manyMetrics[`k${i}`] = i;
    expect(
      AiTriageRequestSchema.safeParse({
        targetType: "cashier_anomaly",
        metrics: manyMetrics,
      }).success
    ).toBe(false);

    const res = await runCalibratedTriage("cashier_anomaly", {
      cashierName: "Alex",
      voidRatePct: 8.5,
      zScore: 5.2,
      noSaleDrawerCount: 22,
      refundCount: 5,
      totalSalesCount: 500,
    });
    expect(res.mode).toBe("calibrated_local");
    expect(res.recommendedAction.toLowerCase()).toContain("cctv");
    expect(res.questions.every((q) => Number.isFinite(q.probability))).toBe(true);
  });

  it("parses paidCases='0' in plain text invoices without coercing to 1 and stops binary OCR fabrication", () => {
    const parsed = parsePlainTextInvoice(
      "Supplier: Fresh Farms\nInvoice: INV-999\nSKU-0001 Bonus Promo | 12 | 0 | 2 | 0.00 | 2027-01-15"
    );
    const lines = parsed.lines ?? [];
    expect(lines).toHaveLength(1);
    expect(lines[0].paidCases).toBe(0);
    expect(lines[0].freeBonusCases).toBe(2);

    const invoiceSrc = fs.readFileSync(path.join(apiRoot, "src", "ai", "invoice.ts"), "utf8");
    expect(invoiceSrc).not.toContain("Summit Brewing & Beer Supply");
    expect(invoiceSrc).toContain("semanticMatchDescriptionsBatch");
  });

  it("blocks unsafe AI promotions (storewide, low margin floor, excessive discount, low bundle price) and enforces turn proposal cap", async () => {
    const baseCtx = {
      conversationId: "01950000-0000-7000-8000-000000000099",
      user: mockManager,
      proposalsCreated: 0,
    };

    const storewide = await executeCopilotTool(
      "propose_promotion",
      { name: "All Store Free", promoType: "clearance", discountBp: 1500 },
      baseCtx
    );
    expect(String(storewide.error)).toMatch(/productIds or categoryIds/i);

    const lowMargin = await executeCopilotTool(
      "propose_promotion",
      {
        name: "Unsafe Floor",
        promoType: "clearance",
        productIds: ["01950000-0000-7000-8000-000000000002"],
        discountBp: 1500,
        minMarginGuardBp: 200,
      },
      baseCtx
    );
    expect(String(lowMargin.error)).toMatch(/minMarginGuardBp/i);

    const highDiscount = await executeCopilotTool(
      "propose_promotion",
      {
        name: "Huge Discount",
        promoType: "clearance",
        productIds: ["01950000-0000-7000-8000-000000000002"],
        discountBp: 9000,
        minMarginGuardBp: 1000,
      },
      baseCtx
    );
    expect(String(highDiscount.error)).toMatch(/safety limit/i);

    const badBundle = await executeCopilotTool(
      "propose_promotion",
      {
        name: "Penny Bundle",
        promoType: "mix_and_match",
        productIds: ["01950000-0000-7000-8000-000000000002"],
        bundlePriceCents: 10,
        minMarginGuardBp: 1000,
      },
      baseCtx
    );
    expect(String(badBundle.error)).toMatch(/bundlePriceCents/i);

    const sameHourDaypart = await executeCopilotTool(
      "propose_promotion",
      {
        name: "Bad Hours",
        promoType: "clearance",
        productIds: ["01950000-0000-7000-8000-000000000002"],
        daypartStartHour: 9,
        daypartEndHour: 9,
      },
      baseCtx
    );
    expect(String(sameHourDaypart.error)).toMatch(/differ/i);

    const cappedCtx = { ...baseCtx, proposalsCreated: MAX_PROPOSALS_PER_TURN };
    const capped = await executeCopilotTool(
      "propose_price_update",
      { skuOrProductId: "BEER-0001", newSellPriceCents: 500 },
      cappedCtx
    );
    expect(String(capped.error)).toMatch(/Proposal rate limit exceeded/i);
  });

  it("hardens route TTL expiry, margin alert binding, SSE AbortController, negative-stock SQL, audit cache & DiD statistics", () => {
    const aiRouteSrc = fs.readFileSync(path.join(apiRoot, "src", "routes", "ai.ts"), "utf8");
    expect(aiRouteSrc).toContain("status: 410 as const");
    expect(aiRouteSrc).toContain("abortController.abort()");
    expect(aiRouteSrc).toContain("and(eq(marginAlerts.id, alertId), eq(marginAlerts.productId, productId))");
    expect(aiRouteSrc).toContain('app.post("/api/ai/triage", { preHandler: managerAiLimited }');

    const copilotSrc = fs.readFileSync(path.join(apiRoot, "src", "ai", "copilot.ts"), "utf8");
    expect(copilotSrc).toContain("statelessHistory");
    expect(copilotSrc).toContain("store: storeInteractions");

    const analyticsSrc = fs.readFileSync(path.join(apiRoot, "src", "routes", "analytics.ts"), "utf8");
    expect(analyticsSrc).toContain("WHERE folded = false");

    const catalogSrc = fs.readFileSync(path.join(apiRoot, "src", "routes", "catalog.ts"), "utf8");
    expect(catalogSrc).toContain("isSafeHttpsUrl");

    const adminSrc = fs.readFileSync(path.join(apiRoot, "src", "routes", "admin.ts"), "utf8");
    expect(adminSrc).toContain("auditFacetsCache");

    const shiftDidSrc = fs.readFileSync(path.join(apiRoot, "src", "lib", "shiftDid.ts"), "utf8");
    expect(shiftDidSrc).toContain("generate_series");
    expect(shiftDidSrc).toContain("pairedPre");

    const briefingSrc = fs.readFileSync(path.join(apiRoot, "src", "ai", "briefing.ts"), "utf8");
    expect(briefingSrc).toContain("<untrusted_store_data>");
    expect(briefingSrc).toContain("BriefingLlmOutputSchema.safeParse");

    const triageSrc = fs.readFileSync(path.join(apiRoot, "src", "ai", "triage.ts"), "utf8");
    expect(triageSrc).toContain("<untrusted_metrics>");
    expect(triageSrc).toContain("buildTriageNarrative");
  });
});
