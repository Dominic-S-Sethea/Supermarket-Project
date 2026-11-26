import { memo, useState } from "react";

export interface HourlyFootfallPoint {
  hour: number;
  shiftKey: string;
  walkIns: number;
  receipts: number;
  conversionPct: number;
  revenueCents: number;
  avgOpenLanes: number;
  avgDwellSec: number;
}

/**
 * Isolated hourly footfall funnel SVG chart so pointer-hover and keyboard-focus
 * state changes stay local instead of re-rendering ShiftDiagnosticsView.
 */
export const HourlyFootfallChart = memo(function HourlyFootfallChart({
  hourly,
}: {
  hourly: HourlyFootfallPoint[];
}) {
  const [hoverHour, setHoverHour] = useState<number | null>(null);

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
      const cy = padT + plotH - (Math.min(100, Math.max(0, h.conversionPct)) / 100) * plotH;
      return `${cx.toFixed(1)},${cy.toFixed(1)}`;
    })
    .filter(Boolean)
    .join(" ");

  const morningCols = hourly.filter((h) => h.hour < 12).length;
  const activePoint = hoverHour !== null ? hourly.find((x) => x.hour === hoverHour) : null;

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2 className="panel-title">Hourly Footfall Funnel (Walk-Ins vs. Receipts &amp; Conversion %)</h2>
          <p className="panel-desc">
            Shaded amber = Morning (08–11). Slate bars = door entries; Emerald bars = paid receipts; Line = conversion %.
          </p>
        </div>
        {activePoint && (
          <div className="tag tag-green mono" role="status">
            {`${String(activePoint.hour).padStart(2, "0")}:00 — ${activePoint.walkIns} in → ${activePoint.receipts} paid (${activePoint.conversionPct}%)`}
          </div>
        )}
      </div>

      {hourly.length === 0 ? (
        <div style={{ color: "var(--ink-muted)", padding: "24px 0", textAlign: "center" }}>
          No hourly footfall telemetry recorded yet.
        </div>
      ) : (
        <svg viewBox={`0 0 ${chartW} ${chartH}`} className="chart-svg" role="group" aria-label="Hourly footfall funnel">
          {morningCols > 0 && (
            <rect
              x={padL}
              y={padT}
              width={morningCols * stepW}
              height={plotH}
              fill="var(--chart-morning-band)"
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
                  stroke="var(--chart-grid)"
                  strokeDasharray={t === 0 ? undefined : "3 3"}
                />
                <text
                  x={padL - 6}
                  y={y + 4}
                  textAnchor="end"
                  fontSize="10"
                  fill="var(--chart-label)"
                  fontFamily="var(--font-mono)"
                >
                  {Math.round(maxTraffic * t)}
                </text>
                <text
                  x={chartW - padR + 6}
                  y={y + 4}
                  textAnchor="start"
                  fontSize="10"
                  fill="var(--accent-primary-ink)"
                  fontFamily="var(--font-mono)"
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
                tabIndex={0}
                role="button"
                aria-label={`${String(h.hour).padStart(2, "0")}:00 — ${h.walkIns} walk-ins, ${h.receipts} receipts, ${h.conversionPct}% conversion`}
                onMouseEnter={() => setHoverHour(h.hour)}
                onMouseLeave={() => setHoverHour((curr) => (curr === h.hour ? null : curr))}
                onFocus={() => setHoverHour(h.hour)}
                onBlur={() => setHoverHour((curr) => (curr === h.hour ? null : curr))}
                onClick={() => setHoverHour((curr) => (curr === h.hour ? null : h.hour))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setHoverHour((curr) => (curr === h.hour ? null : h.hour));
                  }
                }}
                style={{ cursor: "pointer" }}
              >
                <rect
                  x={baseX - barW - 1}
                  y={padT + plotH - hWalk}
                  width={barW}
                  height={Math.max(1, hWalk)}
                  rx={2}
                  fill="var(--chart-bar-muted)"
                />
                <rect
                  x={baseX + 1}
                  y={padT + plotH - hRcpt}
                  width={barW}
                  height={Math.max(1, hRcpt)}
                  rx={2}
                  fill="var(--chart-bar-secondary)"
                />
                <text
                  x={baseX}
                  y={chartH - 8}
                  textAnchor="middle"
                  fontSize="10"
                  fill={h.hour < 12 ? "var(--accent-amber-ink)" : "var(--chart-label)"}
                  fontWeight={h.hour < 12 ? "700" : "400"}
                  fontFamily="var(--font-mono)"
                >
                  {String(h.hour).padStart(2, "0")}
                </text>
              </g>
            );
          })}
          {convPolyline && (
            <polyline
              fill="none"
              stroke="var(--chart-line-amber)"
              strokeWidth="2.4"
              points={convPolyline}
            />
          )}
        </svg>
      )}
    </section>
  );
});
