import { useCallback, useEffect, useRef, useState } from "react";
import type { PaymentIntentDto, StoreSettingsDto } from "@supermarket/shared/dtos";
import {
  convertFromSecondaryToPrimaryCents,
  convertToSecondaryCurrency,
  formatCurrency,
  formatMoney,
  generateUuidV7,
} from "@supermarket/shared/money";
import {
  Banknote,
  CheckCircle2,
  CreditCard,
  QrCode,
  RefreshCw,
  Trash2,
  Wallet,
  X,
} from "lucide-react";
import { apiGet, apiPost } from "../api";
import type { CfdActiveQr } from "../lib/cfdChannel";
import type { QueuedPosPayment } from "../lib/posCache";
import { ModalDialog } from "./AccessibleDialog";
import type { PosCustomer } from "./PosLoyaltyCard";
import { QrCodeSvg } from "./QrCodeSvg";

export type CheckoutTab = "qr" | "cash" | "other";

export function PosCheckoutModal({
  open,
  initialTab = "qr",
  grandTotalCents,
  storeSettings,
  attachedCustomer,
  simulatedOffline,
  submittingSale,
  onActiveQrChange,
  onFinalizeSale,
  onClose,
}: {
  open: boolean;
  initialTab?: CheckoutTab;
  grandTotalCents: number;
  storeSettings: StoreSettingsDto | null;
  attachedCustomer: PosCustomer | null;
  simulatedOffline: boolean;
  submittingSale: boolean;
  onActiveQrChange: (qr: CfdActiveQr | null) => void;
  onFinalizeSale: (payments: QueuedPosPayment[]) => Promise<void>;
  onClose: () => void;
}) {
  const primaryCurrency = storeSettings?.primaryCurrency ?? "USD";
  const secondaryCurrency = storeSettings?.secondaryCurrency ?? "KHR";
  const fxRate = storeSettings?.secondaryFxRate ?? 4100;
  const roundingStep = storeSettings?.secondaryRoundingStep ?? 100;

  const [tab, setTab] = useState<CheckoutTab>(initialTab);
  const [legs, setLegs] = useState<QueuedPosPayment[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Dual-currency Cash state
  const [cashPrimaryInput, setCashPrimaryInput] = useState("");
  const [cashSecondaryInput, setCashSecondaryInput] = useState("0");

  // EMVCo QR state
  const [qrRail, setQrRail] = useState<"khqr" | "promptpay" | "paynow">(
    storeSettings?.defaultQrRail ?? "khqr"
  );
  const [khqrCurrency, setKhqrCurrency] = useState<"USD" | "KHR">("USD");
  const [qrAmountInput, setQrAmountInput] = useState("");
  const [activeIntent, setActiveIntent] = useState<PaymentIntentDto | null>(null);
  const [qrBusy, setQrBusy] = useState(false);

  // Card / Store Credit / Loyalty Points state
  const [otherAmountInput, setOtherAmountInput] = useState("");
  const [confirmCloseSettled, setConfirmCloseSettled] = useState(false);

  const wasOpenRef = useRef(false);
  const isOpenRef = useRef(open);
  isOpenRef.current = open;
  const qrReqSeqRef = useRef(0);
  const qrActionAbortRef = useRef<AbortController | null>(null);

  const cancelPendingIntent = useCallback(
    (intent: PaymentIntentDto | null) => {
      if (!intent || intent.status !== "pending" || simulatedOffline) return;
      void apiPost(`/api/pos/payment-intents/${intent.id}/cancel`, {}).catch(() => {});
    },
    [simulatedOffline]
  );

  const paidSoFarCents = legs.reduce((s, p) => s + p.amountCents, 0);
  const remainingCents = Math.max(0, grandTotalCents - paidSoFarCents);
  const remainingSecondary = secondaryCurrency
    ? convertToSecondaryCurrency(remainingCents, fxRate, roundingStep)
    : 0;
  const usedLoyaltyPts = legs
    .filter((l) => l.method === "loyalty_points")
    .reduce((s, l) => s + l.amountCents, 0);
  const availableLoyaltyPts = attachedCustomer
    ? Math.max(0, attachedCustomer.pointsBalance - usedLoyaltyPts)
    : 0;
  const hasSettledQrLegs = legs.some((l) => Boolean(l.paymentIntentId));

  // Initialize checkout modal strictly on open transition (never wipe settled legs on grandTotalCents/clock ticks)
  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      qrActionAbortRef.current?.abort();
      return;
    }
    if (!wasOpenRef.current) {
      wasOpenRef.current = true;
      setTab(initialTab);
      setLegs([]);
      setError(null);
      setActiveIntent(null);
      setConfirmCloseSettled(false);
      setQrRail(storeSettings?.defaultQrRail ?? "khqr");
      const remStr = (grandTotalCents / 100).toFixed(2);
      setCashPrimaryInput(remStr);
      setCashSecondaryInput("0");
      setQrAmountInput(remStr);
      setOtherAmountInput(remStr);
      onActiveQrChange(null);
    }
  }, [open, initialTab, grandTotalCents, storeSettings?.defaultQrRail, onActiveQrChange]);

  // Keep amount inputs synced to remaining balance after each partial tender leg
  useEffect(() => {
    if (!open) return;
    const remStr = (remainingCents / 100).toFixed(2);
    setCashPrimaryInput(remStr);
    setCashSecondaryInput("0");
    setQrAmountInput(remStr);
    setOtherAmountInput(remStr);
  }, [remainingCents, open]);

  const activeIntentId = activeIntent?.id ?? null;
  const activeIntentStatus = activeIntent?.status ?? null;

  // Poll pending payment intent every 1.5s until settled/expired/cancelled
  useEffect(() => {
    if (!open || !activeIntentId || activeIntentStatus !== "pending") return;
    let cancelled = false;
    let pollController: AbortController | null = null;
    const timer = window.setInterval(() => {
      pollController?.abort();
      const controller = new AbortController();
      pollController = controller;
      void (async () => {
        try {
          const res = await apiGet<{ intent: PaymentIntentDto }>(
            `/api/pos/payment-intents/${activeIntentId}`,
            controller.signal
          );
          if (cancelled || controller.signal.aborted || !isOpenRef.current) return;
          setActiveIntent(res.intent);
          onActiveQrChange({
            intentId: res.intent.id,
            rail: res.intent.rail,
            displayAmount: res.intent.displayAmount,
            currencyCode: res.intent.currencyCode,
            billReference: res.intent.billReference,
            qrPayload: res.intent.qrPayload,
            status: res.intent.status,
            externalRef: res.intent.externalRef,
            expiresAt: res.intent.expiresAt,
          });
          if (res.intent.status === "paid") {
            setLegs((prev) => {
              if (prev.some((l) => l.paymentIntentId === res.intent.id)) return prev;
              return [
                ...prev,
                {
                  id: generateUuidV7(),
                  method:
                    res.intent.rail === "card_terminal" ? "card" : res.intent.rail,
                  amountCents: res.intent.amountCents,
                  tenderedCents: res.intent.amountCents,
                  changeCents: 0,
                  externalRef: res.intent.externalRef,
                  paymentIntentId: res.intent.id,
                  currencyCode: res.intent.currencyCode,
                },
              ];
            });
          }
        } catch {
          // ignore transient poll hiccup or abort
        }
      })();
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      pollController?.abort();
    };
  }, [open, activeIntentId, activeIntentStatus, onActiveQrChange]);

  const handleGenerateQr = async () => {
    if (qrBusy || remainingCents <= 0) return;
    if (simulatedOffline) {
      setError("Dynamic EMVCo QR generation requires live API connectivity.");
      return;
    }
    const parsedUsd = Number(qrAmountInput);
    const amountCents = Math.round(parsedUsd * 100);
    if (!Number.isFinite(parsedUsd) || amountCents < 1 || amountCents > remainingCents) {
      setError(
        `QR amount must be between $0.01 and remaining balance (${formatMoney(remainingCents)}).`
      );
      return;
    }
    if (activeIntent?.status === "pending") {
      cancelPendingIntent(activeIntent);
    }
    qrActionAbortRef.current?.abort();
    const controller = new AbortController();
    qrActionAbortRef.current = controller;
    const seq = ++qrReqSeqRef.current;

    setQrBusy(true);
    setError(null);
    try {
      const currencyCode =
        qrRail === "khqr" ? khqrCurrency : qrRail === "promptpay" ? "THB" : "SGD";
      const res = await apiPost<{ intent: PaymentIntentDto }>(
        "/api/pos/payment-intents",
        {
          registerCode: "REG-01",
          rail: qrRail,
          amountCents,
          currencyCode,
        },
        controller.signal
      );
      if (controller.signal.aborted || qrReqSeqRef.current !== seq || !isOpenRef.current) return;
      setActiveIntent(res.intent);
      onActiveQrChange({
        intentId: res.intent.id,
        rail: res.intent.rail,
        displayAmount: res.intent.displayAmount,
        currencyCode: res.intent.currencyCode,
        billReference: res.intent.billReference,
        qrPayload: res.intent.qrPayload,
        status: res.intent.status,
        externalRef: res.intent.externalRef,
        expiresAt: res.intent.expiresAt,
      });
    } catch (err) {
      if ((err as Error).name !== "AbortError" && qrReqSeqRef.current === seq && isOpenRef.current) {
        setError(err instanceof Error ? err.message : "Failed generating EMVCo QR payment intent");
      }
    } finally {
      if (qrActionAbortRef.current === controller) qrActionAbortRef.current = null;
      if (qrReqSeqRef.current === seq || !isOpenRef.current) {
        setQrBusy(false);
      }
    }
  };

  const handleSimulateSettle = async () => {
    if (!activeIntent || qrBusy) return;
    qrActionAbortRef.current?.abort();
    const controller = new AbortController();
    qrActionAbortRef.current = controller;
    const seq = ++qrReqSeqRef.current;
    const targetIntentId = activeIntent.id;

    setQrBusy(true);
    setError(null);
    try {
      const res = await apiPost<{ intent: PaymentIntentDto }>(
        `/api/pos/payment-intents/${targetIntentId}/simulate-settle`,
        {},
        controller.signal
      );
      if (controller.signal.aborted || qrReqSeqRef.current !== seq || !isOpenRef.current) return;
      setActiveIntent(res.intent);
      onActiveQrChange({
        intentId: res.intent.id,
        rail: res.intent.rail,
        displayAmount: res.intent.displayAmount,
        currencyCode: res.intent.currencyCode,
        billReference: res.intent.billReference,
        qrPayload: res.intent.qrPayload,
        status: res.intent.status,
        externalRef: res.intent.externalRef,
        expiresAt: res.intent.expiresAt,
      });
      if (res.intent.status === "paid") {
        setLegs((prev) => {
          if (prev.some((l) => l.paymentIntentId === res.intent.id)) return prev;
          return [
            ...prev,
            {
              id: generateUuidV7(),
              method: res.intent.rail === "card_terminal" ? "card" : res.intent.rail,
              amountCents: res.intent.amountCents,
              tenderedCents: res.intent.amountCents,
              changeCents: 0,
              externalRef: res.intent.externalRef,
              paymentIntentId: res.intent.id,
              currencyCode: res.intent.currencyCode,
            },
          ];
        });
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError" && qrReqSeqRef.current === seq && isOpenRef.current) {
        setError(err instanceof Error ? err.message : "Failed settling sandbox payment intent");
      }
    } finally {
      if (qrActionAbortRef.current === controller) qrActionAbortRef.current = null;
      if (qrReqSeqRef.current === seq || !isOpenRef.current) {
        setQrBusy(false);
      }
    }
  };

  // Dual-currency cash preview
  const parsedPrimaryCash = Math.max(0, Math.round((Number(cashPrimaryInput) || 0) * 100));
  const parsedSecondaryCash = Math.max(0, Math.round(Number(cashSecondaryInput) || 0));
  const secondaryInPrimaryCents =
    secondaryCurrency && parsedSecondaryCash > 0
      ? convertFromSecondaryToPrimaryCents(parsedSecondaryCash, fxRate)
      : 0;
  const totalCashTenderedCents = parsedPrimaryCash + secondaryInPrimaryCents;
  const appliedCashCents = Math.min(remainingCents, totalCashTenderedCents);
  const cashChangePrimaryCents = Math.max(0, totalCashTenderedCents - appliedCashCents);
  const cashChangeSecondary =
    secondaryCurrency && cashChangePrimaryCents > 0
      ? convertToSecondaryCurrency(cashChangePrimaryCents, fxRate, roundingStep)
      : 0;

  const handleApplyCash = () => {
    setError(null);
    if (appliedCashCents < 1) {
      setError("Enter a positive USD or secondary-currency cash amount.");
      return;
    }
    setLegs((prev) => [
      ...prev,
      {
        id: generateUuidV7(),
        method: "cash",
        amountCents: appliedCashCents,
        tenderedCents: totalCashTenderedCents,
        changeCents: cashChangePrimaryCents,
        currencyCode: parsedSecondaryCash > 0 && parsedPrimaryCash === 0 && secondaryCurrency
          ? secondaryCurrency
          : primaryCurrency,
        foreignAmount: parsedSecondaryCash > 0 ? parsedSecondaryCash : null,
        fxRateUsed: parsedSecondaryCash > 0 ? fxRate : null,
      },
    ]);
  };

  const handleApplyOther = (method: "card" | "store_credit" | "loyalty_points") => {
    setError(null);
    const parsed = Math.round((Number(otherAmountInput) || 0) * 100);
    if (parsed < 1 || parsed > remainingCents) {
      setError(`Amount must be between $0.01 and ${formatMoney(remainingCents)}.`);
      return;
    }
    if (method === "loyalty_points") {
      if (!attachedCustomer) {
        setError("Attach a loyalty member in the basket first to redeem loyalty points.");
        return;
      }
      if (availableLoyaltyPts < parsed) {
        setError(
          `Member has ${availableLoyaltyPts} unallocated pts (${formatMoney(availableLoyaltyPts)}), insufficient for ${formatMoney(parsed)}.`
        );
        return;
      }
    }
    setLegs((prev) => [
      ...prev,
      {
        id: generateUuidV7(),
        method,
        amountCents: parsed,
        tenderedCents: parsed,
        changeCents: 0,
        currencyCode: primaryCurrency,
      },
    ]);
  };

  const handleRequestClose = (force = false) => {
    if (!force && hasSettledQrLegs) {
      setConfirmCloseSettled(true);
      return;
    }
    cancelPendingIntent(activeIntent);
    qrActionAbortRef.current?.abort();
    qrReqSeqRef.current += 1;
    setConfirmCloseSettled(false);
    setActiveIntent(null);
    onActiveQrChange(null);
    onClose();
  };

  return (
    <ModalDialog
      open={open}
      onClose={() => handleRequestClose(false)}
      labelledBy="pos-checkout-modal-title"
      style={{ maxWidth: 820 }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div>
          <h2 id="pos-checkout-modal-title" style={{ margin: 0, fontSize: 18 }}>
            Split Tender &amp; SE Asia EMVCo QR Checkout
          </h2>
          <p className="page-subtitle" style={{ marginTop: 2 }}>
            Combine dual-currency cash ({primaryCurrency}
            {secondaryCurrency ? ` + ${secondaryCurrency} @ ${fxRate.toLocaleString()}` : ""}), KHQR / PromptPay / PayNow, card, store credit, or loyalty points on one receipt.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          aria-label="Close split tender checkout"
          onClick={() => handleRequestClose(false)}
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>

      {confirmCloseSettled && (
        <div className="banner banner-red" role="alert">
          <span>
            This basket already has a settled bank QR payment leg. Closing now will leave the paid leg uncommitted on POS.
          </span>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setConfirmCloseSettled(false)}
            >
              Keep Checkout Open
            </button>
            <button
              id="confirm-close-settled-checkout-btn"
              type="button"
              className="btn btn-danger btn-sm"
              onClick={() => handleRequestClose(true)}
            >
              Close Anyway
            </button>
          </div>
        </div>
      )}

      {paidSoFarCents > grandTotalCents && (
        <div className="banner banner-amber" role="status">
          <span>
            Basket total changed ({formatMoney(grandTotalCents)}) below applied tenders ({formatMoney(paidSoFarCents)}). Review or remove adjustable tender legs before finalizing.
          </span>
        </div>
      )}

      {/* Live Split Tender Summary Strip */}
      <div className="kpi-strip" style={{ marginBottom: 0 }}>
        <div className="kpi-tile">
          <div className="kpi-label">Receipt Total</div>
          <div className="kpi-value" style={{ fontSize: 20 }}>
            {formatCurrency(grandTotalCents, primaryCurrency)}
          </div>
          {secondaryCurrency && (
            <div className="kpi-sub mono">
              ≈ {formatCurrency(convertToSecondaryCurrency(grandTotalCents, fxRate, roundingStep), secondaryCurrency)}
            </div>
          )}
        </div>
        <div className="kpi-tile">
          <div className="kpi-label">Applied Tender</div>
          <div className="kpi-value" style={{ fontSize: 20, color: "var(--accent-primary-ink)" }}>
            {formatCurrency(paidSoFarCents, primaryCurrency)}
          </div>
          <div className="kpi-sub">{legs.length} payment leg(s)</div>
        </div>
        <div className="kpi-tile">
          <div className="kpi-label">Remaining Due</div>
          <div
            className="kpi-value"
            style={{
              fontSize: 20,
              color: remainingCents === 0 ? "var(--accent-primary-ink)" : "var(--accent-amber-ink)",
            }}
          >
            {formatCurrency(remainingCents, primaryCurrency)}
          </div>
          {secondaryCurrency && remainingCents > 0 && (
            <div className="kpi-sub mono">≈ {formatCurrency(remainingSecondary, secondaryCurrency)}</div>
          )}
        </div>
      </div>

      {error && (
        <div className="banner banner-red" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn-sm" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {/* Tender Mode Switcher */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }} role="group" aria-label="Payment method category">
        <button
          id="checkout-tab-qr"
          type="button"
          className={`btn btn-sm ${tab === "qr" ? "btn-primary" : ""}`}
          aria-pressed={tab === "qr"}
          onClick={() => setTab("qr")}
        >
          <QrCode size={14} aria-hidden="true" /> KHQR / PromptPay / PayNow
        </button>
        <button
          id="checkout-tab-cash"
          type="button"
          className={`btn btn-sm ${tab === "cash" ? "btn-primary" : ""}`}
          aria-pressed={tab === "cash"}
          onClick={() => setTab("cash")}
        >
          <Banknote size={14} aria-hidden="true" /> Dual-Currency Cash ({primaryCurrency}
          {secondaryCurrency ? `/${secondaryCurrency}` : ""})
        </button>
        <button
          id="checkout-tab-other"
          type="button"
          className={`btn btn-sm ${tab === "other" ? "btn-primary" : ""}`}
          aria-pressed={tab === "other"}
          onClick={() => setTab("other")}
        >
          <CreditCard size={14} aria-hidden="true" /> Card / Credit / Points
        </button>
      </div>

      {/* Tab 1: SE Asia EMVCo QR */}
      {tab === "qr" && remainingCents > 0 && (
        <div className="panel" style={{ background: "var(--bg-canvas)", margin: 0 }}>
          <div className="form-grid" style={{ marginBottom: 12 }}>
            <div className="field">
              <label htmlFor="qr-rail-select">SE Asia EMVCo QR Rail</label>
              <select
                id="qr-rail-select"
                className="select"
                value={qrRail}
                disabled={qrBusy}
                onChange={(e) => {
                  cancelPendingIntent(activeIntent);
                  qrActionAbortRef.current?.abort();
                  qrReqSeqRef.current += 1;
                  setQrRail(e.target.value as "khqr" | "promptpay" | "paynow");
                  setActiveIntent(null);
                  onActiveQrChange(null);
                }}
              >
                <option value="khqr">KHQR (Cambodia Bakong · USD / KHR)</option>
                <option value="promptpay">PromptPay (Thailand BOT · THB)</option>
                <option value="paynow">PayNow (Singapore ABS · SGD)</option>
              </select>
            </div>
            {qrRail === "khqr" && (
              <div className="field">
                <label htmlFor="khqr-currency-select">KHQR Currency</label>
                <select
                  id="khqr-currency-select"
                  className="select"
                  value={khqrCurrency}
                  disabled={qrBusy}
                  onChange={(e) => {
                    cancelPendingIntent(activeIntent);
                    qrActionAbortRef.current?.abort();
                    qrReqSeqRef.current += 1;
                    setKhqrCurrency(e.target.value as "USD" | "KHR");
                    setActiveIntent(null);
                    onActiveQrChange(null);
                  }}
                >
                  <option value="USD">USD (ISO 840)</option>
                  <option value="KHR">KHR (ISO 116 · @ {fxRate.toLocaleString()})</option>
                </select>
              </div>
            )}
            <div className="field">
              <label htmlFor="qr-amount-input">QR Tender Amount ({primaryCurrency})</label>
              <input
                id="qr-amount-input"
                type="number"
                step="0.01"
                min="0.01"
                className="input mono"
                value={qrAmountInput}
                disabled={qrBusy}
                onChange={(e) => setQrAmountInput(e.target.value)}
              />
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: activeIntent ? 14 : 0 }}>
            <button
              id="qr-generate-btn"
              type="button"
              className="btn btn-primary"
              disabled={qrBusy || simulatedOffline}
              onClick={() => void handleGenerateQr()}
            >
              <QrCode size={14} aria-hidden="true" />{" "}
              {qrBusy ? "Generating EMVCo QR..." : `Generate ${qrRail.toUpperCase()} Dynamic QR`}
            </button>
          </div>

          {activeIntent && (
            <div
              style={{
                display: "flex",
                gap: 16,
                flexWrap: "wrap",
                alignItems: "center",
                padding: 12,
                borderRadius: 10,
                border: "1px solid var(--border-hairline)",
                background: "var(--bg-surface)",
              }}
            >
              {activeIntent.qrPayload && (
                <QrCodeSvg
                  payload={activeIntent.qrPayload}
                  sizePx={188}
                  label={`${activeIntent.rail.toUpperCase()} QR code for ${activeIntent.displayAmount}`}
                />
              )}
              <div style={{ flex: "1 1 240px", display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                  <span className="tag tag-blue mono">{activeIntent.rail.toUpperCase()}</span>
                  <span
                    className={`tag mono ${
                      activeIntent.status === "paid"
                        ? "tag-green"
                        : activeIntent.status === "pending"
                          ? "tag-amber"
                          : "tag-red"
                    }`}
                  >
                    {activeIntent.status.toUpperCase()}
                  </span>
                  <span className="mono" style={{ fontSize: 12, color: "var(--ink-muted)" }}>
                    Ref: {activeIntent.billReference}
                  </span>
                </div>
                <div className="mono" style={{ fontSize: 22, fontWeight: 700, color: "var(--accent-primary-ink)" }}>
                  {activeIntent.displayAmount}
                </div>
                <div style={{ fontSize: 12, color: "var(--ink-secondary)" }}>
                  Mirrored live to Customer-Facing Display (<code>/customer-display</code>). CRC-16 EMVCo TLV verified.
                </div>
                {activeIntent.externalRef && (
                  <div className="mono" style={{ fontSize: 12, color: "var(--accent-primary-ink)" }}>
                    Settled Ref: {activeIntent.externalRef}
                  </div>
                )}
                {activeIntent.status === "pending" && (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
                    {activeIntent.provider === "mock_sandbox" && (
                      <button
                        id="qr-simulate-settle-btn"
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={qrBusy}
                        onClick={() => void handleSimulateSettle()}
                      >
                        <CheckCircle2 size={13} aria-hidden="true" /> Simulate Bank Settlement (Sandbox)
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={qrBusy}
                      onClick={() => void handleGenerateQr()}
                    >
                      <RefreshCw size={13} aria-hidden="true" /> Regenerate
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tab 2: Dual-Currency Cash */}
      {tab === "cash" && remainingCents > 0 && (
        <div className="panel" style={{ background: "var(--bg-canvas)", margin: 0 }}>
          <div className="form-grid" style={{ marginBottom: 12 }}>
            <div className="field">
              <label htmlFor="split-cash-primary-input">Cash Tendered ({primaryCurrency})</label>
              <input
                id="split-cash-primary-input"
                type="number"
                step="0.01"
                min="0"
                className="input mono"
                value={cashPrimaryInput}
                onChange={(e) => setCashPrimaryInput(e.target.value)}
              />
            </div>
            {secondaryCurrency && (
              <div className="field">
                <label htmlFor="split-cash-secondary-input">
                  Cash Tendered ({secondaryCurrency} @ {fxRate.toLocaleString()})
                </label>
                <input
                  id="split-cash-secondary-input"
                  type="number"
                  step={String(roundingStep)}
                  min="0"
                  className="input mono"
                  value={cashSecondaryInput}
                  onChange={(e) => setCashSecondaryInput(e.target.value)}
                />
              </div>
            )}
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 10,
              padding: "10px 12px",
              borderRadius: 8,
              border: "1px solid var(--border-hairline)",
              background: "var(--bg-surface)",
              marginBottom: 12,
            }}
          >
            <div className="mono" style={{ fontSize: 12.5 }}>
              Total Cash Value: <strong>{formatCurrency(totalCashTenderedCents, primaryCurrency)}</strong>
              {" · "}Change Due:{" "}
              <strong style={{ color: "var(--accent-primary-ink)" }}>
                {formatCurrency(cashChangePrimaryCents, primaryCurrency)}
              </strong>
              {secondaryCurrency && cashChangeSecondary > 0
                ? ` (${formatCurrency(cashChangeSecondary, secondaryCurrency)})`
                : ""}
            </div>
            <button
              id="split-add-cash-btn"
              type="button"
              className="btn btn-primary btn-sm"
              disabled={appliedCashCents < 1}
              onClick={handleApplyCash}
            >
              <Banknote size={13} aria-hidden="true" /> Apply {formatCurrency(appliedCashCents, primaryCurrency)} Cash
            </button>
          </div>
        </div>
      )}

      {/* Tab 3: Card / Store Credit / Loyalty Points */}
      {tab === "other" && remainingCents > 0 && (
        <div className="panel" style={{ background: "var(--bg-canvas)", margin: 0 }}>
          <div className="field" style={{ marginBottom: 12, maxWidth: 260 }}>
            <label htmlFor="split-other-amount-input">Amount to Apply ({primaryCurrency})</label>
            <input
              id="split-other-amount-input"
              type="number"
              step="0.01"
              min="0.01"
              className="input mono"
              value={otherAmountInput}
              onChange={(e) => setOtherAmountInput(e.target.value)}
            />
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              id="split-add-card-btn"
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => handleApplyOther("card")}
            >
              <CreditCard size={13} aria-hidden="true" /> Apply Card Terminal
            </button>
            <button
              id="split-add-credit-btn"
              type="button"
              className="btn btn-sm"
              onClick={() => handleApplyOther("store_credit")}
            >
              <Wallet size={13} aria-hidden="true" /> Apply Store Credit / Voucher
            </button>
            <button
              id="split-add-points-btn"
              type="button"
              className="btn btn-sm"
              disabled={!attachedCustomer || availableLoyaltyPts < 1}
              onClick={() => handleApplyOther("loyalty_points")}
            >
              Redeem Loyalty Points
              {attachedCustomer ? ` (${availableLoyaltyPts} pts avail.)` : " (Attach Member)"}
            </button>
          </div>
        </div>
      )}

      {/* Applied Tender Legs */}
      {legs.length > 0 && (
        <div className="table-wrap" role="region" aria-label="Applied split tender payment legs" tabIndex={0}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Method</th>
                <th>Reference / FX</th>
                <th className="text-right">Applied</th>
                <th className="text-right">Change</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {legs.map((leg) => (
                <tr key={leg.id}>
                  <td>
                    <span className="tag tag-green mono">{leg.method.toUpperCase()}</span>
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {leg.externalRef
                      ? leg.externalRef
                      : leg.foreignAmount && secondaryCurrency
                        ? `${formatCurrency(leg.foreignAmount, secondaryCurrency)} @ ${leg.fxRateUsed}`
                        : leg.currencyCode ?? primaryCurrency}
                  </td>
                  <td className="text-right mono" style={{ fontWeight: 600 }}>
                    {formatCurrency(leg.amountCents, primaryCurrency)}
                  </td>
                  <td className="text-right mono">
                    {leg.changeCents ? formatCurrency(leg.changeCents, primaryCurrency) : "—"}
                  </td>
                  <td className="text-right">
                    {!leg.paymentIntentId && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        aria-label={`Remove ${leg.method} payment leg`}
                        onClick={() => setLegs((prev) => prev.filter((p) => p.id !== leg.id))}
                      >
                        <Trash2 size={12} aria-hidden="true" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: "var(--ink-secondary)" }}>
          {remainingCents === 0
            ? "Full balance covered — ready to commit immutable receipt."
            : `Apply ${formatCurrency(remainingCents, primaryCurrency)} more to finalize receipt.`}
        </span>
        <button
          id="finalize-split-sale-btn"
          type="button"
          className="btn btn-primary"
          disabled={remainingCents > 0 || legs.length === 0 || submittingSale}
          onClick={() => void onFinalizeSale(legs)}
        >
          <CheckCircle2 size={14} aria-hidden="true" />{" "}
          {submittingSale ? "Finalizing..." : `Finalize Receipt (${formatCurrency(grandTotalCents, primaryCurrency)})`}
        </button>
      </div>
    </ModalDialog>
  );
}
