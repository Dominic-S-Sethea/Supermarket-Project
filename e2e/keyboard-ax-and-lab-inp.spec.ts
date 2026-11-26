import { expect, test, type Page } from "@playwright/test";

interface FocusCheckResult {
  tag: string;
  id: string;
  role: string | null;
  text: string;
  hasVisibleFocus: boolean;
  outlineStyle: string;
  outlineWidth: string;
  boxShadow: string;
}

async function inspectActiveFocus(page: Page): Promise<FocusCheckResult> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) {
      return {
        tag: "NONE",
        id: "",
        role: null,
        text: "",
        hasVisibleFocus: false,
        outlineStyle: "none",
        outlineWidth: "0px",
        boxShadow: "none",
      };
    }
    const cs = window.getComputedStyle(el);
    const hasOutline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
    const hasShadow = cs.boxShadow !== "none" && cs.boxShadow.trim() !== "";
    return {
      tag: el.tagName,
      id: el.id || "",
      role: el.getAttribute("role"),
      text: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 60),
      hasVisibleFocus: hasOutline || hasShadow,
      outlineStyle: cs.outlineStyle,
      outlineWidth: cs.outlineWidth,
      boxShadow: cs.boxShadow,
    };
  });
}

async function tabUntilSelector(
  page: Page,
  selector: string,
  maxTabs = 80
): Promise<FocusCheckResult[]> {
  const visited: FocusCheckResult[] = [];
  for (let i = 0; i < maxTabs; i++) {
    await page.keyboard.press("Tab");
    const info = await inspectActiveFocus(page);
    visited.push(info);
    const matched = await page.evaluate((sel) => {
      const el = document.activeElement;
      return Boolean(el && el.matches(sel));
    }, selector);
    if (matched) return visited;
  }
  throw new Error(
    `Could not reach "${selector}" within ${maxTabs} Tab presses. Last 8 stops: ${JSON.stringify(
      visited.slice(-8)
    )}`
  );
}

