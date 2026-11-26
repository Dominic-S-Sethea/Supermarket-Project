import { useEffect, useState } from "react";
import { formatMoney } from "@supermarket/shared/money";
import { Award, CheckCircle2, FileWarning, RefreshCw, Scale } from "lucide-react";
import { apiGet, apiPatch } from "../api";

interface SupplierScorecard {
  supplierId: string;
  supplierName: string;
  leadTimeDays: number;
  paymentTerms: string;
  contactEmail: string;
  poCount90d: number;
  grnCount90d: number;
  onTimeRatePct: number;
  inFullRatePct: number;
  otifRatePct: number;
  costVarianceRatePct: number;
  avgLeadTimeDays: number;
  leadTimeStdDays: number;
  totalVarianceCents: number;
  grade: string;
  openVarianceCount: number;
  openVarianceImpactCents: number;
}

interface ScorecardSummary {
  supplierCount: number;
  avgOtifPct: number;
  atRiskSuppliers: number;
  totalOpenVarianceImpactCents: number;
}

interface GrnVariance {
  id: string;
  grnId: string;
  poId: string | null;
  supplierId: string;
  supplierName: string;
  productId: string;
  sku: string;
  productName: string;
  invoiceNumber: string;
  poNumber: string | null;
  varianceType: string;
  orderedQtyUnits: number;
  receivedQtyUnits: number;
  poUnitCostCents: number;
  invoiceUnitCostCents: number;
  financialImpactCents: number;
  status: string;
  resolutionNote: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

interface VarianceSummary {
  openCount: number;
  disputedCount: number;
  resolvedCount: number;
  openImpactCents: number;
}

function gradeBadgeClass(grade: string): string {
  if (grade === "A") return "tag-green";
  if (grade === "B") return "tag-blue";
  if (grade === "C") return "tag-amber";
  return "tag-red";
}

function varianceTypeLabel(vType: string): { label: string; cls: string } {
  switch (vType) {
    case "short_delivery":
      return { label: "Short Delivery", cls: "tag-red" };
    case "over_delivery":
      return { label: "Over Delivery", cls: "tag-amber" };
    case "cost_overcharge":
      return { label: "Cost Overcharge", cls: "tag-red" };
    case "cost_savings":
      return { label: "Cost Savings", cls: "tag-green" };
    default:
      return { label: vType, cls: "tag-neutral" };
  }
}

function varianceStatusClass(status: string): string {
  if (status === "open") return "tag-red";
  if (status === "disputed") return "tag-amber";
  if (status === "resolved_credit_note") return "tag-green";
  return "tag-neutral";
}

export function SupplierMatchTab({
  canManage,
  onFeedback,
  onError,
}: {
  canManage: boolean;
  onFeedback: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [scorecards, setScorecards] = useState<SupplierScorecard[]>([]);
  const [scSummary, setScSummary] = useState<ScorecardSummary | null>(null);
  const [variances, setVariances] = useState<GrnVariance[]>([]);
  const [varSummary, setVarSummary] = useState<VarianceSummary | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [notesById, setNotesById] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadData = async (status = statusFilter, signal?: AbortSignal) => {
    setLoading(true);
    try {
      const qs = status === "all" ? "" : `?status=${encodeURIComponent(status)}`;
      const [scRes, varRes] = await Promise.all([
        apiGet<{ summary: ScorecardSummary; scorecards: SupplierScorecard[] }>(
          "/api/purchasing/supplier-scorecards",
          signal
        ),
        apiGet<{ summary: VarianceSummary; variances: GrnVariance[] }>(
          `/api/purchasing/variances${qs}`,
          signal
        ),
      ]);
      if (signal?.aborted) return;
      setScorecards(scRes.scorecards);
      setScSummary(scRes.summary);
      setVariances(varRes.variances);
      setVarSummary(varRes.summary);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        onError(err instanceof Error ? err.message : "Failed loading supplier scorecards & variances");
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void loadData(statusFilter, controller.signal);
    return () => controller.abort();
  }, [statusFilter]);

  const handleUpdateVariance = async (
    variance: GrnVariance,
    nextStatus: "disputed" | "resolved_credit_note" | "written_off"
  ) => {
    if (busyId) return;
    setBusyId(`${variance.id}-${nextStatus}`);
    try {
      const note =
        (notesById[variance.id] ?? variance.resolutionNote ?? "").trim() || undefined;
      await apiPatch(`/api/purchasing/variances/${variance.id}`, {
        status: nextStatus,
        resolutionNote: note,
      });
      const label =
        nextStatus === "disputed"
          ? "marked Disputed"
          : nextStatus === "resolved_credit_note"
            ? "resolved with Credit Note"
            : "written off";
      onFeedback(`Variance for ${variance.sku} (${variance.invoiceNumber}) ${label}.`);
      await loadData(statusFilter);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed updating variance status");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="stack-md" style={{ gap: 20 }}>
      <div className="kpi-strip">
        <div className="kpi-tile">
          <div className="kpi-label">Avg Supplier OTIF (90d)</div>
          <div className="kpi-value">{scSummary ? `${scSummary.avgOtifPct.toFixed(1)}%` : "—"}</div>
          <div className="kpi-meta">
            Across {scSummary?.supplierCount ?? 0} active FMCG distributors
          </div>
        </div>
        <div className="kpi-tile">
          <div className="kpi-label">At-Risk Vendors (Grade C/D)</div>
          <div
            className="kpi-value"
            style={{
              color: (scSummary?.atRiskSuppliers ?? 0) > 0 ? "var(--accent-crimson)" : "var(--accent-primary)",
            }}
          >
            {scSummary?.atRiskSuppliers ?? 0}
          </div>
          <div className="kpi-meta">Require lead-time buffer or renegotiation</div>
        </div>
        <div className="kpi-tile">
          <div className="kpi-label">Open / Disputed Dock Variances</div>
          <div className="kpi-value">
            {(varSummary?.openCount ?? 0) + (varSummary?.disputedCount ?? 0)}
          </div>
          <div className="kpi-meta">
            {varSummary?.openCount ?? 0} open · {varSummary?.disputedCount ?? 0} disputed · {varSummary?.resolvedCount ?? 0} resolved
          </div>
        </div>
        <div className="kpi-tile">
          <div className="kpi-label">Unresolved Financial Exposure</div>
          <div
            className="kpi-value"
            style={{
              color: (varSummary?.openImpactCents ?? 0) > 0 ? "var(--accent-amber)" : "var(--accent-primary)",
            }}
          >
            {formatMoney(varSummary?.openImpactCents ?? 0)}
          </div>
          <div className="kpi-meta">Pending credit notes or dock resolution</div>
        </div>
      </div>

      {/* Supplier 90-day OTIF Scorecards */}
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2 className="panel-title">
              <Award size={15} style={{ verticalAlign: "middle", marginRight: 6, color: "var(--accent-primary)" }} />
              90-Day Supplier OTIF &amp; Lead-Time Reliability Scorecards
            </h2>
            <p className="panel-desc">
              Ranked lowest-OTIF first so buyers spot short-shipping distributors and volatile lead times feeding safety stock.
            </p>
          </div>
          <button
            className="btn btn-sm"
            disabled={loading}
            onClick={() => void loadData(statusFilter)}
          >
            <RefreshCw size={13} /> Refresh
          </button>
        </div>

        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Grade</th>
                <th>Supplier</th>
                <th className="text-right">POs / GRNs</th>
                <th className="text-right">On-Time %</th>
                <th className="text-right">In-Full %</th>
                <th className="text-right">OTIF %</th>
                <th className="text-right">Lead Time (Avg ± σ)</th>
                <th className="text-right">Cost Var %</th>
                <th className="text-right">Open Exposure</th>
              </tr>
            </thead>
            <tbody>
              {loading && scorecards.length === 0 ? (
                <tr>
                  <td colSpan={9}>Loading supplier scorecards...</td>
                </tr>
              ) : scorecards.length === 0 ? (
                <tr>
                  <td colSpan={9} style={{ textAlign: "center", color: "var(--ink-muted)", padding: "20px 12px" }}>
                    No supplier scorecards computed yet. Run the analytics worker to refresh.
                  </td>
                </tr>
              ) : (
                scorecards.map((s) => (
                  <tr key={s.supplierId}>
                    <td>
                      <span className={`tag mono ${gradeBadgeClass(s.grade)}`}>Grade {s.grade}</span>
                    </td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{s.supplierName}</div>
                      <div style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                        Terms {s.paymentTerms} · Contract {s.leadTimeDays}d · {s.contactEmail}
                      </div>
                    </td>
                    <td className="text-right mono">
                      {s.poCount90d} / {s.grnCount90d}
                    </td>
                    <td className="text-right mono">{s.onTimeRatePct.toFixed(1)}%</td>
                    <td className="text-right mono">{s.inFullRatePct.toFixed(1)}%</td>
                    <td className="text-right mono" style={{ fontWeight: 700 }}>
                      {s.otifRatePct.toFixed(1)}%
                    </td>
                    <td className="text-right mono">
                      {s.avgLeadTimeDays.toFixed(1)}d ± {s.leadTimeStdDays.toFixed(1)}d
                    </td>
                    <td className="text-right mono">
                      <span className={`tag mono ${s.costVarianceRatePct > 5 ? "tag-amber" : "tag-neutral"}`}>
                        {s.costVarianceRatePct.toFixed(1)}%
                      </span>
                    </td>
                    <td className="text-right mono">
                      {s.openVarianceCount > 0 ? (
                        <strong style={{ color: "var(--accent-crimson)" }}>
                          {s.openVarianceCount} ({formatMoney(s.openVarianceImpactCents)})
                        </strong>
                      ) : (
                        <span style={{ color: "var(--ink-muted)" }}>$0.00</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* 3-Way Match Variance Queue */}
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2 className="panel-title">
              <Scale size={15} style={{ verticalAlign: "middle", marginRight: 6, color: "var(--accent-amber)" }} />
              3-Way Dock Variance Queue (PO vs. GRN vs. Supplier Invoice)
            </h2>
            <p className="panel-desc">
              Auto-flagged whenever a PO-linked GRN detects short/over deliveries or invoice unit cost diverging &gt;1% from PO contract price.
            </p>
          </div>
          <select
            id="variance-status-filter"
            className="select"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="all">All Statuses</option>
            <option value="open">Open</option>
            <option value="disputed">Disputed</option>
            <option value="resolved_credit_note">Resolved (Credit Note)</option>
            <option value="written_off">Written Off</option>
          </select>
        </div>

        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Supplier / Doc</th>
                <th>Product</th>
                <th className="text-right">Ord → Rcv Qty</th>
                <th className="text-right">PO → Inv Cost</th>
                <th className="text-right">Impact</th>
                <th>Status &amp; Note</th>
                {canManage && <th className="text-right">Resolution</th>}
              </tr>
            </thead>
            <tbody>
              {loading && variances.length === 0 ? (
                <tr>
                  <td colSpan={canManage ? 8 : 7}>Loading 3-way dock variances...</td>
                </tr>
              ) : variances.length === 0 ? (
                <tr>
                  <td colSpan={canManage ? 8 : 7} style={{ textAlign: "center", color: "var(--ink-muted)", padding: "20px 12px" }}>
                    No dock variances match this filter.
                  </td>
                </tr>
              ) : (
                variances.map((v) => {
                  const vt = varianceTypeLabel(v.varianceType);
                  const isClosed =
                    v.status === "resolved_credit_note" || v.status === "written_off";
                  return (
                    <tr key={v.id}>
                      <td>
                        <span className={`tag ${vt.cls}`}>{vt.label}</span>
                      </td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{v.supplierName}</div>
                        <div className="mono" style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                          {v.poNumber ?? "No PO"} · {v.invoiceNumber}
                        </div>
                      </td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{v.productName}</div>
                        <div className="mono" style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                          {v.sku}
                        </div>
                      </td>
                      <td className="text-right mono">
                        {v.orderedQtyUnits} → <strong>{v.receivedQtyUnits}</strong>
                      </td>
                      <td className="text-right mono">
                        {formatMoney(v.poUnitCostCents)} → {formatMoney(v.invoiceUnitCostCents)}
                      </td>
                      <td className="text-right mono" style={{ fontWeight: 700 }}>
                        {formatMoney(v.financialImpactCents)}
                      </td>
                      <td>
                        <span className={`tag ${varianceStatusClass(v.status)}`}>
                          {v.status.replace(/_/g, " ")}
                        </span>
                        {canManage && !isClosed ? (
                          <input
                            className="input"
                            style={{ marginTop: 6, fontSize: 12, padding: "4px 8px", minWidth: 160 }}
                            placeholder="Credit note # or dispute note..."
                            value={notesById[v.id] ?? v.resolutionNote ?? ""}
                            onChange={(e) =>
                              setNotesById((prev) => ({ ...prev, [v.id]: e.target.value }))
                            }
                          />
                        ) : (
                          v.resolutionNote && (
                            <div style={{ fontSize: 11.5, color: "var(--ink-muted)", marginTop: 4 }}>
                              {v.resolutionNote}
                            </div>
                          )
                        )}
                      </td>
                      {canManage && (
                        <td className="text-right">
                          {isClosed ? (
                            <span style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                              <CheckCircle2 size={13} style={{ verticalAlign: "middle", marginRight: 4 }} />
                              Closed
                            </span>
                          ) : (
                            <div style={{ display: "inline-flex", gap: 5, flexWrap: "wrap", justifyContent: "flex-end" }}>
                              {v.status !== "disputed" && (
                                <button
                                  className="btn btn-amber btn-sm"
                                  disabled={busyId !== null}
                                  onClick={() => void handleUpdateVariance(v, "disputed")}
                                >
                                  <FileWarning size={12} /> Dispute
                                </button>
                              )}
                              <button
                                className="btn btn-primary btn-sm"
                                disabled={busyId !== null}
                                onClick={() => void handleUpdateVariance(v, "resolved_credit_note")}
                              >
                                Credit Note
                              </button>
                              <button
                                className="btn btn-sm"
                                disabled={busyId !== null}
                                onClick={() => void handleUpdateVariance(v, "written_off")}
                              >
                                Write Off
                              </button>
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
