import { useRef, useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModalDialog, SlideDrawer } from "../components/AccessibleDialog";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { HourlyFootfallChart } from "../components/HourlyFootfallChart";
import { LoginScreen } from "../components/LoginScreen";
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

  it("validates short PINs and submits credentials to /api/auth/login", async () => {
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

    fireEvent.change(screen.getByLabelText(/Username/i), { target: { value: "owner" } });
    fireEvent.change(screen.getByLabelText(/Staff PIN/i), { target: { value: "12" } });
    fireEvent.submit(screen.getByRole("button", { name: /Sign In/i }).closest("form")!);
    expect(screen.getByRole("alert")).toHaveTextContent(/4 to 64 characters/i);
    expect(fetchSpy).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/Staff PIN/i), { target: { value: "1111" } });
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

  it("defaults to Blue-Navy and switches cleanly between Dark and Light with persistence", () => {
    window.localStorage.removeItem(THEME_STORAGE_KEY);
    delete document.documentElement.dataset.theme;

    render(<ThemeHarness />);

    const navyBtn = screen.getByRole("button", { name: /Navy/i });
    const darkBtn = screen.getByRole("button", { name: /Dark/i });
    const lightBtn = screen.getByRole("button", { name: /Light/i });

    expect(navyBtn).toHaveAttribute("aria-pressed", "true");
    expect(document.documentElement.dataset.theme).toBe("navy");

    fireEvent.click(darkBtn);
    expect(darkBtn).toHaveAttribute("aria-pressed", "true");
    expect(navyBtn).toHaveAttribute("aria-pressed", "false");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    fireEvent.click(lightBtn);
    expect(lightBtn).toHaveAttribute("aria-pressed", "true");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");

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
});

describe("PosScanBar & HourlyFootfallChart localized interaction state", () => {
  it("submits barcode, clears only when accepted, and focuses when active", () => {
    const onScan = vi.fn((code: string) => code === "8850000000014");
    function Harness() {
      const ref = useRef<HTMLInputElement>(null);
      return <PosScanBar inputRef={ref} isActive disabled={false} onScan={onScan} />;
    }

    render(<Harness />);
    const input = screen.getByLabelText(/Scan EAN-13 or UPC-A barcode/i);
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: "0000" } });
    fireEvent.submit(input.closest("form")!);
    expect(onScan).toHaveBeenCalledWith("0000");
    expect(input).toHaveValue("0000");

    fireEvent.change(input, { target: { value: "8850000000014" } });
    fireEvent.submit(input.closest("form")!);
    expect(onScan).toHaveBeenCalledWith("8850000000014");
    expect(input).toHaveValue("");
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


