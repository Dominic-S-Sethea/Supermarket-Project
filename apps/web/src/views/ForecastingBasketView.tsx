import { useEffect, useState } from "react";
import { formatMoney, type UserRole } from "@supermarket/shared";
import { ArrowRight, ClipboardList, Sparkles, Truck } from "lucide-react";
import { apiGet, apiPatch, apiPost } from "../api";

interface DraftPo {
  supplierName: string;
  skuCount: number;
  totalCases: number;
  estimatedCostCents: number;
}

interface ForecastRow {
  productId: string;
  sku: string;
  name: string;
  brand: string;
  departmentName: string;
  avgCostCents: number;
  modelUsed: string;
  forecast7dUnits: number;
  forecast14dUnits: number;
  safetyStockUnits: number;
  reorderPointUnits: number;
  currentStockUnits: number;
  suggestedOrderCases: number;
  caseQty: number;
  estimatedOrderCostCents: number;
  supplierName: string;
  wmapePct: number;
  urgency: string;
}

interface BasketRule {
  id: string;
  antecedentName: string;
  consequentName: string;
  coOccurrences: number;
  support: number;
  confidence: number;
  lift: number;
}

interface PersistedPo {
  id: string;
  poNumber: string;
  supplierName: string;
  status: string;
  totalCases: number;
  estimatedCostCents: number;
  createdBy: string;
  createdAt: string;
}

interface SupplierOption {
  id: string;
  name: string;
}

