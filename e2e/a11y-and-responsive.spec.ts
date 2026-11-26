import { expect, test, type Page } from "@playwright/test";

async function loginAs(page: Page, username: string, pin: string) {
  await page.goto("/");
  await expect(page.locator("#login-username")).toBeVisible();
  await page.fill("#login-username", username);
  await page.fill("#login-pin", pin);
  await page.click("#login-submit-btn");
  await expect(page.locator("main.main-content")).toBeVisible();
}

test.describe("SupermarketOS Accessibility, Negative Paths, URL Sync & Mobile Responsive E2E", () => {
  test("hides demo PIN buttons in production build and displays accessible alert on invalid login", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator("#login-username")).toBeVisible();
    await expect(page.getByText(/LOCAL DEV DEMO ROLES/i)).toHaveCount(0);

    // Invalid credential negative path (use unique non-existent user to avoid affecting seeded staff lockouts)
    await page.fill("#login-username", "nonexistent_e2e_user");
    await page.fill("#login-pin", "9876");
    await page.click("#login-submit-btn");

    const alert = page.locator('[role="alert"]');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/Invalid|credentials|failed/i);
  });

  test("enforces accessible dialogs (ARIA + Escape), URL tab persistence & keyboard Catalog inspection", async ({
    page,
  }) => {
    await loginAs(page, "owner", "1111");

    // Active nav button carries aria-current="page" and URL reflects ?tab=catalog
    await page.click("#nav-catalog");
    await expect(page.locator("#nav-catalog")).toHaveAttribute("aria-current", "page");
    await expect(page).toHaveURL(/[?&]tab=catalog/);

    // Reload preserves active tab from URL
    await page.reload();
    await expect(page.locator("#nav-catalog")).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#catalog-search-input")).toBeVisible();

    // Open product inspector via keyboard-accessible row button & verify ARIA dialog + Escape close
    const firstInspectBtn = page.locator("button.table-row-btn").first();
    await expect(firstInspectBtn).toBeVisible();
    await firstInspectBtn.focus();
    await page.keyboard.press("Enter");

    const drawer = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(drawer).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);

    // Open Bulk CSV modal and verify ARIA dialog + Escape close
    await page.click("#open-csv-wizard-btn");
    await expect(page.locator('[role="dialog"][aria-modal="true"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);

    // Switch to Operations -> sub-tab URL sync (?tab=operations&sub=tasks)
    await page.click("#nav-operations");
    await page.click("#ops-subtab-tasks");
    await expect(page).toHaveURL(/[?&]tab=operations/);
    await expect(page).toHaveURL(/[?&]sub=tasks/);
  });

  test("renders collapsible mobile navigation drawer cleanly on narrow 390px viewport", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, "owner", "1111");

    const toggleBtn = page.locator("#mobile-nav-toggle-btn");
    await expect(toggleBtn).toBeVisible();
    await expect(toggleBtn).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#primary-sidebar")).toBeHidden();

    await toggleBtn.click();
    await expect(toggleBtn).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#primary-sidebar")).toHaveClass(/mobile-open/);
    await expect(page.locator("#primary-sidebar")).toBeVisible();

    await page.click("#nav-pos");
    await expect(page.locator("#primary-sidebar")).not.toHaveClass(/mobile-open/);
    await expect(page.locator("#primary-sidebar")).toBeHidden();
    await expect(page.locator("#pos-barcode-input")).toBeVisible();
  });
});
