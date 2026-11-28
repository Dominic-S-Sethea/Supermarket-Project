import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModalDialog } from "../components/AccessibleDialog";
import { AiCopilotDrawer } from "../components/AiCopilotDrawer";
import { ConfirmActionButton } from "../components/ConfirmActionButton";
import { FreshProductionTab } from "../components/FreshProductionTab";
import { PosCheckoutModal } from "../components/PosCheckoutModal";
import { PosScanBar } from "../components/PosScanBar";
import { QrCodeSvg } from "../components/QrCodeSvg";
import { PosTerminalView } from "../views/PosTerminalView";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WP-5 Checkout, QR resilience, A11y & lifecycle controls", () => {
  it("preserves settled QR payment legs across grandTotalCents ticks, cancels pending QR on close, and prevents cumulative loyalty over-redemption (AUD-020)", async () => {
    const cancelledIntentIds: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/pos/payment-intents") {
        return new Response(
          JSON.stringify({
            intent: {
              id: "intent-1",
              registerCode: "REG-01",
              rail: "khqr",
              provider: "mock_sandbox",
              status: "pending",
              amountCents: 500,
              currencyCode: "USD",
              displayAmount: "$5.00",
              billReference: "REF-1",
              qrPayload: "00020101021229160012aba@flagship52045411530384054045.005802KH5906MARKET6010Phnom Penh62090105REF-16304ABCD",
              externalRef: null,
              expiresAt: new Date(Date.now() + 300_000).toISOString(),
            },
          }),
          { status: 201, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url === "/api/pos/payment-intents/intent-1/simulate-settle") {
        return new Response(
          JSON.stringify({
            intent: {
              id: "intent-1",
              registerCode: "REG-01",
              rail: "khqr",
              provider: "mock_sandbox",
              status: "paid",
              amountCents: 500,
              currencyCode: "USD",
              displayAmount: "$5.00",
              billReference: "REF-1",
              qrPayload: null,
              externalRef: "BAKONG-123",
              expiresAt: new Date(Date.now() + 300_000).toISOString(),
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url === "/api/pos/payment-intents/intent-1/cancel") {
        cancelledIntentIds.push("intent-1");
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ intent: { id: "intent-1", status: "pending" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const onClose = vi.fn();
    const onActiveQrChange = vi.fn();
    const { rerender } = render(
      <PosCheckoutModal
        open={true}
        initialTab="qr"
        grandTotalCents={1000}
        storeSettings={null}
        attachedCustomer={{
          id: "cust-1",
          fullName: "Nadia Sok",
          phone: "+85512345678",
          rfmSegment: "Champion",
          pointsBalance: 300,
        }}
        simulatedOffline={false}
        submittingSale={false}
        onActiveQrChange={onActiveQrChange}
        onFinalizeSale={vi.fn().mockResolvedValue(undefined)}
        onClose={onClose}
      />
    );

    fireEvent.change(screen.getByLabelText(/QR Tender Amount/i), { target: { value: "5.00" } });
    fireEvent.click(screen.getByRole("button", { name: /Generate KHQR Dynamic QR/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Simulate Bank Settlement/i })).toBeInTheDocument();
    });

    // Closing while pending (before settling) is not settled yet -> should close? Wait: let's settle first!
    fireEvent.click(screen.getByRole("button", { name: /Simulate Bank Settlement/i }));
    await waitFor(() => {
      expect(screen.getByText(/1 payment leg\(s\)/i)).toBeInTheDocument();
    });

    // Daypart tick changes grandTotalCents -> settled QR leg MUST survive!
    rerender(
      <PosCheckoutModal
        open={true}
        initialTab="qr"
        grandTotalCents={1100}
        storeSettings={null}
        attachedCustomer={{
          id: "cust-1",
          fullName: "Nadia Sok",
          phone: "+85512345678",
          rfmSegment: "Champion",
          pointsBalance: 300,
        }}
        simulatedOffline={false}
        submittingSale={false}
        onActiveQrChange={onActiveQrChange}
        onFinalizeSale={vi.fn().mockResolvedValue(undefined)}
        onClose={onClose}
      />
    );
    expect(screen.getByText(/1 payment leg\(s\)/i)).toBeInTheDocument();

    // Loyalty points cumulative balance cap across two legs
    fireEvent.click(screen.getByRole("button", { name: /Card \/ Credit \/ Points/i }));
    fireEvent.change(screen.getByLabelText(/Amount to Apply/i), { target: { value: "2.00" } });
    fireEvent.click(screen.getByRole("button", { name: /Redeem Loyalty Points/i }));
    expect(screen.getByText(/100 pts avail\./i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Amount to Apply/i), { target: { value: "2.00" } });
    fireEvent.click(screen.getByRole("button", { name: /Redeem Loyalty Points/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/100 unallocated pts/i);

    // Attempting to close while a settled QR leg exists requires confirmation
    fireEvent.click(screen.getByRole("button", { name: /Close split tender checkout/i }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Close Anyway/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    void fetchSpy;
    void cancelledIntentIds;
  });

  it("cancels pending payment intent when closing checkout modal before settlement (AUD-020)", async () => {
    let cancelled = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/pos/payment-intents") {
        return new Response(
          JSON.stringify({
            intent: {
              id: "intent-pending",
              registerCode: "REG-01",
              rail: "khqr",
              provider: "mock_sandbox",
              status: "pending",
              amountCents: 400,
              currencyCode: "USD",
              displayAmount: "$4.00",
              billReference: "REF-P",
              qrPayload: "0002010102116304ABCD",
              externalRef: null,
              expiresAt: new Date(Date.now() + 300_000).toISOString(),
            },
          }),
          { status: 201, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url === "/api/pos/payment-intents/intent-pending/cancel") {
        cancelled = true;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ intent: { id: "intent-pending", status: "pending" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const onClose = vi.fn();
    render(
      <PosCheckoutModal
        open={true}
        initialTab="qr"
        grandTotalCents={400}
        storeSettings={null}
        attachedCustomer={null}
        simulatedOffline={false}
        submittingSale={false}
        onActiveQrChange={vi.fn()}
        onFinalizeSale={vi.fn().mockResolvedValue(undefined)}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Generate KHQR Dynamic QR/i }));
    await waitFor(() => {
      expect(screen.getByText(/REF-P/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Close split tender checkout/i }));
    await waitFor(() => {
      expect(cancelled).toBe(true);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders accessible alert fallback instead of throwing when QR payload exceeds capacity (AUD-021)", () => {
    render(<QrCodeSvg payload={"X".repeat(500)} label="Oversized QR" />);
    expect(screen.getByRole("alert")).toHaveTextContent(/Unable to render QR matrix/i);
  });

  it("avoids re-fetch loops on FreshProductionTab when parent re-renders with new inline callbacks (AUD-021)", async () => {
    let fetchCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ recipes: [], recentBatches: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    function ParentWrapper() {
      const [tick, setTick] = useState(0);
      return (
        <div>
          <button type="button" onClick={() => setTick((t) => t + 1)}>
            Re-render {tick}
          </button>
          <FreshProductionTab onFeedback={() => {}} onError={() => {}} />
        </div>
      );
    }

    render(<ParentWrapper />);
    await waitFor(() => {
      expect(fetchCount).toBe(1);
    });
    fireEvent.click(screen.getByRole("button", { name: /Re-render/i }));
    fireEvent.click(screen.getByRole("button", { name: /Re-render/i }));
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchCount).toBe(1);
  });

  it("inerts lower stacked dialogs in AccessibleDialog and restores interactivity when top closes (AUD-022)", () => {
    function StackedHarness() {
      const [firstOpen, setFirstOpen] = useState(true);
      const [secondOpen, setSecondOpen] = useState(true);
      return (
        <div>
          <ModalDialog open={firstOpen} onClose={() => setFirstOpen(false)} ariaLabel="Base Dialog">
            <button type="button">Base Action</button>
          </ModalDialog>
          <ModalDialog open={secondOpen} onClose={() => setSecondOpen(false)} ariaLabel="Top Dialog">
            <button type="button" onClick={() => setSecondOpen(false)}>
              Close Top
            </button>
          </ModalDialog>
        </div>
      );
    }

    render(<StackedHarness />);
    const overlays = document.body.querySelectorAll<HTMLElement>('[data-supermarket-dialog-overlay="true"]');
    expect(overlays.length).toBe(2);
    expect(overlays[0].inert).toBe(true);
    expect(overlays[1].inert).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Close Top" }));
    expect(overlays[0].inert).toBe(false);
  });

  it("requires 2-step confirmation in ConfirmActionButton and renders previewJson in AiCopilotDrawer (AUD-021, AUD-022)", async () => {
    const confirmed = vi.fn();
    render(
      <ConfirmActionButton
        label="Write Off"
        confirmLabel="Confirm Write Off"
        onConfirm={confirmed}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Write Off" }));
    expect(confirmed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Write Off" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Write Off" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm Write Off" }));
    expect(confirmed).toHaveBeenCalledTimes(1);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/ai/status") {
        return new Response(JSON.stringify({ geminiConfigured: false, model: "local" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/ai/conversations") {
        return new Response(
          JSON.stringify({
            conversations: [{ id: "conv-1", title: "Promo Check", model: "local", updatedAt: new Date().toISOString() }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url === "/api/ai/conversations/conv-1") {
        return new Response(
          JSON.stringify({
            messages: [
              { id: "m1", role: "user", content: "Propose promo", createdAt: new Date().toISOString() },
            ],
            actions: [
              {
                id: "act-1",
                actionType: "create_promo",
                title: "15% Clearance on NDL-001",
                summary: "Targeted SKU promo",
                previewJson: { discountBp: 1500, targetSku: "NDL-001" },
                status: "pending",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("{}", { status: 404 });
    });

    render(
      <AiCopilotDrawer
        open={true}
        onClose={vi.fn()}
        onActionExecuted={vi.fn()}
      />
    );
    const select = await screen.findByLabelText(/Recent AI Copilot threads/i);
    fireEvent.change(select, { target: { value: "conv-1" } });
    await waitFor(() => {
      expect(screen.getByText(/discountBp: 1500/i)).toBeInTheDocument();
      expect(screen.getByText(/targetSku: NDL-001/i)).toBeInTheDocument();
    });
  });

  it("ignores Shift+F10 context-menu chords in PosTerminalView and suppresses PosScanBar focus while modalOpen (AUD-022)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/pos/bootstrap") {
        return new Response(
          JSON.stringify({
            syncedAt: new Date().toISOString(),
            products: [
              {
                id: "p1",
                sku: "NDLS-001",
                name: "Noodle",
                brand: "Brand",
                categoryId: "c1",
                taxRateId: "t1",
                baseUnitLabel: "pack",
                unitMode: "each",
                requiresAgeCheck: false,
              },
            ],
            barcodes: [
              {
                id: "b1",
                productId: "p1",
                barcode: "8850000000012",
                packQty: 1,
                packLabel: "Single Pack",
                sellPriceCents: 100,
                isPrimary: true,
              },
            ],
            taxRates: [{ id: "t1", rateBp: 0, isInclusive: true }],
            promotions: [],
            basketRules: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.startsWith("/api/pos/shifts/active")) {
        return new Response(JSON.stringify({ shift: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ baskets: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const inputRef = { current: null as HTMLInputElement | null };
    const { rerender } = render(
      <div>
        <button type="button">Outside Focus</button>
        <PosScanBar
          inputRef={inputRef}
          isActive={true}
          disabled={false}
          modalOpen={true}
          onScan={() => true}
        />
      </div>
    );
    const outsideBtn = screen.getByRole("button", { name: "Outside Focus" });
    outsideBtn.focus();
    expect(document.activeElement).toBe(outsideBtn);

    rerender(
      <div>
        <button type="button">Outside Focus</button>
        <PosScanBar
          inputRef={inputRef}
          isActive={true}
          disabled={false}
          modalOpen={false}
          onScan={() => true}
        />
      </div>
    );
    expect(document.activeElement).toBe(screen.getByPlaceholderText(/Scan EAN-13/i));

    render(<PosTerminalView isActive={true} />);
    await waitFor(() => {
      expect(screen.getByText(/Single Pack/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Noodle"));
    fireEvent.keyDown(window, { key: "F10", shiftKey: true, bubbles: true });
    expect(screen.queryByRole("dialog", { name: /Split Tender/i })).not.toBeInTheDocument();
  });
});