export function ForecastingBasketView({ userRole = "owner" }: { userRole?: UserRole }) {
  const canManage = userRole === "owner" || userRole === "manager";

  const [urgency, setUrgency] = useState("");
  const [draftPos, setDraftPos] = useState<DraftPo[]>([]);
  const [forecasts, setForecasts] = useState<ForecastRow[]>([]);
  const [basketRules, setBasketRules] = useState<BasketRule[]>([]);
  const [orders, setOrders] = useState<PersistedPo[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadData = async (u = urgency, signal?: AbortSignal) => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const qs = u ? `?urgency=${encodeURIComponent(u)}` : "";
      const [fc, br, poRes, metaRes] = await Promise.all([
        apiGet<{ supplierDraftPos: DraftPo[]; items: ForecastRow[] }>(
          `/api/analytics/forecasts${qs}`,
          signal
        ),
        apiGet<{ rules: BasketRule[] }>("/api/analytics/basket-rules", signal),
        apiGet<{ orders: PersistedPo[] }>("/api/purchasing/orders", signal).catch(() => ({
          orders: [],
        })),
        apiGet<{ suppliers: SupplierOption[] }>("/api/meta", signal),
      ]);
      if (signal?.aborted) return;
      setDraftPos(fc.supplierDraftPos);
      setForecasts(fc.items);
      setBasketRules(br.rules);
      setOrders(poRes.orders);
      setSuppliers(metaRes.suppliers);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setErrorMsg(err instanceof Error ? err.message : "Failed loading forecasts");
      }
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void loadData(urgency, controller.signal);
    return () => controller.abort();
  }, [urgency]);

  const handleApproveDraftPo = async (po: DraftPo) => {
    if (!canManage || busyKey) return;
    setErrorMsg(null);
    const sup = suppliers.find((s) => s.name === po.supplierName);
    if (!sup) {
      setErrorMsg(`Supplier "${po.supplierName}" not found.`);
      return;
    }
    const matchingLines = forecasts.filter(
      (f) => f.supplierName === po.supplierName && f.suggestedOrderCases > 0
    );
    if (matchingLines.length === 0) return;

    setBusyKey(`draft-${po.supplierName}`);
    try {
      const created = await apiPost<PersistedPo>("/api/purchasing/orders", {
        supplierId: sup.id,
        status: "approved",
        notes: "Approved from Predictive Replenishment Draft PO",
        lines: matchingLines.map((f) => ({
          productId: f.productId,
          caseQty: f.caseQty,
          orderedCases: f.suggestedOrderCases,
          unitCostCents: f.avgCostCents,
        })),
      });
      setFeedback(`Persisted PO ${created.poNumber} for ${po.supplierName} (${po.totalCases} cases).`);
      await loadData(urgency);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed saving Purchase Order");
    } finally {
      setBusyKey(null);
    }
  };

  const handleStatusChange = async (poId: string, status: "sent" | "cancelled") => {
    if (!canManage || busyKey) return;
    setErrorMsg(null);
    setBusyKey(`po-${poId}-${status}`);
    try {
      await apiPatch(`/api/purchasing/orders/${poId}/status`, { status });
      await loadData(urgency);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed updating PO status");
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>Predictive Demand Forecasting, Auto-POs &amp; Market Basket AI</h1>
          <p className="page-subtitle">
            Leak-free portfolio forecasting engine (<strong>WeekendETS</strong> for smooth beverages/snacks + <strong>CrostonSBA</strong> for intermittent long-tail SKUs) &amp; receipt association mining.
          </p>
        </div>
      </header>

      {errorMsg && (
        <div className="banner banner-red" style={{ marginBottom: 14 }}>
          <span>{errorMsg}</span>
          <button className="btn btn-sm" onClick={() => setErrorMsg(null)}>
            Dismiss
          </button>
        </div>
      )}
      {feedback && (
        <div className="banner banner-green" style={{ marginBottom: 14 }}>
          <span>{feedback}</span>
          <button className="btn btn-sm" onClick={() => setFeedback(null)}>
            Dismiss
          </button>
        </div>
      )}

      {/* Auto-Replenishment Draft POs by Supplier */}
      <section className="panel" style={{ marginBottom: 20 }}>
        <div className="panel-header">
          <div>
            <h2 className="panel-title">
              <Truck size={15} style={{ verticalAlign: "middle", marginRight: 6 }} />
              Auto-Replenishment Draft Purchase Orders (Grouped by Supplier &amp; Case-Rounded)
            </h2>
            <p className="panel-desc">
              Calculated from 14-day demand forecasts + dynamic lead-time safety stock, rounded cleanly to supplier Case Qty &amp; MOQ.
            </p>
          </div>
        </div>

        {loading && draftPos.length === 0 ? (
          <div style={{ color: "var(--ink-muted)", padding: "12px 0" }}>
            Loading supplier replenishment recommendations...
          </div>
        ) : draftPos.length === 0 ? (
          <div style={{ color: "var(--ink-muted)", padding: "12px 0" }}>
            No supplier draft POs required for the selected urgency filter.
          </div>
        ) : (
          <div className="kpi-strip" style={{ marginBottom: 0 }}>
            {draftPos.map((po) => (
              <div key={po.supplierName} className="kpi-tile">
                <div style={{ fontWeight: 700, fontSize: 13.5 }}>{po.supplierName}</div>
                <div className="kpi-value" style={{ fontSize: 21 }}>
                  {formatMoney(po.estimatedCostCents)}
                </div>
                <div className="kpi-meta" style={{ marginBottom: 10 }}>
                  <span className="mono">{po.skuCount}</span> SKUs ·{" "}
                  <strong className="mono">{po.totalCases}</strong> cases to order
                </div>
                {canManage && (
                  <button
                    className="btn btn-sm btn-primary"
                    style={{ width: "100%" }}
                    disabled={busyKey !== null}
                    onClick={() => void handleApproveDraftPo(po)}
                  >
                    {busyKey === `draft-${po.supplierName}`
                      ? "Saving PO..."
                      : "Approve & Persist PO"}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Persisted Purchase Orders */}
      {orders.length > 0 && (
        <section className="panel" style={{ marginBottom: 20 }}>
          <div className="panel-header">
            <div>
              <h2 className="panel-title">
                <ClipboardList size={15} style={{ verticalAlign: "middle", marginRight: 6 }} />
                Persisted Purchase Orders ({orders.length})
              </h2>
              <p className="panel-desc">Stored in PostgreSQL with full audit trail.</p>
            </div>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>PO #</th>
                  <th>Supplier</th>
                  <th>Status</th>
                  <th className="text-right">Cases</th>
                  <th className="text-right">Est. Cost</th>
                  <th>Created By</th>
                  {canManage && <th className="text-right">Action</th>}
                </tr>
              </thead>
              <tbody>
                {orders.slice(0, 10).map((o) => (
                  <tr key={o.id}>
                    <td className="mono" style={{ fontWeight: 600 }}>{o.poNumber}</td>
                    <td>{o.supplierName}</td>
                    <td>
                      <span
                        className={`tag ${
                          o.status === "sent" || o.status === "received"
                            ? "tag-green"
                            : o.status === "cancelled"
                              ? "tag-red"
                              : "tag-blue"
                        }`}
                      >
                        {o.status.toUpperCase()}
                      </span>
                    </td>
                    <td className="text-right mono">{o.totalCases}</td>
                    <td className="text-right mono">{formatMoney(o.estimatedCostCents)}</td>
                    <td>{o.createdBy}</td>
                    {canManage && (
                      <td className="text-right">
                        {o.status === "approved" && (
                          <div style={{ display: "inline-flex", gap: 6 }}>
                            <button
                              className="btn btn-sm btn-primary"
                              disabled={busyKey !== null}
                              onClick={() => void handleStatusChange(o.id, "sent")}
                            >
                              Mark Sent
                            </button>
                            <button
                              className="btn btn-sm"
                              disabled={busyKey !== null}
                              onClick={() => void handleStatusChange(o.id, "cancelled")}
                            >
                              Cancel
                            </button>
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* SKU-Level Forecast & Reorder Table */}
      <section className="panel" style={{ marginBottom: 20 }}>
        <div className="panel-header">
          <div>
            <h2 className="panel-title">SKU-Level Replenishment Forecasts</h2>
            <p className="panel-desc">
              Dynamic ROP accounts for both daily sales variance and supplier lead-time variance.
            </p>
          </div>
          <select
            className="select"
            value={urgency}
            onChange={(e) => setUrgency(e.target.value)}
          >
            <option value="">All SKUs Needing Reorder</option>
            <option value="critical">Critical Stockout Risk</option>
            <option value="reorder_now">Reorder Now</option>
            <option value="watch">Watch List</option>
          </select>
        </div>

        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Urgency</th>
                <th>SKU / Product</th>
                <th>Model</th>
                <th className="text-right">7d / 14d Fcst</th>
                <th className="text-right">Stock vs ROP</th>
                <th className="text-right">Order (Cases)</th>
                <th className="text-right">Est. PO Cost</th>
                <th className="text-right">WMAPE</th>
              </tr>
            </thead>
            <tbody>
              {loading && forecasts.length === 0 ? (
                <tr>
                  <td colSpan={8}>Loading demand forecasts...</td>
                </tr>
              ) : forecasts.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: "center", color: "var(--ink-muted)", padding: "20px 12px" }}>
                    No SKUs match the selected replenishment urgency filter.
                  </td>
                </tr>
              ) : (
                forecasts.slice(0, 30).map((f) => (
                  <tr key={f.productId}>
                    <td>
                      <span
                        className={`tag ${
                          f.urgency === "critical"
                            ? "tag-red"
                            : f.urgency === "reorder_now"
                              ? "tag-amber"
                              : "tag-blue"
                        }`}
                      >
                        {f.urgency.replace("_", " ").toUpperCase()}
                      </span>
                    </td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{f.name}</div>
                      <div style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                        {f.sku} · {f.supplierName}
                      </div>
                    </td>
                    <td>
                      <span className="tag tag-neutral mono">{f.modelUsed}</span>
                    </td>
                    <td className="text-right mono">
                      {f.forecast7dUnits} / {f.forecast14dUnits}
                    </td>
                    <td className="text-right mono">
                      <strong
                        style={{
                          color:
                            f.currentStockUnits <= f.reorderPointUnits
                              ? "var(--accent-crimson)"
                              : "inherit",
                        }}
                      >
                        {f.currentStockUnits}
                      </strong>{" "}
                      <span style={{ color: "var(--ink-muted)" }}>/ ROP {f.reorderPointUnits}</span>
                    </td>
                    <td className="text-right mono">
                      <strong>{f.suggestedOrderCases} cs</strong>{" "}
                      <span style={{ fontSize: 11, color: "var(--ink-muted)" }}>
                        (×{f.caseQty})
                      </span>
                    </td>
                    <td className="text-right mono">{formatMoney(f.estimatedOrderCostCents)}</td>
                    <td className="text-right mono">{f.wmapePct.toFixed(1)}%</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Market Basket Association Rules */}
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2 className="panel-title">
              <Sparkles size={15} style={{ verticalAlign: "middle", marginRight: 6, color: "var(--accent-primary)" }} />
              Market Basket Association Rules (High-Lift Co-Purchase Mining)
            </h2>
            <p className="panel-desc">
              Pairs with <strong>Lift &gt; 2.0</strong> are prime targets for adjacent aisle placement, end-cap displays, and combo promotions.
            </p>
          </div>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>If Customer Buys (Antecedent)</th>
                <th />
                <th>They Frequently Also Buy (Consequent)</th>
                <th className="text-right">Co-Baskets</th>
                <th className="text-right">Confidence</th>
                <th className="text-right">Lift</th>
                <th>Merchandising Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && basketRules.length === 0 ? (
                <tr>
                  <td colSpan={7}>Loading association rules...</td>
                </tr>
              ) : basketRules.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: "center", color: "var(--ink-muted)", padding: "20px 12px" }}>
                    No high-lift market basket pairs computed yet.
                  </td>
                </tr>
              ) : (
                basketRules.slice(0, 18).map((r) => (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600 }}>{r.antecedentName}</td>
                    <td style={{ color: "var(--ink-muted)" }}>
                      <ArrowRight size={14} />
                    </td>
                    <td style={{ fontWeight: 600 }}>{r.consequentName}</td>
                    <td className="text-right mono">{r.coOccurrences}</td>
                    <td className="text-right mono">{(r.confidence * 100).toFixed(1)}%</td>
                    <td className="text-right">
                      <span className={`tag mono ${r.lift >= 5 ? "tag-green" : "tag-blue"}`}>
                        {r.lift.toFixed(2)}×
                      </span>
                    </td>
                    <td style={{ fontSize: 12, color: "var(--ink-secondary)" }}>
                      {r.lift >= 6
                        ? "Place on shared weekend end-cap or combo bundle"
                        : "Cross-merchandise in adjacent aisle clip-strip"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
