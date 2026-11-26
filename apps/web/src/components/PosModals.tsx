import { formatMoney } from "@supermarket/shared/money";
import { AlertTriangle, RefreshCw, RotateCcw, ShieldCheck, X } from "lucide-react";
import type { DeadLetterPosSale } from "../lib/posCache";
import { ModalDialog } from "./AccessibleDialog";

export interface RecentSaleLine {
  id: string;
  productId: string;
  productName: string;
  scannedBarcode: string;
  packLabel: string;
  packQty: number;
  qtyPacks: number;
  unitPriceCents: number;
  unitCostCents: number;
  discountCents: number;
  taxRateBp: number;
  taxCents: number;
  lineTotalCents: number;
}

export interface RecentSalePayment {
  id: string;
  method: "cash" | "card" | "mobile_pay" | "voucher";
  amountCents: number;
}

export interface RecentSaleRow {
  id: string;
  registerCode: string;
  receiptNo: string;
  kind: "sale" | "refund" | "void";
  originalSaleId: string | null;
  customerId: string | null;
  cashierName: string;
  totalCents: number;
  soldAt: string;
  alreadyVoided: boolean;
  lines: RecentSaleLine[];
  payments: RecentSalePayment[];
}

export interface ActiveShiftInfo {
  id: string;
  registerCode: string;
  openingFloatCents: number;
  openedAt: string;
}

export interface ZReportSummary {
  zReportNo: string;
  expectedCashCents: number;
  blindCountedCashCents: number;
  varianceCents: number;
}

export function AgeVerificationModal({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ModalDialog
      open={open}
      onClose={onCancel}
      labelledBy="age-check-modal-title"
      style={{ maxWidth: 440 }}
    >
      <div style={{ display: "flex", gap: 10, alignItems: "center", color: "var(--accent-amber)" }}>
        <AlertTriangle size={22} aria-hidden="true" />
        <h2 id="age-check-modal-title" style={{ margin: 0, fontSize: 18, color: "var(--ink-primary)" }}>
          Age Verification Required
        </h2>
      </div>
      <p style={{ margin: 0, color: "var(--ink-secondary)" }}>
        This SKU belongs to an age-restricted alcohol category. Please verify customer photo ID before proceeding with checkout.
      </p>
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel Scan
        </button>
        <button
          id="confirm-age-check-btn"
          type="button"
          className="btn btn-primary"
          onClick={onConfirm}
        >
          <ShieldCheck size={14} aria-hidden="true" /> ID Verified — Add to Basket
        </button>
      </div>
    </ModalDialog>
  );
}

