import { Fragment, useEffect, useState } from "react";
import type { UserRole } from "@supermarket/shared/dtos";
import { formatMoney } from "@supermarket/shared/money";
import { RefreshCw, ShieldAlert, Sparkles } from "lucide-react";
import { apiGet, apiPost } from "../api";

interface MatrixCell {
  segment: string;
  abcClass: string;
  xyzClass: string;
  skuCount: number;
  revenueCents: number;
  profitCents: number;
  avgGmroii: number;
}

interface AbcSkuRow {
  productId: string;
  sku: string;
  name: string;
  brand: string;
  departmentName: string;
  segment: string;
  revenue60dCents: number;
  profit60dCents: number;
  units60d: number;
  demandCv: number;
  gmroii: number;
  daysOfStock: number;
  recommendedAction: string;
}

interface CashierAnomaly {
  id: string;
  cashierName: string;
  totalSalesCount: number;
  voidCount: number;
  refundCount: number;
  noSaleDrawerCount: number;
  voidRatePct: number;
  zScore: number;
  riskLevel: string;
}

interface DeadStockRow {
  id: string;
  sku: string;
  name: string;
  brand: string;
  departmentName: string;
  onHandUnits: number;
  tiedCapitalCents: number;
  units60d: number;
}

interface TriageResult {
  model: string;
  mode: string;
  summary: string;
  recommendedAction: string;
  questions: {
    key: string;
    label: string;
    probability: number;
    confidence: number;
    verdict: string;
  }[];
}

