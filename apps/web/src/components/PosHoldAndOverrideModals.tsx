import { useState } from "react";
import type { ParkedBasketDto, SupervisorOverrideAction } from "@supermarket/shared/dtos";
import { formatMoney } from "@supermarket/shared/money";
import { KeyRound, PauseCircle, PlayCircle, ShieldAlert, Trash2, X } from "lucide-react";
import { apiPost } from "../api";
import { ModalDialog } from "./AccessibleDialog";
import { ConfirmActionButton } from "./ConfirmActionButton";

export interface LocalOrServerParkedBasket {
  id: string;
  holdCode: string;
  registerCode: string;
  cashierName: string;
  customerLabel: string | null;
  customerId: string | null;
  couponCode: string | null;
  linesJson: unknown[];
  subtotalCents: number;
  itemCount: number;
  note: string | null;
  parkedAt: string;
  source: "server" | "local";
}

export function PosParkedBasketsModal({
  open,
  canParkCurrent,
  currentItemCount,
  currentSubtotalCents,
  baskets,
  loading,
  busyId,
  error,
  onParkCurrent,
  onRecall,
  onDiscard,
  onClose,
}: {
  open: boolean;
  canParkCurrent: boolean;
  currentItemCount: number;
  currentSubtotalCents: number;
  baskets: LocalOrServerParkedBasket[];
  loading: boolean;
  busyId: string | null;
  error: string | null;
  onParkCurrent: (customerLabel: string, note: string) => Promise<void>;
  onRecall: (basket: LocalOrServerParkedBasket) => Promise<void>;
  onDiscard: (basket: LocalOrServerParkedBasket) => Promise<void>;
  onClose: () => void;
}) {
  const [customerLabel, setCustomerLabel] = useState("");
  const [note, setNote] = useState("");

  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      labelledBy="parked-baskets-modal-title"
      style={{ maxWidth: 720 }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div>
          <h2 id="parked-baskets-modal-title" style={{ margin: 0, fontSize: 18, display: "flex", alignItems: "center", gap: 8 }}>
            <PauseCircle size={18} aria-hidden="true" style={{ color: "var(--accent-primary-ink)" }} />
            Hold / Park &amp; Recall Baskets (Shortcut: F6)
          </h2>
          <p className="page-subtitle" style={{ marginTop: 2 }}>
            Suspend an active basket to serve the next shopper and recall it on this or any other POS lane.
          </p>
        </div>
        <button type="button" className="btn btn-sm" aria-label="Close parked baskets" onClick={onClose}>
          <X size={15} aria-hidden="true" />
        </button>
      </div>

      {error && (
        <div className="banner banner-red" role="alert">
          <span>{error}</span>
        </div>
      )}

      {canParkCurrent && (
        <div className="panel" style={{ background: "var(--bg-canvas)", margin: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 8 }}>
            Park Current Basket ({currentItemCount} line(s) · {formatMoney(currentSubtotalCents)})
          </div>
          <div className="form-grid" style={{ marginBottom: 10 }}>
            <div className="field">
              <label htmlFor="park-customer-label-input">Shopper Label / Name (Optional)</label>
              <input
                id="park-customer-label-input"
                className="input"
                placeholder="e.g. Red jacket — grabbing forgotten milk"
                value={customerLabel}
                onChange={(e) => setCustomerLabel(e.target.value)}
                disabled={busyId === "park"}
              />
            </div>
            <div className="field">
              <label htmlFor="park-note-input">Lane Note (Optional)</label>
              <input
                id="park-note-input"
                className="input"
                placeholder="e.g. Chilled bag behind lane 1"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={busyId === "park"}
              />
            </div>
          </div>
          <button
            id="confirm-park-basket-btn"
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busyId === "park"}
            onClick={() => {
              void onParkCurrent(customerLabel.trim(), note.trim()).then(() => {
                setCustomerLabel("");
                setNote("");
              });
            }}
          >
            <PauseCircle size={13} aria-hidden="true" />{" "}
            {busyId === "park" ? "Parking Basket..." : "Park Active Basket"}
          </button>
        </div>
      )}

      <div>
        <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 8 }}>
          Suspended Baskets Ready to Recall ({baskets.length})
        </div>
        {loading && baskets.length === 0 ? (
          <div style={{ color: "var(--ink-muted)", padding: "12px 0" }}>Loading parked baskets...</div>
        ) : baskets.length === 0 ? (
          <div style={{ color: "var(--ink-muted)", padding: "14px 0" }}>
            No parked baskets currently held.
          </div>
        ) : (
          <div className="table-wrap" role="region" aria-label="Parked POS baskets" tabIndex={0}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Hold Code</th>
                  <th>Shopper / Note</th>
                  <th className="text-right">Lines</th>
                  <th className="text-right">Subtotal</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {baskets.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <div className="mono" style={{ fontWeight: 700 }}>{b.holdCode}</div>
                      <div className="mono" style={{ fontSize: 11, color: "var(--ink-muted)" }}>
                        {b.registerCode} · {b.source === "local" ? "Offline Local" : "Synced"}
                      </div>
                    </td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{b.customerLabel || "Walk-in Shopper"}</div>
                      <div style={{ fontSize: 11.5, color: "var(--ink-secondary)" }}>
                        {b.note || `Parked by ${b.cashierName}`}
                      </div>
                    </td>
                    <td className="text-right mono">{b.itemCount}</td>
                    <td className="text-right mono" style={{ fontWeight: 600 }}>
                      {formatMoney(b.subtotalCents)}
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={busyId !== null}
                          onClick={() => void onRecall(b)}
                        >
                          <PlayCircle size={12} aria-hidden="true" /> Recall
                        </button>
                        <ConfirmActionButton
                          label={<Trash2 size={12} aria-hidden="true" />}
                          confirmLabel="Discard"
                          ariaLabel={`Discard parked basket ${b.holdCode}`}
                          confirmAriaLabel={`Confirm discard parked basket ${b.holdCode}`}
                          disabled={busyId !== null}
                          onConfirm={() => onDiscard(b)}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </ModalDialog>
  );
}

export interface SupervisorOverrideResult {
  approved: boolean;
  overrideId: string;
  supervisorName: string;
  supervisorRole: string;
  actionType: SupervisorOverrideAction;
  approvedAt: string;
}

export function PosSupervisorOverrideModal({
  open,
  defaultAction = "no_sale_drawer",
  onApproved,
  onClose,
}: {
  open: boolean;
  defaultAction?: Exclude<SupervisorOverrideAction, "recall_override">;
  onApproved: (res: SupervisorOverrideResult, reason: string) => void;
  onClose: () => void;
}) {
  const [actionType, setActionType] =
    useState<Exclude<SupervisorOverrideAction, "recall_override">>(defaultAction);
  const [username, setUsername] = useState("manager");
  const [pin, setPin] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (reason.trim().length < 3) {
      setError("Enter a clear override reason (at least 3 characters).");
      return;
    }
    setBusy(true);
    try {
      const res = await apiPost<SupervisorOverrideResult>("/api/auth/verify-override", {
        username: username.trim(),
        pin: pin.trim(),
        actionType,
        reason: reason.trim(),
        registerCode: "REG-01",
      });
      setPin("");
      onApproved(res, reason.trim());
      setReason("");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Supervisor verification failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      labelledBy="supervisor-override-modal-title"
      style={{ maxWidth: 480 }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div>
          <h2 id="supervisor-override-modal-title" style={{ margin: 0, fontSize: 18, display: "flex", alignItems: "center", gap: 8 }}>
            <KeyRound size={17} aria-hidden="true" style={{ color: "var(--accent-primary-ink)" }} />
            In-Lane Supervisor PIN Override
          </h2>
          <p className="page-subtitle" style={{ marginTop: 2 }}>
            Authorizes a manager/owner action without signing out the active cashier. Both actors are immutably logged.
          </p>
        </div>
        <button type="button" className="btn btn-sm" aria-label="Close supervisor override" onClick={onClose}>
          <X size={15} aria-hidden="true" />
        </button>
      </div>

      <div className="banner banner-amber" style={{ fontSize: 12 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <ShieldAlert size={14} aria-hidden="true" />
          Food-safety product recalls cannot be overridden in-lane and must be cleared in Catalog.
        </span>
      </div>

      {error && (
        <div className="banner banner-red" role="alert">
          <span>{error}</span>
        </div>
      )}

      <form onSubmit={(e) => void handleVerify(e)} className="stack-sm">
        <div className="field">
          <label htmlFor="override-action-select">Override Action</label>
          <select
            id="override-action-select"
            className="select"
            value={actionType}
            onChange={(e) =>
              setActionType(e.target.value as Exclude<SupervisorOverrideAction, "recall_override">)
            }
            disabled={busy}
          >
            <option value="no_sale_drawer">No-Sale Cash Drawer Open (Change / Skim)</option>
            <option value="basket_void">Authorize Full Basket Clear / Void</option>
            <option value="line_void">Authorize Line Item Void</option>
            <option value="price_override">Authorize Manual Price / Discount Exception</option>
          </select>
        </div>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="override-username-input">Manager / Owner Username</label>
            <input
              id="override-username-input"
              className="input"
              autoComplete="off"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="field">
            <label htmlFor="override-pin-input">Supervisor PIN</label>
            <input
              id="override-pin-input"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              className="input mono"
              placeholder="••••"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              disabled={busy}
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor="override-reason-input">Audited Reason</label>
          <input
            id="override-reason-input"
            className="input"
            placeholder="e.g. Customer requested small bills / damaged packaging"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={busy}
          />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button type="button" className="btn btn-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            id="submit-supervisor-override-btn"
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={busy || pin.trim().length < 4 || reason.trim().length < 3}
          >
            <KeyRound size={13} aria-hidden="true" />{" "}
            {busy ? "Verifying PIN..." : "Verify & Authorize"}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}

export function mapServerParkedBasket(b: ParkedBasketDto): LocalOrServerParkedBasket {
  return {
    id: b.id,
    holdCode: b.holdCode,
    registerCode: b.registerCode,
    cashierName: b.cashierName,
    customerLabel: b.customerLabel,
    customerId: b.customerId,
    couponCode: b.couponCode,
    linesJson: b.linesJson,
    subtotalCents: b.subtotalCents,
    itemCount: b.itemCount,
    note: b.note,
    parkedAt: b.parkedAt,
    source: "server",
  };
}
