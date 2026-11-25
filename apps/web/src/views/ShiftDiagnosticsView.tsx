import { useEffect, useState } from "react";
import { formatMoney, type UserRole } from "@supermarket/shared";
import {
  Camera,
  FlaskConical,
  Plus,
  RefreshCw,
  ShoppingBag,
  Sparkles,
  Sun,
  Users,
} from "lucide-react";
import { apiGet, apiPost } from "../api";

interface ShiftRow {
  shiftKey: string;
  label: string;
  saleReceipts: number;
  voidRefundCount: number;
  voidRefundRatePct: number;
  grossSalesCents: number;
  netSalesCents: number;
  grossProfitCents: number;
  grossMarginPct: number;
  revenueSharePct: number;
  revenuePerOpenHourUsd: number;
  atvCents: number;
  avgPacks: number;
  avgSkus: number;
  multipackLinePct: number;
  walkInEntries: number;
  conversionPct: number;
  conversionCiLow: number;
  conversionCiHigh: number;
  avgOpenLanes: number;
  avgDwellSec: number;
  activeHoursObserved: number;
}

interface HourlyPoint {
  hour: number;
  shiftKey: string;
  walkIns: number;
  receipts: number;
  conversionPct: number;
  revenueCents: number;
  avgOpenLanes: number;
  avgDwellSec: number;
}

interface OosRootCause {
  productId: string;
  sku: string;
  name: string;
  departmentName: string;
  abcSegment: string;
  oosDays: number;
  snapshotDays: number;
  avgRestockHour: number;
  expectedMorningUnitsPerDay: number;
  estLostRevenueCents: number;
  suggestedPreOpenPickUnits: number;
  supplierId: string;
  supplierName: string;
}

interface QueueBin {
  loadBin: string;
  buckets: number;
  conversionPct: number;
  avgDwellSec: number;
  avgEntries: number;
}

interface RidgeDriver {
  feature: string;
  label: string;
  coefUsdPerSd: number;
  importancePct: number;
  direction: "positive" | "negative";
}

interface MissionCluster {
  clusterId: number;
  name: string;
  receipts: number;
  sharePct: number;
  avgHour: number;
  avgSkus: number;
  avgAtvUsd: number;
  multipackPct: number;
  morningSharePct: number;
  afternoonSharePct: number;
  eveningSharePct: number;
}

interface RecommendationItem {
  priority: string;
  title: string;
  evidence: string;
  actionType: string;
  impactEstimate: string;
}

interface BasketRule {
  id: string;
  shiftBucket: string;
  antecedentName: string;
  consequentName: string;
  coOccurrences: number;
  confidence: number;
  lift: number;
}

interface DaypartPromo {
  id: string;
  name: string;
  promoType: string;
  daypartStartHour: number | null;
  daypartEndHour: number | null;
  active: boolean;
}

interface ShiftExperiment {
  id: string;
  name: string;
  hypothesis: string;
  interventionType: string;
  targetShift: string;
  controlShift: string;
  preStartDate: string;
  preEndDate: string;
  postStartDate: string;
  postEndDate: string;
  status: string;
  resultsJson: {
    preTargetMeanUsd: number;
    postTargetMeanUsd: number;
    preControlMeanUsd: number;
    postControlMeanUsd: number;
    didLiftUsdPerDay: number;
    didLiftPct: number;
    ciLowUsd: number;
    ciHighUsd: number;
    pValue: number;
    controlChangePct: number;
    cannibalizationFlag: boolean;
    verdict: string;
  } | null;
}

interface DiagnosticsPayload {
  diagnostics: {
    id: string;
    windowDays: number;
    primaryBottleneck: string;
    morningSharePct: number;
    morningConversionPct: number;
    afternoonConversionPct: number;
    eveningConversionPct: number;
    morningEstLostRevenueCents: number;
    shiftComparison: {
      shifts: ShiftRow[];
      morningVsAfternoonConversionPValue: number;
      morningVsAfternoonRevPerHrPValue: number;
      dataHygiene?: { excludedPartialCurrentDate: boolean; inactiveZeroReceiptHours: number[] };
    };
    hourlyProfile: HourlyPoint[];
    oosRootCauses: OosRootCause[];
    queueSaturation: { thresholdBin: string; bins: QueueBin[] };
    driverAttribution: {
      holdoutWmapePct: number;
      baselineWmapePct: number;
      r2Train: number;
      drivers: RidgeDriver[];
    };
    shopperMissions: { silhouetteScore: number; k: number; clusters: MissionCluster[] };
    recommendations: RecommendationItem[];
    computedAt: string;
  } | null;
  morningBasketRules: BasketRule[];
  daypartPromotions: DaypartPromo[];
  experiments: ShiftExperiment[];
}

