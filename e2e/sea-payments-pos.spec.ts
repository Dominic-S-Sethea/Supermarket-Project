import { expect, test } from "@playwright/test";
import { attachErrorGuards, E2E_ORIGIN, loginAsOwner } from "./helpers";

test.describe("Flagship Milestone 2: SE Asia EMVCo QR, Dual-Currency Split Tender, CFD, Hold/Recall & Supervisor PIN", () => {
  test("completes split-tender checkout (KHQR dynamic QR + dual-currency KHR cash) while mirroring live to /customer-display", async ({
    page,
    context,
  }) => {
    const guard = attachErrorGuards(page);
    await loginAsOwner(page);
    await page.click("#nav-pos");
    await expect(page.locator("#pos-barcode-input")).toBeVisible();
    await expect(page.locator("button.quick-sku-btn").first()).toBeVisible();

    // Open standalone Customer-Facing Display in a second tab (no login required)
    const cfdPage = await context.newPage();
    await cfdPage.goto("/customer-display");
    await expect(cfdPage.locator("#cfd-grand-total")).toBeVisible();

    // Ring up 2 non-age-restricted quick items so grand total is well above $2.00
    const quickBtns = page.locator("button.quick-sku-btn");
    const lastBtn = quickBtns.last();
    const secondLastBtn = quickBtns.nth((await quickBtns.count()) - 2);
    await lastBtn.click();
    await lastBtn.click();
    await secondLastBtn.click();

    await expect(page.locator("#pos-secondary-total")).toContainText("KHR");
    await expect(page.locator("#pos-pay-qr-btn")).toBeEnabled();

    // Customer Display mirrors basket lines & dual-currency KHR total live via BroadcastChannel
    await expect(cfdPage.locator("#cfd-secondary-total")).toContainText("៛");
    await expect(cfdPage.locator("table.data-table tbody tr").first()).toBeVisible();

    // Open EMVCo QR / Split Tender modal and generate a partial $1.00 KHQR dynamic QR
    await page.click("#pos-pay-qr-btn");
    const modal = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(modal).toBeVisible();

    await page.fill("#qr-amount-input", "1.00");
    await page.click("#qr-generate-btn");

    // Crisp SVG QR renders in POS modal AND mirrors live on /customer-display
    await expect(modal.locator('svg[role="img"]')).toBeVisible();
    await expect(cfdPage.locator('#cfd-qr-section svg[role="img"]')).toBeVisible();

    // Simulate bank settlement in sandbox -> KHQR leg locks as PAID
    await page.click("#qr-simulate-settle-btn");
    await expect(modal).toContainText("PAID");
    await expect(modal).toContainText("KHQR");

    // Pay the remaining balance using Dual-Currency KHR cash (0 USD + 100,000 KHR)
    await page.click("#checkout-tab-cash");
    await page.fill("#split-cash-primary-input", "0");
    await page.fill("#split-cash-secondary-input", "100000");
    await page.click("#split-add-cash-btn");

    // Finalize split-tender sale -> receipt syncs to PostgreSQL and /customer-display confirms payment
    await expect(page.locator("#finalize-split-sale-btn")).toBeEnabled();
    await page.click("#finalize-split-sale-btn");
    await expect(modal).toHaveCount(0);

    const receipt = page.locator(".thermal-paper");
    await expect(receipt).toContainText("[SYNCED]");
    await expect(receipt).toContainText("KHQR");
    await expect(receipt).toContainText("CASH");
    await expect(receipt).toContainText("៛");

    await expect(cfdPage.locator("#cfd-paid-banner")).toContainText("Payment Complete");
    await cfdPage.close();
    guard.assertClean();
  });

  test("parks an active basket via Hold/Recall and restores all items cleanly", async ({ page }) => {
    const guard = attachErrorGuards(page);
    await loginAsOwner(page);
    await page.click("#nav-pos");
    await expect(page.locator("button.quick-sku-btn").last()).toBeVisible();

    const targetItem = page.locator("button.quick-sku-btn").last();
    const targetName = (await targetItem.locator(".quick-sku-name").textContent())?.trim() ?? "";
    expect(targetName.length).toBeGreaterThan(2);
    await targetItem.click();

    const basketPanel = page.locator("aside.pos-receipt-panel");
    await expect(basketPanel).toContainText(targetName);

    // Park basket with shopper label
    const holdLabel = `E2E Shopper ${Date.now().toString().slice(-4)}`;
    await page.click("#open-parked-baskets-btn");
    const modal = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(modal).toBeVisible();
    await page.fill("#park-customer-label-input", holdLabel);
    await page.fill("#park-note-input", "Chilled bag held at lane 1");
    await page.click("#confirm-park-basket-btn");
    await expect(modal).toHaveCount(0);

    // Basket is now empty
    await expect(basketPanel).toContainText("Scan a barcode or tap a quick-test SKU");

    // Reopen Hold/Recall modal and recall the parked basket
    await page.click("#open-parked-baskets-btn");
    await expect(modal).toBeVisible();
    const row = modal.locator("tbody tr", { hasText: holdLabel }).first();
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: /Recall/i }).click();
    await expect(modal).toHaveCount(0);

    // Original item restored intact
    await expect(basketPanel).toContainText(targetName);
    guard.assertClean();
  });

  test("verifies in-lane Supervisor PIN override without signing out cashier and updates Flagship Store Settings FX rate", async ({
    page,
  }) => {
    const guard = attachErrorGuards(page, {
      allowApiErrors: [
        { method: "POST", pathIncludes: "/api/auth/verify-override", status: 401 },
        { method: "POST", pathIncludes: "/api/pos/supervisor-override", status: 401 },
      ],
    });
    await loginAsOwner(page);
    await page.click("#nav-pos");
    await expect(page.locator("#open-supervisor-override-btn")).toBeVisible();

    // 1. Wrong supervisor PIN shows inline alert WITHOUT logging out active session
    await page.click("#open-supervisor-override-btn");
    const modal = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(modal).toBeVisible();
    await page.fill("#override-username-input", "manager");
    await page.fill("#override-pin-input", "0000");
    await page.fill("#override-reason-input", "E2E wrong PIN check");
    await page.click("#submit-supervisor-override-btn");
    await expect(modal.locator('.banner-red[role="alert"]')).toBeVisible();
    await expect(page.locator("#logout-btn")).toBeVisible();

    // 2. Valid manager PIN authorizes No-Sale drawer with immutable dual-actor audit confirmation
    await page.fill("#override-pin-input", "9999");
    await page.fill("#override-reason-input", "E2E change break drawer kick");
    await page.click("#submit-supervisor-override-btn");
    await expect(modal).toHaveCount(0);
    await expect(page.locator("#supervisor-override-banner")).toContainText("NO SALE DRAWER");
    await expect(page.locator("#supervisor-override-banner")).toContainText("Priya Patel");

    // 3. Update Flagship Store Settings FX rate -> verify live POS propagation -> restore cleanly
    await page.click("#nav-admin");
    await expect(page.locator("#admin-subtab-settings")).toBeVisible();
    await page.click("#admin-subtab-settings");
    await expect(page.locator("#settings-fx-rate")).toBeVisible();

    const originalFx = await page.locator("#settings-fx-rate").inputValue();
    try {
      const nextFx = originalFx === "4150" ? "4100" : "4150";
      await page.fill("#settings-fx-rate", nextFx);
      const bootstrapSync = page.waitForResponse(
        (res) => res.url().includes("/api/pos/bootstrap") && res.status() === 200
      );
      await page.click("#save-store-settings-btn");
      await expect(page.locator("#store-settings-saved-banner")).toContainText(
        Number(nextFx).toLocaleString()
      );
      await bootstrapSync;

      await page.click("#nav-pos");
      await expect(page.locator("#pos-secondary-total")).toContainText(
        Number(nextFx).toLocaleString()
      );
    } finally {
      const res = await page.request.patch("/api/store-settings", {
        headers: { Origin: E2E_ORIGIN },
        data: { secondaryFxRate: Number(originalFx) || 4100 },
      });
      expect(res.ok(), `Store settings FX cleanup failed with HTTP ${res.status()}`).toBeTruthy();
    }
    guard.assertClean();
  });
});