export function OpenShiftModal({
  open,
  activeShift,
  openFloatInput,
  openingShift,
  shiftError,
  openShiftBanner,
  onFloatChange,
  onSubmit,
  onClose,
}: {
  open: boolean;
  activeShift: ActiveShiftInfo | null;
  openFloatInput: string;
  openingShift: boolean;
  shiftError: string | null;
  openShiftBanner: string | null;
  onFloatChange: (val: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      labelledBy="open-shift-modal-title"
      style={{ maxWidth: 440 }}
    >
      <h2 id="open-shift-modal-title" style={{ margin: 0, fontSize: 18 }}>
        Open Register Shift (Lane 01)
      </h2>
      <p className="page-subtitle" style={{ margin: 0 }}>
        Record starting drawer float for blind Z-Report reconciliation at end of shift.
      </p>
      {activeShift && (
        <div className="banner banner-green" role="status">
          <span>
            Active shift on <strong className="mono">{activeShift.registerCode}</strong> · Opening float{" "}
            <strong className="mono">{formatMoney(activeShift.openingFloatCents)}</strong>
          </span>
        </div>
      )}
      {shiftError && (
        <div className="banner banner-red" role="alert">
          {shiftError}
        </div>
      )}
      {openShiftBanner && (
        <div className="banner banner-green" role="status">
          {openShiftBanner}
        </div>
      )}
      <div className="field">
        <label htmlFor="open-float-input">Opening Cash Float ($ USD)</label>
        <input
          id="open-float-input"
          className="input mono"
          value={openFloatInput}
          onChange={(e) => onFloatChange(e.target.value)}
          disabled={openingShift}
        />
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <button
          id="confirm-open-shift-btn"
          type="button"
          className="btn btn-primary"
          disabled={openingShift}
          onClick={onSubmit}
        >
          {openingShift ? "Opening..." : "Open Shift on REG-01"}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </ModalDialog>
  );
}

export function RecentReceiptsModal({
  open,
  canVoidOrRefund,
  loadingRecent,
  recentSales,
  recentError,
  busyReceiptId,
  onVoidOrRefund,
  onClose,
}: {
  open: boolean;
  canVoidOrRefund: boolean;
  loadingRecent: boolean;
  recentSales: RecentSaleRow[];
  recentError: string | null;
  busyReceiptId: string | null;
  onVoidOrRefund: (sale: RecentSaleRow, kind: "void" | "refund") => void;
  onClose: () => void;
}) {
  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      labelledBy="recent-receipts-modal-title"
      style={{ maxWidth: 760, width: "92vw" }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 id="recent-receipts-modal-title" style={{ margin: 0, fontSize: 18 }}>
            Recent POS Receipts (Lane Feed)
          </h2>
          <p className="page-subtitle" style={{ margin: 0 }}>
            {canVoidOrRefund
              ? "Managers & Owners can post append-only Voids or Refunds that atomically restock ledger inventory and claw back loyalty points."
              : "Read-only receipt feed. Voids and Refunds require Store Manager or Owner login."}
          </p>
        </div>
        <button type="button" className="btn btn-sm" aria-label="Close recent receipts dialog" onClick={onClose}>
          <X size={14} aria-hidden="true" /> Close
        </button>
      </div>
      {recentError && (
        <div className="banner banner-red" role="alert">
          {recentError}
        </div>
      )}
      <div className="table-wrap" role="region" aria-label="Receipt lookup results" tabIndex={0} style={{ maxHeight: 420, overflowY: "auto" }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Receipt</th>
              <th>Type</th>
              <th>Cashier &amp; Time</th>
              <th className="text-right">Items</th>
              <th className="text-right">Total</th>
              {canVoidOrRefund && <th className="text-right">Manager Action</th>}
            </tr>
          </thead>
          <tbody>
            {loadingRecent ? (
              <tr>
                <td colSpan={canVoidOrRefund ? 6 : 5}>Loading recent receipts...</td>
              </tr>
            ) : recentSales.length === 0 ? (
              <tr>
                <td colSpan={canVoidOrRefund ? 6 : 5} style={{ textAlign: "center", color: "var(--ink-muted)" }}>
                  No receipts recorded yet.
                </td>
              </tr>
            ) : (
              recentSales.map((s) => (
                <tr key={s.id}>
                  <td className="mono" style={{ fontWeight: 600 }}>
                    {s.receiptNo}
                  </td>
                  <td>
                    <span
                      className={`tag ${
                        s.kind === "sale"
                          ? s.alreadyVoided
                            ? "tag-neutral"
                            : "tag-green"
                          : "tag-red"
                      }`}
                    >
                      {s.kind === "sale" && s.alreadyVoided ? "voided" : s.kind}
                    </span>
                  </td>
                  <td>
                    <div style={{ fontSize: 12.5 }}>{s.cashierName}</div>
                    <div className="mono" style={{ fontSize: 11, color: "var(--ink-muted)" }}>
                      {new Date(s.soldAt).toLocaleString()}
                    </div>
                  </td>
                  <td className="text-right mono">{s.lines.length}</td>
                  <td className="text-right mono" style={{ fontWeight: 700 }}>
                    {s.kind === "sale" ? formatMoney(s.totalCents) : `-${formatMoney(s.totalCents)}`}
                  </td>
                  {canVoidOrRefund && (
                    <td className="text-right">
                      {s.kind === "sale" && !s.alreadyVoided && s.lines.length > 0 ? (
                        <div style={{ display: "inline-flex", gap: 6 }}>
                          <button
                            type="button"
                            className="btn btn-amber btn-sm"
                            disabled={busyReceiptId !== null}
                            onClick={() => onVoidOrRefund(s, "refund")}
                          >
                            <RotateCcw size={12} aria-hidden="true" /> Refund
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={busyReceiptId !== null}
                            onClick={() => onVoidOrRefund(s, "void")}
                          >
                            Void
                          </button>
                        </div>
                      ) : (
                        <span style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>—</span>
                      )}
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </ModalDialog>
  );
}

export function ShiftCloseModal({
  open,
  activeShift,
  blindCashInput,
  fallbackFloatInput,
  closingShift,
  shiftError,
  zReportResult,
  onBlindCashChange,
  onFallbackFloatChange,
  onSubmit,
  onClose,
}: {
  open: boolean;
  activeShift: ActiveShiftInfo | null;
  blindCashInput: string;
  fallbackFloatInput: string;
  closingShift: boolean;
  shiftError: string | null;
  zReportResult: ZReportSummary | null;
  onBlindCashChange: (val: string) => void;
  onFallbackFloatChange: (val: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      labelledBy="shift-close-modal-title"
      style={{ maxWidth: 480 }}
    >
      <h2 id="shift-close-modal-title" style={{ margin: 0, fontSize: 18 }}>
        Blind Shift Cash Closeout (Z-Report)
      </h2>
      <p className="page-subtitle" style={{ margin: 0 }}>
        Cashier enters counted drawer cash without seeing the expected system total — prevents skimming overages.
      </p>
      {activeShift ? (
        <div className="banner banner-green">
          <span>
            Closing shift on <strong className="mono">{activeShift.registerCode}</strong> (opened{" "}
            {new Date(activeShift.openedAt).toLocaleTimeString()} · float{" "}
            <strong className="mono">{formatMoney(activeShift.openingFloatCents)}</strong>)
          </span>
        </div>
      ) : (
        <div className="banner banner-amber">
          <span>
            No open shift record found for REG-01 — confirm starting float below to reconcile today&apos;s lane cash.
          </span>
        </div>
      )}
      {shiftError && (
        <div className="banner banner-red" role="alert">
          {shiftError}
        </div>
      )}
      {!activeShift && (
        <div className="field">
          <label htmlFor="close-opening-float-input">Starting Opening Float ($ USD)</label>
          <input
            id="close-opening-float-input"
            className="input mono"
            value={fallbackFloatInput}
            onChange={(e) => onFallbackFloatChange(e.target.value)}
            disabled={closingShift}
          />
        </div>
      )}
      <div className="field">
        <label htmlFor="blind-cash-input">Physical Cash Counted in Drawer ($ USD)</label>
        <input
          id="blind-cash-input"
          className="input mono"
          value={blindCashInput}
          onChange={(e) => onBlindCashChange(e.target.value)}
          disabled={closingShift}
        />
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={closingShift}
          onClick={onSubmit}
        >
          {closingShift ? "Closing Shift..." : "Submit Blind Count & Generate Z-Report"}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </div>
      {zReportResult && (
        <div className="thermal-paper">
          {`Z-REPORT: ${zReportResult.zReportNo}
Expected Cash:  ${formatMoney(zReportResult.expectedCashCents)}
Blind Counted:  ${formatMoney(zReportResult.blindCountedCashCents)}
Variance:       ${formatMoney(zReportResult.varianceCents)}`}
        </div>
      )}
    </ModalDialog>
  );
}

export function DeadLetterModal({
  open,
  entries,
  syncingQueue,
  canVoidOrRefund,
  onRetry,
  onDismiss,
  onClose,
}: {
  open: boolean;
  entries: DeadLetterPosSale[];
  syncingQueue: boolean;
  canVoidOrRefund: boolean;
  onRetry: (entry: DeadLetterPosSale, stripCoupon: boolean) => void;
  onDismiss: (saleId: string) => void;
  onClose: () => void;
}) {
  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      labelledBy="dlq-modal-title"
      style={{ maxWidth: 720, width: "94vw" }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 id="dlq-modal-title" style={{ margin: 0, fontSize: 18 }}>
            Quarantined Offline Receipts (Dead-Letter Queue)
          </h2>
          <p className="page-subtitle" style={{ margin: 0 }}>
            Receipts rejected with 4xx validation/conflict errors are preserved locally so paid transactions are never lost.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          aria-label="Close quarantined receipts dialog"
          onClick={onClose}
        >
          <X size={14} aria-hidden="true" /> Close
        </button>
      </div>
      {entries.length === 0 ? (
        <div style={{ color: "var(--ink-secondary)", padding: "12px 0" }}>
          All quarantined receipts have been resolved.
        </div>
      ) : (
        <div className="stack-md" style={{ gap: 10 }}>
          {entries.map((entry) => {
            const totalCents = entry.sale.lines.reduce((s, l) => s + l.lineTotalCents, 0);
            return (
              <div key={entry.sale.id} className="triage-box">
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                  <strong className="mono">{entry.sale.receiptNo}</strong>
                  <span className="tag tag-red mono">
                    HTTP {entry.status ?? "ERR"} · {formatMoney(totalCents)}
                  </span>
                </div>
                <div style={{ fontSize: 12.5, color: "var(--accent-crimson)", marginTop: 4 }}>
                  {entry.error}
                </div>
                <div className="mono" style={{ fontSize: 11, color: "var(--ink-muted)", marginTop: 3 }}>
                  Sold {new Date(entry.sale.soldAt).toLocaleString()} · {entry.sale.lines.length} line(s)
                  {entry.sale.couponCode ? ` · Coupon: ${entry.sale.couponCode}` : ""}
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={syncingQueue}
                    onClick={() => onRetry(entry, false)}
                  >
                    <RefreshCw size={12} aria-hidden="true" /> Retry Sync
                  </button>
                  {entry.sale.couponCode && (
                    <button
                      type="button"
                      className="btn btn-amber btn-sm"
                      disabled={syncingQueue}
                      onClick={() => onRetry(entry, true)}
                    >
                      Retry Without Coupon
                    </button>
                  )}
                  <a
                    className="btn btn-sm"
                    href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(entry, null, 2))}`}
                    download={`${entry.sale.receiptNo}-quarantined.json`}
                  >
                    Export JSON
                  </a>
                  {canVoidOrRefund && (
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      onClick={() => onDismiss(entry.sale.id)}
                    >
                      Dismiss (Reconciled)
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </ModalDialog>
  );
}