export function ShiftDiagnosticsView({
  userRole = "owner",
  onAskCopilot,
}: {
  userRole?: UserRole;
  onAskCopilot?: (prompt: string) => void;
}) {
  const [data, setData] = useState<DiagnosticsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ kind: "green" | "amber" | "red"; text: string } | null>(null);
  const [subTab, setSubTab] = useState<"oos" | "queue" | "missions" | "experiments">("oos");
  const [hoverHour, setHoverHour] = useState<number | null>(null);

  // Footfall log modal state
  const [showFootfallModal, setShowFootfallModal] = useState(false);
  const [ffEntries, setFfEntries] = useState("14");
  const [ffLanes, setFfLanes] = useState("1");
  const [ffDwell, setFfDwell] = useState("195");
  const [ffRain, setFfRain] = useState(false);

  // New DiD Experiment form
  const todayIso = new Date().toISOString().slice(0, 10);
  const offsetIso = (daysAgo: number) =>
    new Date(Date.now() - daysAgo * 86400_000).toISOString().slice(0, 10);
  const [expName, setExpName] = useState("Express Lane 02 + Morning Coffee Combo Trial");
  const [expHyp, setExpHyp] = useState(
    "Opening Lane 02 from 08:15-09:30 reduces queue walkouts and raises morning conversion."
  );
  const [expType, setExpType] = useState("express_lane_staffing");
  const [preStart, setPreStart] = useState(offsetIso(35));
  const [preEnd, setPreEnd] = useState(offsetIso(15));
  const [postStart, setPostStart] = useState(offsetIso(14));
  const [postEnd, setPostEnd] = useState(todayIso);

  const load = async () => {
    setLoading(true);
    try {
      const res = await apiGet<DiagnosticsPayload>("/api/analytics/shift-diagnostics");
      setData(res);
    } catch (err) {
      setBanner({
        kind: "red",
        text: err instanceof Error ? err.message : "Failed loading shift diagnostics",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const canManage = userRole === "owner" || userRole === "manager";

  const handleCaptureSnapshot = async () => {
    setBusyAction("snapshot");
    setBanner(null);
    try {
      const res = await apiPost<{
        snapshotDate: string;
        snapshotHour: number;
        capturedSkus: number;
        oosCount: number;
      }>("/api/analytics/stock-snapshots/capture", {});
      setBanner({
        kind: "green",
        text: `Captured live shelf availability snapshot (${res.snapshotDate} ${String(
          res.snapshotHour
        ).padStart(2, "0")}:00): ${res.capturedSkus} top Class-A/B SKUs checked, ${res.oosCount} currently OOS.`,
      });
    } catch (err) {
      setBanner({ kind: "red", text: err instanceof Error ? err.message : "Snapshot failed" });
    } finally {
      setBusyAction(null);
    }
  };

  const handleRecompute = async () => {
    setBusyAction("recompute");
    setBanner(null);
    try {
      await apiPost("/api/analytics/shift-diagnostics/recompute", {});
      await load();
      setBanner({
        kind: "green",
        text: "Python ML pipeline finished: updated Shift Funnel, OOS Losses, K-Means Missions, Ridge Drivers, and DiD Experiments.",
      });
    } catch (err) {
      setBanner({ kind: "red", text: err instanceof Error ? err.message : "Recompute failed" });
    } finally {
      setBusyAction(null);
    }
  };

  const handleLogFootfall = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusyAction("footfall");
    try {
      const d = new Date();
      d.setMinutes(Math.floor(d.getMinutes() / 15) * 15, 0, 0);
      await apiPost("/api/analytics/footfall", {
        buckets: [
          {
            bucketStart: d.toISOString(),
            entries: Math.max(0, Number(ffEntries) || 0),
            exits: Math.max(0, Number(ffEntries) || 0),
            avgDwellSec: Math.max(30, Number(ffDwell) || 240),
            openLanes: Math.max(1, Number(ffLanes) || 1),
            weatherRain: ffRain,
            source: "manual_counter",
          },
        ],
      });
      setShowFootfallModal(false);
      setBanner({
        kind: "green",
        text: `Recorded 15-min door counter bucket (${ffEntries} walk-ins, ${ffLanes} open lane(s)). Click Recompute ML to fold into hourly curve.`,
      });
    } catch (err) {
      setBanner({ kind: "red", text: err instanceof Error ? err.message : "Footfall ingest failed" });
    } finally {
      setBusyAction(null);
    }
  };

  const handleCreateExperiment = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusyAction("experiment");
    try {
      await apiPost("/api/analytics/shift-experiments", {
        name: expName,
        hypothesis: expHyp,
        interventionType: expType,
        targetShift: "morning",
        controlShift: "afternoon",
        preStartDate: preStart,
        preEndDate: preEnd,
        postStartDate: postStart,
        postEndDate: postEnd,
      });
      await load();
      setBanner({
        kind: "green",
        text: `Created & evaluated Difference-in-Differences trial "${expName}" against Afternoon shift control.`,
      });
    } catch (err) {
      setBanner({ kind: "red", text: err instanceof Error ? err.message : "Failed creating experiment" });
    } finally {
      setBusyAction(null);
    }
  };

  if (loading && !data) {
    return <div className="panel">Loading Morning Shift Diagnostics &amp; ML Analytics...</div>;
  }

  const diag = data?.diagnostics;
  const shifts = diag?.shiftComparison.shifts ?? [];
  const morning = shifts.find((s) => s.shiftKey === "morning");
  const afternoon = shifts.find((s) => s.shiftKey === "afternoon");
  const evening = shifts.find((s) => s.shiftKey === "evening");
  const hourly = diag?.hourlyProfile ?? [];
  const oosList = diag?.oosRootCauses ?? [];
  const queueBins = diag?.queueSaturation.bins ?? [];
  const drivers = diag?.driverAttribution.drivers ?? [];
  const missions = diag?.shopperMissions.clusters ?? [];

  // Hourly SVG dimensions
  const chartW = 720;
  const chartH = 225;
  const padL = 48;
  const padR = 46;
  const padT = 20;
  const padB = 30;
  const plotW = chartW - padL - padR;
  const plotH = chartH - padT - padB;
  const maxTraffic = Math.max(10, ...hourly.map((h) => Math.max(h.walkIns, h.receipts)));
  const stepW = hourly.length > 0 ? plotW / hourly.length : plotW;
  const barW = Math.max(8, stepW * 0.34);

  const convPolyline = hourly
    .map((h, i) => {
      if (h.walkIns === 0) return null;
      const cx = padL + i * stepW + stepW / 2;
      const cy = padT + plotH - (Math.min(100, h.conversionPct) / 100) * plotH;
      return `${cx.toFixed(1)},${cy.toFixed(1)}`;
    })
    .filter(Boolean)
    .join(" ");

  const morningCols = hourly.filter((h) => h.hour < 12).length;

  return (
    <div>
      <header className="page-header">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Sun size={22} color="var(--accent-amber)" />
            <h1 style={{ margin: 0 }}>Morning Shift Diagnostics &amp; Footfall Intelligence</h1>
          </div>
          <p className="page-subtitle">
            {diag
              ? `Diagnosed Root Cause: ${diag.primaryBottleneck}`
              : "Run Python analytics worker to materialize shift funnel, OOS losses, and ML attribution."}
          </p>
        </div>
        <div className="header-actions">
          <button
            id="capture-snapshot-btn"
            className="btn"
            disabled={busyAction !== null}
            onClick={() => void handleCaptureSnapshot()}
          >
            <Camera size={14} /> Capture Shelf Snapshot
          </button>
          <button
            id="log-footfall-btn"
            className="btn"
            disabled={busyAction !== null}
            onClick={() => setShowFootfallModal(true)}
          >
            <Users size={14} /> Log Footfall
          </button>
          {canManage && (
            <>
              <button
                id="recompute-shift-ml-btn"
                className="btn"
                disabled={busyAction !== null}
                onClick={() => void handleRecompute()}
              >
                <RefreshCw size={14} /> {busyAction === "recompute" ? "Running ML..." : "Recompute ML"}
              </button>
              {onAskCopilot && (
                <button
                  id="ask-ai-shift-fix-btn"
                  className="btn btn-primary"
                  onClick={() =>
                    onAskCopilot(
                      "Diagnose why morning shift sales are underperforming compared to afternoon and evening, and propose a morning commuter combo fix"
                    )
                  }
                >
                  <Sparkles size={14} /> Ask AI to Fix
                </button>
              )}
            </>
          )}
        </div>
      </header>

      {banner && (
        <div
          className={`banner ${
            banner.kind === "green" ? "banner-green" : banner.kind === "amber" ? "banner-amber" : "banner-red"
          }`}
          style={{ marginBottom: 16 }}
        >
          <span>{banner.text}</span>
          <button className="btn btn-sm" onClick={() => setBanner(null)}>
            Dismiss
          </button>
        </div>
      )}

      {diag && (
        <>
          <section className="kpi-strip" aria-label="4-Lever Morning Decomposition KPIs">
            <div className="kpi-tile">
              <div className="kpi-label">1. Morning Revenue / Open Hr</div>
              <div className="kpi-value">
                ${morning?.revenuePerOpenHourUsd.toFixed(0) ?? "0"}
                <span style={{ fontSize: 13, fontWeight: 500, color: "var(--ink-muted)" }}>/hr</span>
              </div>
              <div className="kpi-meta">
                Afternoon: <span className="mono">${afternoon?.revenuePerOpenHourUsd.toFixed(0) ?? 0}/hr</span>{" "}
                · Share <strong className="mono">{diag.morningSharePct}%</strong> (p=
                {diag.shiftComparison.morningVsAfternoonRevPerHrPValue})
              </div>
            </div>

            <div className="kpi-tile">
              <div className="kpi-label">2. Morning Walk-In Conversion</div>
              <div className="kpi-value" style={{ color: "var(--accent-crimson)" }}>
                {diag.morningConversionPct.toFixed(1)}%
              </div>
              <div className="kpi-meta">
                95% CI{" "}
                <span className="mono">
                  [{morning?.conversionCiLow ?? 0}–{morning?.conversionCiHigh ?? 0}%]
                </span>{" "}
                vs Aft <strong className="mono">{diag.afternoonConversionPct.toFixed(1)}%</strong> (p=
                {diag.shiftComparison.morningVsAfternoonConversionPValue})
              </div>
            </div>

            <div className="kpi-tile">
              <div className="kpi-label">3. 08:00 AM OOS Lost Sales (60d)</div>
              <div className="kpi-value" style={{ color: "var(--accent-amber)" }}>
                {formatMoney(diag.morningEstLostRevenueCents)}
              </div>
              <div className="kpi-meta">
                Across <strong className="mono">{oosList.length}</strong> Class-A/B SKUs · Avg restock{" "}
                <span className="mono">~{oosList[0]?.avgRestockHour ?? 11}:00</span>
              </div>
            </div>

            <div className="kpi-tile">
              <div className="kpi-label">4. Morning Basket Depth (UPT / ATV)</div>
              <div className="kpi-value">{formatMoney(morning?.atvCents ?? 0)}</div>
              <div className="kpi-meta">
                <span className="mono">{morning?.avgPacks ?? 0}</span> packs/tx · Multipack{" "}
                <span className="mono">{morning?.multipackLinePct ?? 0}%</span> vs Eve{" "}
                <span className="mono">{evening?.multipackLinePct ?? 0}%</span>
              </div>
            </div>
          </section>

          <div className="grid-asymmetric">
            <section className="panel">
              <div className="panel-header">
                <div>
                  <h2 className="panel-title">Hourly Footfall Funnel (Walk-Ins vs. Receipts &amp; Conversion %)</h2>
                  <p className="panel-desc">
                    Shaded amber = Morning (08–11). Slate bars = door entries; Emerald bars = paid receipts; Line = conversion %.
                  </p>
                </div>
                {hoverHour !== null && (
                  <div className="tag tag-green mono">
                    {(() => {
                      const pt = hourly.find((x) => x.hour === hoverHour);
                      return pt
                        ? `${String(pt.hour).padStart(2, "0")}:00 — ${pt.walkIns} in → ${pt.receipts} paid (${pt.conversionPct}%)`
                        : "";
                    })()}
                  </div>
                )}
              </div>

              <svg viewBox={`0 0 ${chartW} ${chartH}`} className="chart-svg" role="img">
                {morningCols > 0 && (
                  <rect
                    x={padL}
                    y={padT}
                    width={morningCols * stepW}
                    height={plotH}
                    fill="hsla(38, 92%, 50%, 0.08)"
                  />
                )}
                {[0, 0.5, 1].map((t) => {
                  const y = padT + plotH - t * plotH;
                  return (
                    <g key={t}>
                      <line
                        x1={padL}
                        y1={y}
                        x2={chartW - padR}
                        y2={y}
                        stroke="hsl(36, 14%, 89%)"
                        strokeDasharray={t === 0 ? undefined : "3 3"}
                      />
                      <text
                        x={padL - 6}
                        y={y + 4}
                        textAnchor="end"
                        fontSize="10"
                        fill="hsl(215, 10%, 52%)"
                        fontFamily="JetBrains Mono, monospace"
                      >
                        {Math.round(maxTraffic * t)}
                      </text>
                      <text
                        x={chartW - padR + 6}
                        y={y + 4}
                        textAnchor="start"
                        fontSize="10"
                        fill="hsl(158, 62%, 27%)"
                        fontFamily="JetBrains Mono, monospace"
                      >
                        {Math.round(t * 100)}%
                      </text>
                    </g>
                  );
                })}
                {hourly.map((h, i) => {
                  const baseX = padL + i * stepW + stepW / 2;
                  const hWalk = (h.walkIns / maxTraffic) * plotH;
                  const hRcpt = (h.receipts / maxTraffic) * plotH;
                  return (
                    <g
                      key={h.hour}
                      onMouseEnter={() => setHoverHour(h.hour)}
                      onMouseLeave={() => setHoverHour(null)}
                      style={{ cursor: "pointer" }}
                    >
                      <rect
                        x={baseX - barW - 1}
                        y={padT + plotH - hWalk}
                        width={barW}
                        height={Math.max(1, hWalk)}
                        rx={2}
                        fill="hsl(215, 22%, 72%)"
                      />
                      <rect
                        x={baseX + 1}
                        y={padT + plotH - hRcpt}
                        width={barW}
                        height={Math.max(1, hRcpt)}
                        rx={2}
                        fill="hsl(158, 52%, 34%)"
                      />
                      <text
                        x={baseX}
                        y={chartH - 8}
                        textAnchor="middle"
                        fontSize="10"
                        fill={h.hour < 12 ? "hsl(28, 84%, 32%)" : "hsl(215, 10%, 50%)"}
                        fontWeight={h.hour < 12 ? "700" : "400"}
                        fontFamily="JetBrains Mono, monospace"
                      >
                        {String(h.hour).padStart(2, "0")}
                      </text>
                    </g>
                  );
                })}
                {convPolyline && (
                  <polyline
                    fill="none"
                    stroke="hsl(28, 88%, 48%)"
                    strokeWidth="2.4"
                    points={convPolyline}
                  />
                )}
              </svg>
            </section>

            <section className="panel">
              <div className="panel-header">
                <div>
                  <h2 className="panel-title">Chronological Ridge Causal Attribution</h2>
                  <p className="panel-desc">
                    Out-of-sample 14d Holdout WMAPE{" "}
                    <strong className="mono">{diag.driverAttribution.holdoutWmapePct}%</strong> vs Seasonal
                    Baseline <span className="mono">{diag.driverAttribution.baselineWmapePct}%</span>
                  </p>
                </div>
              </div>
              <div className="stack-md" style={{ gap: 11 }}>
                {drivers.map((d) => (
                  <div key={d.feature} className="driver-row">
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
                      <span style={{ fontWeight: 600 }}>{d.label}</span>
                      <span className="mono">
                        {d.importancePct}% ({d.coefUsdPerSd >= 0 ? "+" : ""}
                        ${d.coefUsdPerSd}/SD)
                      </span>
                    </div>
                    <div className="driver-bar-track">
                      <div
                        style={{
                          width: `${Math.min(100, d.importancePct * 1.4)}%`,
                          height: "100%",
                          background:
                            d.direction === "positive" ? "var(--accent-primary)" : "var(--accent-amber)",
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <div className="subtab-bar" role="tablist">
            <button
              id="subtab-oos"
              className={`subtab-btn ${subTab === "oos" ? "active" : ""}`}
              onClick={() => setSubTab("oos")}
            >
              Morning OOS &amp; Restock Lag ({oosList.length})
            </button>
            <button
              id="subtab-queue"
              className={`subtab-btn ${subTab === "queue" ? "active" : ""}`}
              onClick={() => setSubTab("queue")}
            >
              Checkout Queue Saturation
            </button>
            <button
              id="subtab-missions"
              className={`subtab-btn ${subTab === "missions" ? "active" : ""}`}
              onClick={() => setSubTab("missions")}
            >
              K-Means Missions &amp; Morning Basket ({missions.length})
            </button>
            <button
              id="subtab-experiments"
              className={`subtab-btn ${subTab === "experiments" ? "active" : ""}`}
              onClick={() => setSubTab("experiments")}
            >
              DiD Impact Trials ({data?.experiments.length ?? 0})
            </button>
          </div>

          {subTab === "oos" && (
            <section className="panel" style={{ marginBottom: 20 }}>
              <div className="panel-header">
                <div>
                  <h2 className="panel-title">08:00 AM Shelf Stockouts ("Phantom-Zero" Morning Losses)</h2>
                  <p className="panel-desc">
                    Class-A/B SKUs depleted by prior-evening rush and not replenished until ~11:00 AM.
                  </p>
                </div>
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>SKU &amp; Product</th>
                      <th>Dept / Seg</th>
                      <th className="text-right">OOS Mornings</th>
                      <th className="text-right">Avg Restock</th>
                      <th className="text-right">In-Stock Rate/Day</th>
                      <th className="text-right">Pre-Open Pick</th>
                      <th className="text-right">Est. Lost Sales</th>
                    </tr>
                  </thead>
                  <tbody>
                    {oosList.slice(0, 15).map((item) => (
                      <tr key={item.productId}>
                        <td>
                          <div style={{ fontWeight: 600 }}>{item.name}</div>
                          <div className="mono" style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                            {item.sku} · {item.supplierName}
                          </div>
                        </td>
                        <td>
                          <span className="tag tag-neutral mono">{item.abcSegment}</span>{" "}
                          <span style={{ fontSize: 12 }}>{item.departmentName}</span>
                        </td>
                        <td className="text-right mono">
                          <span className="tag tag-red">
                            {item.oosDays} / {item.snapshotDays}d
                          </span>
                        </td>
                        <td className="text-right mono">{item.avgRestockHour}:00</td>
                        <td className="text-right mono">{item.expectedMorningUnitsPerDay} u/morn</td>
                        <td className="text-right mono">
                          <strong>{item.suggestedPreOpenPickUnits} units</strong>
                        </td>
                        <td className="text-right mono" style={{ color: "var(--accent-crimson)", fontWeight: 700 }}>
                          {formatMoney(item.estLostRevenueCents)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {subTab === "queue" && (
            <section className="panel" style={{ marginBottom: 20 }}>
              <div className="panel-header">
                <div>
                  <h2 className="panel-title">Morning 15-Min Queue Saturation &amp; Walk-Out Knee</h2>
                  <p className="panel-desc">
                    Detected walk-out saturation threshold:{" "}
                    <span className="tag tag-amber mono">{diag.queueSaturation.thresholdBin}</span>. Opening
                    Lane 02 keeps load under 6 entries/lane.
                  </p>
                </div>
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Walk-In Load / Open Lane (15m)</th>
                      <th className="text-right">Observed 15m Buckets</th>
                      <th className="text-right">Avg Door Entries</th>
                      <th className="text-right">Avg Dwell Time</th>
                      <th className="text-right">Conversion Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {queueBins.map((b) => (
                      <tr key={b.loadBin}>
                        <td>
                          <strong>{b.loadBin}</strong>{" "}
                          {b.loadBin === diag.queueSaturation.thresholdBin && (
                            <span className="tag tag-red">Saturation Knee</span>
                          )}
                        </td>
                        <td className="text-right mono">{b.buckets}</td>
                        <td className="text-right mono">{b.avgEntries}</td>
                        <td className="text-right mono">{b.avgDwellSec}s</td>
                        <td className="text-right mono">
                          <span
                            className={`tag ${
                              b.conversionPct < 62 ? "tag-red" : b.conversionPct < 70 ? "tag-amber" : "tag-green"
                            }`}
                          >
                            {b.conversionPct}%
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {subTab === "missions" && (
            <div className="stack-md" style={{ marginBottom: 20 }}>
              <section className="panel">
                <div className="panel-header">
                  <div>
                    <h2 className="panel-title">
                      K-Means Shopper Mission Clusters (Silhouette {diag.shopperMissions.silhouetteScore})
                    </h2>
                    <p className="panel-desc">
                      Receipts clustered on time-of-day, SKU depth, multipack share, ATV, and category mix.
                    </p>
                  </div>
                </div>
                <div className="mission-grid">
                  {missions.map((m) => (
                    <div key={m.clusterId} className="did-card">
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <strong style={{ fontSize: 14 }}>{m.name}</strong>
                        <span className="tag tag-blue mono">{m.sharePct}% tx</span>
                      </div>
                      <div className="mono" style={{ fontSize: 12, color: "var(--ink-secondary)" }}>
                        Avg Hour {m.avgHour}:00 · ATV ${m.avgAtvUsd.toFixed(2)} · {m.avgSkus} SKUs ·{" "}
                        {m.multipackPct}% multipack
                      </div>
                      <div style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                        Morning {m.morningSharePct}% / Afternoon {m.afternoonSharePct}% / Evening{" "}
                        {m.eveningSharePct}%
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="panel">
                <div className="panel-header">
                  <div>
                    <h2 className="panel-title">Morning-Only Market Basket Rules (08:00–11:59)</h2>
                    <p className="panel-desc">
                      Co-purchase affinities mined strictly from morning receipts to drive POS upsell prompts &amp; commuter combos.
                    </p>
                  </div>
                </div>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Morning Antecedent</th>
                        <th>Recommended Add-On</th>
                        <th className="text-right">Co-Purchases</th>
                        <th className="text-right">Confidence</th>
                        <th className="text-right">Lift</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(data?.morningBasketRules ?? []).slice(0, 10).map((r) => (
                        <tr key={r.id}>
                          <td>{r.antecedentName}</td>
                          <td>
                            <ShoppingBag size={12} style={{ marginRight: 5 }} />
                            <strong>{r.consequentName}</strong>
                          </td>
                          <td className="text-right mono">{r.coOccurrences}</td>
                          <td className="text-right mono">{(r.confidence * 100).toFixed(1)}%</td>
                          <td className="text-right mono">
                            <span className="tag tag-green">{r.lift}×</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          )}

          {subTab === "experiments" && (
            <div className="grid-2" style={{ marginBottom: 20 }}>
              <section className="panel">
                <div className="panel-header">
                  <div>
                    <h2 className="panel-title">Difference-in-Differences (DiD) Shift Evaluations</h2>
                    <p className="panel-desc">
                      Measures true Morning lift net of shared macro trends using Afternoon as intra-store control.
                    </p>
                  </div>
                </div>
                <div className="stack-md">
                  {(data?.experiments ?? []).map((exp) => {
                    const r = exp.resultsJson;
                    return (
                      <div key={exp.id} className="did-card">
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                          <strong>{exp.name}</strong>
                          {r && (
                            <span
                              className={`tag ${
                                r.verdict === "significant_positive"
                                  ? "tag-green"
                                  : r.verdict === "negative_or_cannibalized"
                                    ? "tag-red"
                                    : "tag-amber"
                              }`}
                            >
                              {r.verdict.replace(/_/g, " ").toUpperCase()}
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: 12.5, color: "var(--ink-secondary)" }}>{exp.hypothesis}</div>
                        <div className="mono" style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                          Pre {exp.preStartDate}..{exp.preEndDate} vs Post {exp.postStartDate}..{exp.postEndDate}
                        </div>
                        {r && (
                          <div className="mono" style={{ fontSize: 12 }}>
                            DiD Lift:{" "}
                            <strong>
                              {r.didLiftUsdPerDay >= 0 ? "+" : ""}${r.didLiftUsdPerDay}/day ({r.didLiftPct}%)
                            </strong>{" "}
                            · 95% CI [${r.ciLowUsd}, ${r.ciHighUsd}] · p={r.pValue} · Control{" "}
                            {r.controlChangePct >= 0 ? "+" : ""}
                            {r.controlChangePct}%{" "}
                            {r.cannibalizationFlag && (
                              <span className="tag tag-red">Cannibalization Risk</span>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>

              {canManage && (
                <section className="panel">
                  <div className="panel-header">
                    <div>
                      <h2 className="panel-title">Log &amp; Evaluate New Morning Trial</h2>
                      <p className="panel-desc">Runs instant bootstrap DiD against Afternoon control</p>
                    </div>
                  </div>
                  <form className="stack-md" onSubmit={(e) => void handleCreateExperiment(e)}>
                    <div className="field">
                      <label>Experiment Name</label>
                      <input
                        className="input"
                        value={expName}
                        onChange={(e) => setExpName(e.target.value)}
                        required
                      />
                    </div>
                    <div className="field">
                      <label>Hypothesis</label>
                      <input
                        className="input"
                        value={expHyp}
                        onChange={(e) => setExpHyp(e.target.value)}
                        required
                      />
                    </div>
                    <div className="form-grid">
                      <div className="field">
                        <label>Intervention</label>
                        <select
                          className="select"
                          value={expType}
                          onChange={(e) => setExpType(e.target.value)}
                        >
                          <option value="pre_open_restock">07:45 Pre-Open Restock</option>
                          <option value="express_lane_staffing">08:15 Express Float Lane</option>
                          <option value="morning_daypart_promo">08:00-11:59 Daypart Combo</option>
                          <option value="entrance_merchandising">Entrance Grab-and-Go Zone</option>
                        </select>
                      </div>
                      <div className="field">
                        <label>Pre Window</label>
                        <div style={{ display: "flex", gap: 4 }}>
                          <input
                            type="date"
                            className="input"
                            value={preStart}
                            onChange={(e) => setPreStart(e.target.value)}
                          />
                          <input
                            type="date"
                            className="input"
                            value={preEnd}
                            onChange={(e) => setPreEnd(e.target.value)}
                          />
                        </div>
                      </div>
                      <div className="field">
                        <label>Post Window</label>
                        <div style={{ display: "flex", gap: 4 }}>
                          <input
                            type="date"
                            className="input"
                            value={postStart}
                            onChange={(e) => setPostStart(e.target.value)}
                          />
                          <input
                            type="date"
                            className="input"
                            value={postEnd}
                            onChange={(e) => setPostEnd(e.target.value)}
                          />
                        </div>
                      </div>
                    </div>
                    <button
                      id="create-did-experiment-btn"
                      type="submit"
                      className="btn btn-primary"
                      disabled={busyAction !== null}
                    >
                      <FlaskConical size={14} /> Run DiD Evaluation
                    </button>
                  </form>
                </section>
              )}
            </div>
          )}

          <section className="panel">
            <div className="panel-header">
              <div>
                <h2 className="panel-title">Inference-to-Action Operational Playbook</h2>
                <p className="panel-desc">
                  Each intervention maps directly to statistically verified morning bottlenecks. Active daypart promos:{" "}
                  <strong className="mono">{data?.daypartPromotions.length ?? 0}</strong>.
                </p>
              </div>
            </div>
            <div className="playbook-grid">
              {(diag.recommendations ?? []).map((rec) => (
                <div key={rec.priority} className="briefing-bullet">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span className={`tag ${rec.priority === "P1" ? "tag-red" : "tag-amber"}`}>
                      {rec.priority}
                    </span>
                    <span className="tag tag-green mono">{rec.impactEstimate}</span>
                  </div>
                  <strong style={{ fontSize: 13.5 }}>{rec.title}</strong>
                  <div style={{ fontSize: 12.5, color: "var(--ink-secondary)", lineHeight: 1.45 }}>
                    {rec.evidence}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      {showFootfallModal && (
        <div className="overlay centered" onClick={() => setShowFootfallModal(false)}>
          <div className="modal" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ margin: 0, fontSize: 18 }}>Log 15-Minute Door Footfall Counter</h2>
            <p className="panel-desc">
              Simulates or records IR/Wi-Fi people-counter telemetry for the current 15-minute bucket.
            </p>
            <form className="stack-md" onSubmit={(e) => void handleLogFootfall(e)}>
              <div className="form-grid">
                <div className="field">
                  <label>Door Walk-In Entries</label>
                  <input
                    type="number"
                    min={0}
                    className="input"
                    value={ffEntries}
                    onChange={(e) => setFfEntries(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label>Open Checkout Lanes</label>
                  <input
                    type="number"
                    min={1}
                    max={16}
                    className="input"
                    value={ffLanes}
                    onChange={(e) => setFfLanes(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label>Avg Dwell Time (sec)</label>
                  <input
                    type="number"
                    min={30}
                    className="input"
                    value={ffDwell}
                    onChange={(e) => setFfDwell(e.target.value)}
                  />
                </div>
                <div className="field" style={{ justifyContent: "flex-end" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={ffRain}
                      onChange={(e) => setFfRain(e.target.checked)}
                    />
                    Rainy Weather Window
                  </label>
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button type="button" className="btn" onClick={() => setShowFootfallModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={busyAction !== null}>
                  <Plus size={14} /> Save Counter Bucket
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
