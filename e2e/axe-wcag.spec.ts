import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function loginAsOwner(page: Page) {
  await page.goto("/");
  await expect(page.locator("#login-username")).toBeVisible();
  await page.fill("#login-username", "owner");
  await page.fill("#login-pin", "1111");
  await page.click("#login-submit-btn");
  await expect(page.locator("#logout-btn")).toBeVisible();
}

async function scanAxe(page: Page, label: string, bucket: Array<{ label: string; violations: unknown[] }>) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  if (results.violations.length > 0) {
    bucket.push({
      label,
      violations: results.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes.slice(0, 4).map((n) => ({
          target: n.target,
          summary: n.failureSummary,
        })),
      })),
    });
  }
}

async function settleView(page: Page) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  );
}

const ALL_NAV_TABS = [
  { id: "nav-overview", label: "Overview" },
  { id: "nav-pos", label: "POS Terminal" },
  { id: "nav-catalog", label: "Catalog" },
  { id: "nav-operations", label: "Operations" },
  { id: "nav-loyalty", label: "Loyalty & Promos" },
  { id: "nav-shift-diagnostics", label: "Shift Diagnostics" },
  { id: "nav-abc-lp", label: "ABC & Loss Prevention" },
  { id: "nav-forecasting", label: "Forecasting & Basket" },
  { id: "nav-admin", label: "Admin & Audit" },
] as const;

