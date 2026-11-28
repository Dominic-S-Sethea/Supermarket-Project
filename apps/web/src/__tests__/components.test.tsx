import { useRef, useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModalDialog, SlideDrawer } from "../components/AccessibleDialog";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { HourlyFootfallChart } from "../components/HourlyFootfallChart";
import { LoginScreen } from "../components/LoginScreen";
import {
  RecentReceiptsModal,
  ShiftCloseModal,
} from "../components/PosModals";
import { PosScanBar } from "../components/PosScanBar";
import { SalesTrendChart } from "../components/SalesTrendChart";
import { SubTabBar } from "../components/SubTabBar";
import { ThemeSwitcher } from "../components/ThemeSwitcher";
import {
  clearRecentClientErrors,
  getRecentClientErrors,
  setClientErrorReporter,
} from "../lib/telemetry";
import { THEME_STORAGE_KEY, useTheme } from "../lib/theme";
import { useSpatial3DPanels } from "../lib/spatial3d";
import { CatalogView } from "../views/CatalogView";

afterEach(() => {
  vi.restoreAllMocks();
  setClientErrorReporter(null);
  clearRecentClientErrors();
});

describe("LoginScreen security & error-state behavior (C-02, M-19)", () => {
  it("omits demo persona shortcuts by default and renders API outage retry banner", () => {
    const onRetry = vi.fn();
    render(
      <LoginScreen
        onLoggedIn={vi.fn()}
        apiHealthy={false}
        onRetryConnection={onRetry}
      />
    );

    expect(screen.queryByText(/LOCAL DEV DEMO ROLES/i)).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/Store API is currently unreachable/i);

    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("validates short PINs with accessible ARIA links and submits credentials to /api/auth/login", async () => {
    const onLoggedIn = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          user: { id: "u1", username: "owner", fullName: "Store Owner", role: "owner" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    render(<LoginScreen onLoggedIn={onLoggedIn} />);
    const usernameInput = screen.getByLabelText(/Username/i);
    const pinInput = screen.getByLabelText(/Staff PIN/i);
    const form = screen.getByRole("button", { name: /Sign In/i }).closest("form")!;

    expect(document.activeElement).toBe(usernameInput);
    expect(form).toHaveAttribute("novalidate");

    fireEvent.change(usernameInput, { target: { value: "owner" } });
    fireEvent.change(pinInput, { target: { value: "12" } });
    fireEvent.submit(form);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("id", "login-error-alert");
    expect(alert).toHaveTextContent(/4 to 64 characters/i);
    expect(pinInput).toHaveAttribute("aria-invalid", "true");
    expect(pinInput).toHaveAttribute("aria-describedby", "login-error-alert");
    expect(fetchSpy).not.toHaveBeenCalled();

    fireEvent.change(pinInput, { target: { value: "1111" } });
    fireEvent.click(screen.getByRole("button", { name: /Sign In/i }));

    await waitFor(() => {
      expect(onLoggedIn).toHaveBeenCalledWith(
        expect.objectContaining({ username: "owner", role: "owner" })
      );
    });
  });
});

describe("AccessibleDialog (ModalDialog & SlideDrawer) ARIA, focus trap & Escape (H-18)", () => {
  function DialogHarness() {
    const [open, setOpen] = useState(false);
    return (
      <div>
        <button type="button" onClick={() => setOpen(true)}>
          Open Modal Trigger
        </button>
        <ModalDialog open={open} onClose={() => setOpen(false)} labelledBy="test-modal-title">
          <h2 id="test-modal-title">Accessible Test Modal</h2>
          <button type="button">First Action</button>
          <button type="button" onClick={() => setOpen(false)}>
            Last Action
          </button>
        </ModalDialog>
      </div>
    );
  }

  it("sets dialog ARIA attributes, traps Tab focus, closes on Escape, and restores focus", async () => {
    render(<DialogHarness />);
    const trigger = screen.getByRole("button", { name: "Open Modal Trigger" });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Accessible Test Modal" });
    expect(dialog).toHaveAttribute("aria-modal", "true");

    const firstBtn = screen.getByRole("button", { name: "First Action" });
    const lastBtn = screen.getByRole("button", { name: "Last Action" });
    await waitFor(() => {
      expect(document.activeElement).toBe(firstBtn);
    });

    // Shift+Tab from first focusable wraps to last focusable
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(lastBtn);

    // Tab from last focusable wraps to first focusable
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(firstBtn);

    // Escape closes dialog and restores focus to trigger button
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it("renders SlideDrawer with accessible aria-label when labelledBy is omitted", () => {
    render(
      <SlideDrawer open onClose={vi.fn()} ariaLabel="Product Drawer">
        <div>Drawer Body</div>
      </SlideDrawer>
    );
    expect(screen.getByRole("dialog", { name: "Product Drawer" })).toHaveAttribute(
      "aria-modal",
      "true"
    );
  });
});

describe("ErrorBoundary & frontend error telemetry hook (H-17, L-08)", () => {
  function CrashComponent({ shouldThrow }: { shouldThrow: boolean }) {
    if (shouldThrow) {
      throw new Error("Simulated POS render crash");
    }
    return <div>Healthy Workspace</div>;
  }

  it("catches crashes, reports telemetry, renders recovery UI, and resets cleanly", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const reported: string[] = [];
    setClientErrorReporter((ev) => reported.push(`${ev.scope}:${ev.message}`));

    function Wrapper() {
      const [broken, setBroken] = useState(true);
      return (
        <ErrorBoundary scope="POS Terminal" onReset={() => setBroken(false)}>
          <CrashComponent shouldThrow={broken} />
        </ErrorBoundary>
      );
    }

    render(<Wrapper />);
    expect(screen.getByRole("alert")).toHaveTextContent(/POS Terminal encountered an unexpected error/i);
    expect(reported).toContain("POS Terminal:Simulated POS render crash");
    expect(getRecentClientErrors().length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /Try Again/i }));
    expect(screen.getByText("Healthy Workspace")).toBeInTheDocument();
    spy.mockRestore();
  });
});

describe("SalesTrendChart keyboard/touch interactivity (M-02, M-17)", () => {
  it("reveals daily sales & profit readout on keyboard focus and click", () => {
    render(
      <SalesTrendChart
        days={7}
        dailyTrend={[
          { day: "2026-11-20", receipts: 120, salesCents: 452000, profitCents: 112000 },
          { day: "2026-11-21", receipts: 185, salesCents: 689500, profitCents: 175000 },
        ]}
      />
    );

    const bar = screen.getByRole("button", { name: /2026-11-21.*185 receipts/i });
    fireEvent.focus(bar);
    expect(screen.getByText(/2026-11-21: \$6,895\.00 \(185 tx/i)).toBeInTheDocument();
  });
});

describe("CatalogView RBAC cost hiding & keyboard inspection (H-15, H-18)", () => {
  it("hides wholesale cost for cashiers and opens accessible inspector drawer via row button", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          total: 1,
          pageSize: 40,
          items: [
            {
              id: "prod-1",
              sku: "BEV-0001",
              name: "Sparkling Water 500ml",
              brand: "PureSpring",
              departmentName: "Beverages",
              categoryName: "Water",
              aisleLocation: "A1",
              baseUnitLabel: "bottle",
              requiresAgeCheck: false,
              onHandUnits: 42,
              primaryBarcode: "8850000000014",
              primarySellPriceCents: 150,
              segment: "AX",
              units60d: 310,
              earliestExpiry: null,
              barcodes: [
                {
                  id: "bc-1",
                  barcode: "8850000000014",
                  packQty: 1,
                  packLabel: "Single Bottle",
                  sellPriceCents: 150,
                  isPrimary: true,
                  isOrderableCase: false,
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    render(<CatalogView departments={[{ id: "d1", name: "Beverages" }]} userRole="cashier" />);

    const inspectBtn = await screen.findByRole("button", {
      name: /Inspect Sparkling Water 500ml \(BEV-0001\)/i,
    });
    expect(screen.queryByRole("button", { name: /Bulk CSV Onboarding Wizard/i })).not.toBeInTheDocument();

    fireEvent.click(inspectBtn);
    const drawer = screen.getByRole("dialog", { name: /Sparkling Water 500ml/i });
    expect(drawer).toHaveAttribute("aria-modal", "true");
    expect(screen.queryByText(/Avg Base Cost/i)).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("ThemeSwitcher & useTheme (Blue-Navy, Dark, Light)", () => {
  function ThemeHarness() {
    const { theme, setTheme } = useTheme();
    return <ThemeSwitcher theme={theme} onChange={setTheme} variant="sidebar" />;
  }

  it("defaults to Warm Editorial Light and switches cleanly between Navy and Dark with persistence", () => {
    window.localStorage.removeItem(THEME_STORAGE_KEY);
    delete document.documentElement.dataset.theme;

    render(<ThemeHarness />);

    const lightBtn = screen.getByRole("button", { name: /Light/i });
    const navyBtn = screen.getByRole("button", { name: /Navy/i });
    const darkBtn = screen.getByRole("button", { name: /Dark/i });

    expect(lightBtn).toHaveAttribute("aria-pressed", "true");
    expect(document.documentElement.dataset.theme).toBe("light");

    fireEvent.click(navyBtn);
    expect(navyBtn).toHaveAttribute("aria-pressed", "true");
    expect(lightBtn).toHaveAttribute("aria-pressed", "false");
    expect(document.documentElement.dataset.theme).toBe("navy");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("navy");

    fireEvent.click(darkBtn);
    expect(darkBtn).toHaveAttribute("aria-pressed", "true");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    window.localStorage.removeItem(THEME_STORAGE_KEY);
  });
});

describe("SubTabBar WAI-ARIA tablist keyboard navigation", () => {
  function TabHarness() {
    const [active, setActive] = useState<"alpha" | "beta" | "gamma">("alpha");
    return (
      <div>
        <SubTabBar
          ariaLabel="Demo sub-views"
          activeId={active}
          onSelect={setActive}
          tabs={[
            { id: "alpha", elementId: "tab-alpha", panelId: "panel-alpha", label: "Alpha" },
            { id: "beta", elementId: "tab-beta", panelId: "panel-beta", label: "Beta" },
            { id: "gamma", elementId: "tab-gamma", panelId: "panel-gamma", label: "Gamma" },
          ]}
        />
        <div role="tabpanel" id={`panel-${active}`} aria-labelledby={`tab-${active}`}>
          Active: {active}
        </div>
      </div>
    );
  }

  it("supports roving tabIndex and ArrowRight / ArrowLeft / Home / End focus & selection", () => {
    render(<TabHarness />);
    const alpha = screen.getByRole("tab", { name: "Alpha" });
    const beta = screen.getByRole("tab", { name: "Beta" });
    const gamma = screen.getByRole("tab", { name: "Gamma" });

    expect(alpha).toHaveAttribute("aria-selected", "true");
    expect(alpha).toHaveAttribute("tabindex", "0");
    expect(beta).toHaveAttribute("tabindex", "-1");
    expect(gamma).toHaveAttribute("tabindex", "-1");

    alpha.focus();
    fireEvent.keyDown(alpha, { key: "ArrowRight" });
    expect(beta).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(beta);
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Active: beta");

    fireEvent.keyDown(beta, { key: "End" });
    expect(gamma).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(gamma);

    fireEvent.keyDown(gamma, { key: "ArrowRight" });
    expect(alpha).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(alpha);

    fireEvent.keyDown(alpha, { key: "ArrowLeft" });
    expect(gamma).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(gamma);

    fireEvent.keyDown(gamma, { key: "Home" });
    expect(alpha).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(alpha);
  });
});

describe("AccessibleDialog background inert isolation & stacked scroll lock", () => {
  function StackedDialogHarness() {
    const [firstOpen, setFirstOpen] = useState(false);
    const [secondOpen, setSecondOpen] = useState(false);
    return (
      <div data-testid="app-shell">
        <button type="button" onClick={() => setFirstOpen(true)}>
          Open Outer
        </button>
        <ModalDialog open={firstOpen} onClose={() => setFirstOpen(false)} ariaLabel="Outer Dialog">
          <button type="button" onClick={() => setSecondOpen(true)}>
            Open Inner
          </button>
          <ModalDialog
            open={secondOpen}
            onClose={() => setSecondOpen(false)}
            ariaLabel="Inner Dialog"
          >
            <button type="button" onClick={() => setSecondOpen(false)}>
              Close Inner
            </button>
          </ModalDialog>
        </ModalDialog>
      </div>
    );
  }

  it("marks app root inert/aria-hidden while open and only unlocks body overflow after last stacked modal closes", () => {
    document.body.style.overflow = "auto";
    const { container } = render(<StackedDialogHarness />);
    expect(container.getAttribute("aria-hidden")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open Outer" }));
    expect(document.body.style.overflow).toBe("hidden");
    expect(container.getAttribute("aria-hidden")).toBe("true");
    expect((container as HTMLElement & { inert?: boolean }).inert).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Open Inner" }));
    expect(screen.getByRole("dialog", { name: "Inner Dialog" })).toBeInTheDocument();

    // Pressing Escape closes only the topmost Inner Dialog; overflow stays locked
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Inner Dialog" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Outer Dialog" })).toBeInTheDocument();
    expect(document.body.style.overflow).toBe("hidden");

    // Closing Outer Dialog restores overflow and unlocks background container
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Outer Dialog" })).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("auto");
    expect(container.getAttribute("aria-hidden")).toBeNull();
    expect((container as HTMLElement & { inert?: boolean }).inert).toBe(false);
  });

  it("supports initialFocusRef, skips hidden elements in focus cycle, and ignores mouse-drag backdrop releases", async () => {
    const onClose = vi.fn();
    function FocusHarness() {
      const inputRef = useRef<HTMLInputElement>(null);
      return (
        <SlideDrawer
          open
          onClose={onClose}
          ariaLabel="Preferred Focus Drawer"
          initialFocusRef={inputRef}
        >
          <button type="button">Header Action</button>
          <button type="button" hidden>
            Hidden Action
          </button>
          <input ref={inputRef} aria-label="Target Input" />
        </SlideDrawer>
      );
    }

    render(<FocusHarness />);
    const headerBtn = screen.getByRole("button", { name: "Header Action" });
    const targetInput = screen.getByLabelText("Target Input");
    await waitFor(() => {
      expect(document.activeElement).toBe(targetInput);
    });

    // Tab wraps past hidden button back to visible Header Action
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(headerBtn);

    // Mousedown inside dialog followed by backdrop click does not dismiss
    const backdrop = document.querySelector(".overlay-backdrop")!;
    fireEvent.mouseDown(targetInput);
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();

    // Direct mousedown + click on backdrop dismisses cleanly
    fireEvent.mouseDown(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("PosScanBar & HourlyFootfallChart localized interaction state", () => {
  it("submits barcode, exposes ARIA error/disabled states, clears only when accepted, and focuses when active", () => {
    const onScan = vi.fn((code: string) => code === "8850000000014");
    function Harness() {
      const ref = useRef<HTMLInputElement>(null);
      const [invalid, setInvalid] = useState(true);
      const [inputDisabled, setInputDisabled] = useState(false);
      return (
        <>
          <PosScanBar
            inputRef={ref}
            isActive
            disabled={false}
            inputDisabled={inputDisabled}
            invalid={invalid}
            errorId="pos-scan-error-alert"
            onScan={onScan}
          />
          <button type="button" onClick={() => setInvalid(false)}>
            Clear Error
          </button>
          <button type="button" onClick={() => setInputDisabled(true)}>
            Lock Scan
          </button>
        </>
      );
    }

    render(<Harness />);
    const input = screen.getByLabelText(/Scan EAN-13, UPC-A, GS1 scale barcode/i);
    expect(document.activeElement).toBe(input);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-describedby", "pos-scan-error-alert");

    fireEvent.change(input, { target: { value: "0000" } });
    fireEvent.submit(input.closest("form")!);
    expect(onScan).toHaveBeenCalledWith("0000");
    expect(input).toHaveValue("0000");

    fireEvent.change(input, { target: { value: "8850000000014" } });
    fireEvent.submit(input.closest("form")!);
    expect(onScan).toHaveBeenCalledWith("8850000000014");
    expect(input).toHaveValue("");

    fireEvent.click(screen.getByRole("button", { name: "Clear Error" }));
    expect(input).not.toHaveAttribute("aria-invalid");

    fireEvent.click(screen.getByRole("button", { name: "Lock Scan" }));
    expect(input).toBeDisabled();
  });

  it("reveals hourly funnel readout on keyboard focus", () => {
    render(
      <HourlyFootfallChart
        hourly={[
          {
            hour: 9,
            shiftKey: "morning",
            walkIns: 48,
            receipts: 36,
            conversionPct: 75,
            revenueCents: 120000,
            avgOpenLanes: 2,
            avgDwellSec: 180,
          },
        ]}
      />
    );
    const bar = screen.getByRole("button", { name: /09:00 — 48 walk-ins, 36 receipts/i });
    fireEvent.focus(bar);
    expect(screen.getByRole("status")).toHaveTextContent(/09:00 — 48 in → 36 paid \(75%\)/i);
  });
});

describe("Flagship Milestone 1: PosFreshPluModal & FreshProductionTab", () => {
  it("computes net weight after tare, generates GS1 scale barcode, and blocks recalled SKUs", async () => {
    const { PosFreshPluModal } = await import("../components/PosFreshPluModal");
    const onAddWeighted = vi.fn();
    const onAddEach = vi.fn();
    const onSimulateScaleBarcode = vi.fn();
    const onClose = vi.fn();

    render(
      <PosFreshPluModal
        open
        items={[
          {
            productId: "p-banana",
            sku: "PROD-4011",
            name: "Cavendish Bananas (Loose)",
            brand: "TropiFresh",
            pluCode: "4011",
            unitMode: "weight_g",
            defaultTareGrams: 12,
            netContentAmount: 1000,
            netContentUnit: "g",
            allergens: [],
            recalled: false,
            recallReason: null,
            barcode: "8990009100011",
            packLabel: "Per kg",
            sellPriceCents: 200,
          },
          {
            productId: "p-salmon",
            sku: "MEAT-20020",
            name: "Atlantic Salmon Fillet",
            brand: "NordicSea",
            pluCode: "20020",
            unitMode: "weight_g",
            defaultTareGrams: 30,
            netContentAmount: 1000,
            netContentUnit: "g",
            allergens: ["fish"],
            recalled: true,
            recallReason: "Cold chain temperature excursion",
            barcode: "8990009100073",
            packLabel: "Per kg",
            sellPriceCents: 2450,
          },
        ]}
        onAddWeighted={onAddWeighted}
        onAddEach={onAddEach}
        onSimulateScaleBarcode={onSimulateScaleBarcode}
        onClose={onClose}
      />
    );

    const dialog = screen.getByRole("dialog", { name: /Fresh Produce, Butcher, Deli & Bakery PLU Scale/i });
    expect(dialog).toHaveAttribute("aria-modal", "true");

    // Default gross = 512g, tare = 12g -> net = 500g (0.500 kg) @ $2.00/kg = $1.00
    fireEvent.click(screen.getByRole("button", { name: /Add 0\.500 kg to Basket \(\$1\.00\)/i }));
    expect(onAddWeighted).toHaveBeenCalledWith(
      expect.objectContaining({ sku: "PROD-4011" }),
      500,
      12
    );

    // Select recalled salmon -> food-safety alert blocks checkout
    fireEvent.click(screen.getByRole("button", { name: /Atlantic Salmon Fillet/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/FOOD-SAFETY RECALL BLOCK/i);
    expect(screen.queryByRole("button", { name: /Add .* to Basket/i })).not.toBeInTheDocument();
  });

  it("loads BOM recipes and posts a production batch with yield feedback", async () => {
    const { FreshProductionTab } = await import("../components/FreshProductionTab");
    const onFeedback = vi.fn();
    const onError = vi.fn();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/operations/recipes")) {
        return new Response(
          JSON.stringify({
            recipes: [
              {
                id: "rec-1",
                code: "BAKE-SOURDOUGH-10",
                name: "Country Sourdough 10-Loaf Batch",
                outputProductId: "p-loaf",
                outputSku: "BAKE-40010",
                outputName: "Artisan Country Sourdough Loaf 750g",
                outputUnitMode: "each",
                outputBaseUnitLabel: "loaf",
                expectedYieldBaseUnits: 10,
                shelfLifeDays: 2,
                notes: "Stone deck bake",
                active: true,
                estimatedBatchCostCents: 1200,
                ingredients: [
                  {
                    id: "ing-1",
                    recipeId: "rec-1",
                    ingredientProductId: "p-flour",
                    sku: "BAKE-RAW-FLOUR",
                    name: "Artisan Bread Flour T65",
                    unitMode: "weight_g",
                    baseUnitLabel: "g",
                    avgCostCents: 240,
                    qtyBaseUnits: 5000,
                    onHandUnits: 25000,
                    estimatedLineCostCents: 1200,
                  },
                ],
              },
            ],
            recentBatches: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/api/operations/production-batches") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            batch: {
              lotCode: "PROD-BAKE-SOURDOUGH-10-261126",
              actualOutputUnits: 10,
              yieldBp: 10000,
              effectiveUnitCostCents: 120,
            },
          }),
          { status: 201, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("{}", { status: 404 });
    });

    render(<FreshProductionTab onFeedback={onFeedback} onError={onError} />);

    const logBtn = await screen.findByRole("button", {
      name: /Log Production Batch & Deduct Raw Stock/i,
    });
    expect(screen.getByText(/Artisan Bread Flour T65/i)).toBeInTheDocument();

    fireEvent.click(logBtn);
    await waitFor(() => {
      expect(onFeedback).toHaveBeenCalledWith(expect.stringContaining("PROD-BAKE-SOURDOUGH-10-261126"));
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/operations/production-batches",
      expect.objectContaining({ method: "POST" })
    );
  });
});

describe("Flagship Milestone 2: QrCodeSvg, PosCheckoutModal & CustomerDisplayView", () => {
  it("renders a crisp ISO/IEC 18004 SVG QR code with white quiet zone for a valid KHQR payload", async () => {
    const { buildKhqrPayload } = await import("@supermarket/shared/emvqr");
    const { QrCodeSvg } = await import("../components/QrCodeSvg");

    const khqr = buildKhqrPayload({
      accountId: "supermarket_flagship@aclb",
      merchantName: "SUPERMARKET OS",
      merchantCity: "PHNOM PENH",
      currencyCode: "USD",
      amountMinorUnits: 1250,
      billReference: "REG01-TEST01",
    });

    const { container } = render(
      <QrCodeSvg payload={khqr.payload} sizePx={200} label="KHQR payment QR for $12.50" />
    );

    const img = screen.getByRole("img", { name: "KHQR payment QR for $12.50" });
    expect(img).toBeInTheDocument();
    expect(container.querySelector("rect")?.getAttribute("fill")).toBe("#ffffff");
    const pathD = container.querySelector("path")?.getAttribute("d") ?? "";
    expect(pathD.length).toBeGreaterThan(200);
  });

  it("supports split tender combining dual-currency KHR cash and Card inside PosCheckoutModal", async () => {
    const { PosCheckoutModal } = await import("../components/PosCheckoutModal");
    const onFinalize = vi.fn().mockResolvedValue(undefined);
    const onActiveQrChange = vi.fn();

    render(
      <PosCheckoutModal
        open
        initialTab="cash"
        grandTotalCents={1000}
        storeSettings={{
          id: "store-1",
          code: "FLAGSHIP",
          legalName: "SupermarketOS Flagship Co., Ltd.",
          storeName: "SupermarketOS Flagship Market",
          address: "123 Norodom Blvd",
          taxId: "K001-990011223",
          primaryCurrency: "USD",
          secondaryCurrency: "KHR",
          secondaryFxRate: 4100,
          secondaryRoundingStep: 100,
          cashSkimLimitCents: 50000,
          receiptHeader: "Fresh Daily",
          receiptFooter: "Thank you!",
          defaultQrRail: "khqr",
          paymentProvider: "mock_sandbox",
          khqrAccountId: "flagship@aclb",
          khqrMerchantId: null,
          khqrAcquiringBank: "ABA Bank",
          khqrCity: "Phnom Penh",
          promptpayProxy: "0812345678",
          paynowUen: "202412345A",
          fiscalProvider: "local_hash_chain",
          updatedAt: new Date().toISOString(),
        }}
        attachedCustomer={null}
        simulatedOffline={false}
        submittingSale={false}
        onActiveQrChange={onActiveQrChange}
        onFinalizeSale={onFinalize}
        onClose={vi.fn()}
      />
    );

    // Pay $5.00 equivalent using 20,500 KHR (0 USD)
    fireEvent.change(screen.getByLabelText(/Cash Tendered \(USD\)/i), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText(/Cash Tendered \(KHR/i), { target: { value: "20500" } });
    fireEvent.click(screen.getByRole("button", { name: /Apply \$5\.00 Cash/i }));

    // Remaining balance should now be $5.00; switch to Card tab and pay remaining $5.00
    fireEvent.click(screen.getByRole("button", { name: /Card \/ Credit \/ Points/i }));
    expect(screen.getByLabelText(/Amount to Apply \(USD\)/i)).toHaveValue(5);
    fireEvent.click(screen.getByRole("button", { name: /Apply Card Terminal/i }));

    const finalizeBtn = screen.getByRole("button", { name: /Finalize Receipt \(\$10\.00\)/i });
    expect(finalizeBtn).toBeEnabled();
    fireEvent.click(finalizeBtn);

    await waitFor(() => {
      expect(onFinalize).toHaveBeenCalledTimes(1);
    });
    const submittedLegs = onFinalize.mock.calls[0][0] as Array<{
      method: string;
      amountCents: number;
      foreignAmount?: number | null;
    }>;
    expect(submittedLegs).toHaveLength(2);
    expect(submittedLegs[0]).toMatchObject({
      method: "cash",
      amountCents: 500,
      foreignAmount: 20500,
    });
    expect(submittedLegs[1]).toMatchObject({
      method: "card",
      amountCents: 500,
    });
  });

  it("hydrates CustomerDisplayView with live dual-currency totals and EMVCo QR from cfdChannel", async () => {
    const { buildKhqrPayload } = await import("@supermarket/shared/emvqr");
    const { publishCfdState, CFD_STORAGE_KEY } = await import("../lib/cfdChannel");
    const { CustomerDisplayView } = await import("../views/CustomerDisplayView");

    const qr = buildKhqrPayload({
      accountId: "flagship@aclb",
      merchantName: "SUPERMARKET OS",
      merchantCity: "PHNOM PENH",
      currencyCode: "USD",
      amountMinorUnits: 1000,
      billReference: "REG01-CFD01",
    });

    publishCfdState({
      storeName: "SupermarketOS Flagship Market",
      receiptHeader: "Fresh Produce & Grocery",
      receiptFooter: "See you again!",
      registerCode: "REG-01",
      cashierName: "Elena Morales",
      primaryCurrency: "USD",
      secondaryCurrency: "KHR",
      secondaryFxRate: 4100,
      secondaryRoundingStep: 100,
      status: "awaiting_qr",
      lines: [
        {
          lineKey: "l1",
          name: "Cavendish Bananas (Loose)",
          packLabel: "1.000 kg",
          qtyPacks: 1,
          weightGrams: 1000,
          unitMode: "weight_g",
          lineTotalCents: 1000,
          discountCents: 0,
        },
      ],
      subtotalCents: 1000,
      discountCents: 0,
      taxCents: 0,
      grandTotalCents: 1000,
      activeQr: {
        intentId: "intent-1",
        rail: "khqr",
        displayAmount: "$10.00",
        currencyCode: "USD",
        billReference: "REG01-CFD01",
        qrPayload: qr.payload,
        status: "pending",
        externalRef: null,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      },
      lastReceiptNo: null,
      updatedAt: new Date().toISOString(),
    });

    render(<CustomerDisplayView />);

    expect(screen.getByRole("heading", { name: "SupermarketOS Flagship Market" })).toBeInTheDocument();
    expect(screen.getByText("Cavendish Bananas (Loose)")).toBeInTheDocument();
    expect(screen.getByText(/41,000 ៛/)).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: /Customer display KHQR QR for \$10\.00/i })
    ).toBeInTheDocument();

    localStorage.removeItem(CFD_STORAGE_KEY);
  });
});

describe("POS Destructive Guardrails & Blind Close Controls", () => {
  it("requires confirmation before voiding/refunding receipts and highlights Void as btn-danger", () => {
    const onVoidOrRefund = vi.fn();
    render(
      <RecentReceiptsModal
        open
        canVoidOrRefund
        loadingRecent={false}
        recentSales={[
          {
            id: "s1",
            registerCode: "REG-01",
            receiptNo: "REG-01-TEST9999",
            kind: "sale",
            originalSaleId: null,
            customerId: null,
            cashierName: "Elena Morales",
            totalCents: 1450,
            soldAt: new Date().toISOString(),
            alreadyVoided: false,
            lines: [
              {
                id: "l1",
                productId: "p1",
                productName: "Sparkling Water",
                scannedBarcode: "8850000000014",
                packLabel: "Single",
                packQty: 1,
                qtyPacks: 1,
                unitPriceCents: 1450,
                unitCostCents: 900,
                discountCents: 0,
                taxRateBp: 0,
                taxCents: 0,
                lineTotalCents: 1450,
              },
            ],
            payments: [{ id: "pm1", method: "cash", amountCents: 1450 }],
          },
        ]}
        recentError={null}
        busyReceiptId={null}
        onVoidOrRefund={onVoidOrRefund}
        onClose={vi.fn()}
      />
    );

    const voidBtn = screen.getByRole("button", { name: /^Void$/i });
    expect(voidBtn).toHaveClass("btn-danger");

    fireEvent.click(voidBtn);
    expect(onVoidOrRefund).not.toHaveBeenCalled();
    expect(screen.getByText(/Confirm VOID:/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Confirm Void/i }));
    expect(onVoidOrRefund).toHaveBeenCalledTimes(1);
    expect(onVoidOrRefund).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }), "void");
  });

  it("disables ShiftCloseModal submission when blind cash count is empty and enables on valid entry", () => {
    function BlindHarness() {
      const [val, setVal] = useState("");
      return (
        <ShiftCloseModal
          open
          activeShift={{
            id: "sh1",
            registerCode: "REG-01",
            openingFloatCents: 30000,
            openedAt: new Date().toISOString(),
          }}
          blindCashInput={val}
          fallbackFloatInput="300.00"
          closingShift={false}
          shiftError={null}
          zReportResult={null}
          onBlindCashChange={setVal}
          onFallbackFloatChange={vi.fn()}
          onSubmit={vi.fn()}
          onClose={vi.fn()}
        />
      );
    }

    render(<BlindHarness />);
    const submitBtn = screen.getByRole("button", {
      name: /Submit Blind Count & Generate Z-Report/i,
    });
    const blindInput = screen.getByLabelText(/Physical Cash Counted in Drawer/i);
    expect(blindInput).toHaveValue("");
    expect(submitBtn).toBeDisabled();

    fireEvent.change(blindInput, { target: { value: "312.50" } });
    expect(submitBtn).toBeEnabled();
  });
});

describe("useSpatial3DPanels cursor-reactive 3D elevation & reduced motion", () => {
  function mockMatchMedia(reducedMotion: boolean) {
    return (query: string) => ({
      matches: query.includes("prefers-reduced-motion") ? reducedMotion : query.includes("pointer: fine"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });
  }

  function SpatialHarness() {
    useSpatial3DPanels();
    return (
      <section className="panel" data-testid="outer-panel">
        <div className="kpi-tile" data-testid="inner-tile">
          <span>Live Tile</span>
        </div>
      </section>
    );
  }

  it("applies is-3d-active and cursor tilt CSS variables on inner card and cleans up on pointerleave", async () => {
    const origMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: mockMatchMedia(false),
    });

    try {
      render(<SpatialHarness />);
      const outer = screen.getByTestId("outer-panel");
      const inner = screen.getByTestId("inner-tile");

      vi.spyOn(inner, "getBoundingClientRect").mockReturnValue({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 200,
        bottom: 100,
        width: 200,
        height: 100,
        toJSON: () => ({}),
      });

      const moveEvent = new Event("pointermove", { bubbles: true }) as PointerEvent;
      Object.defineProperties(moveEvent, {
        clientX: { value: 180 },
        clientY: { value: 20 },
        pointerType: { value: "mouse" },
        buttons: { value: 0 },
      });
      inner.dispatchEvent(moveEvent);

      await waitFor(() => {
        expect(inner).toHaveClass("is-3d-active");
      });
      expect(outer).not.toHaveClass("is-3d-active");
      expect(inner.style.getPropertyValue("--rx")).toMatch(/^-?\d+(\.\d+)?deg$/);
      expect(inner.style.getPropertyValue("--ry")).toMatch(/^-?\d+(\.\d+)?deg$/);
      expect(inner.style.getPropertyValue("--gx")).toBe("90.0%");
      expect(inner.style.getPropertyValue("--gy")).toBe("20.0%");

      document.documentElement.dispatchEvent(new Event("pointerleave"));
      expect(inner).not.toHaveClass("is-3d-active");
      expect(inner.style.getPropertyValue("--rx")).toBe("");
    } finally {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: origMatchMedia,
      });
    }
  });

  it("stays disabled when prefers-reduced-motion: reduce matches", async () => {
    const origMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: mockMatchMedia(true),
    });

    try {
      render(<SpatialHarness />);
      const inner = screen.getByTestId("inner-tile");
      const moveEvent = new Event("pointermove", { bubbles: true }) as PointerEvent;
      Object.defineProperties(moveEvent, {
        clientX: { value: 120 },
        clientY: { value: 40 },
        pointerType: { value: "mouse" },
        buttons: { value: 0 },
      });
      inner.dispatchEvent(moveEvent);
      await new Promise((r) => setTimeout(r, 30));
      expect(inner).not.toHaveClass("is-3d-active");
      expect(inner.style.getPropertyValue("--rx")).toBe("");
    } finally {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: origMatchMedia,
      });
    }
  });
});




