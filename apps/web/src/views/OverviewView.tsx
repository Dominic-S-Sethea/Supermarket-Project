import { type CSSProperties, useEffect, useState } from "react";
import type { UserRole } from "@supermarket/shared/dtos";
import { formatBp, formatMoney } from "@supermarket/shared/money";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Boxes,
  Database,
  DollarSign,
  Download,
  Layers,
  Package,
  PackageCheck,
  Percent,
  RefreshCw,
  ScanBarcode,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
} from "lucide-react";
import { apiGet, apiPost } from "../api";
import { PageHeading } from "../components/PageHeading";
import { SalesTrendChart, type DailyTrendPoint } from "../components/SalesTrendChart";

interface BriefingBullet {
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
  metric: string;
  targetTab: "operations" | "forecasting" | "abc-lp" | "catalog";
}

interface DailyBriefing {
  briefingDate: string;
  headline: string;
  bullets: BriefingBullet[];
  model: string;
  generatedAt: string;
  cached: boolean;
}

interface OverviewData {
  days: number;
  kpis: {
    receiptCount: number;
    grossSalesCents: number;
    netSalesCents: number;
    discountsCents: number;
    taxCents: number;
    cogsCents: number;
    grossProfitCents: number;
    grossMarginBp: number;
    avgTransactionValueCents: number;
    shrinkageCostCents: number;
    shrinkageRateBp: number;
    totalSkus: number;
    totalBarcodes: number;
    inventoryCostValueCents: number;
  };
  dailyTrend: DailyTrendPoint[];
  hourlyTraffic: {
    hour: number;
    receipts: number;
    salesCents: number;
  }[];
  paymentMix: {
    method: string;
    txCount: number;
    totalCents: number;
  }[];
}

interface DeptRow {
  id: string;
  code: string;
  name: string;
  targetMarginBp: number;
  skuCount: number;
  stockCostCents: number;
  netSales60dCents: number;
  grossProfit60dCents: number;
  grossMarginBp: number;
  units60d: number;
  gmroii: number;
  annualTurns: number;
}

