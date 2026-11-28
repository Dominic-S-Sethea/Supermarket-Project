import { memo, useEffect, useState } from "react";
import {
  convertToSecondaryCurrency,
  formatBp,
  formatCurrency,
  formatMeasure,
  formatMoney,
} from "@supermarket/shared/money";
import type { CartInputLine, EvaluatedCart } from "@supermarket/shared/pricing";
import {
  CreditCard,
  DollarSign,
  QrCode,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Split,
  Trash2,
} from "lucide-react";
import type { PosBootstrapSnapshot } from "../lib/posCache";
import type { CheckoutTab } from "./PosCheckoutModal";
import { PosLoyaltyCard, type AppliedCoupon, type PosCustomer } from "./PosLoyaltyCard";

type BootstrapProduct = PosBootstrapSnapshot["products"][number];

export interface UpsellSuggestion {
  productId: string;
  name: string;
  barcode: string;
  priceCents: number;
  lift: number;
  confidence: number;
  isMorningPair: boolean;
}

/**
 * Active POS basket, destructive action guardrails, totals, and tender triggers.
 */
export const PosCartPanel = memo(function PosCartPanel({
  cartLength,
  evaluated,
  ageVerified,
  productsMap,
  upsellSuggestions,
  attachedCustomer,
  customerLookupInput,
  customerResults,
  appliedCoupon,
  couponEligibleNow,
  couponInput,
  couponFeedback,
  validatingCoupon,
  simulatedOffline,
  submittingSale,
  submittingMethod,
  canVoidOrRefund,
  primaryCurrency,
  secondaryCurrency,
  secondaryFxRate,
  secondaryRoundingStep,
  removedUndoLine,
  onClearCart,
  onRemoveLine,
  onDecrementLine,
  onIncrementLine,
  onUndoRemovedLine,
  onDismissUndo,
  onQuickAddBarcode,
  onCustomerLookupInputChange,
  onLookupCustomer,
  onSelectCustomer,
  onDetachCustomer,
  onCouponInputChange,
  onApplyCoupon,
  onRemoveCoupon,
  onQuickPay,
  onOpenCheckoutTab,
}: {
  cartLength: number;
  evaluated: EvaluatedCart;
  ageVerified: boolean;
  productsMap: Map<string, BootstrapProduct>;
  upsellSuggestions: UpsellSuggestion[];
  attachedCustomer: PosCustomer | null;
  customerLookupInput: string;
  customerResults: PosCustomer[];
  appliedCoupon: AppliedCoupon | null;
  couponEligibleNow: boolean;
  couponInput: string;
  couponFeedback: string | null;
  validatingCoupon: boolean;
  simulatedOffline: boolean;
  submittingSale: boolean;
  submittingMethod: "cash" | "card" | "modal" | null;
  canVoidOrRefund: boolean;
  primaryCurrency: string;
  secondaryCurrency: string;
  secondaryFxRate: number;
  secondaryRoundingStep: number;
  removedUndoLine: CartInputLine | null;
  onClearCart: () => void;
  onRemoveLine: (lineKey: string) => void;
  onDecrementLine: (lineKey: string) => void;
  onIncrementLine: (lineKey: string) => void;
  onUndoRemovedLine: () => void;
  onDismissUndo: () => void;
  onQuickAddBarcode: (barcode: string) => void;
  onCustomerLookupInputChange: (val: string) => void;
  onLookupCustomer: () => void;
  onSelectCustomer: (customer: PosCustomer) => void;
  onDetachCustomer: () => void;
  onCouponInputChange: (val: string) => void;
  onApplyCoupon: () => void;
  onRemoveCoupon: () => void;
  onQuickPay: (method: "cash" | "card") => void;
  onOpenCheckoutTab: (tab: CheckoutTab) => void;
}) {
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    if (cartLength === 0 || submittingSale) {
      setConfirmClear(false);
    }
  }, [cartLength, submittingSale]);

  return (
    <aside className="pos-receipt-panel">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <h2 className="panel-title">Current Basket (Lane 01)</h2>
        {cartLength > 0 && (
          confirmClear ? (
            <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <button
                id="pos-confirm-clear-btn"
                type="button"
                className="btn btn-danger btn-sm"
                disabled={submittingSale}
                onClick={() => {
                  setConfirmClear(false);
                  onClearCart();
                }}
              >
                <Trash2 size={13} aria-hidden="true" /> Confirm Clear ({cartLength})
              </button>
              <button
                id="pos-cancel-clear-btn"
                type="button"
                className="btn btn-sm"
                disabled={submittingSale}
                onClick={() => setConfirmClear(false)}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              id="pos-clear-basket-btn"
              type="button"
              className="btn btn-sm"
              disabled={submittingSale}
              onClick={() => {
                if (cartLength >= 2) {
                  setConfirmClear(true);
                } else {
                  onClearCart();
                }
              }}
            >
              <Trash2 size={13} aria-hidden="true" /> Clear
            </button>
          )
        )}
      </div>

      {removedUndoLine && (
        <div
          id="pos-undo-remove-banner"
          className="banner banner-amber"
          role="status"
          style={{ padding: "8px 10px", fontSize: 12 }}
        >
          <span>Removed {removedUndoLine.name}</span>
          <div style={{ display: "inline-flex", gap: 6 }}>
            <button
              id="pos-undo-remove-btn"
              type="button"
              className="btn btn-primary btn-sm"
              disabled={submittingSale}
              onClick={onUndoRemovedLine}
            >
              <RotateCcw size={12} aria-hidden="true" /> Undo
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={onDismissUndo}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {evaluated.requiresAgeCheck && ageVerified && (
        <div className="banner banner-green" style={{ padding: "7px 10px", fontSize: 12 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <ShieldCheck size={14} aria-hidden="true" /> Alcohol Age Check Verified
          </span>
        </div>
      )}

      <div className="cart-lines">
        {evaluated.lines.length === 0 ? (
          <div style={{ color: "var(--ink-muted)", padding: "28px 0", textAlign: "center" }}>
            Scan a barcode or tap a quick-test SKU to start ringing up a basket.
          </div>
        ) : (
          evaluated.lines.map((line) => {
            const isWeighted =
              (line.unitMode === "weight_g" || line.unitMode === "volume_ml") &&
              typeof line.weightGrams === "number" &&
              line.weightGrams > 0;
            const prodMeta = productsMap.get(line.productId);
            const allergens = prodMeta?.allergens ?? [];
            return (
              <div key={line.lineKey} className="cart-line">
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{line.name}</div>
                  <div style={{ fontSize: 11.5, color: "var(--ink-secondary)" }} className="mono">
                    {isWeighted
                      ? `${line.packLabel} · ${formatMoney(line.unitPriceCents)}/${
                          line.unitMode === "volume_ml" ? "L" : "kg"
                        } · -${formatMeasure(line.baseUnitsSold, line.unitMode)} stock`
                      : `${line.packLabel} (${line.packQty}× base) · -${line.baseUnitsSold} stock`}
                  </div>
                  {allergens.length > 0 && (
                    <div style={{ marginTop: 3, display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {allergens.map((a) => (
                        <span key={a} className="tag tag-amber mono" style={{ fontSize: 11.5 }}>
                          {a.toUpperCase()}
                        </span>
                      ))}
                    </div>
                  )}
                  {line.appliedPromotions.length > 0 && (
                    <div style={{ marginTop: 3, display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {line.appliedPromotions.map((pName, idx) => (
                        <span key={`${pName}-${idx}`} className="tag tag-green" style={{ fontSize: 11.5 }}>
                          {pName}
                          {idx === 0 ? ` (-${formatMoney(line.discountCents)})` : ""}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="mono" style={{ fontWeight: 600 }}>
                    {formatMoney(line.lineTotalCents)}
                  </div>
                  {isWeighted ? (
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ marginTop: 4 }}
                      aria-label={`Remove weighted line ${line.name}`}
                      disabled={submittingSale}
                      onClick={() => onRemoveLine(line.lineKey)}
                    >
                      Remove
                    </button>
                  ) : (
                    <div className="qty-stepper" style={{ marginTop: 4 }}>
                      <button
                        type="button"
                        className="qty-btn"
                        aria-label={`Decrease quantity for ${line.name}`}
                        disabled={submittingSale}
                        onClick={() => onDecrementLine(line.lineKey)}
                      >
                        -
                      </button>
                      <span className="mono" style={{ minWidth: 18, textAlign: "center" }}>
                        {line.qtyPacks}
                      </span>
                      <button
                        type="button"
                        className="qty-btn"
                        aria-label={`Increase quantity for ${line.name}`}
                        disabled={submittingSale}
                        onClick={() => onIncrementLine(line.lineKey)}
                      >
                        +
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {upsellSuggestions.length > 0 && (
        <div className="upsell-box">
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--accent-primary-ink)", display: "flex", alignItems: "center", gap: 5 }}>
            <Sparkles size={12} aria-hidden="true" /> OFFLINE-SAFE BASKET UPSELLS
          </div>
          {upsellSuggestions.map((u) => (
            <div key={u.productId} className="upsell-row">
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {u.name}
                </div>
                <div className="mono" style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                  {u.lift.toFixed(1)}× lift · {formatMoney(u.priceCents)}{" "}
                  {u.isMorningPair && <span className="tag tag-amber">Morning Pair</span>}
                </div>
              </div>
              <button
                type="button"
                className="btn btn-sm"
                disabled={submittingSale}
                onClick={() => onQuickAddBarcode(u.barcode)}
              >
                + Add
              </button>
            </div>
          ))}
        </div>
      )}

      <PosLoyaltyCard
        attachedCustomer={attachedCustomer}
        customerLookupInput={customerLookupInput}
        customerResults={customerResults}
        appliedCoupon={appliedCoupon}
        couponEligibleNow={couponEligibleNow}
        couponInput={couponInput}
        couponFeedback={couponFeedback}
        validatingCoupon={validatingCoupon}
        simulatedOffline={simulatedOffline}
        onCustomerLookupInputChange={onCustomerLookupInputChange}
        onLookupCustomer={onLookupCustomer}
        onSelectCustomer={onSelectCustomer}
        onDetachCustomer={onDetachCustomer}
        onCouponInputChange={onCouponInputChange}
        onApplyCoupon={onApplyCoupon}
        onRemoveCoupon={onRemoveCoupon}
      />

      <div className="totals-box">
        <div className="total-row">
          <span>Subtotal</span>
          <span className="mono">{formatMoney(evaluated.subtotalBeforeDiscountCents)}</span>
        </div>
        <div className="total-row" style={{ color: "var(--accent-primary-ink)", fontWeight: 600 }}>
          <span>Auto Promotions &amp; Coupons</span>
          <span className="mono">-{formatMoney(evaluated.totalDiscountCents)}</span>
        </div>
        {evaluated.couponDiscountCents > 0 && (
          <div className="total-row" style={{ fontSize: 11.5, color: "var(--accent-primary-ink)" }}>
            <span>↳ Loyalty Coupon ({appliedCoupon?.code})</span>
            <span className="mono">-{formatMoney(evaluated.couponDiscountCents)}</span>
          </div>
        )}
        <div className="total-row">
          <span>VAT / Excise Tax</span>
          <span className="mono">{formatMoney(evaluated.totalTaxCents)}</span>
        </div>
        {canVoidOrRefund && (
          <div className="total-row" style={{ fontSize: 11.5 }}>
            <span>Live Basket Margin (Cost Snapshot)</span>
            <span className="mono">{formatBp(evaluated.estimatedMarginBp)}</span>
          </div>
        )}
        <div className="total-row grand">
          <span>Total Due</span>
          <span className="mono">{formatCurrency(evaluated.grandTotalCents, primaryCurrency)}</span>
        </div>
        {secondaryCurrency && (
          <div
            id="pos-secondary-total"
            className="total-row"
            style={{ fontSize: 12, color: "var(--accent-primary-ink)", fontWeight: 600 }}
          >
            <span>
              Dual Currency ({secondaryCurrency} @ {secondaryFxRate.toLocaleString()})
            </span>
            <span className="mono">
              ≈{" "}
              {formatCurrency(
                convertToSecondaryCurrency(
                  evaluated.grandTotalCents,
                  secondaryFxRate,
                  secondaryRoundingStep
                ),
                secondaryCurrency
              )}
            </span>
          </div>
        )}
      </div>

      <div className="tender-grid">
        <button
          id="pos-pay-cash-btn"
          type="button"
          className="btn btn-primary"
          disabled={evaluated.lines.length === 0 || submittingSale}
          aria-busy={submittingSale && submittingMethod === "cash"}
          aria-keyshortcuts="F8"
          title="Complete cash sale (F8)"
          onClick={() => onQuickPay("cash")}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <DollarSign size={14} aria-hidden="true" />
            {submittingSale && submittingMethod === "cash" ? "Saving..." : "Cash"}
          </span>
          <kbd className="kbd-hint" aria-hidden="true">F8</kbd>
        </button>
        <button
          id="pos-pay-card-btn"
          type="button"
          className="btn btn-primary"
          disabled={evaluated.lines.length === 0 || submittingSale}
          aria-busy={submittingSale && submittingMethod === "card"}
          aria-keyshortcuts="F9"
          title="Complete card sale (F9)"
          onClick={() => onQuickPay("card")}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <CreditCard size={14} aria-hidden="true" />
            {submittingSale && submittingMethod === "card" ? "Saving..." : "Card"}
          </span>
          <kbd className="kbd-hint" aria-hidden="true">F9</kbd>
        </button>
        <button
          id="pos-pay-qr-btn"
          type="button"
          className="btn"
          disabled={evaluated.lines.length === 0 || submittingSale}
          aria-keyshortcuts="F10"
          title="Pay via KHQR / dynamic QR (F10)"
          onClick={() => onOpenCheckoutTab("qr")}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <QrCode size={14} aria-hidden="true" /> KHQR / QR
          </span>
          <kbd className="kbd-hint" aria-hidden="true">F10</kbd>
        </button>
        <button
          id="open-split-tender-btn"
          type="button"
          className="btn"
          disabled={evaluated.lines.length === 0 || submittingSale}
          aria-keyshortcuts="F7"
          title="Open split / multi-currency tender (F7)"
          onClick={() => onOpenCheckoutTab("cash")}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Split size={14} aria-hidden="true" /> Split / {secondaryCurrency || "Multi"}
          </span>
          <kbd className="kbd-hint" aria-hidden="true">F7</kbd>
        </button>
      </div>
    </aside>
  );
});