test.describe("Manual-Equivalent Verification: Keyboard-Only, Chromium AX Tree & Lab INP", () => {
  test("1. Keyboard-only operability & visible focus pass (Login -> POS -> Catalog Drawer -> Operations SubTabBar -> Mobile 390px Drawer)", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(page.locator("#login-username")).toBeVisible();

    // --- A. Login purely via keyboard (Tab + type + Enter, zero mouse clicks) ---
    const loginSteps = await tabUntilSelector(page, "#login-username", 20);
    const missingLoginFocus = loginSteps.filter((s) => !s.hasVisibleFocus);
    expect(
      missingLoginFocus,
      `Elements missing visible focus ring on Login: ${JSON.stringify(missingLoginFocus)}`
    ).toEqual([]);

    await page.keyboard.type("owner");
    await page.keyboard.press("Tab");
    const pinFocus = await inspectActiveFocus(page);
    expect(pinFocus.id).toBe("login-pin");
    expect(pinFocus.hasVisibleFocus).toBe(true);
    await page.keyboard.type("1111");

    await page.keyboard.press("Tab");
    const submitFocus = await inspectActiveFocus(page);
    expect(submitFocus.id).toBe("login-submit-btn");
    expect(submitFocus.hasVisibleFocus).toBe(true);
    await page.keyboard.press("Enter");
    await expect(page.locator("main.main-content")).toBeVisible();

    // --- B. Sidebar navigation via keyboard -> POS Terminal checkout flow ---
    const toPosSteps = await tabUntilSelector(page, "#nav-pos", 30);
    const missingNavFocus = toPosSteps.filter((s) => !s.hasVisibleFocus);
    expect(
      missingNavFocus,
      `Elements missing visible focus ring in sidebar navigation: ${JSON.stringify(missingNavFocus)}`
    ).toEqual([]);
    await page.keyboard.press("Enter");
    await expect(page.locator("#pos-barcode-input")).toBeVisible();
    await expect(page.locator(".quick-sku-btn").first()).toBeVisible();

    // PosScanBar automatically focuses #pos-barcode-input when POS tab mounts
    await expect(page.locator("#pos-barcode-input")).toBeFocused();

    // Tab to a quick-scan item and press Enter to add to cart, then Tab to #pos-pay-cash-btn and complete cash sale
    const toQuickSku = await tabUntilSelector(page, ".quick-sku-btn", 25);
    expect(toQuickSku.filter((s) => !s.hasVisibleFocus)).toEqual([]);
    await page.keyboard.press("Enter");
    // If age verification modal appeared (e.g. Beer 6-Pack is first), Tab inside modal to #confirm-age-check-btn and press Enter
    const ageBtn = page.locator("#confirm-age-check-btn");
    if (await ageBtn.isVisible().catch(() => false)) {
      const toConfirmAge = await tabUntilSelector(page, "#confirm-age-check-btn", 8);
      expect(toConfirmAge.filter((s) => !s.hasVisibleFocus)).toEqual([]);
      await page.keyboard.press("Enter");
    }
    await expect(page.locator(".cart-lines")).not.toContainText("Cart is empty");

    const toCashBtn = await tabUntilSelector(page, "#pos-pay-cash-btn", 60);
    expect(toCashBtn.filter((s) => !s.hasVisibleFocus)).toEqual([]);
    await page.keyboard.press("Enter");
    await expect(page.locator(".thermal-paper")).toBeVisible();

    // --- C. Catalog Product Inspector drawer: focus move, Tab trap, background inert, Escape restore ---
    await page.locator("#nav-catalog").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("button.table-row-btn").first()).toBeVisible();

    const firstRowTrigger = page.locator("button.table-row-btn").first();
    await firstRowTrigger.focus();
    const triggerInfo = await inspectActiveFocus(page);
    expect(triggerInfo.hasVisibleFocus).toBe(true);
    await page.keyboard.press("Enter");

    const dialog = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(dialog).toBeVisible();

    // Verify background #root is marked inert + aria-hidden while dialog is open
    const rootInertWhileOpen = await page.evaluate(() => {
      const root = document.getElementById("root") as (HTMLElement & { inert?: boolean }) | null;
      return {
        inert: Boolean(root?.inert),
        ariaHidden: root?.getAttribute("aria-hidden"),
      };
    });
    expect(rootInertWhileOpen).toEqual({ inert: true, ariaHidden: "true" });

    // Wait for initial focus inside dialog and verify 15 Tab presses never escape the dialog
    await expect.poll(async () => {
      return page.evaluate(() => {
        const dlg = document.querySelector('[role="dialog"]');
        return Boolean(dlg && dlg.contains(document.activeElement));
      });
    }).toBe(true);

    for (let i = 0; i < 15; i++) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(() => {
        const dlg = document.querySelector('[role="dialog"]');
        return Boolean(dlg && dlg.contains(document.activeElement));
      });
      expect(inside, `Tab #${i + 1} escaped Catalog modal dialog!`).toBe(true);
      const info = await inspectActiveFocus(page);
      expect(info.hasVisibleFocus, `Missing focus ring inside dialog on ${JSON.stringify(info)}`).toBe(true);
    }

    // Escape closes drawer, unlocks #root, and returns focus to exact trigger button
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    const rootAfterClose = await page.evaluate(() => {
      const root = document.getElementById("root") as (HTMLElement & { inert?: boolean }) | null;
      return {
        inert: Boolean(root?.inert),
        ariaHidden: root?.getAttribute("aria-hidden"),
      };
    });
    expect(rootAfterClose).toEqual({ inert: false, ariaHidden: null });
    await expect(firstRowTrigger).toBeFocused();

    // --- D. Operations WAI-ARIA SubTabBar: roving tabIndex, ArrowRight/End/Home/ArrowLeft + Tab exit ---
    await page.locator("#nav-operations").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#ops-subtab-receiving")).toBeVisible();

    await page.locator("#ops-subtab-receiving").focus();
    expect((await inspectActiveFocus(page)).hasVisibleFocus).toBe(true);

    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#ops-subtab-production")).toBeFocused();
    await expect(page.locator("#ops-subtab-production")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('[role="tabpanel"]')).toHaveAttribute(
      "aria-labelledby",
      "ops-subtab-production"
    );

    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#ops-subtab-orders")).toBeFocused();
    await expect(page.locator("#ops-subtab-orders")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('[role="tabpanel"]')).toHaveAttribute(
      "aria-labelledby",
      "ops-subtab-orders"
    );

    await page.keyboard.press("End");
    await expect(page.locator("#ops-subtab-suppliers")).toBeFocused();
    await expect(page.locator("#ops-subtab-suppliers")).toHaveAttribute("aria-selected", "true");

    await page.keyboard.press("Home");
    await expect(page.locator("#ops-subtab-receiving")).toBeFocused();
    await expect(page.locator("#ops-subtab-receiving")).toHaveAttribute("aria-selected", "true");

    // Pressing Tab once from tablist should exit tablist immediately (not stop on inactive tabs)
    await page.keyboard.press("Tab");
    const afterTablist = await page.evaluate(() => {
      const el = document.activeElement;
      return el?.getAttribute("role");
    });
    expect(afterTablist).not.toBe("tab");

    // --- E. Mobile 390x844 Drawer: collapsed inert isolation, open focus trap, Escape focus return ---
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileToggle = page.locator("#mobile-nav-toggle-btn");
    await expect(mobileToggle).toBeVisible();

    // Tab 12 times across top of mobile page: focus must NEVER enter collapsed #primary-sidebar
    await mobileToggle.focus();
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      const inCollapsedSidebar = await page.evaluate(() => {
        const sb = document.getElementById("primary-sidebar");
        return Boolean(sb && sb.contains(document.activeElement));
      });
      expect(inCollapsedSidebar, `Tab #${i + 1} entered collapsed mobile sidebar!`).toBe(false);
    }

    // Open mobile drawer via keyboard Enter -> focus moves inside sidebar & Shift+Tab wraps inside
    await mobileToggle.focus();
    expect((await inspectActiveFocus(page)).hasVisibleFocus).toBe(true);
    await page.keyboard.press("Enter");
    await expect(mobileToggle).toHaveAttribute("aria-expanded", "true");

    await expect
      .poll(async () =>
        page.evaluate(() => {
          const sb = document.getElementById("primary-sidebar");
          return Boolean(sb && sb.contains(document.activeElement));
        })
      )
      .toBe(true);

    // Shift+Tab from first item wraps to last item inside sidebar
    await page.keyboard.press("Shift+Tab");
    const stillInsideAfterShiftTab = await page.evaluate(() => {
      const sb = document.getElementById("primary-sidebar");
      return Boolean(sb && sb.contains(document.activeElement));
    });
    expect(stillInsideAfterShiftTab).toBe(true);

    // Escape closes drawer and returns focus to #mobile-nav-toggle-btn
    await page.keyboard.press("Escape");
    await expect(mobileToggle).toHaveAttribute("aria-expanded", "false");
    await expect(mobileToggle).toBeFocused();
  });

  test("2. Chromium live Accessibility Tree inspection (CDP AX tree for dialogs, live regions, tablists, charts)", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const cdp = await page.context().newCDPSession(page);

    async function getAxNodes() {
      const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as {
        nodes: Array<{
          ignored?: boolean;
          role?: { value?: string };
          name?: { value?: string };
          properties?: Array<{ name: string; value: { value: unknown } }>;
        }>;
      };
      return nodes.filter((n) => !n.ignored);
    }

    // A. Invalid login error alert exposes live assertive alert role in AX tree
    await page.goto("/");
    await page.fill("#login-username", "nonexistent_ax_probe");
    await page.fill("#login-pin", "9999");
    await page.click("#login-submit-btn");
    await expect(page.locator('[role="alert"]')).toBeVisible();

    const loginAx = await getAxNodes();
    const alertNode = loginAx.find((n) => n.role?.value === "alert");
    expect(alertNode, "Login error banner must expose AX role 'alert'").toBeTruthy();

    // Sign in as owner
    await page.fill("#login-username", "owner");
    await page.fill("#login-pin", "1111");
    await page.click("#login-submit-btn");
    await expect(page.locator("main.main-content")).toBeVisible();

    // B. Catalog Drawer: verify background nav buttons disappear from active AX tree while modal is open
    await page.click("#nav-catalog");
    await expect(page.locator("button.table-row-btn").first()).toBeVisible();

    const beforeModalAx = await getAxNodes();
    expect(
      beforeModalAx.some((n) => n.role?.value === "button" && /Executive Overview/i.test(n.name?.value || ""))
    ).toBe(true);

    await page.locator("button.table-row-btn").first().click();
    await expect(page.locator('[role="dialog"][aria-modal="true"]')).toBeVisible();

    const duringModalAx = await getAxNodes();
    const dialogNode = duringModalAx.find((n) => n.role?.value === "dialog");
    expect(dialogNode, "Open drawer must expose AX role 'dialog'").toBeTruthy();
    expect(dialogNode?.name?.value?.trim().length).toBeGreaterThan(0);
    const modalProp = dialogNode?.properties?.find((p) => p.name === "modal");
    expect(modalProp?.value.value).toBe(true);

    // Background sidebar nav button must NOT be exposed as active node while modal is open (inert/aria-hidden)
    const bgNavExposedDuringModal = duringModalAx.some(
      (n) => n.role?.value === "button" && /Executive Overview/i.test(n.name?.value || "")
    );
    expect(bgNavExposedDuringModal).toBe(false);

    await page.keyboard.press("Escape");
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);

    // C. Operations SubTabBar AX tree: tablist + tabs with selected state + named tabpanel
    await page.click("#nav-operations");
    await expect(page.locator("#ops-subtab-receiving")).toBeVisible();
    const opsAx = await getAxNodes();
    const tablist = opsAx.find((n) => n.role?.value === "tablist");
    expect(tablist).toBeTruthy();
    const tabs = opsAx.filter((n) => n.role?.value === "tab");
    expect(tabs.length).toBe(6);
    const selectedTabs = tabs.filter(
      (t) => t.properties?.find((p) => p.name === "selected")?.value.value === true
    );
    expect(selectedTabs.length).toBe(1);
    const tabpanel = opsAx.find((n) => n.role?.value === "tabpanel");
    expect(tabpanel).toBeTruthy();
    expect(tabpanel?.name?.value).toContain("Receiving");

    // D. Shift Diagnostics HourlyFootfallChart: focusing bar exposes live status readout in AX tree
    await page.click("#nav-shift-diagnostics");
    const firstChartBar = page.locator('svg[aria-label="Hourly footfall funnel"] g[role="button"]').first();
    await expect(firstChartBar).toBeVisible();
    await firstChartBar.focus();
    await expect(page.locator('.panel-header [role="status"]')).toBeVisible();
    const chartAx = await getAxNodes();
    const statusNode = chartAx.find((n) => n.role?.value === "status");
    expect(statusNode).toBeTruthy();
  });

  test("3. Lab-only INP / Event Timing breakdown (1x unthrottled + 4x CPU throttle via CDP)", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const cdp = await page.context().newCDPSession(page);

    await page.addInitScript(() => {
      interface PerfEventTiming extends PerformanceEntry {
        processingStart: number;
        processingEnd: number;
        interactionId?: number;
      }
      (window as unknown as { __labEvents: unknown[] }).__labEvents = [];
      try {
        const obs = new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as PerfEventTiming[]) {
            if (!entry.interactionId || entry.interactionId === 0) continue;
            const inputDelay = Math.max(0, entry.processingStart - entry.startTime);
            const processingDuration = Math.max(0, entry.processingEnd - entry.processingStart);
            const presentationDelay = Math.max(
              0,
              entry.startTime + entry.duration - entry.processingEnd
            );
            (window as unknown as { __labEvents: unknown[] }).__labEvents.push({
              name: entry.name,
              interactionId: entry.interactionId,
              duration: Math.round(entry.duration * 10) / 10,
              inputDelay: Math.round(inputDelay * 10) / 10,
              processingDuration: Math.round(processingDuration * 10) / 10,
              presentationDelay: Math.round(presentationDelay * 10) / 10,
            });
          }
        });
        obs.observe({ type: "event", durationThreshold: 0, buffered: true } as PerformanceObserverInit);
      } catch {
        // Event Timing not supported
      }
    });

    await page.goto("/");
    await page.fill("#login-username", "owner");
    await page.fill("#login-pin", "1111");
    await page.click("#login-submit-btn");
    await expect(page.locator("main.main-content")).toBeVisible();

    async function runInteractionScenario(throttleRate: number) {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttleRate });
      await page.evaluate(() => {
        (window as unknown as { __labEvents: unknown[] }).__labEvents = [];
      });

      // 1. POS rapid barcode keystrokes + quick-scan add
      await page.locator("#nav-pos").click({ force: true });
      await expect(page.locator("#pos-barcode-input")).toBeVisible();
      await page.locator("#pos-barcode-input").focus();
      await page.keyboard.type("8850000000014", { delay: 15 });
      await page.keyboard.press("Enter");
      if (await page.locator('[role="dialog"]').isVisible().catch(() => false)) {
        await page.keyboard.press("Escape");
      }
      const noodleBtn = page.locator(".quick-sku-btn", { hasText: "5 for $3.95" }).first();
      if (await noodleBtn.isVisible().catch(() => false)) {
        await noodleBtn.click({ force: true });
      }
      await page.waitForTimeout(150);

      // 2. Operations lazy sub-tab switches
      await page.locator("#nav-operations").click({ force: true });
      await expect(page.locator("#ops-subtab-orders")).toBeVisible();
      await page.locator("#ops-subtab-orders").click({ force: true });
      await page.waitForTimeout(200);
      await page.locator("#ops-subtab-tasks").click({ force: true });
      await page.waitForTimeout(200);
      await page.locator("#ops-subtab-shelf").click({ force: true });
      await page.waitForTimeout(200);

      // 3. Shift Diagnostics chart keyboard focus stepping
      await page.locator("#nav-shift-diagnostics").click({ force: true });
      const bars = page.locator('svg[aria-label="Hourly footfall funnel"] g[role="button"]');
      await expect(bars.first()).toBeVisible();
      await bars.nth(0).focus();
      await bars.nth(2).focus();
      await bars.nth(4).focus();
      await page.waitForTimeout(150);

      // 4. Catalog drawer open + Escape close
      await page.locator("#nav-catalog").click({ force: true });
      await expect(page.locator("button.table-row-btn").first()).toBeVisible();
      await page.locator("button.table-row-btn").first().click({ force: true });
      await expect(page.locator('[role="dialog"]')).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator('[role="dialog"]')).toHaveCount(0);

      // 5. Theme switching (Navy -> Dark -> Light -> Navy)
      await page.locator("#theme-btn-sidebar-dark").click({ force: true });
      await page.locator("#theme-btn-sidebar-light").click({ force: true });
      await page.locator("#theme-btn-sidebar-navy").click({ force: true });
      await page.waitForTimeout(200);

      // Aggregate by interactionId (matching INP spec: max entry duration per interactionId)
      const summary = await page.evaluate(() => {
        type Ev = {
          name: string;
          interactionId: number;
          duration: number;
          inputDelay: number;
          processingDuration: number;
          presentationDelay: number;
        };
        const raw = (window as unknown as { __labEvents: Ev[] }).__labEvents;
        const byId = new Map<number, Ev>();
        for (const ev of raw) {
          const prev = byId.get(ev.interactionId);
          if (!prev || ev.duration > prev.duration) {
            byId.set(ev.interactionId, ev);
          }
        }
        const interactions = Array.from(byId.values()).sort((a, b) => b.duration - a.duration);
        const p75Idx = Math.max(0, Math.floor(interactions.length * 0.25));
        const worst = interactions[0] ?? null;
        const p75 = interactions[p75Idx] ?? null;
        return {
          count: interactions.length,
          worst,
          p75,
          top5: interactions.slice(0, 5),
        };
      });
      return summary;
    }

    const desktop1x = await runInteractionScenario(1);
    const mobile4x = await runInteractionScenario(4);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });

    console.log("LAB_INP_1X_DESKTOP:", JSON.stringify(desktop1x));
    console.log("LAB_INP_4X_THROTTLED:", JSON.stringify(mobile4x));

    expect(desktop1x.count).toBeGreaterThan(10);
    expect(mobile4x.count).toBeGreaterThan(10);
    // Lab sanity guard: desktop worst interaction should stay comfortably <= 200ms ("good" INP threshold)
    expect(desktop1x.worst!.duration).toBeLessThanOrEqual(200);
  });
});