export function OverviewView({
  userRole = "owner",
  allowedTabs,
  onNavigate,
}: {
  userRole?: UserRole;
  allowedTabs?: string[];
  onNavigate?: (tab: "pos" | "catalog" | "operations" | "forecasting" | "abc-lp" | "admin") => void;
}) {
  const [days, setDays] = useState(30);
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [depts, setDepts] = useState<DeptRow[]>([]);
  const [briefing, setBriefing] = useState<DailyBriefing | null>(null);
  const [briefingWarning, setBriefingWarning] = useState<string | null>(null);
  const [refreshingBriefing, setRefreshingBriefing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadBriefing = async (signal?: AbortSignal) => {
    setBriefingWarning(null);
    try {
      const br = await apiGet<DailyBriefing>("/api/ai/briefing", signal);
      if (!signal?.aborted) setBriefing(br);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setBriefingWarning(
          err instanceof Error
            ? `Morning AI briefing unavailable: ${err.message}`
            : "Morning AI briefing is temporarily unavailable."
        );
      }
    }
  };

  const loadOverview = async (windowDays: number, signal?: AbortSignal) => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const [ov, dp] = await Promise.all([
        apiGet<OverviewData>(`/api/analytics/overview?days=${windowDays}`, signal),
        apiGet<{ departments: DeptRow[] }>("/api/analytics/departments", signal),
      ]);
      if (signal?.aborted) return;
      setOverview(ov);
      setDepts(dp.departments);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setErrorMsg(err instanceof Error ? err.message : "Failed loading store overview analytics.");
      }
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  };

  const handleRefreshBriefing = async () => {
    setRefreshingBriefing(true);
    setBriefingWarning(null);
    try {
      const br = await apiPost<DailyBriefing>("/api/ai/briefing/refresh", {});
      setBriefing(br);
    } catch (err) {
      setBriefingWarning(
        err instanceof Error ? err.message : "Failed refreshing AI morning briefing."
      );
    } finally {
      setRefreshingBriefing(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void loadOverview(days, controller.signal);
    return () => controller.abort();
  }, [days]);

  useEffect(() => {
    const controller = new AbortController();
    void loadBriefing(controller.signal);
    return () => controller.abort();
  }, []);

  if (loading && !overview) {
    return <div className="panel">Loading store analytics from PostgreSQL...</div>;
  }

  if (!overview) {
    return (
      <div className="panel stack-md" style={{ gap: 12 }}>
        <div className="banner banner-red" role="alert">
          <span>{errorMsg ?? "Unable to load store executive overview."}</span>
        </div>
        <div>
          <button type="button" className="btn btn-primary" onClick={() => void loadOverview(days)}>
            <RefreshCw size={14} aria-hidden="true" /> Retry Loading Overview
          </button>
        </div>
      </div>
    );
  }

  const { kpis, dailyTrend, hourlyTraffic, paymentMix } = overview;
  const maxHourReceipts = Math.max(1, ...hourlyTraffic.map((h) => h.receipts));
  const totalPayCents = Math.max(
    1,
    paymentMix.reduce((s, p) => s + p.totalCents, 0)
  );

  return (
    <div>
      <header className="page-header">
        <PageHeading
          lead="Store Executive"
          accent="Overview"
          subtitle={
            <>
              Real-time P&amp;L, gross margin mix, traffic heatmap, and department GMROII across{" "}
              <strong className="mono">{kpis.totalSkus.toLocaleString()}</strong> packaged SKUs &amp;{" "}
              <strong className="mono">{kpis.totalBarcodes.toLocaleString()}</strong> multi-UOM barcodes.
            </>
          }
        />
        <div className="header-actions">
          <select
            id="overview-window-select"
            aria-label="Analytics time window"
            className="select"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            <option value={7}>Last 7 Days</option>
            <option value={30}>Last 30 Days</option>
            <option value={60}>Last 60 Days</option>
          </select>
          <button
            id="overview-refresh-btn"
            type="button"
            className="btn"
            disabled={loading}
            onClick={() => {
              void loadOverview(days);
              void loadBriefing();
            }}
          >
            <RefreshCw size={14} aria-hidden="true" /> {loading ? "Refreshing..." : "Refresh"}
          </button>
          <a
            id="export-accounting-csv-link"
            className="btn btn-primary"
            href={`/api/exports/accounting.csv?days=${days}`}
            download={`supermarket-os-accounting-journal-${days}d.csv`}
          >
            <Download size={14} aria-hidden="true" /> Export Accounting CSV
          </a>
        </div>
      </header>

      {errorMsg && (
        <div className="banner banner-red" role="alert" style={{ marginBottom: 16 }}>
          <span>{errorMsg}</span>
          <button type="button" className="btn btn-sm" onClick={() => setErrorMsg(null)}>
            Dismiss
          </button>
        </div>
      )}

      {briefingWarning && (
        <div className="banner banner-amber" role="status" style={{ marginBottom: 16 }}>
          <span>{briefingWarning}</span>
          <button type="button" className="btn btn-sm" onClick={() => void loadBriefing()}>
            <RefreshCw size={12} aria-hidden="true" /> Retry Briefing
          </button>
        </div>
      )}

      {briefing && (
        <section className="panel briefing-card" style={{ marginBottom: 20 }}>
          <div className="panel-header" style={{ marginBottom: 10 }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span className="icon-tile-md tone-violet" aria-hidden="true">
                  <Sparkles size={16} />
                </span>
                <h2 className="panel-title">AI Morning Executive Briefing ({briefing.briefingDate})</h2>
                <span className="tag tag-violet mono">{briefing.model}</span>
              </div>
              <p className="panel-desc" style={{ marginTop: 4, fontWeight: 500, color: "var(--ink-primary)" }}>
                {briefing.headline}
              </p>
            </div>
            {(userRole === "owner" || userRole === "manager") && (
              <button
                id="refresh-ai-briefing-btn"
                type="button"
                className="btn btn-sm"
                disabled={refreshingBriefing}
                onClick={() => void handleRefreshBriefing()}
              >
                <RefreshCw size={13} aria-hidden="true" /> {refreshingBriefing ? "Refreshing..." : "Refresh Digest"}
              </button>
            )}
          </div>
          <div className="briefing-grid">
            {briefing.bullets.map((b, idx) => {
              const canInspect = Boolean(
                onNavigate && (!allowedTabs || allowedTabs.includes(b.targetTab))
              );
              return (
                <div key={`${b.title}-${idx}`} className="briefing-bullet">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <span
                      className={`tag ${
                        b.severity === "critical"
                          ? "tag-red"
                          : b.severity === "warning"
                            ? "tag-amber"
                            : "tag-blue"
                      }`}
                    >
                      {b.severity.toUpperCase()}
                    </span>
                    <span className="mono" style={{ fontSize: 12, fontWeight: 700 }}>{b.metric}</span>
                  </div>
                  <strong style={{ fontSize: 13 }}>{b.title}</strong>
                  <div style={{ fontSize: 12, color: "var(--ink-secondary)", lineHeight: 1.45 }}>
                    {b.detail}
                  </div>
                  {canInspect && onNavigate && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ width: "fit-content", marginTop: "auto" }}
                      onClick={() => onNavigate(b.targetTab)}
                    >
                      Inspect <ArrowRight size={12} aria-hidden="true" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="kpi-strip vector-stagger" aria-label="Core store KPIs">
        <div className="kpi-tile">
          <div className="kpi-label-row">
            <span className="icon-tile-sm tone-emerald-soft" aria-hidden="true">
              <DollarSign size={14} />
            </span>
            <div className="kpi-label">Net Sales ({days}d)</div>
          </div>
          <div className="kpi-value">{formatMoney(kpis.netSalesCents)}</div>
          <div className="kpi-meta">
            Gross: <span className="mono">{formatMoney(kpis.grossSalesCents)}</span> · VAT:{" "}
            <span className="mono">{formatMoney(kpis.taxCents)}</span>
          </div>
        </div>
        <div className="kpi-tile">
          <div className="kpi-label-row">
            <span className="icon-tile-sm tone-violet-soft" aria-hidden="true">
              <Percent size={14} />
            </span>
            <div className="kpi-label">Gross Profit &amp; Margin</div>
          </div>
          <div className="kpi-value">{formatBp(kpis.grossMarginBp)}</div>
          <div className="kpi-meta">
            Profit: <strong className="mono">{formatMoney(kpis.grossProfitCents)}</strong> (cost-at-sale)
          </div>
        </div>
        <div className="kpi-tile">
          <div className="kpi-label-row">
            <span className="icon-tile-sm tone-teal-soft" aria-hidden="true">
              <ShoppingBag size={14} />
            </span>
            <div className="kpi-label">Avg Basket (ATV)</div>
          </div>
          <div className="kpi-value">{formatMoney(kpis.avgTransactionValueCents)}</div>
          <div className="kpi-meta">
            <span className="mono">{kpis.receiptCount.toLocaleString()}</span> completed receipts
          </div>
        </div>
        <div className="kpi-tile">
          <div className="kpi-label-row">
            <span className="icon-tile-sm tone-indigo-soft" aria-hidden="true">
              <Package size={14} />
            </span>
            <div className="kpi-label">Stock Capital On Hand</div>
          </div>
          <div className="kpi-value">{formatMoney(kpis.inventoryCostValueCents)}</div>
          <div className="kpi-meta">
            At MWAC across <span className="mono">{kpis.totalSkus.toLocaleString()}</span> SKUs
          </div>
        </div>
        <div className="kpi-tile">
          <div className="kpi-label-row">
            <span className="icon-tile-sm tone-rose-soft" aria-hidden="true">
              <AlertTriangle size={14} />
            </span>
            <div className="kpi-label">Recorded Shrinkage ({days}d)</div>
          </div>
          <div className="kpi-value">{formatBp(kpis.shrinkageRateBp)}</div>
          <div className="kpi-meta">
            Write-off cost: <span className="mono">{formatMoney(kpis.shrinkageCostCents)}</span>
          </div>
        </div>
      </section>

      <section id="overview-ops-pipeline" className="panel ops-pipeline-card" aria-label="Live store request and ledger flow">
        <div className="panel-header" style={{ marginBottom: 10 }}>
          <div>
            <h2 className="panel-title">Live Store Request &amp; Ledger Architecture</h2>
            <p className="panel-desc">
              Semantic layer flow from cashier scan through catalog pricing, RBAC governance, PostgreSQL settlement, and FEFO stock telemetry.
            </p>
          </div>
          <span className="tag tag-violet mono">
            {kpis.receiptCount.toLocaleString()} tx · {days}d window
          </span>
        </div>

        <div className="ops-pipeline-flow">
          <div className="pipeline-packet" aria-hidden="true" />
          {[
            {
              key: "pos" as const,
              label: "POS LANES",
              metric: `${kpis.receiptCount.toLocaleString()} receipts`,
              tone: "teal",
              Icon: ScanBarcode,
              targetTab: "pos" as const,
            },
            {
              key: "catalog" as const,
              label: "CATALOG",
              metric: `${kpis.totalSkus.toLocaleString()} SKUs`,
              tone: "indigo",
              Icon: Boxes,
              targetTab: "catalog" as const,
            },
            {
              key: "admin" as const,
              label: "RBAC & AUDIT",
              metric: `${userRole.toUpperCase()} active`,
              tone: "rose",
              Icon: ShieldCheck,
              targetTab: "admin" as const,
            },
            {
              key: "pg" as const,
              label: "POSTGRESQL",
              metric: "Integer cents",
              tone: "emerald",
              Icon: Database,
              targetTab: null,
            },
            {
              key: "operations" as const,
              label: "FEFO & ALERTS",
              metric: `${depts.length} departments`,
              tone: "amber",
              Icon: PackageCheck,
              targetTab: "operations" as const,
            },
          ].map((node) => {
            const canNav = Boolean(
              node.targetTab && onNavigate && (!allowedTabs || allowedTabs.includes(node.targetTab))
            );
            const content = (
              <>
                <span className={`icon-tile-lg tone-${node.tone}`} aria-hidden="true">
                  <node.Icon size={20} />
                </span>
                <div>
                  <div className="ops-pipeline-label">{node.label}</div>
                  <div className="ops-pipeline-metric">{node.metric}</div>
                </div>
              </>
            );
            if (canNav && node.targetTab) {
              return (
                <button
                  key={node.key}
                  type="button"
                  className="ops-pipeline-node"
                  onClick={() => onNavigate?.(node.targetTab!)}
                >
                  {content}
                </button>
              );
            }
            return (
              <div key={node.key} className="ops-pipeline-node">
                {content}
              </div>
            );
          })}
        </div>

        <div className="foundation-stack">
          <div className="foundation-bar foundation-sky">
            <span className="foundation-bar-icon" aria-hidden="true">
              <Layers size={14} />
            </span>
            <span className="foundation-bar-label">POSTGRESQL LEDGER</span>
            <span className="foundation-bar-metric">
              INTEGER CENTS · {kpis.receiptCount.toLocaleString()} RECEIPTS
            </span>
          </div>
          <div className="foundation-bar foundation-blue">
            <span className="foundation-bar-icon" aria-hidden="true">
              <Boxes size={14} />
            </span>
            <span className="foundation-bar-label">MULTI-UOM CATALOG</span>
            <span className="foundation-bar-metric">
              {kpis.totalSkus.toLocaleString()} SKUS / {kpis.totalBarcodes.toLocaleString()} BARCODES
            </span>
          </div>
          <div className="foundation-bar foundation-cyan">
            <span className="foundation-bar-icon" aria-hidden="true">
              <Activity size={14} />
            </span>
            <span className="foundation-bar-label">ANALYTICS TELEMETRY</span>
            <span className="foundation-bar-metric">
              {days}D WINDOW · {formatBp(kpis.grossMarginBp)} MARGIN
            </span>
          </div>
        </div>
      </section>

      <div className="grid-asymmetric">
        <SalesTrendChart dailyTrend={dailyTrend} days={days} />

        <section className="panel">
          <div className="panel-header">
            <div>
              <h2 className="panel-title">Tender Mix &amp; Discounts</h2>
              <p className="panel-desc">Settlement breakdown across all lanes</p>
            </div>
          </div>
          <div className="stack-md" style={{ gap: 12 }}>
            {paymentMix.length === 0 ? (
              <div style={{ color: "var(--ink-muted)", padding: "12px 0" }}>
                No settled payments in this period.
              </div>
            ) : (
              paymentMix.map((p) => {
                const pct = Math.round((p.totalCents / totalPayCents) * 100);
                return (
                  <div key={p.method}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        fontSize: 13,
                        marginBottom: 4,
                      }}
                    >
                      <span style={{ fontWeight: 600, textTransform: "capitalize" }}>
                        {p.method.replace("_", " ")}
                      </span>
                      <span className="mono">
                        {formatMoney(p.totalCents)} ({pct}%)
                      </span>
                    </div>
                    <div
                      style={{
                        height: 8,
                        borderRadius: 4,
                        background: "var(--bg-subtle)",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          width: `${pct}%`,
                          height: "100%",
                          background:
                            p.method === "card"
                              ? "var(--accent-primary)"
                              : p.method === "cash"
                                ? "var(--accent-cash-bar)"
                                : "var(--accent-blue)",
                        }}
                      />
                    </div>
                  </div>
                );
              })
            )}
            <div
              style={{
                marginTop: 8,
                paddingTop: 12,
                borderTop: "1px solid var(--border-hairline)",
                display: "flex",
                justifyContent: "space-between",
                fontSize: 12.5,
                color: "var(--ink-secondary)",
              }}
            >
              <span>Total Promo Discounts Given ({days}d)</span>
              <strong className="mono">{formatMoney(kpis.discountsCents)}</strong>
            </div>
          </div>
        </section>
      </div>

      <section className="panel" style={{ marginBottom: 20 }}>
        <div className="panel-header">
          <div>
            <h2 className="panel-title">Hourly Checkout Traffic Heatmap</h2>
            <p className="panel-desc">
              Receipt volume by hour of day — optimize cashier lane staffing for lunch &amp; 17:00–19:00 rush.
            </p>
          </div>
        </div>
        {hourlyTraffic.length === 0 ? (
          <div style={{ color: "var(--ink-muted)", padding: "12px 0" }}>
            No hourly checkout traffic recorded in this window.
          </div>
        ) : (
          <div className="heatmap-row">
            {hourlyTraffic.map((h) => {
              const intensity = h.receipts / maxHourReceipts;
              return (
                <div
                  key={h.hour}
                  className="heat-cell"
                  style={{ "--heat": intensity } as CSSProperties}
                  title={`${h.hour}:00 — ${h.receipts} receipts, ${formatMoney(h.salesCents)}`}
                >
                  <span className="heat-hour">{String(h.hour).padStart(2, "0")}:00</span>
                  <span className="heat-val">{h.receipts}</span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2 className="panel-title">Department Profitability, GMROII &amp; Capital Turns (60-Day Annualized)</h2>
            <p className="panel-desc">
              GMROII measures gross margin dollars earned per $1.00 invested in department shelf stock.
            </p>
          </div>
        </div>
        <div className="table-wrap" role="region" aria-label="Department profitability and GMROII" tabIndex={0}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Department</th>
                <th className="text-right">SKUs</th>
                <th className="text-right">Units (60d)</th>
                <th className="text-right">Net Sales (60d)</th>
                <th className="text-right">Gross Profit</th>
                <th className="text-right">Actual vs Target Margin</th>
                <th className="text-right">Stock Capital</th>
                <th className="text-right">GMROII</th>
                <th className="text-right">Turns / Yr</th>
              </tr>
            </thead>
            <tbody>
              {depts.length === 0 ? (
                <tr>
                  <td colSpan={9} style={{ textAlign: "center", color: "var(--ink-muted)" }}>
                    No department profitability metrics available yet.
                  </td>
                </tr>
              ) : (
                depts.map((d) => {
                  const marginOk = d.grossMarginBp >= d.targetMarginBp - 150;
                  return (
                    <tr key={d.id}>
                      <td>
                        <strong>{d.name}</strong>{" "}
                        <span className="tag tag-neutral mono">{d.code}</span>
                      </td>
                      <td className="text-right mono">{d.skuCount}</td>
                      <td className="text-right mono">{d.units60d.toLocaleString()}</td>
                      <td className="text-right mono">{formatMoney(d.netSales60dCents)}</td>
                      <td className="text-right mono">{formatMoney(d.grossProfit60dCents)}</td>
                      <td className="text-right">
                        <span className={`tag mono ${marginOk ? "tag-green" : "tag-amber"}`}>
                          {formatBp(d.grossMarginBp)}
                        </span>{" "}
                        <span style={{ fontSize: 11.5, color: "var(--ink-muted)" }} className="mono">
                          / {formatBp(d.targetMarginBp)}
                        </span>
                      </td>
                      <td className="text-right mono">{formatMoney(d.stockCostCents)}</td>
                      <td className="text-right mono">
                        <strong>${d.gmroii.toFixed(2)}</strong>
                      </td>
                      <td className="text-right mono">{d.annualTurns.toFixed(1)}×</td>
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
