import { formatMoney } from "@supermarket/shared/money";
import { Ticket, UserCheck, X } from "lucide-react";

export interface PosCustomer {
  id: string;
  phone: string;
  fullName: string;
  pointsBalance: number;
  rfmSegment: string;
}

export interface AppliedCoupon {
  id: string;
  code: string;
  discountCents: number;
  minBasketCents: number;
  customerId: string | null;
}

export function PosLoyaltyCard({
  attachedCustomer,
  customerLookupInput,
  customerResults,
  appliedCoupon,
  couponEligibleNow,
  couponInput,
  couponFeedback,
  validatingCoupon,
  simulatedOffline,
  onCustomerLookupInputChange,
  onLookupCustomer,
  onSelectCustomer,
  onDetachCustomer,
  onCouponInputChange,
  onApplyCoupon,
  onRemoveCoupon,
}: {
  attachedCustomer: PosCustomer | null;
  customerLookupInput: string;
  customerResults: PosCustomer[];
  appliedCoupon: AppliedCoupon | null;
  couponEligibleNow: boolean;
  couponInput: string;
  couponFeedback: string | null;
  validatingCoupon: boolean;
  simulatedOffline: boolean;
  onCustomerLookupInputChange: (val: string) => void;
  onLookupCustomer: () => void;
  onSelectCustomer: (customer: PosCustomer) => void;
  onDetachCustomer: () => void;
  onCouponInputChange: (val: string) => void;
  onApplyCoupon: () => void;
  onRemoveCoupon: () => void;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--border-hairline)",
        borderRadius: "var(--radius-md)",
        padding: "10px 11px",
        background: "var(--bg-subtle)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {attachedCustomer ? (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 5 }}>
            <UserCheck size={14} aria-hidden="true" style={{ color: "var(--accent-primary)" }} />
            <strong>{attachedCustomer.fullName}</strong>
            <span className="tag tag-blue mono" style={{ fontSize: 10 }}>
              {attachedCustomer.pointsBalance} pts
            </span>
          </span>
          <button
            type="button"
            className="btn btn-sm"
            aria-label="Detach loyalty customer"
            onClick={onDetachCustomer}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 6 }}>
          <input
            id="pos-customer-lookup"
            aria-label="Loyalty customer phone or name"
            className="input"
            style={{ fontSize: 12, padding: "5px 8px", flex: 1, minWidth: 0 }}
            placeholder="Loyalty phone or name..."
            value={customerLookupInput}
            onChange={(e) => onCustomerLookupInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onLookupCustomer();
              }
            }}
          />
          <button
            id="pos-customer-lookup-btn"
            type="button"
            className="btn btn-sm"
            disabled={simulatedOffline || !customerLookupInput.trim()}
            onClick={onLookupCustomer}
          >
            Find
          </button>
        </div>
      )}

      {customerResults.length > 0 && !attachedCustomer && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {customerResults.map((c) => (
            <button
              key={c.id}
              type="button"
              className="btn btn-sm"
              style={{ justifyContent: "space-between", fontSize: 11.5 }}
              onClick={() => onSelectCustomer(c)}
            >
              <span>
                {c.fullName} ({c.phone})
              </span>
              <span className="mono">{c.pointsBalance} pts</span>
            </button>
          ))}
        </div>
      )}

      {appliedCoupon ? (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 5 }}>
            <Ticket
              size={14}
              aria-hidden="true"
              style={{ color: couponEligibleNow ? "var(--accent-primary)" : "var(--accent-amber)" }}
            />
            <strong className="mono">{appliedCoupon.code}</strong>
            <span className={`tag ${couponEligibleNow ? "tag-green" : "tag-amber"} mono`} style={{ fontSize: 10 }}>
              {couponEligibleNow
                ? `-${formatMoney(appliedCoupon.discountCents)}`
                : `Min ${formatMoney(appliedCoupon.minBasketCents)}`}
            </span>
          </span>
          <button
            type="button"
            className="btn btn-sm"
            aria-label="Remove coupon"
            onClick={onRemoveCoupon}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 6 }}>
          <input
            id="pos-coupon-input"
            aria-label="Loyalty coupon code"
            className="input mono"
            style={{ fontSize: 12, padding: "5px 8px", flex: 1, minWidth: 0 }}
            placeholder="Coupon code (e.g., SAVE5-...)..."
            value={couponInput}
            onChange={(e) => onCouponInputChange(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onApplyCoupon();
              }
            }}
          />
          <button
            id="pos-apply-coupon-btn"
            type="button"
            className="btn btn-sm"
            disabled={validatingCoupon || simulatedOffline || !couponInput.trim()}
            onClick={onApplyCoupon}
          >
            {validatingCoupon ? "..." : "Apply"}
          </button>
        </div>
      )}

      {couponFeedback && (
        <div style={{ fontSize: 11.5, color: "var(--ink-secondary)" }} role="status">
          {couponFeedback}
        </div>
      )}
    </div>
  );
}
