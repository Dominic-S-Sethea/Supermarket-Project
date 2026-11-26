import { useEffect, useState } from "react";
import { formatMoney } from "@supermarket/shared/money";
import {
  CheckCircle2,
  ClipboardCheck,
  FileText,
  PackageCheck,
  RefreshCw,
  Send,
  XCircle,
} from "lucide-react";
import { apiGet, apiPatch } from "../api";

interface PurchaseOrderRow {
  id: string;
  poNumber: string;
  supplierId: string;
  supplierName: string;
  status: string;
  totalCases: number;
  estimatedCostCents: number;
  createdBy: string;
  approvedBy: string | null;
  notes: string | null;
  createdAt: string;
  approvedAt: string | null;
}

interface PurchaseOrderLineDetail {
  id: string;
  productId: string;
  sku: string;
  productName: string;
  caseQty: number;
  orderedCases: number;
  receivedCases: number;
  remainingCases: number;
  unitCostCents: number;
  lineTotalCents: number;
}

interface PurchaseOrderDetailPayload {
  order: PurchaseOrderRow;
  lines: PurchaseOrderLineDetail[];
  grns: {
    id: string;
    invoiceNumber: string;
    receivedBy: string;
    totalInvoiceCents: number;
    receivedAt: string;
  }[];
  variances: {
    id: string;
    varianceType: string;
    financialImpactCents: number;
    status: string;
  }[];
}

export interface ReceiveAgainstPoDraft {
  poId: string;
  poNumber: string;
  supplierId: string;
  productId: string;
  sku: string;
  productName: string;
  caseQty: number;
  paidCases: number;
  invoiceLineTotalCents: number;
}

const STATUS_TAG: Record<string, string> = {
  draft: "tag-neutral",
  approved: "tag-amber",
  sent: "tag-amber",
  partially_received: "tag-amber",
  received: "tag-green",
  cancelled: "tag-red",
};

