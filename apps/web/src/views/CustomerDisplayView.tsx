import { useEffect, useState } from "react";
import {
  convertToSecondaryCurrency,
  formatCurrency,
  formatMeasure,
} from "@supermarket/shared/money";
import { CheckCircle2, Monitor, QrCode, ShoppingBag, Sparkles } from "lucide-react";
import { QrCodeSvg } from "../components/QrCodeSvg";
import { ThemeSwitcher } from "../components/ThemeSwitcher";
import {
  readCfdState,
  subscribeCfdState,
  type CfdStatePayload,
} from "../lib/cfdChannel";
import { useSpatial3DPanels } from "../lib/spatial3d";
import { useTheme } from "../lib/theme";

const DEFAULT_IDLE_STATE: CfdStatePayload = {
  storeName: "SupermarketOS Flagship Market",
  receiptHeader: "Fresh Produce · Meat · Deli · Bakery · Packaged FMCG",
  receiptFooter: "Thank you for shopping at SupermarketOS Flagship!",
  registerCode: "REG-01",
  cashierName: "Lane 01",
  primaryCurrency: "USD",
  secondaryCurrency: "KHR",
  secondaryFxRate: 4100,
  secondaryRoundingStep: 100,
  status: "idle",
  lines: [],
  subtotalCents: 0,
  discountCents: 0,
  taxCents: 0,
  grandTotalCents: 0,
  activeQr: null,
  lastReceiptNo: null,
  updatedAt: new Date().toISOString(),
};

