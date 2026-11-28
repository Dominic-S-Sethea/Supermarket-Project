import { expect, test } from "@playwright/test";
import { attachErrorGuards, loginAs, logout } from "./helpers";

test.describe("SupermarketOS Full-Stack E2E Smoke Suite", () => {
  test("1. enforces RBAC login & sidebar tab isolation across owner, manager, cashier1, and clerk1", async ({
    page,
  }) => {
    const guard = attachErrorGuards(page);

    // Owner: sees all 9 tabs + AI Copilot
    await loginAs(page, "owner", "1111");
    await expect(page.locator("#open-ai-copilot-btn")).toBeVisible();
    for (const id of [
      "#nav-overview",
      "#nav-pos",
      "#nav-catalog",
      "#nav-operations",
      "#nav-loyalty",
      "#nav-shift-diagnostics",
      "#nav-abc-lp",
      "#nav-forecasting",
      "#nav-admin",
    ]) {
      await expect(page.locator(id)).toBeVisible();
    }
    await logout(page);

    // Manager: sees all 9 tabs + AI Copilot
    await loginAs(page, "manager", "9999");
    await expect(page.locator("#open-ai-copilot-btn")).toBeVisible();
    await expect(page.locator("#nav-operations")).toBeVisible();
    await expect(page.locator("#nav-loyalty")).toBeVisible();
    await expect(page.locator("#nav-admin")).toBeVisible();
    await logout(page);

    // Accountant: sees Overview, Loyalty, Shift Diagnostics, ABC-LP, Forecasting & Governance (NO POS/Catalog/Ops/AI/Staff Users)
    await loginAs(page, "accountant", "4444");
    await expect(page.locator("#nav-overview")).toBeVisible();
    await expect(page.locator("#nav-admin")).toBeVisible();
    await expect(page.locator("#nav-pos")).toHaveCount(0);
    await expect(page.locator("#nav-catalog")).toHaveCount(0);
    await expect(page.locator("#nav-operations")).toHaveCount(0);
    await expect(page.locator("#open-ai-copilot-btn")).toHaveCount(0);
    await page.click("#nav-admin");
    await expect(page.locator("#admin-subtab-audit")).toBeVisible();
    await expect(page.locator("#admin-subtab-reconciliation")).toBeVisible();
    await expect(page.locator("#admin-subtab-pipeline")).toBeVisible();
    await expect(page.locator("#admin-subtab-users")).toHaveCount(0);
    await logout(page);

    // Cashier: strictly POS + Catalog, NO Operations / Overview / Loyalty / Admin / AI Copilot
    await loginAs(page, "cashier1", "1234");
    await expect(page.locator("#nav-pos")).toBeVisible();
    await expect(page.locator("#nav-catalog")).toBeVisible();
    await expect(page.locator("#nav-overview")).toHaveCount(0);
    await expect(page.locator("#nav-operations")).toHaveCount(0);
    await expect(page.locator("#nav-loyalty")).toHaveCount(0);
    await expect(page.locator("#nav-admin")).toHaveCount(0);
    await expect(page.locator("#open-ai-copilot-btn")).toHaveCount(0);
    await logout(page);

    // Stock Clerk: strictly Catalog + Operations (incl. Shelf Integrity & Floor Tasks), NO POS / Overview / Admin / AI Copilot
    await loginAs(page, "clerk1", "2222");
    await expect(page.locator("#nav-catalog")).toBeVisible();
    await expect(page.locator("#nav-operations")).toBeVisible();
    await expect(page.locator("#nav-pos")).toHaveCount(0);
    await expect(page.locator("#nav-overview")).toHaveCount(0);
    await expect(page.locator("#nav-admin")).toHaveCount(0);
    await expect(page.locator("#open-ai-copilot-btn")).toHaveCount(0);
    await page.click("#nav-operations");
    await expect(page.locator("#ops-subtab-shelf")).toBeVisible();
    await expect(page.locator("#ops-subtab-tasks")).toBeVisible();
    await expect(page.locator("#ops-subtab-suppliers")).toHaveCount(0);
    await expect(page.locator("#ops-subtab-orders")).toHaveCount(0);
    await logout(page);

    guard.assertClean();
  });

  test("2. POS multi-UOM scan, promo trigger, 18+ age check, offline outage queue, reconnect sync & receipts modal", async ({
    page,
  }) => {
    const guard = attachErrorGuards(page);
    await loginAs(page, "owner", "1111");
    await page.click("#nav-pos");

    // Wait for POS bootstrap quick-scan items to hydrate
    const noodleBtn = page.locator(".quick-sku-btn", { hasText: "5 for $3.95" }).first();
    await expect(noodleBtn).toBeVisible();

    // Tap 5x noodles -> triggers Mix & Match promo
    for (let i = 0; i < 5; i++) {
      await noodleBtn.click();
    }
    await expect(page.locator(".cart-lines")).toContainText("-5 stock");

    // Tap age-restricted Beer 6-pack -> opens Age Verification modal -> verify ID
    const beerBtn = page.locator(".quick-sku-btn", { hasText: "Beer 6-Pack" }).first();
    await beerBtn.click();
    await expect(page.locator("#confirm-age-check-btn")).toBeVisible();
    await page.click("#confirm-age-check-btn");
    await expect(page.locator(".pos-receipt-panel")).toContainText("Alcohol Age Check Verified");

    // Simulate Internet Outage -> complete cash sale offline -> queued locally
    await page.click("#toggle-offline-sim-btn");
    await expect(page.locator("#toggle-offline-sim-btn")).toContainText("Offline Mode Active");
    await page.click("#pos-pay-cash-btn");
    await expect(page.locator(".thermal-paper")).toContainText("[OFFLINE QUEUED]");

    // Reconnect internet -> auto-flushes offline queue idempotently to PostgreSQL
    await page.click("#toggle-offline-sim-btn");
    await expect(page.locator(".banner-green")).toContainText("Idempotently synced 1 queued receipt");

    // Open Recent Receipts modal and verify receipts load cleanly
    await page.click("#recent-receipts-btn");
    await expect(page.locator(".modal")).toContainText("Recent POS Receipts");
    await expect(page.locator(".modal tbody tr").first()).toBeVisible();
    await page.keyboard.press("Escape");

    await logout(page);
    guard.assertClean();
  });

  test("3. Catalog search, Semantic AI Search toggle & Multi-UOM barcode drawer", async ({
    page,
  }) => {
    const guard = attachErrorGuards(page);
    await loginAs(page, "owner", "1111");
    await page.click("#nav-catalog");

    // Wait for 3,120+ catalog table to load
    await expect(page.locator("tbody tr").first()).toBeVisible();
    await page.fill("#catalog-search-input", "Heineken");
    await expect(page.locator("tbody")).toContainText("Heineken");

    // Toggle Semantic AI Search
    await page.click("#toggle-semantic-search-btn");
    await expect(page.locator("#toggle-semantic-search-btn")).toContainText("Semantic AI: ON");
    await page.fill("#catalog-search-input", "cold beer six pack");
    await expect(page.locator("tbody tr").first()).toBeVisible();

    // Open Multi-UOM Barcode Drawer by clicking first product row
    await page.locator("tbody tr").first().click();
    await expect(page.locator(".drawer")).toBeVisible();
    await expect(page.locator(".drawer")).toContainText("Multi-UOM");
    await page.keyboard.press("Escape");

    await logout(page);
    guard.assertClean();
  });

  test("4. Milestone 1-3 workflows: Supplier OTIF & Variances, Shelf Integrity & ZPL Queue, Floor Tasks, Loyalty & Roster", async ({
    page,
  }) => {
    const guard = attachErrorGuards(page);
    await loginAs(page, "owner", "1111");

    // Operations -> Receiving & FEFO, Shelf Integrity & 07:30 Tags, Daily Floor Tasks, Supplier OTIF
    await page.click("#nav-operations");
    await expect(page.locator("#ops-subtab-shelf")).toBeVisible();

    await page.click("#ops-subtab-shelf");
    await expect(page.locator("text=07:30 Shelf Tag Batch ZPL Print Queue")).toBeVisible();
    await expect(page.locator("text=Dynamic FEFO Markdown Optimizer")).toBeVisible();
    await expect(page.locator("text=Phantom Stock Detector")).toBeVisible();

    await page.click("#ops-subtab-tasks");
    await expect(page.locator("text=Daily Floor Operations Checklist")).toBeVisible();
    await expect(page.locator("tbody tr").first()).toBeVisible();

    await page.click("#ops-subtab-suppliers");
    await expect(page.locator("text=90-Day Supplier OTIF")).toBeVisible();
    await expect(page.locator("text=3-Way Dock Variance Queue")).toBeVisible();
    await expect(page.locator("tbody tr").first()).toBeVisible();

    // Loyalty & Promos tab -> Customers, Coupons, Promotions
    await page.click("#nav-loyalty");
    await expect(page.locator("text=RFM Loyalty Directory")).toBeVisible();
    await expect(page.locator("tbody tr").first()).toBeVisible();

    await page.click("#loyalty-subtab-coupons");
    await expect(page.locator("text=Targeted Single-Use Coupons")).toBeVisible();

    await page.click("#loyalty-subtab-promotions");
    await expect(page.locator("text=Active & Daypart POS Promotions")).toBeVisible();
    await expect(page.locator("tbody tr").first()).toBeVisible();

    // Shift Diagnostics -> Hourly Lane Staffing Roster
    await page.click("#nav-shift-diagnostics");
    await expect(page.locator("#subtab-roster")).toBeVisible();
    await page.click("#subtab-roster");
    await expect(page.locator("text=Hourly Checkout Lane Staffing Roster")).toBeVisible();
    await expect(page.locator("tbody tr").first()).toBeVisible();

    // ABC-XYZ & Loss Prevention + Forecasting tabs load cleanly
    await page.click("#nav-abc-lp");
    await expect(page.locator("tbody tr").first()).toBeVisible();

    await page.click("#nav-forecasting");
    await expect(page.locator("tbody tr").first()).toBeVisible();

    await logout(page);
    guard.assertClean();
  });

  test("5. AI Store Copilot SSE streaming with M1-M3 tools & Human-in-the-Loop proposal card", async ({
    page,
  }) => {
    const guard = attachErrorGuards(page);
    await loginAs(page, "owner", "1111");

    await page.click("#open-ai-copilot-btn");
    await expect(page.locator("#ai-copilot-input")).toBeVisible();

    // Stream M1-M3 tools query
    await page.fill(
      "#ai-copilot-input",
      "Show supplier OTIF scorecards and phantom stock alerts"
    );
    await page.click("#ai-copilot-send-btn");
    await expect(page.locator(".ai-bubble.assistant").last()).toContainText(
      "Supplier 90-Day OTIF Scorecards",
      { timeout: 15_000 }
    );
    await expect(page.locator(".ai-bubble.assistant").last()).toContainText(
      "get_supplier_scorecards"
    );

    // Stream PO proposal query -> verifies Human-in-the-Loop approval card renders
    await page.fill(
      "#ai-copilot-input",
      "Draft an urgent supplier Purchase Order for critical stockouts"
    );
    await page.click("#ai-copilot-send-btn");
    await expect(page.locator(".ai-action-card").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".ai-action-card").first()).toContainText("PENDING");

    await page.keyboard.press("Escape");
    await logout(page);
    guard.assertClean();
  });

  test("6. Wave 2 Governance & Audit Explorer: Staff Users, Audit Log, Z-Reports/Exports & 12-Check ML Pipeline Health", async ({
    page,
  }) => {
    const guard = attachErrorGuards(page);
    await loginAs(page, "owner", "1111");

    await page.click("#nav-admin");
    await expect(page.locator("#admin-subtab-users")).toBeVisible();
    await expect(page.locator("text=Staff Accounts & Active Sessions")).toBeVisible();
    await expect(page.locator("tbody")).toContainText("@accountant");
    await expect(page.locator("tbody")).toContainText("@owner");

    // Immutable Audit Log tab
    await page.click("#admin-subtab-audit");
    await expect(page.locator("text=Immutable Compliance Audit Trail")).toBeVisible();
    await expect(page.locator("#audit-search-input")).toBeVisible();

    // Z-Report Reconciliation & 5 Formula-Safe Exports + OpenAPI 3.1 link
    await page.click("#admin-subtab-reconciliation");
    await expect(page.locator("text=Formula-Safe ERP CSV Exports")).toBeVisible();
    await expect(page.locator("#export-valuation-csv")).toBeVisible();
    await expect(page.locator("#openapi-spec-link")).toBeVisible();

    // ML Pipeline Health & 12-Check Data-Quality Contract Matrix
    await page.click("#admin-subtab-pipeline");
    await expect(page.locator("text=12-Check Data-Quality Contract Matrix")).toBeVisible();
    await expect(page.locator("text=12 / 12")).toBeVisible();
    await expect(page.locator("text=abc_xyz_non_empty")).toBeVisible();

    // My PIN Security tab
    await page.click("#admin-subtab-security");
    await expect(page.locator("#rotate-pin-btn")).toBeVisible();

    await logout(page);
    guard.assertClean();
  });

  test("7. Wave 2 Purchase Orders Workbench & 60-Day Promotion ROI Attribution", async ({
    page,
  }) => {
    const guard = attachErrorGuards(page);
    await loginAs(page, "owner", "1111");

    // Operations -> Purchase Orders Workbench
    await page.click("#nav-operations");
    await expect(page.locator("#ops-subtab-orders")).toBeVisible();
    await page.click("#ops-subtab-orders");
    await expect(page.locator("text=Purchase Order Register")).toBeVisible();
    await expect(page.locator("#po-status-filter")).toBeVisible();

    // Loyalty & Promos -> Promotions -> 60-Day Promo ROI Attribution table
    await page.click("#nav-loyalty");
    await page.click("#loyalty-subtab-promotions");
    await expect(page.locator("#promo-roi-panel")).toBeVisible();
    await expect(page.locator("#promo-roi-panel tbody tr").first()).toBeVisible();

    await logout(page);
    guard.assertClean();
  });
});