export function PurchaseOrdersTab({
  onReceiveAgainstPo,
  onFeedback,
  onError,
}: {
  onReceiveAgainstPo: (draft: ReceiveAgainstPoDraft) => void;
  onFeedback: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [orders, setOrders] = useState<PurchaseOrderRow[]>([]);
  const [selectedPoId, setSelectedPoId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PurchaseOrderDetailPayload | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadOrders = async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const res = await apiGet<{ orders: PurchaseOrderRow[] }>("/api/purchasing/orders", signal);
      if (signal?.aborted) return;
      setOrders(res.orders);
      if (res.orders.length > 0 && !selectedPoId) {
        setSelectedPoId(res.orders[0].id);
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        onError(err instanceof Error ? err.message : "Failed loading purchase orders.");
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  };

  const loadDetail = async (poId: string, signal?: AbortSignal) => {
    setLoadingDetail(true);
    try {
      const res = await apiGet<PurchaseOrderDetailPayload>(
        `/api/purchasing/orders/${poId}`,
        signal
      );
      if (signal?.aborted) return;
      setDetail(res);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        onError(err instanceof Error ? err.message : "Failed loading purchase order detail.");
      }
    } finally {
      if (!signal?.aborted) setLoadingDetail(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void loadOrders(controller.signal);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!selectedPoId) {
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    void loadDetail(selectedPoId, controller.signal);
    return () => controller.abort();
  }, [selectedPoId]);

  const handleStatusChange = async (
    po: PurchaseOrderRow,
    nextStatus: "approved" | "sent" | "cancelled"
  ) => {
    if (busyId) return;
    setBusyId(`${po.id}-${nextStatus}`);
    try {
      await apiPatch(`/api/purchasing/orders/${po.id}/status`, { status: nextStatus });
      onFeedback(`Purchase Order ${po.poNumber} marked as "${nextStatus}".`);
      await loadOrders();
      if (selectedPoId === po.id) await loadDetail(po.id);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed updating purchase order status.");
    } finally {
      setBusyId(null);
    }
  };

  const visibleOrders =
    statusFilter === "all" ? orders : orders.filter((o) => o.status === statusFilter);

  const openPoValueCents = orders
    .filter((o) => !["received", "cancelled"].includes(o.status))
    .reduce((sum, o) => sum + o.estimatedCostCents, 0);

  return (
    <div className="stack-md">
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
        <div className="kpi-card">
          <div className="kpi-label">Total Persistent POs</div>
          <div className="kpi-value mono">{orders.length}</div>
          <div className="kpi-meta">Latest 30 replenishment orders</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Awaiting Receipt</div>
          <div className="kpi-value mono">
            {orders.filter((o) => ["draft", "approved", "sent", "partially_received"].includes(o.status)).length}
          </div>
          <div className="kpi-meta">Open on receiving dock</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Open Commitment</div>
          <div className="kpi-value mono">{formatMoney(openPoValueCents)}</div>
          <div className="kpi-meta">Estimated vendor PO cost</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Fully Received</div>
          <div className="kpi-value mono">
            {orders.filter((o) => o.status === "received").length}
          </div>
          <div className="kpi-meta">Closed against GRN</div>
        </div>
      </div>

      <div className="grid-asymmetric">
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2 className="panel-title">
                <FileText size={15} style={{ verticalAlign: "middle", marginRight: 6 }} />
                Purchase Order Register ({visibleOrders.length})
              </h2>
              <p className="panel-desc">
                Select any PO to inspect ordered vs. received cases, update status, or 1-click receive into GRN with automatic 3-way invoice matching.
              </p>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <select
                id="po-status-filter"
                className="select"
                style={{ width: 155 }}
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="all">All Statuses</option>
                <option value="draft">Draft</option>
                <option value="approved">Approved</option>
                <option value="sent">Sent</option>
                <option value="partially_received">Partially Received</option>
                <option value="received">Received</option>
                <option value="cancelled">Cancelled</option>
              </select>
              <button
                className="btn btn-sm"
                disabled={loading}
                onClick={() => void loadOrders()}
              >
                <RefreshCw size={13} /> Refresh
              </button>
            </div>
          </div>

          {loading && orders.length === 0 ? (
            <div style={{ padding: "16px 0", color: "var(--ink-muted)" }}>
              Loading purchase orders...
            </div>
          ) : visibleOrders.length === 0 ? (
            <div className="banner banner-amber">
              No purchase orders match the selected filter. Create one from Forecasts &amp; Basket AI or the AI Store Copilot.
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>PO Number</th>
                    <th>Supplier</th>
                    <th className="text-right">Cases</th>
                    <th className="text-right">Est. Cost</th>
                    <th>Status</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleOrders.map((po) => {
                    const isSelected = po.id === selectedPoId;
                    return (
                      <tr
                        key={po.id}
                        style={{
                          cursor: "pointer",
                          background: isSelected ? "rgba(18, 128, 92, 0.08)" : undefined,
                        }}
                        onClick={() => setSelectedPoId(po.id)}
                      >
                        <td className="mono" style={{ fontWeight: 700 }}>
                          {po.poNumber}
                        </td>
                        <td>
                          <div style={{ fontWeight: 600 }}>{po.supplierName}</div>
                          <div style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                            By {po.createdBy}
                          </div>
                        </td>
                        <td className="text-right mono">{po.totalCases}</td>
                        <td className="text-right mono">{formatMoney(po.estimatedCostCents)}</td>
                        <td>
                          <span className={`tag mono ${STATUS_TAG[po.status] ?? "tag-neutral"}`}>
                            {po.status}
                          </span>
                        </td>
                        <td className="mono" style={{ fontSize: 11.5 }}>
                          {new Date(po.createdAt).toLocaleDateString()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <h2 className="panel-title">
                <ClipboardCheck size={15} style={{ verticalAlign: "middle", marginRight: 6 }} />
                {detail ? `${detail.order.poNumber} — Lifecycle & Receiving` : "Purchase Order Detail"}
              </h2>
              <p className="panel-desc">
                {detail
                  ? `${detail.order.supplierName} · Created by ${detail.order.createdBy}${detail.order.approvedBy ? ` · Approved by ${detail.order.approvedBy}` : ""}`
                  : "Pick a purchase order on the left to inspect lines and receive against it."}
              </p>
            </div>
          </div>

          {loadingDetail ? (
            <div style={{ padding: "16px 0", color: "var(--ink-muted)" }}>
              Loading PO line details...
            </div>
          ) : !detail ? (
            <div style={{ padding: "12px 0", color: "var(--ink-muted)" }}>
              Select a purchase order to inspect line items, linked GRNs, and variances.
            </div>
          ) : (
            <div className="stack-md" style={{ gap: 12 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <span className={`tag mono ${STATUS_TAG[detail.order.status] ?? "tag-neutral"}`}>
                  Status: {detail.order.status}
                </span>
                <span className="tag tag-neutral mono">
                  Est: {formatMoney(detail.order.estimatedCostCents)}
                </span>
                {detail.order.status === "draft" && (
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={busyId !== null}
                    onClick={() => void handleStatusChange(detail.order, "approved")}
                  >
                    <CheckCircle2 size={13} /> Approve PO
                  </button>
                )}
                {(detail.order.status === "draft" || detail.order.status === "approved") && (
                  <button
                    className="btn btn-sm"
                    disabled={busyId !== null}
                    onClick={() => void handleStatusChange(detail.order, "sent")}
                  >
                    <Send size={13} /> Mark Sent to Vendor
                  </button>
                )}
                {!["received", "cancelled"].includes(detail.order.status) && (
                  <button
                    className="btn btn-sm"
                    style={{ color: "var(--accent-crimson)" }}
                    disabled={busyId !== null}
                    onClick={() => void handleStatusChange(detail.order, "cancelled")}
                  >
                    <XCircle size={13} /> Cancel PO
                  </button>
                )}
              </div>

              {detail.order.notes && (
                <div className="banner banner-amber" style={{ fontSize: 12.5 }}>
                  Note: {detail.order.notes}
                </div>
              )}

              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>SKU / Product</th>
                      <th className="text-right">Ordered</th>
                      <th className="text-right">Received</th>
                      <th className="text-right">Unit Cost</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {detail.lines.map((line) => (
                      <tr key={line.id}>
                        <td>
                          <div style={{ fontWeight: 600 }}>{line.productName}</div>
                          <div className="mono" style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                            {line.sku} · ×{line.caseQty} units/case
                          </div>
                        </td>
                        <td className="text-right mono">{line.orderedCases} cs</td>
                        <td className="text-right mono">
                          {line.receivedCases} cs
                          {line.remainingCases > 0 && (
                            <div style={{ fontSize: 11, color: "var(--accent-amber)" }}>
                              {line.remainingCases} remaining
                            </div>
                          )}
                        </td>
                        <td className="text-right mono">{formatMoney(line.unitCostCents)}</td>
                        <td className="text-right">
                          {line.remainingCases > 0 &&
                          !["received", "cancelled"].includes(detail.order.status) ? (
                            <button
                              className="btn btn-primary btn-sm"
                              onClick={() =>
                                onReceiveAgainstPo({
                                  poId: detail.order.id,
                                  poNumber: detail.order.poNumber,
                                  supplierId: detail.order.supplierId,
                                  productId: line.productId,
                                  sku: line.sku,
                                  productName: line.productName,
                                  caseQty: line.caseQty,
                                  paidCases: line.remainingCases,
                                  invoiceLineTotalCents:
                                    line.remainingCases * line.caseQty * line.unitCostCents,
                                })
                              }
                            >
                              <PackageCheck size={13} /> Receive Against PO
                            </button>
                          ) : (
                            <span className="tag tag-green">Complete</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {detail.grns.length > 0 && (
                <div>
                  <h3 style={{ fontSize: 13, margin: "4px 0 8px" }}>
                    Linked Goods Receipts ({detail.grns.length})
                  </h3>
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Invoice #</th>
                          <th>Received By</th>
                          <th className="text-right">Total</th>
                          <th>Date</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.grns.map((g) => (
                          <tr key={g.id}>
                            <td className="mono">{g.invoiceNumber}</td>
                            <td>{g.receivedBy}</td>
                            <td className="text-right mono">{formatMoney(g.totalInvoiceCents)}</td>
                            <td className="mono" style={{ fontSize: 11.5 }}>
                              {new Date(g.receivedAt).toLocaleDateString()}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {detail.variances.length > 0 && (
                <div className="banner banner-amber" style={{ fontSize: 12.5 }}>
                  {detail.variances.length} 3-way dock variance(s) detected on this PO — inspect and dispute in the Supplier OTIF &amp; 3-Way Match tab.
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
