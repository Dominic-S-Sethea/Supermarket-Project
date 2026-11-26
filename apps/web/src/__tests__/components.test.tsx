import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModalDialog, SlideDrawer } from "../components/AccessibleDialog";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { LoginScreen } from "../components/LoginScreen";
import { SalesTrendChart } from "../components/SalesTrendChart";
import {
  clearRecentClientErrors,
  getRecentClientErrors,
  setClientErrorReporter,
} from "../lib/telemetry";
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