test.describe("SupermarketOS Automated WCAG 2.0/2.1/2.2 A/AA Gate (axe-core)", () => {
  test("login screen has zero axe-core WCAG violations across Navy, Dark, and Light themes", async ({
    page,
  }) => {
    const findings: Array<{ label: string; violations: unknown[] }> = [];
    await page.goto("/");
    await expect(page.locator("#login-username")).toBeVisible();

    for (const theme of ["navy", "dark", "light"] as const) {
      await page.click(`#theme-btn-surface-${theme}`);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await scanAxe(page, `Login (${theme})`, findings);
    }
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });

  test("all 9 routes, subtabs, modal drawers, and mobile drawer inert isolation pass axe-core in Blue-Navy", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const findings: Array<{ label: string; violations: unknown[] }> = [];
    await loginAsOwner(page);
    await page.click("#theme-btn-sidebar-navy");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "navy");

    for (const tab of ALL_NAV_TABS) {
      await page.click(`#${tab.id}`);
      await settleView(page);
      await scanAxe(page, `${tab.label} (navy)`, findings);
    }

    // Catalog Product Inspector drawer (portaled modal + background inert)
    await page.click("#nav-catalog");
    await settleView(page);
    const firstRowBtn = page.locator("button.table-row-btn").first();
    await expect(firstRowBtn).toBeVisible();
    await firstRowBtn.click();
    await expect(page.locator('[role="dialog"][aria-modal="true"]')).toBeVisible();
    await scanAxe(page, "Catalog Product Drawer (navy)", findings);
    await page.keyboard.press("Escape");
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);

    // AI Store Copilot non-modal docked side panel on desktop
    await page.click("#open-ai-copilot-btn");
    await expect(page.locator("#ai-copilot-drawer")).toBeVisible();
    await expect(page.locator("#ai-copilot-input")).toBeFocused();
    await scanAxe(page, "AI Store Copilot Docked Panel (navy)", findings);
    await page.keyboard.press("Escape");
    await expect(page.locator("#ai-copilot-drawer")).toHaveCount(0);

    // POS Fresh PLU / Scale modal (portaled dialog + background inert)
    await page.click("#nav-pos");
    await settleView(page);
    await expect(page.locator("#open-plu-grid-btn")).toBeEnabled();
    await page.click("#open-plu-grid-btn");
    await expect(page.locator('[role="dialog"][aria-modal="true"]')).toBeVisible();
    await scanAxe(page, "POS Fresh PLU Scale Modal (navy)", findings);
    await page.keyboard.press("Escape");
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);

    // Milestone 2 POS Modals: Hold/Recall, Supervisor PIN Override, and Split Tender / EMVCo QR
    await page.click("#open-parked-baskets-btn");
    await expect(page.locator('[role="dialog"][aria-modal="true"]')).toBeVisible();
    await scanAxe(page, "POS Parked Baskets Modal (navy)", findings);
    await page.keyboard.press("Escape");
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);

    await page.click("#open-supervisor-override-btn");
    await expect(page.locator('[role="dialog"][aria-modal="true"]')).toBeVisible();
    await scanAxe(page, "POS Supervisor PIN Override Modal (navy)", findings);
    await page.keyboard.press("Escape");
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);

    // Add a quick item so Split Tender / EMVCo QR Checkout modal opens
    const quickSku = page.locator("button.quick-sku-btn").last();
    await quickSku.click();
    await expect(page.locator("#pos-pay-qr-btn")).toBeEnabled();
    await page.click("#pos-pay-qr-btn");
    await expect(page.locator('[role="dialog"][aria-modal="true"]')).toBeVisible();
    await scanAxe(page, "POS EMVCo QR & Split Tender Modal (navy)", findings);
    await page.click("#checkout-tab-cash");
    await scanAxe(page, "POS Dual-Currency Cash Tab (navy)", findings);
    await page.keyboard.press("Escape");
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);

    // Operations lazy subtabs + WAI-ARIA tablist
    await page.click("#nav-operations");
    await settleView(page);
    for (const subId of [
      "ops-subtab-production",
      "ops-subtab-orders",
      "ops-subtab-shelf",
      "ops-subtab-tasks",
      "ops-subtab-suppliers",
    ]) {
      await page.click(`#${subId}`);
      await settleView(page);
      await scanAxe(page, `Operations/${subId} (navy)`, findings);
    }

    // Loyalty subtabs
    await page.click("#nav-loyalty");
    await settleView(page);
    for (const subId of ["loyalty-subtab-coupons", "loyalty-subtab-promotions"]) {
      await page.click(`#${subId}`);
      await settleView(page);
      await scanAxe(page, `Loyalty/${subId} (navy)`, findings);
    }

    // Shift Diagnostics subtabs (including hourly heatmap, DiD inputs & staffing roster)
    await page.click("#nav-shift-diagnostics");
    await settleView(page);
    for (const subId of [
      "subtab-queue",
      "subtab-missions",
      "subtab-experiments",
      "subtab-roster",
    ]) {
      await page.click(`#${subId}`);
      await settleView(page);
      await scanAxe(page, `ShiftDiagnostics/${subId} (navy)`, findings);
    }

    // Admin subtabs (including Milestone 2 Store & QR Rails Settings)
    await page.click("#nav-admin");
    await settleView(page);
    for (const subId of [
      "admin-subtab-settings",
      "admin-subtab-audit",
      "admin-subtab-reconciliation",
      "admin-subtab-pipeline",
      "admin-subtab-security",
    ]) {
      await page.click(`#${subId}`);
      await settleView(page);
      await scanAxe(page, `Admin/${subId} (navy)`, findings);
    }

    // Mobile 390px viewport: closed sidebar must be inert; Escape closes drawer and returns focus
    await page.setViewportSize({ width: 390, height: 844 });
    const sidebarInertClosed = await page
      .locator("#primary-sidebar")
      .evaluate((el) => Boolean((el as HTMLElement & { inert?: boolean }).inert));
    expect(sidebarInertClosed).toBe(true);
    await scanAxe(page, "Mobile 390px closed drawer (navy)", findings);

    const toggleBtn = page.locator("#mobile-nav-toggle-btn");
    await toggleBtn.click();
    await expect(toggleBtn).toHaveAttribute("aria-expanded", "true");
    const sidebarInertOpen = await page
      .locator("#primary-sidebar")
      .evaluate((el) => Boolean((el as HTMLElement & { inert?: boolean }).inert));
    expect(sidebarInertOpen).toBe(false);
    await scanAxe(page, "Mobile 390px open drawer (navy)", findings);

    await page.keyboard.press("Escape");
    await expect(toggleBtn).toHaveAttribute("aria-expanded", "false");
    await expect(toggleBtn).toBeFocused();

    // Mobile 390px AI Store Copilot opens as accessible modal SlideDrawer
    await page.click("#mobile-ai-copilot-btn");
    await expect(page.locator('[role="dialog"][aria-modal="true"]')).toBeVisible();
    await scanAxe(page, "AI Store Copilot Mobile Modal (navy)", findings);
    await page.keyboard.press("Escape");
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);

    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });

  test("standalone /customer-display route passes axe-core WCAG 2.2 AA across Navy, Dark, and Light themes", async ({
    page,
  }) => {
    const findings: Array<{ label: string; violations: unknown[] }> = [];
    await page.goto("/customer-display");
    await expect(page.locator("#cfd-grand-total")).toBeVisible();

    for (const theme of ["navy", "dark", "light"] as const) {
      await page.click(`#theme-btn-surface-${theme}`);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await scanAxe(page, `Customer Display (${theme})`, findings);
    }

    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });

  test("all 9 routes pass axe-core WCAG 2.2 AA in Carbon Dark and Classic Light themes", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const findings: Array<{ label: string; violations: unknown[] }> = [];
    await loginAsOwner(page);

    for (const theme of ["dark", "light"] as const) {
      await page.click(`#theme-btn-sidebar-${theme}`);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

      for (const tab of ALL_NAV_TABS) {
        await page.click(`#${tab.id}`);
        await settleView(page);
        await scanAxe(page, `${tab.label} (${theme})`, findings);
      }
    }

    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });
});
