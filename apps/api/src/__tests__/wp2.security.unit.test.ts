import fs from "node:fs";
import path from "node:path";
import { generateUuidV7, PosSaleUploadSchema } from "@supermarket/shared";
import { afterEach, describe, expect, it } from "vitest";
import { assertSafeToSeed } from "../db/seed.js";
import {
  escapeLikePattern,
  getHourInTimezone,
  validateSoldAtBounds,
} from "../lib/helpers.js";
import {
  checkLoginLockout,
  recordFailedLogin,
  resetLoginLockouts,
  unlockUserLogin,
} from "../plugins/security.js";

describe("WP-2 security, migration 0003, lockout & POS bounds checks", () => {
  afterEach(() => {
    resetLoginLockouts();
  });

  it("refuses to run demo seed under NODE_ENV=production while allowing dev/test", () => {
    expect(() => assertSafeToSeed("production")).toThrow(/NODE_ENV=production/);
    expect(() => assertSafeToSeed("development")).not.toThrow();
    expect(() => assertSafeToSeed("test")).not.toThrow();
  });

  it("isolates per-IP brute-force lockouts from other IPs while still enforcing global threshold & unlock", () => {
    for (let i = 1; i <= 5; i++) {
      recordFailedLogin("owner", "10.0.0.1");
    }
    expect(checkLoginLockout("owner", "10.0.0.1").locked).toBe(true);
    expect(checkLoginLockout("owner", "10.0.0.2").locked).toBe(false);

    // Remaining distributed failures reach 15 -> global lock blocks IP 2 as well
    for (let i = 6; i <= 15; i++) {
      recordFailedLogin("owner", `10.0.0.${i}`);
    }
    expect(checkLoginLockout("owner", "10.0.0.2").locked).toBe(true);
    expect(checkLoginLockout("owner", "10.0.0.2").scope).toBe("global");

    // Admin unlock clears both per-IP and global lockout buckets
    unlockUserLogin("owner");
    expect(checkLoginLockout("owner", "10.0.0.1").locked).toBe(false);
    expect(checkLoginLockout("owner", "10.0.0.2").locked).toBe(false);
  });

  it("validates bounded POS soldAt timestamps and computes daypart hours in explicit store timezone", () => {
    const nowMs = Date.parse("2026-11-28T05:00:00.000Z"); // 12:00 PM in Asia/Phnom_Penh (UTC+7)
    expect(getHourInTimezone(new Date(nowMs), "Asia/Phnom_Penh")).toBe(12);
    expect(getHourInTimezone(new Date(nowMs), "UTC")).toBe(5);

    expect(validateSoldAtBounds("2026-11-28T04:59:00.000Z", nowMs, 72, 300).ok).toBe(true);
    expect(validateSoldAtBounds("2026-11-28T05:06:00.000Z", nowMs, 72, 300).ok).toBe(false);
    expect(validateSoldAtBounds("2026-11-25T04:59:00.000Z", nowMs, 72, 300).ok).toBe(false);
  });

  it("escapes LIKE/ILIKE wildcard characters and accepts supervisorOverrideId in PosSaleUploadSchema", () => {
    expect(escapeLikePattern("100%_test\\path")).toBe("100\\%\\_test\\\\path");

    const parsed = PosSaleUploadSchema.safeParse({
      id: generateUuidV7(),
      registerCode: "REG-01",
      shiftId: null,
      receiptNo: "REG-01-OV-01",
      kind: "sale",
      soldAt: new Date().toISOString(),
      supervisorOverrideId: generateUuidV7(),
      lines: [
        {
          id: generateUuidV7(),
          productId: generateUuidV7(),
          scannedBarcode: "8850000000012",
          packLabel: "Single",
          packQty: 1,
          qtyPacks: 1,
          unitPriceCents: 200,
          discountCents: 0,
          taxRateBp: 0,
          taxCents: 0,
          lineTotalCents: 200,
        },
      ],
      payments: [{ id: generateUuidV7(), method: "cash", amountCents: 200 }],
    });
    expect(parsed.success).toBe(true);
  });

  it("ships migration 0003 consolidating DB constraints, partial uniques, FK hardening & view", () => {
    const drizzleDir = path.resolve(import.meta.dirname, "../../drizzle");
    const sqlPath = path.join(drizzleDir, "0003_security_constraints_indexes.sql");
    const journalPath = path.join(drizzleDir, "meta/_journal.json");

    expect(fs.existsSync(sqlPath)).toBe(true);
    const sqlText = fs.readFileSync(sqlPath, "utf8");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
      entries: { tag: string }[];
    };

    expect(journal.entries.some((e) => e.tag === "0003_security_constraints_indexes")).toBe(true);
    for (const marker of [
      "supervisor_overrides",
      "uq_sale_payments_intent_not_null",
      "uq_sales_single_void_per_original",
      "uq_pos_shifts_open_register",
      "uq_pos_shifts_z_report_no",
      "uq_po_lines_po_product",
      "uq_lp_anomalies_cashier",
      "chk_inventory_batches_qty_nonneg",
      "v_product_live_stock",
      "ON DELETE restrict",
    ]) {
      expect(sqlText).toContain(marker);
    }
  });
});