export function CustomerDisplayView() {
  useSpatial3DPanels();
  const { theme, setTheme } = useTheme();
  const [state, setState] = useState<CfdStatePayload>(
    () => readCfdState() ?? DEFAULT_IDLE_STATE
  );
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    document.title = `${state.storeName} — Customer Display`;
  }, [state.storeName]);

  useEffect(() => {
    const initial = readCfdState();
    if (initial) setState(initial);
    return subscribeCfdState((next) => {
      setState(next ?? DEFAULT_IDLE_STATE);
    });
  }, []);

  const activeQrStatus = state.activeQr?.status ?? null;
  useEffect(() => {
    if (activeQrStatus !== "pending") return;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 5_000);
    return () => window.clearInterval(id);
  }, [activeQrStatus]);

  const isQrExpired = Boolean(
    state.activeQr &&
      state.activeQr.status === "pending" &&
      Number.isFinite(Date.parse(state.activeQr.expiresAt)) &&
      Date.parse(state.activeQr.expiresAt) <= nowMs
  );
  const effectiveQrStatus = isQrExpired ? "expired" : state.activeQr?.status ?? null;

  const secondaryTotal =
    state.secondaryCurrency && state.grandTotalCents > 0
      ? convertToSecondaryCurrency(
          state.grandTotalCents,
          state.secondaryFxRate,
          state.secondaryRoundingStep
        )
      : 0;

  return (
    <div className="cfd-shell">
      <header className="cfd-topbar">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div className="brand-mark" aria-hidden="true">
            S
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontFamily: "var(--font-display)", fontWeight: 800, letterSpacing: "-0.025em" }}>
              {state.storeName}
            </h1>
            <div className="heading-rule" aria-hidden="true" />
            <div style={{ fontSize: 12.5, color: "var(--ink-secondary)" }}>
              {state.receiptHeader}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span className="tag tag-blue mono">
            <Monitor size={12} aria-hidden="true" /> {state.registerCode} · Customer Display
          </span>
          <span
            className={`tag mono ${
              state.status === "paid"
                ? "tag-green"
                : state.status === "awaiting_qr"
                  ? "tag-amber"
                  : "tag-neutral"
            }`}
          >
            {state.status === "paid"
              ? "PAYMENT CONFIRMED"
              : state.status === "awaiting_qr"
                ? "SCAN QR TO PAY"
                : state.status === "ringing"
                  ? "RINGING BASKET"
                  : "WELCOME · READY"}
          </span>
          <ThemeSwitcher theme={theme} onChange={setTheme} variant="surface" />
        </div>
      </header>

      <main className="cfd-grid" aria-live="polite">
        {/* Left: Live Basket Items */}
        <section className="panel cfd-lines-panel" aria-label="Scanned items">
          <div className="panel-header" style={{ marginBottom: 12 }}>
            <div>
              <h2 className="panel-title" style={{ fontSize: 17 }}>
                <ShoppingBag
                  size={16}
                  aria-hidden="true"
                  style={{ verticalAlign: "middle", marginRight: 7 }}
                />
                Your Basket ({state.lines.length} line{state.lines.length === 1 ? "" : "s"})
              </h2>
              <p className="panel-desc">
                Served by {state.cashierName} · Prices include live promotions &amp; member savings.
              </p>
            </div>
          </div>

          {state.status === "paid" && state.lines.length === 0 ? (
            <div
              id="cfd-paid-banner"
              className="banner banner-green"
              role="status"
              style={{
                flexDirection: "column",
                alignItems: "flex-start",
                gap: 8,
                padding: "22px 20px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 20, fontWeight: 700 }}>
                <CheckCircle2 size={24} aria-hidden="true" />
                Thank You! Payment Complete
              </div>
              {state.lastReceiptNo && (
                <div className="mono" style={{ fontSize: 14 }}>
                  Receipt No: <strong>{state.lastReceiptNo}</strong>
                </div>
              )}
              <div style={{ fontSize: 13.5 }}>{state.receiptFooter}</div>
            </div>
          ) : state.lines.length === 0 ? (
            <div
              id="cfd-welcome-card"
              style={{
                padding: "44px 24px",
                textAlign: "center",
                borderRadius: 10,
                border: "1px dashed var(--border-strong)",
                background: "var(--bg-canvas)",
              }}
            >
              <Sparkles
                size={28}
                aria-hidden="true"
                style={{ color: "var(--accent-primary-ink)", marginBottom: 10 }}
              />
              <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>
                Welcome to {state.storeName}
              </div>
              <p style={{ margin: 0, color: "var(--ink-secondary)", fontSize: 14 }}>
                Your items, automatic promotions, and instant KHQR / PromptPay / PayNow QR payment codes will appear here as the cashier scans.
              </p>
            </div>
          ) : (
            <div className="table-wrap" role="region" aria-label="Live customer basket lines" tabIndex={0}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Qty / Weight</th>
                    <th className="text-right">Savings</th>
                    <th className="text-right">Line Total</th>
                  </tr>
                </thead>
                <tbody>
                  {state.lines.map((line) => {
                    const isWeighted =
                      (line.unitMode === "weight_g" || line.unitMode === "volume_ml") &&
                      typeof line.weightGrams === "number" &&
                      line.weightGrams > 0;
                    return (
                      <tr key={line.lineKey}>
                        <td>
                          <div style={{ fontWeight: 600, fontSize: 14.5 }}>{line.name}</div>
                          <div style={{ fontSize: 12, color: "var(--ink-secondary)" }}>
                            {line.packLabel}
                          </div>
                        </td>
                        <td className="mono" style={{ fontSize: 13.5 }}>
                          {isWeighted
                            ? formatMeasure(line.weightGrams!, line.unitMode)
                            : `${line.qtyPacks}×`}
                        </td>
                        <td className="text-right mono" style={{ color: "var(--accent-primary-ink)" }}>
                          {line.discountCents > 0
                            ? `-${formatCurrency(line.discountCents, state.primaryCurrency)}`
                            : "—"}
                        </td>
                        <td className="text-right mono" style={{ fontWeight: 700, fontSize: 15 }}>
                          {formatCurrency(line.lineTotalCents, state.primaryCurrency)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Right: Dual-Currency Total Due + Live EMVCo QR */}
        <aside className="stack-md">
          <section className="panel cfd-total-panel" aria-label="Amount due summary">
            <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--ink-muted)" }}>
              Total Due ({state.primaryCurrency})
            </div>
            <div
              id="cfd-grand-total"
              className="mono"
              style={{
                fontSize: 44,
                fontWeight: 800,
                letterSpacing: "-0.03em",
                lineHeight: 1.1,
                marginTop: 6,
                color: "var(--ink-primary)",
              }}
            >
              {formatCurrency(state.grandTotalCents, state.primaryCurrency)}
            </div>
            {state.secondaryCurrency && (
              <div
                id="cfd-secondary-total"
                className="mono"
                style={{
                  fontSize: 22,
                  fontWeight: 700,
                  marginTop: 6,
                  color: "var(--accent-primary-ink)",
                }}
              >
                ≈ {formatCurrency(secondaryTotal, state.secondaryCurrency)}
                <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--ink-secondary)", marginLeft: 8 }}>
                  (1 {state.primaryCurrency} = {state.secondaryFxRate.toLocaleString()} {state.secondaryCurrency})
                </span>
              </div>
            )}

            <div className="totals-box" style={{ marginTop: 14 }}>
              <div className="total-row">
                <span>Subtotal</span>
                <span className="mono">{formatCurrency(state.subtotalCents, state.primaryCurrency)}</span>
              </div>
              {state.discountCents > 0 && (
                <div className="total-row" style={{ color: "var(--accent-primary-ink)", fontWeight: 700 }}>
                  <span>You Saved Today</span>
                  <span className="mono">-{formatCurrency(state.discountCents, state.primaryCurrency)}</span>
                </div>
              )}
              <div className="total-row">
                <span>VAT / Tax</span>
                <span className="mono">{formatCurrency(state.taxCents, state.primaryCurrency)}</span>
              </div>
            </div>
          </section>

          {state.activeQr && (
            <section
              id="cfd-qr-section"
              className="panel cfd-qr-card"
              aria-label="Live payment QR code"
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, width: "100%" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700, fontSize: 15 }}>
                  <QrCode size={16} aria-hidden="true" style={{ color: "var(--accent-primary-ink)" }} />
                  Scan {state.activeQr.rail.toUpperCase()} to Pay
                </div>
                <span
                  className={`tag mono ${
                    effectiveQrStatus === "paid"
                      ? "tag-green"
                      : effectiveQrStatus === "pending"
                        ? "tag-amber"
                        : "tag-red"
                  }`}
                >
                  {(effectiveQrStatus ?? state.activeQr.status).toUpperCase()}
                </span>
              </div>

              {state.activeQr.qrPayload && effectiveQrStatus === "pending" && (
                <QrCodeSvg
                  payload={state.activeQr.qrPayload}
                  sizePx={236}
                  label={`Customer display ${state.activeQr.rail.toUpperCase()} QR for ${state.activeQr.displayAmount}`}
                />
              )}

              {effectiveQrStatus === "expired" && (
                <div className="banner banner-red" role="alert" style={{ width: "100%", justifyContent: "center" }}>
                  <span>Payment QR expired — please ask the cashier to generate a fresh QR code.</span>
                </div>
              )}

              {effectiveQrStatus === "paid" && (
                <div className="banner banner-green" style={{ width: "100%", justifyContent: "center" }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 700 }}>
                    <CheckCircle2 size={16} aria-hidden="true" />
                    QR Payment Settled ({state.activeQr.externalRef ?? state.activeQr.billReference})
                  </span>
                </div>
              )}

              <div className="mono" style={{ fontSize: 22, fontWeight: 700, color: "var(--accent-primary-ink)" }}>
                {state.activeQr.displayAmount}
              </div>
              <div className="mono" style={{ fontSize: 12, color: "var(--ink-secondary)" }}>
                Bill Ref: {state.activeQr.billReference} · EMVCo CRC-16 Verified
              </div>
            </section>
          )}
        </aside>
      </main>
    </div>
  );
}
