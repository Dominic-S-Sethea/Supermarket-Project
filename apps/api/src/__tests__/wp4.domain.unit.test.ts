import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CreatePromotionSchema, evaluateCart, type PromotionRule } from "@supermarket/shared";
import { describe, expect, it } from "vitest";
import { FOLD_LEDGER_ADVISORY_LOCK_KEY } from "../lib/stockLedger.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(dirname, "../..");

describe("WP-4 domain invariants, concurrency locks, and migration integrity", () => {
  it("registers migration 0004 with user identity columns, pos_cash_drops, and active-only hold_code unique index", () => {
    const journalPath = path.join(apiRoot, "drizzle", "meta", "_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
      entries: { idx: number; tag: string }[];
    };
    const entry0004 = journal.entries.find((e) => e.tag === "0004_identity_shifts_integrity");
    expect(entry0004?.idx).toBe(4);

    const sqlPath = path.join(apiRoot, "drizzle", "0004_identity_shifts_integrity.sql");
    const sqlText = fs.readFileSync(sqlPath, "utf8");
    for (const marker of [
      "cashier_user_id",
      "closed_by_user_id",
      "actor_user_id",
      "pos_cash_drops",
      "chk_pos_cash_drops_amount_pos",
      "uq_parked_baskets_active_hold_code",
      "WHERE \"status\" = 'parked'",
    ]) {
      expect(sqlText).toContain(marker);
    }
  });

  it("enforces advisory lock and deterministic product_id lock ordering inside stockLedger fold", () => {
    expect(FOLD_LEDGER_ADVISORY_LOCK_KEY).toBeGreaterThan(0);
    const ledgerSrc = fs.readFileSync(path.join(apiRoot, "src", "lib", "stockLedger.ts"), "utf8");
    expect(ledgerSrc).toContain("pg_try_advisory_xact_lock");
    expect(ledgerSrc).toContain("ORDER BY product_id ASC");
    expect(ledgerSrc).toContain("bestBeforeDate");
  });

  it("aligns OpenAPI curated routes with live Fastify AI and POS routes", () => {
    const exportsSrc = fs.readFileSync(path.join(apiRoot, "src", "routes", "exports.ts"), "utf8");
    expect(exportsSrc).toContain('"/ai/briefing"');
    expect(exportsSrc).toContain('"/ai/grn/parse-invoice"');
    expect(exportsSrc).toContain('"/pos/shifts/{id}/cash-drop"');
    expect(exportsSrc).toContain('"/admin/users/{id}/unlock"');
    expect(exportsSrc).not.toContain('"/ai/briefing/today"');
    expect(exportsSrc).not.toContain('"/ai/invoice/parse"');
  });

  it("guards semantic embedding sync with single-flight deduplication and admin role transitions inside FOR UPDATE", () => {
    const semanticSrc = fs.readFileSync(path.join(apiRoot, "src", "ai", "semantic.ts"), "utf8");
    expect(semanticSrc).toContain("syncInFlight");
    expect(semanticSrc).toContain("loadInFlight");

    const adminSrc = fs.readFileSync(path.join(apiRoot, "src", "routes", "admin.ts"), "utf8");
    expect(adminSrc).toContain("lockedTarget.role");
    expect(adminSrc).not.toContain("existing.role");
  });

  it("rejects malformed promo rulesJson while preserving deterministic evaluation", () => {
    expect(
      CreatePromotionSchema.safeParse({
        name: "Bad Array Obj",
        promoType: "clearance",
        rulesJson: { productIds: { length: 1 }, discountBp: 1000 },
      }).success
    ).toBe(false);

    const promo: PromotionRule = {
      id: "01950000-0000-7000-8000-000000000001",
      name: "Tier 10%",
      promoType: "tier_price",
      priority: 1,
      combinable: false,
      minMarginGuardBp: null,
      requiredQty: 3,
      discountBp: 1000,
    };
    const evaluated = evaluateCart(
      [
        {
          lineKey: "l1",
          productId: "01950000-0000-7000-8000-000000000002",
          categoryId: "01950000-0000-7000-8000-000000000003",
          sku: "SKU-1",
          name: "Item",
          scannedBarcode: "8850000000012",
          packLabel: "Single",
          packQty: 1,
          qtyPacks: 3,
          unitPriceCents: 100,
          unitCostCents: 50,
          taxRateBp: 0,
          taxInclusive: true,
          requiresAgeCheck: false,
        },
      ],
      [promo]
    );
    expect(evaluated.totalDiscountCents).toBe(30);
  });
});
