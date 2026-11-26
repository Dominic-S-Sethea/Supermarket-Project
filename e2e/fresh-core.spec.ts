import { expect, test, type Page } from "@playwright/test";

async function loginAsOwner(page: Page) {
  await page.goto("/");
  await expect(page.locator("#login-username")).toBeVisible();
  await page.fill("#login-username", "owner");
  await page.fill("#login-pin", "1111");
  await page.click("#login-submit-btn");
  await expect(page.locator("#logout-btn")).toBeVisible();
}

test.describe("Flagship Milestone 1: Fresh Produce, Meat, Deli & Bakery Core E2E", () => {
  test("weighs fresh PLU produce, decodes simulated GS1 scale barcode, and completes weighted checkout", async ({
    page,
  }) => {
    await loginAsOwner(page);
    await page.click("#nav-pos");
    await expect(page.locator("#open-plu-grid-btn")).toBeEnabled();

    // 1. Open Fresh PLU / Scale modal -> select PLU 4011 Cavendish Bananas -> add weighted line
    await page.click("#open-plu-grid-btn");
    const dialog = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(dialog).toBeVisible();
    await page.fill("#fresh-plu-search-input", "4011");
    await dialog.getByRole("button", { name: /Cavendish Bananas/i }).first().click();
    await expect(page.locator("#fresh-add-weighted-btn")).toBeEnabled();
    await page.click("#fresh-add-weighted-btn");
    await expect(dialog).toHaveCount(0);

    // 2. Open modal again -> select Butcher Ribeye Steak (PLU 20010) -> Simulate GS1 prefix-20 scale barcode
    await page.click("#open-plu-grid-btn");
    await expect(dialog).toBeVisible();
    await page.fill("#fresh-plu-search-input", "20010");
    await dialog.getByRole("button", { name: /Prime Angus Ribeye Steak/i }).first().click();
    await expect(page.locator("#fresh-simulate-scale-btn")).toBeEnabled();
    await page.click("#fresh-simulate-scale-btn");
    await expect(dialog).toHaveCount(0);

    // Verify both weighted items are in the live basket with gram/kg stock deductions
    const basket = page.locator("aside.pos-receipt-panel");
    await expect(basket).toContainText("Cavendish Bananas (Loose)");
    await expect(basket).toContainText("Prime Angus Ribeye Steak (Cut)");
    await expect(basket).toContainText("-0.500 kg stock");

    // 3. Complete Cash checkout and confirm 80mm thermal receipt synced to PostgreSQL
    await page.click("#pos-pay-cash-btn");
    await expect(page.locator(".thermal-paper")).toContainText("[SYNCED]");
    await expect(page.locator(".thermal-paper")).toContainText("0.500 kg");
  });

  test("enforces one-click Food-Safety Recall POS-Block from Catalog to POS and restores cleanly", async ({
    page,
  }) => {
    await loginAsOwner(page);
    await page.click("#nav-catalog");
    await expect(page.locator("#export-scale-plu-btn")).toBeVisible();

    await page.fill("#catalog-search-input", "PROD-4011");
    const bananaRowBtn = page.getByRole("button", { name: /Inspect Cavendish Bananas \(Loose\) \(PROD-4011\)/i });
    await expect(bananaRowBtn).toBeVisible();
    await bananaRowBtn.click();

    const drawer = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText("PLU 4011");

    // Activate recall block and wait for POS background bootstrap sync to complete
    await page.fill("#recall-reason-input", "E2E test recall advisory");
    const recallRespPromise = page.waitForResponse(
      (res) => res.url().includes("/recall") && res.request().method() === "PATCH"
    );
    const bootstrapSync = page.waitForResponse(
      (res) => res.url().includes("/api/pos/bootstrap") && res.status() === 200
    );
    await page.click("#activate-recall-btn");
    const recallResp = await recallRespPromise;
    expect(recallResp.status()).toBe(200);
    const recalledProductId = ((await recallResp.json()) as { product?: { id?: string } }).product?.id;
    await expect(drawer).toContainText("RECALLED · POS BLOCKED");
    await bootstrapSync;
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);

    try {
      // Switch to POS and attempt to ring up PLU 4011 -> blocked with food-safety alert
      await page.click("#nav-pos");
      await expect(page.locator("#pos-barcode-input")).toBeVisible();
      await page.fill("#pos-barcode-input", "4011");
      await page.locator("#pos-barcode-input").press("Enter");
      await expect(page.locator('.banner-red[role="alert"]')).toContainText(
        "FOOD-SAFETY RECALL BLOCK"
      );

      // Clear recall via Catalog UI to verify full round-trip
      await page.click("#nav-catalog");
      await page.fill("#catalog-search-input", "PROD-4011");
      const restoreBtn = page.getByRole("button", {
        name: /Inspect Cavendish Bananas \(Loose\) \(PROD-4011\)/i,
      });
      await expect(restoreBtn).toBeVisible();
      await restoreBtn.click();
      await expect(page.locator("#clear-recall-btn")).toBeVisible();
      await page.click("#clear-recall-btn");
      await expect(page.locator("#activate-recall-btn")).toBeVisible();
      await page.keyboard.press("Escape");
    } finally {
      if (recalledProductId) {
        await page.request
          .patch(`/api/products/${recalledProductId}/recall`, {
            data: { recalled: false },
          })
          .catch(() => {});
      }
    }
  });

  test("logs an in-store Bakery BOM production batch and renders it in the production ledger", async ({
    page,
  }) => {
    await loginAsOwner(page);
    await page.click("#nav-operations");
    await expect(page.locator("#ops-subtab-production")).toBeVisible();
    await page.click("#ops-subtab-production");

    await expect(page.locator("#bom-recipe-select")).toBeVisible();
    await expect(page.locator("#bom-log-batch-btn")).toBeEnabled();
    await expect(page.locator("#ops-panel-production")).toContainText("BAKE-RAW-FLOUR");

    const customLot = `E2E-BAKE-${Date.now().toString().slice(-5)}`;
    await page.fill("#bom-lot-code-input", customLot);
    await page.fill("#bom-notes-input", "Playwright E2E morning sourdough bake");
    await page.click("#bom-log-batch-btn");

    await expect(page.locator('.banner-green[role="status"]')).toContainText(customLot);
    await expect(page.locator("#ops-panel-production")).toContainText(customLot);
  });
});