export function AbcLossView({ userRole = "owner" }: { userRole?: UserRole }) {
  const canTriage = userRole === "owner" || userRole === "manager";

  const [selectedSegment, setSelectedSegment] = useState<string>("");
  const [matrix, setMatrix] = useState<MatrixCell[]>([]);
  const [skus, setSkus] = useState<AbcSkuRow[]>([]);
  const [cashiers, setCashiers] = useState<CashierAnomaly[]>([]);
  const [deadStock, setDeadStock] = useState<DeadStockRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [triageLoading, setTriageLoading] = useState<string | null>(null);
  const [triageResult, setTriageResult] = useState<{
    cashierName: string;
    data: TriageResult;
  } | null>(null);

  const loadData = async (segmentFilter = selectedSegment, signal?: AbortSignal) => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const qs = segmentFilter ? `?segment=${encodeURIComponent(segmentFilter)}` : "";
      const [abc, lp] = await Promise.all([
        apiGet<{ matrix: MatrixCell[]; skus: AbcSkuRow[] }>(`/api/analytics/abc-xyz${qs}`, signal),
        apiGet<{
          cashierAnomalies: CashierAnomaly[];
          deadStockTraps: DeadStockRow[];
        }>("/api/analytics/loss-prevention", signal),
      ]);
      if (signal?.aborted) return;
      setMatrix(abc.matrix);
      setSkus(abc.skus);
      setCashiers(lp.cashierAnomalies);
      setDeadStock(lp.deadStockTraps);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setErrorMsg(err instanceof Error ? err.message : "Failed loading ABC-XYZ & Loss Prevention data.");
      }
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  };

  const runCashierTriage = async (c: CashierAnomaly) => {
    if (!canTriage || triageLoading) return;
    setErrorMsg(null);
    setTriageLoading(c.id);
    try {
      const data = await apiPost<TriageResult>("/api/ai/triage", {
        targetType: "cashier_anomaly",
        subjectId: c.id,
        metrics: {
          cashierName: c.cashierName,
          totalSalesCount: c.totalSalesCount,
          voidCount: c.voidCount,
          refundCount: c.refundCount,
          noSaleDrawerCount: c.noSaleDrawerCount,
          voidRatePct: c.voidRatePct,
          zScore: c.zScore,
          riskLevel: c.riskLevel,
        },
      });
      setTriageResult({ cashierName: c.cashierName, data });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed running AI cashier risk triage.");
    } finally {
      setTriageLoading(null);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void loadData(selectedSegment, controller.signal);
    return () => controller.abort();
  }, [selectedSegment]);

  const cellMap = new Map(matrix.map((m) => [m.segment, m]));
  const totalDeadCapital = deadStock.reduce((s, d) => s + d.tiedCapitalCents, 0);

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>ABC-XYZ Inventory Segmentation &amp; Loss Prevention</h1>
          <p className="page-subtitle">
            Computed by the Python Analytics Worker across all 3,120 SKUs — triage high-profit staples vs. dead-stock cash traps and flag cashier anomalies.
          </p>
        </div>
        <div className="header-actions">
          {selectedSegment && (
            <button className="btn" onClick={() => setSelectedSegment("")}>
              Clear Filter ({selectedSegment})
            </button>
          )}
          <button className="btn" disabled={loading} onClick={() => void loadData(selectedSegment)}>
            <RefreshCw size={14} /> {loading ? "Loading..." : "Refresh"}
          </button>
        </div>
      </header>

      {errorMsg && (
        <div className="banner banner-red" style={{ marginBottom: 16 }}>
          <span>{errorMsg}</span>
          <button className="btn btn-sm" onClick={() => setErrorMsg(null)}>
            Dismiss
          </button>
        </div>
      )}

      <section className="panel" style={{ marginBottom: 20 }}>
        <div className="panel-header">
          <div>
            <h2 className="panel-title">Interactive 3×3 ABC-XYZ Matrix (Click Any Cell to Drill Down)</h2>
            <p className="panel-desc">
              <strong>A/B/C</strong> = 60-day Gross Profit Pareto (78% / 16% / 6%) ·{" "}
              <strong>X/Y/Z</strong> = Demand Predictability (Smooth / Seasonal / Intermittent).
            </p>
          </div>
        </div>

        <div className="table-wrap">
          <div className="abc-grid">
            <div />
            <div className="abc-axis-head">X · Steady / Smooth</div>
            <div className="abc-axis-head">Y · Seasonal / Variable</div>
            <div className="abc-axis-head">Z · Intermittent / Lumpy</div>

            {(["A", "B", "C"] as const).map((abc) => (
              <Fragment key={`row-${abc}`}>
                <div className="abc-row-head">
                  <span>Class {abc}</span>
                  <span style={{ fontSize: 11, fontWeight: 400, color: "var(--ink-muted)" }}>
                    {abc === "A" ? "Top 78% Profit" : abc === "B" ? "Next 16%" : "Bottom 6%"}
                  </span>
                </div>
                {(["X", "Y", "Z"] as const).map((xyz) => {
                  const seg = `${abc}${xyz}`;
                  const cell = cellMap.get(seg);
                  const tint =
                    abc === "A" && xyz === "X"
                      ? "hsl(156, 44%, 95%)"
                      : abc === "C" && xyz === "Z"
                        ? "hsl(4, 58%, 96%)"
                        : abc === "A"
                          ? "hsl(156, 26%, 97%)"
                          : "var(--bg-surface)";
                  return (
                    <button
                      key={seg}
                      className={`abc-cell ${selectedSegment === seg ? "selected" : ""}`}
                      style={{ background: tint }}
                      onClick={() => setSelectedSegment(selectedSegment === seg ? "" : seg)}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <strong className="mono" style={{ fontSize: 15 }}>
                          {seg}
                        </strong>
                        <span className="tag tag-neutral mono">{cell?.skuCount ?? 0} SKUs</span>
                      </div>
                      <div className="mono" style={{ fontSize: 17, fontWeight: 700, marginTop: 8 }}>
                        {formatMoney(cell?.profitCents ?? 0)}
                      </div>
                      <div style={{ fontSize: 11.5, color: "var(--ink-secondary)", marginTop: 3 }}>
                        60d Profit · Avg GMROII <strong className="mono">${(cell?.avgGmroii ?? 0).toFixed(2)}</strong>
                      </div>
                    </button>
                  );
                })}
              </Fragment>
            ))}
          </div>
        </div>
      </section>

      <section className="panel" style={{ marginBottom: 20 }}>
        <div className="panel-header">
          <div>
            <h2 className="panel-title">
              Top SKUs {selectedSegment ? `in Segment ${selectedSegment}` : "Across Store"} ({Math.min(20, skus.length)} of {skus.length} shown)
            </h2>
          </div>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Segment</th>
                <th>SKU / Product</th>
                <th className="text-right">Units (60d)</th>
                <th className="text-right">Gross Profit</th>
                <th className="text-right">Demand CV</th>
                <th className="text-right">GMROII</th>
                <th className="text-right">Days Stock</th>
                <th>Operational Playbook</th>
              </tr>
            </thead>
            <tbody>
              {loading && skus.length === 0 ? (
                <tr>
                  <td colSpan={8}>Loading ABC-XYZ segmentation...</td>
                </tr>
              ) : skus.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: "center", color: "var(--ink-muted)", padding: "20px 12px" }}>
                    No ABC-XYZ records found{selectedSegment ? ` in segment ${selectedSegment}` : ""}. Run the Python analytics worker to compute segmentation.
                  </td>
                </tr>
              ) : (
                skus.slice(0, 20).map((s) => (
                  <tr key={s.productId}>
                    <td>
                      <span
                        className={`tag mono ${
                          s.segment.startsWith("A")
                            ? "tag-green"
                            : s.segment.startsWith("B")
                              ? "tag-blue"
                              : "tag-red"
                        }`}
                      >
                        {s.segment}
                      </span>
                    </td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{s.name}</div>
                      <div style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                        {s.sku} · {s.departmentName}
                      </div>
                    </td>
                    <td className="text-right mono">{s.units60d.toLocaleString()}</td>
                    <td className="text-right mono" style={{ fontWeight: 600 }}>
                      {formatMoney(s.profit60dCents)}
                    </td>
                    <td className="text-right mono">{s.demandCv.toFixed(2)}</td>
                    <td className="text-right mono">${s.gmroii.toFixed(2)}</td>
                    <td className="text-right mono">
                      {s.daysOfStock >= 999 ? "∞" : `${s.daysOfStock.toFixed(0)}d`}
                    </td>
                    <td style={{ fontSize: 12.5, color: "var(--ink-secondary)" }}>
                      {s.recommendedAction}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid-2">
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2 className="panel-title">
                <ShieldAlert size={15} style={{ verticalAlign: "middle", marginRight: 6, color: "var(--accent-crimson)" }} />
                Cashier Loss-Prevention Exception Scorecard
              </h2>
              <p className="panel-desc">
                Z-score outlier detection across 60-day void rates, refunds, and &ldquo;No-Sale&rdquo; cash drawer opens.
              </p>
            </div>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Cashier</th>
                  <th className="text-right">Receipts</th>
                  <th className="text-right">Voids</th>
                  <th className="text-right">Refunds</th>
                  <th className="text-right">No-Sale Opens</th>
                  <th className="text-right">Void %</th>
                  <th className="text-right">MAD Z</th>
                  <th>Risk</th>
                  {canTriage && <th />}
                </tr>
              </thead>
              <tbody>
                {loading && cashiers.length === 0 ? (
                  <tr>
                    <td colSpan={canTriage ? 9 : 8}>Loading loss-prevention scorecard...</td>
                  </tr>
                ) : cashiers.length === 0 ? (
                  <tr>
                    <td colSpan={canTriage ? 9 : 8} style={{ textAlign: "center", color: "var(--ink-muted)" }}>
                      No cashier exception metrics computed yet.
                    </td>
                  </tr>
                ) : (
                  cashiers.map((c) => (
                    <tr key={c.id}>
                      <td style={{ fontWeight: 600 }}>{c.cashierName}</td>
                      <td className="text-right mono">{c.totalSalesCount.toLocaleString()}</td>
                      <td className="text-right mono">{c.voidCount}</td>
                      <td className="text-right mono">{c.refundCount}</td>
                      <td className="text-right mono">{c.noSaleDrawerCount}</td>
                      <td className="text-right mono">{c.voidRatePct.toFixed(2)}%</td>
                      <td className="text-right mono">{c.zScore > 0 ? `+${c.zScore.toFixed(2)}` : c.zScore.toFixed(2)}</td>
                      <td>
                        <span
                          className={`tag ${
                            c.riskLevel === "high"
                              ? "tag-red"
                              : c.riskLevel === "elevated"
                                ? "tag-amber"
                                : "tag-green"
                          }`}
                        >
                          {c.riskLevel.toUpperCase()}
                        </span>
                      </td>
                      {canTriage && (
                        <td className="text-right">
                          <button
                            className="btn btn-sm"
                            disabled={triageLoading !== null}
                            onClick={() => void runCashierTriage(c)}
                          >
                            <Sparkles size={11} /> {triageLoading === c.id ? "..." : "AI Triage"}
                          </button>
                        </td>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {triageResult && (
            <div className="triage-box" style={{ marginTop: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <strong style={{ fontSize: 13 }}>
                  Calibrated Risk Triage — {triageResult.cashierName}
                </strong>
                <span className="tag tag-blue mono">{triageResult.data.model}</span>
              </div>
              <div style={{ fontSize: 12.5, color: "var(--ink-secondary)", margin: "6px 0 10px" }}>
                {triageResult.data.recommendedAction}
              </div>
              <div className="stack-md" style={{ gap: 7 }}>
                {triageResult.data.questions.map((q) => (
                  <div key={q.key}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 3 }}>
                      <span>{q.label}</span>
                      <span className="mono">
                        <strong>{Math.round(q.probability * 100)}%</strong> (conf{" "}
                        {Math.round(q.confidence * 100)}%)
                      </span>
                    </div>
                    <div style={{ height: 6, borderRadius: 4, background: "var(--bg-subtle)", overflow: "hidden" }}>
                      <div
                        style={{
                          width: `${Math.round(q.probability * 100)}%`,
                          height: "100%",
                          background:
                            q.probability >= 0.65
                              ? "var(--accent-crimson)"
                              : q.probability >= 0.4
                                ? "var(--accent-amber)"
                                : "var(--accent-primary)",
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <h2 className="panel-title">
                Dead-Stock Capital Traps (Top 25 · <span className="mono">{formatMoney(totalDeadCapital)}</span> tied up)
              </h2>
              <p className="panel-desc">
                Packaged SKUs with ≤2 units sold in 60 days while holding heavy backroom/shelf stock.
              </p>
            </div>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>SKU / Product</th>
                  <th className="text-right">60d Sold</th>
                  <th className="text-right">On Hand</th>
                  <th className="text-right">Tied Cash</th>
                </tr>
              </thead>
              <tbody>
                {loading && deadStock.length === 0 ? (
                  <tr>
                    <td colSpan={4}>Loading dead-stock analysis...</td>
                  </tr>
                ) : deadStock.length === 0 ? (
                  <tr>
                    <td colSpan={4} style={{ textAlign: "center", color: "var(--ink-muted)" }}>
                      No dead-stock capital traps detected!
                    </td>
                  </tr>
                ) : (
                  deadStock.slice(0, 12).map((d) => (
                    <tr key={d.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{d.name}</div>
                        <div style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                          {d.sku} · {d.departmentName}
                        </div>
                      </td>
                      <td className="text-right mono">{d.units60d}</td>
                      <td className="text-right mono">{d.onHandUnits}</td>
                      <td className="text-right mono" style={{ fontWeight: 600, color: "var(--accent-crimson)" }}>
                        {formatMoney(d.tiedCapitalCents)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
