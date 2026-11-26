import { useState } from "react";
import { formatMoney } from "@supermarket/shared/money";

export interface DailyTrendPoint {
  day: string;
  receipts: number;
  salesCents: number;
  profitCents: number;
}

/**
 * Isolated sales & profit SVG chart with localized hover/focus/click state (M-02, M-17)
 * so hovering or navigating bars does not re-render the parent OverviewView and works
 * on keyboard and touch devices.
 */
export function SalesTrendChart({
  dailyTrend,
  days,
}: {
  dailyTrend: DailyTrendPoint[];
  days: number;
}) {
  const [activeIdx, setActiveIdx] = useState<number | null>(null);

  const maxSales = Math.max(1, ...dailyTrend.map((d) => d.salesCents));
  const chartW = 720;
  const chartH = 210;
  const padL = 56;
  const padR = 14;
  const padT = 16;
  const padB = 28;
  const plotW = chartW - padL - padR;
  const plotH = chartH - padT - padB;

  const barStep = dailyTrend.length > 0 ? plotW / dailyTrend.length : plotW;
  const barW = Math.max(4, barStep * 0.62);

  const profitPoints = dailyTrend
    .map((d, i) => {
      const x = padL + i * barStep + barStep / 2;
      const rawY = padT + plotH - (d.profitCents / maxSales) * plotH;
      const y = Math.min(padT + plotH, Math.max(padT, rawY));
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const activePoint = activeIdx !== null ? dailyTrend[activeIdx] ?? null : null;

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2 className="panel-title">Daily Sales &amp; Gross Profit Trend</h2>
          <p className="panel-desc">
            Bars = daily gross sales (notice Fri/Sat beverage &amp; snack surges); Emerald line = net gross profit.
          </p>
        </div>
        {activePoint && (
          <div className="tag tag-green mono" aria-live="polite">
            {activePoint.day}: {formatMoney(activePoint.salesCents)} ({activePoint.receipts} tx ·{" "}
            {formatMoney(activePoint.profitCents)} GP)
          </div>
        )}
      </div>
      {dailyTrend.length === 0 ? (
        <div style={{ color: "var(--ink-muted)", padding: "24px 0", textAlign: "center" }}>
          No completed sales recorded in the last {days} days.
        </div>
      ) : (
        <svg
          viewBox={`0 0 ${chartW} ${chartH}`}
          className="chart-svg"
          role="group"
          aria-label={`Daily sales and profit trend across ${dailyTrend.length} days`}
        >
          {[0, 0.25, 0.5, 0.75, 1].map((t) => {
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
                  x={padL - 8}
                  y={y + 4}
                  textAnchor="end"
                  fontSize="10"
                  fill="var(--chart-label)"
                  fontFamily="var(--font-mono)"
                >
                  ${Math.round((maxSales * t) / 100)}
                </text>
              </g>
            );
          })}
          {dailyTrend.map((d, i) => {
            const x = padL + i * barStep + (barStep - barW) / 2;
            const h = (d.salesCents / maxSales) * plotH;
            const y = padT + plotH - h;
            const isActive = activeIdx === i;
            return (
              <g
                key={d.day}
                tabIndex={0}
                role="button"
                aria-label={`${d.day}: ${formatMoney(d.salesCents)} sales, ${formatMoney(d.profitCents)} gross profit, ${d.receipts} receipts`}
                onMouseEnter={() => setActiveIdx(i)}
                onMouseLeave={() => setActiveIdx((curr) => (curr === i ? null : curr))}
                onFocus={() => setActiveIdx(i)}
                onBlur={() => setActiveIdx((curr) => (curr === i ? null : curr))}
                onClick={() => setActiveIdx((curr) => (curr === i ? null : i))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setActiveIdx((curr) => (curr === i ? null : i));
                  }
                }}
                style={{ cursor: "pointer" }}
              >
                <rect
                  x={x}
                  y={y}
                  width={barW}
                  height={Math.max(1, h)}
                  rx={2}
                  fill={isActive ? "var(--chart-bar-active)" : "var(--chart-bar)"}
                />
                {(i === 0 || i === Math.floor(dailyTrend.length / 2) || i === dailyTrend.length - 1) && (
                  <text
                    x={x + barW / 2}
                    y={chartH - 7}
                    textAnchor="middle"
                    fontSize="10"
                    fill="var(--chart-label)"
                    fontFamily="var(--font-mono)"
                  >
                    {d.day.slice(5)}
                  </text>
                )}
              </g>
            );
          })}
          {profitPoints && (
            <polyline
              fill="none"
              stroke="var(--chart-line)"
              strokeWidth="2.2"
              points={profitPoints}
            />
          )}
        </svg>
      )}
    </section>
  );
}
