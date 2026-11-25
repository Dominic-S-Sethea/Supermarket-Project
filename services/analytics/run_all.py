"""
SupermarketOS Python Analytics & Predictive Intelligence Worker
Computes and materializes into PostgreSQL:
  1. ABC-XYZ 3x3 Inventory Segmentation (Pareto Profit x Demand CV/ADI + GMROII)
  2. Portfolio Demand Forecasting (Weekend-Seasonal ETS without holdout leakage for X/Y SKUs,
     Croston-SBA with genuine holdout WMAPE for intermittent Z-class SKUs) + Case-Rounded Auto-PO Suggestions
  3. Market Basket Association Rules (Co-occurrence Support, Confidence, Lift)
  4. Loss Prevention Cashier Anomaly Robust MAD Z-Scores (Voids, Refunds, No-Sale Drawer Opens)
"""

from __future__ import annotations

import json
import logging
import math
import os
import time
import uuid
from collections import Counter, defaultdict

import numpy as np
import psycopg

logging.basicConfig(
    level=logging.INFO,
    format="%(message)s",
)
log = logging.getLogger("supermarket.analytics")

def log_event(stage: str, **fields: object) -> None:
    log.info(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "stage": stage, **fields}))

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgres://supermarket:supermarket_dev_password@localhost:5433/supermarket_os",
)


def croston_sba_forecast(series: np.ndarray, alpha: float = 0.2) -> float:
    """Syntetos-Boylan Approximation (Croston-SBA) for intermittent Z-class SKUs."""
    nz_indices = np.flatnonzero(series > 0)
    if len(nz_indices) == 0:
        return 0.0
    if len(nz_indices) == 1:
        return float(series[nz_indices[0]]) / max(1.0, len(series))

    z_hat = float(series[nz_indices[0]])  # smoothed demand size
    p_hat = float(nz_indices[0] + 1)  # smoothed inter-demand interval

    for i in range(1, len(nz_indices)):
        demand = float(series[nz_indices[i]])
        interval = float(nz_indices[i] - nz_indices[i - 1])
        z_hat = alpha * demand + (1.0 - alpha) * z_hat
        p_hat = alpha * interval + (1.0 - alpha) * p_hat

    # SBA bias-correction factor (1 - alpha/2)
    return (1.0 - alpha / 2.0) * (z_hat / max(1.0, p_hat))


def croston_holdout_wmape(series: np.ndarray, holdout_days: int = 14) -> float:
    """Genuine out-of-sample WMAPE for Croston-SBA over the trailing holdout window."""
    if len(series) <= holdout_days or series.sum() == 0:
        return 0.0
    train = series[:-holdout_days]
    actual_sum = float(series[-holdout_days:].sum())
    pred_sum = croston_sba_forecast(train) * holdout_days
    if actual_sum <= 0:
        return 0.0 if pred_sum <= 0.1 else 100.0
    wmape = abs(actual_sum - pred_sum) / actual_sum * 100.0
    return round(min(200.0, wmape), 1)


def weekend_ets_forecast(
    series: np.ndarray, alpha: float = 0.25, holdout_days: int = 14
) -> tuple[float, float]:
    """
    Single Exponential Smoothing with Day-of-Week seasonality multipliers.
    Seasonal indices are fit ONLY on the training split (series[:-holdout_days]) for leak-free WMAPE.
    Returns (predicted_daily_mean, holdout_wmape_pct).
    """
    n = len(series)
    if n < holdout_days + 14 or series.sum() == 0:
        mean_val = float(series.mean()) if n > 0 else 0.0
        return mean_val, 0.0

    split = n - holdout_days
    train = series[:split]
    holdout = series[split:]

    # 1. Fit day-of-week seasonal indices & SES level strictly on training window (no holdout leakage)
    train_overall = max(0.01, float(train.mean()))
    train_dow = np.array(
        [train[i::7].mean() if len(train[i::7]) > 0 else train_overall for i in range(7)],
        dtype=float,
    )
    train_seasonal = np.clip(train_dow / train_overall, 0.5, 2.2)

    train_deseason = np.array(
        [train[t] / train_seasonal[t % 7] for t in range(split)], dtype=float
    )
    train_level = float(train_deseason[0])
    for t in range(split):
        train_level = alpha * train_deseason[t] + (1.0 - alpha) * train_level

    # 2. Out-of-sample forecast over the 14-day holdout window
    holdout_preds = np.array(
        [train_level * train_seasonal[(split + h) % 7] for h in range(holdout_days)],
        dtype=float,
    )
    denom = float(holdout.sum())
    if denom > 0:
        wmape = float(np.abs(holdout - holdout_preds).sum()) / denom * 100.0
        wmape = round(min(200.0, wmape), 1)
    else:
        wmape = 0.0

    # 3. Refit on full 60-day history to generate the live 7-day forward forecast
    full_overall = max(0.01, float(series.mean()))
    full_dow = np.array([series[i::7].mean() for i in range(7)], dtype=float)
    full_seasonal = np.clip(full_dow / full_overall, 0.5, 2.2)
    full_deseason = np.array(
        [series[t] / full_seasonal[t % 7] for t in range(n)], dtype=float
    )
    level = float(full_deseason[0])
    for t in range(n):
        level = alpha * full_deseason[t] + (1.0 - alpha) * level

    next_7_mean = float(np.mean([level * full_seasonal[(n + h) % 7] for h in range(7)]))
    return max(0.0, next_7_mean), wmape


def recommend_abc_xyz_action(segment: str, days_of_stock: float) -> str:
    if segment in ("AX", "BX"):
        return "Auto-replenish tightly; weekly cycle count; zero stockout tolerance"
    if segment in ("AY", "BY"):
        return "Seasonal/weekend buffer + monitor promo lift & weather surges"
    if segment == "AZ":
        return "Manager-reviewed ordering; maintain safety buffer for erratic spikes"
    if segment in ("CX", "CY"):
        return "Automated low-touch Min/Max par replenishment (monthly review)"
    if days_of_stock > 120:
        return "Candidate for clearance markdown or delisting (capital trap)"
    return "Order strictly on demand; minimize shelf facings"


def score_cashiers_robust(
    rows: list[tuple[str, int, int, int, int]],
) -> list[tuple[str, int, int, int, int, float, float, str]]:
    """
    Compute composite cashier anomaly score (voids + 0.8*refunds + 0.5*no_sales)
    and MAD robust Z-score so a single bad actor among a small team cannot mask itself.
    Input rows: (cashier_name, total_tx, voids, refunds, no_sales)
    """
    if not rows:
        return []

    void_rates = np.array(
        [(v / max(1, total)) * 100.0 for _, total, v, _, _ in rows], dtype=float
    )
    composites = np.array(
        [
            ((v + 0.8 * ref + 0.5 * ns) / max(1, total)) * 100.0
            for _, total, v, ref, ns in rows
        ],
        dtype=float,
    )

    median_comp = float(np.median(composites))
    mad = max(0.05, float(np.median(np.abs(composites - median_comp))))

    scored = []
    for (cashier, total, voids, refunds, no_sales), v_rate, comp in zip(
        rows, void_rates, composites
    ):
        robust_z = 0.6745 * (float(comp) - median_comp) / mad
        if robust_z >= 2.5 or float(v_rate) >= 4.0:
            risk = "high"
        elif robust_z >= 1.2 or float(v_rate) >= 2.2:
            risk = "elevated"
        else:
            risk = "normal"

        scored.append(
            (
                cashier,
                int(total),
                int(voids),
                int(refunds),
                int(no_sales),
                round(float(v_rate), 2),
                round(float(robust_z), 2),
                risk,
            )
        )
    return scored


def run_abc_xyz_and_forecasts(
    conn: psycopg.Connection,
    supplier_lead_std: dict[str, float] | None = None,
) -> tuple[int, int]:
    t0 = time.perf_counter()
    with conn.cursor() as cur:
        # Load active products + live on-hand stock + primary supplier case details
        cur.execute("""
            WITH unfolded AS (
                SELECT product_id, COALESCE(SUM(qty_delta), 0)::int AS delta
                FROM stock_movements
                WHERE folded = false
                GROUP BY product_id
            )
            SELECT
                p.id::text,
                p.avg_cost_cents,
                COALESCE(sb.quantity, 0) + COALESCE(u.delta, 0) AS on_hand,
                COALESCE(sp.case_qty, 24) AS case_qty,
                COALESCE(sp.moq_cases, 1) AS moq_cases,
                COALESCE(sp.lead_time_days, 3) AS lead_time_days,
                COALESCE(s.name, 'Default Distributor') AS supplier_name,
                COALESCE(s.id::text, '') AS supplier_id
            FROM products p
            LEFT JOIN stock_baselines sb ON sb.product_id = p.id
            LEFT JOIN unfolded u ON u.product_id = p.id
            LEFT JOIN supplier_products sp ON sp.product_id = p.id AND sp.is_primary = true
            LEFT JOIN suppliers s ON s.id = sp.supplier_id
            WHERE p.active = true
        """)
        prod_rows = cur.fetchall()

        # Load last 60 COMPLETE calendar days (exclude partial CURRENT_DATE to avoid mid-day dropoff bias)
        cur.execute("""
            SELECT
                sl.product_id::text,
                (CURRENT_DATE - DATE(s.sold_at))::int AS day_ago,
                SUM(sl.base_units_sold)::int AS units,
                SUM(sl.line_total_cents - sl.tax_cents)::bigint AS net_rev,
                SUM(sl.line_total_cents - sl.tax_cents - (sl.unit_cost_cents * sl.base_units_sold))::bigint AS profit
            FROM sale_lines sl
            JOIN sales s ON s.id = sl.sale_id
            WHERE s.kind = 'sale'
              AND s.sold_at >= CURRENT_DATE - interval '60 days'
              AND s.sold_at < CURRENT_DATE
            GROUP BY 1, 2
        """)
        daily_rows = cur.fetchall()

    HORIZON = 60
    series_map: dict[str, np.ndarray] = {}
    rev_map: dict[str, int] = defaultdict(int)
    profit_map: dict[str, int] = defaultdict(int)

    for pid, day_ago, units, net_rev, profit in daily_rows:
        # day_ago is in [1..60] -> idx in [0..59]
        idx = HORIZON - int(day_ago)
        if 0 <= idx < HORIZON:
            arr = series_map.get(pid)
            if arr is None:
                arr = np.zeros(HORIZON, dtype=float)
                series_map[pid] = arr
            arr[idx] += float(units)
            rev_map[pid] += int(net_rev)
            profit_map[pid] += int(profit)

    ranked = sorted(prod_rows, key=lambda r: profit_map.get(r[0], 0), reverse=True)
    total_profit = max(1, sum(max(0, profit_map.get(r[0], 0)) for r in ranked))

    abc_records = []
    forecast_records = []
    active_pids = [r[0] for r in ranked]
    cum_profit = 0

    for pid, avg_cost, on_hand, case_qty, moq_cases, lead_days, supplier_name, supplier_id in ranked:
        rev60 = rev_map.get(pid, 0)
        prof60 = profit_map.get(pid, 0)
        cum_profit += max(0, prof60)
        share = cum_profit / total_profit

        abc = "A" if share <= 0.78 else ("B" if share <= 0.94 else "C")

        series = series_map.get(pid)
        if series is None:
            series = np.zeros(HORIZON, dtype=float)

        units60 = int(series.sum())
        avg_daily = units60 / float(HORIZON)
        std_daily = float(series.std())
        cv = (std_daily / avg_daily) if avg_daily > 0 else 9.99
        nz_days = int(np.count_nonzero(series > 0))
        adi = (HORIZON / float(nz_days)) if nz_days > 0 else float(HORIZON)

        if cv < 0.85 and adi <= 2.2:
            xyz = "X"
        elif cv < 1.65 and adi <= 5.5:
            xyz = "Y"
        else:
            xyz = "Z"

        segment = f"{abc}{xyz}"

        avg_inv_cost = max(1, max(1, int(on_hand)) * max(1, int(avg_cost)))
        gmroii = round((prof60 * 6.08) / avg_inv_cost, 2)
        dos = round(max(0, int(on_hand)) / max(0.05, avg_daily), 1) if units60 > 0 else 999.0

        abc_records.append(
            (
                pid,
                rev60,
                prof60,
                units60,
                round(avg_daily, 3),
                round(min(9.99, cv), 3),
                round(adi, 2),
                abc,
                xyz,
                segment,
                gmroii,
                min(999.0, dos),
                recommend_abc_xyz_action(segment, dos),
            )
        )

        if xyz == "Z":
            daily_fc = croston_sba_forecast(series)
            model_used = "CrostonSBA"
            wmape = croston_holdout_wmape(series)
        else:
            daily_fc, wmape = weekend_ets_forecast(series)
            model_used = "WeekendETS"

        fc7 = int(math.ceil(daily_fc * 7.0))
        fc14 = int(math.ceil(daily_fc * 14.0))

        # Dynamic Safety Stock: Z * sqrt(L * sigma_D^2 + D^2 * sigma_L^2) using measured empirical sigma_L
        z_factor = 1.65 if abc == "A" else (1.28 if abc == "B" else 0.84)
        fallback_sigma_l = max(0.4, lead_days * 0.25)
        sigma_l = (
            supplier_lead_std.get(supplier_id, fallback_sigma_l)
            if supplier_lead_std
            else fallback_sigma_l
        )
        safety_stock = int(
            math.ceil(
                z_factor * math.sqrt(lead_days * (std_daily**2) + (daily_fc**2) * (sigma_l**2))
            )
        )
        rop = int(math.ceil(daily_fc * lead_days)) + safety_stock

        target_cover_units = fc14 + safety_stock if abc in ("A", "B") else fc7 + safety_stock
        deficit = target_cover_units - int(on_hand)

        if int(on_hand) <= rop and daily_fc > 0.15 and deficit > 0:
            raw_cases = math.ceil(deficit / max(1, int(case_qty)))
            order_cases = max(int(moq_cases), raw_cases)
        else:
            order_cases = 0

        if int(on_hand) <= max(2, int(daily_fc * lead_days)) and daily_fc >= 0.4:
            urgency = "critical"
        elif order_cases > 0:
            urgency = "reorder_now"
        elif int(on_hand) <= int(rop * 1.25) and daily_fc >= 0.25:
            urgency = "watch"
        else:
            urgency = "healthy"

        est_order_cost = order_cases * int(case_qty) * int(avg_cost)

        forecast_records.append(
            (
                pid,
                model_used,
                fc7,
                fc14,
                safety_stock,
                rop,
                int(on_hand),
                order_cases,
                int(case_qty),
                est_order_cost,
                supplier_name,
                wmape,
                urgency,
            )
        )

    # Atomic upserts without taking ACCESS EXCLUSIVE TRUNCATE locks against live API readers
    with conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO analytics_abc_xyz (
                product_id, revenue_60d_cents, profit_60d_cents, units_60d,
                avg_daily_units, demand_cv, adi, abc_class, xyz_class, segment,
                gmroii, days_of_stock, recommended_action, computed_at
            ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now())
            ON CONFLICT (product_id) DO UPDATE SET
                revenue_60d_cents = EXCLUDED.revenue_60d_cents,
                profit_60d_cents = EXCLUDED.profit_60d_cents,
                units_60d = EXCLUDED.units_60d,
                avg_daily_units = EXCLUDED.avg_daily_units,
                demand_cv = EXCLUDED.demand_cv,
                adi = EXCLUDED.adi,
                abc_class = EXCLUDED.abc_class,
                xyz_class = EXCLUDED.xyz_class,
                segment = EXCLUDED.segment,
                gmroii = EXCLUDED.gmroii,
                days_of_stock = EXCLUDED.days_of_stock,
                recommended_action = EXCLUDED.recommended_action,
                computed_at = now()
            """,
            abc_records,
        )
        cur.executemany(
            """
            INSERT INTO analytics_demand_forecasts (
                product_id, model_used, forecast_7d_units, forecast_14d_units,
                safety_stock_units, reorder_point_units, current_stock_units,
                suggested_order_cases, case_qty, estimated_order_cost_cents,
                supplier_name, wmape_pct, urgency, computed_at
            ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now())
            ON CONFLICT (product_id) DO UPDATE SET
                model_used = EXCLUDED.model_used,
                forecast_7d_units = EXCLUDED.forecast_7d_units,
                forecast_14d_units = EXCLUDED.forecast_14d_units,
                safety_stock_units = EXCLUDED.safety_stock_units,
                reorder_point_units = EXCLUDED.reorder_point_units,
                current_stock_units = EXCLUDED.current_stock_units,
                suggested_order_cases = EXCLUDED.suggested_order_cases,
                case_qty = EXCLUDED.case_qty,
                estimated_order_cost_cents = EXCLUDED.estimated_order_cost_cents,
                supplier_name = EXCLUDED.supplier_name,
                wmape_pct = EXCLUDED.wmape_pct,
                urgency = EXCLUDED.urgency,
                computed_at = now()
            """,
            forecast_records,
        )
        cur.execute(
            "DELETE FROM analytics_abc_xyz WHERE product_id <> ALL(%s::uuid[])",
            (active_pids,),
        )
        cur.execute(
            "DELETE FROM analytics_demand_forecasts WHERE product_id <> ALL(%s::uuid[])",
            (active_pids,),
        )
    conn.commit()
    print(
        f"[ABC-XYZ & Forecasts] Computed {len(abc_records)} SKUs in {time.perf_counter() - t0:.2f}s"
    )
    return len(abc_records), len(forecast_records)


def _mine_basket_subset(
    rows: list[tuple[str, str, str]],
    shift_bucket: str,
    min_co: int,
    min_lift: float,
    top_n: int,
) -> list[tuple[str, str, str, str, str, str, int, float, float, float]]:
    baskets: dict[str, set[str]] = defaultdict(set)
    name_map: dict[str, str] = {}
    for sale_id, pid, name in rows:
        baskets[sale_id].add(pid)
        name_map[pid] = name

    total_baskets = max(1, len(baskets))
    item_counts: Counter[str] = Counter()
    pair_counts: Counter[tuple[str, str]] = Counter()

    for items in baskets.values():
        sorted_items = sorted(items)
        for p in sorted_items:
            item_counts[p] += 1
        if 2 <= len(sorted_items) <= 20:
            for i in range(len(sorted_items)):
                for j in range(i + 1, len(sorted_items)):
                    pair_counts[(sorted_items[i], sorted_items[j])] += 1

    rules = []
    for (a, b), co in pair_counts.items():
        if co < min_co:
            continue
        support = co / total_baskets
        conf_ab = co / item_counts[a]
        conf_ba = co / item_counts[b]
        prob_b = item_counts[b] / total_baskets
        lift = conf_ab / max(1e-9, prob_b)
        if lift < min_lift:
            continue
        if conf_ab >= conf_ba:
            ant, cons, conf = a, b, conf_ab
        else:
            ant, cons, conf = b, a, conf_ba

        rules.append(
            (
                str(uuid.uuid4()),
                shift_bucket,
                ant,
                cons,
                name_map[ant],
                name_map[cons],
                int(co),
                round(float(support), 5),
                round(float(conf), 4),
                round(float(lift), 2),
            )
        )

    rules.sort(key=lambda r: (r[9], r[6]), reverse=True)
    return rules[:top_n]


def run_market_basket(conn: psycopg.Connection) -> int:
    t0 = time.perf_counter()
    with conn.cursor() as cur:
        cur.execute("""
            SELECT
                sl.sale_id::text,
                sl.product_id::text,
                p.name,
                EXTRACT(HOUR FROM s.sold_at)::int AS sale_hour
            FROM sale_lines sl
            JOIN sales s ON s.id = sl.sale_id
            JOIN products p ON p.id = sl.product_id
            WHERE s.kind = 'sale' AND s.sold_at >= now() - interval '60 days'
        """)
        rows = cur.fetchall()

    all_rows = [(sid, pid, name) for sid, pid, name, _ in rows]
    morning_rows = [(sid, pid, name) for sid, pid, name, hr in rows if int(hr) < 12]

    all_rules = _mine_basket_subset(all_rows, "all", min_co=12, min_lift=1.35, top_n=40)
    morning_rules = _mine_basket_subset(
        morning_rows, "morning", min_co=3, min_lift=1.15, top_n=25
    )
    combined = all_rules + morning_rules

    with conn.cursor() as cur:
        cur.execute("DELETE FROM analytics_basket_rules;")
        cur.executemany(
            """
            INSERT INTO analytics_basket_rules (
                id, shift_bucket, antecedent_product_id, consequent_product_id,
                antecedent_name, consequent_name, co_occurrences,
                support, confidence, lift
            ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            """,
            combined,
        )
    conn.commit()
    print(
        f"[Market Basket] Mined {len(all_rows)} lines -> {len(all_rules)} full-day + {len(morning_rules)} morning rules in {time.perf_counter() - t0:.2f}s"
    )
    return len(combined)


def bootstrap_ci(
    values: np.ndarray, n_boot: int = 500, seed: int = 42
) -> tuple[float, float, float]:
    """Return (mean, ci_low_95, ci_high_95) using percentile bootstrap resampling."""
    arr = np.asarray(values, dtype=float)
    arr = arr[np.isfinite(arr)]
    if len(arr) == 0:
        return 0.0, 0.0, 0.0
    mean_val = float(arr.mean())
    if len(arr) == 1:
        return round(mean_val, 3), round(mean_val, 3), round(mean_val, 3)

    rng = np.random.default_rng(seed)
    idx = rng.integers(0, len(arr), size=(n_boot, len(arr)))
    boot_means = arr[idx].mean(axis=1)
    lo, hi = np.percentile(boot_means, [2.5, 97.5])
    return round(mean_val, 3), round(float(lo), 3), round(float(hi), 3)


def welch_ttest_pvalue(a: np.ndarray, b: np.ndarray) -> float:
    """Two-sided Welch t-test p-value (normal approximation for moderate/large samples)."""
    xa = np.asarray(a, dtype=float)
    xb = np.asarray(b, dtype=float)
    xa = xa[np.isfinite(xa)]
    xb = xb[np.isfinite(xb)]
    if len(xa) < 2 or len(xb) < 2:
        return 1.0
    var_a = float(xa.var(ddof=1))
    var_b = float(xb.var(ddof=1))
    se = math.sqrt(max(1e-12, var_a / len(xa) + var_b / len(xb)))
    t_stat = abs(float(xa.mean()) - float(xb.mean())) / se
    p_val = math.erfc(t_stat / math.sqrt(2.0))
    return round(min(1.0, max(0.0, float(p_val))), 6)


def _silhouette_score(X_norm: np.ndarray, labels: np.ndarray) -> float:
    n = len(X_norm)
    unique = np.unique(labels)
    if n < 6 or len(unique) < 2:
        return 0.0
    if n > 450:
        rng = np.random.default_rng(42)
        sub_idx = rng.choice(n, size=450, replace=False)
        X_s = X_norm[sub_idx]
        L_s = labels[sub_idx]
    else:
        X_s = X_norm
        L_s = labels

    diff = X_s[:, None, :] - X_s[None, :, :]
    dists = np.sqrt(np.sum(diff * diff, axis=2))
    sil_vals = []
    for i in range(len(X_s)):
        own_mask = L_s == L_s[i]
        own_count = int(own_mask.sum())
        a_i = float(dists[i, own_mask].sum() / max(1, own_count - 1)) if own_count > 1 else 0.0
        b_i = float("inf")
        for c in unique:
            if c == L_s[i]:
                continue
            other_mask = L_s == c
            if np.any(other_mask):
                b_i = min(b_i, float(dists[i, other_mask].mean()))
        if not math.isfinite(b_i):
            continue
        denom = max(a_i, b_i, 1e-9)
        sil_vals.append((b_i - a_i) / denom)
    return float(np.mean(sil_vals)) if sil_vals else 0.0


def kmeans_missions(
    X: np.ndarray, k_candidates: tuple[int, ...] = (3, 4), seed: int = 42
) -> tuple[np.ndarray, np.ndarray, float, int]:
    """Standardize features and fit K-Means++ across candidate K values, selecting best Silhouette Score."""
    X_arr = np.asarray(X, dtype=float)
    n, d = X_arr.shape
    if n < 10:
        labels = np.zeros(n, dtype=int)
        return labels, X_arr.mean(axis=0, keepdims=True) if n > 0 else np.zeros((1, d)), 0.0, 1

    mean = X_arr.mean(axis=0)
    std = np.where(X_arr.std(axis=0) > 1e-6, X_arr.std(axis=0), 1.0)
    X_norm = (X_arr - mean) / std
    rng = np.random.default_rng(seed)

    best_sil = -1.0
    best_labels = np.zeros(n, dtype=int)
    best_centroids = np.zeros((1, d), dtype=float)
    best_k = 1

    for k in k_candidates:
        if k >= n:
            continue
        for _ in range(4):
            # k-means++ initialization
            first = int(rng.integers(0, n))
            centers = [X_norm[first].copy()]
            for _c in range(1, k):
                c_arr = np.vstack(centers)
                sq_d = np.min(
                    np.sum((X_norm[:, None, :] - c_arr[None, :, :]) ** 2, axis=2),
                    axis=1,
                )
                probs = sq_d / max(1e-9, float(sq_d.sum()))
                nxt = int(rng.choice(n, p=probs))
                centers.append(X_norm[nxt].copy())
            c_mat = np.vstack(centers)

            labels = np.zeros(n, dtype=int)
            for _it in range(25):
                sq_d = np.sum((X_norm[:, None, :] - c_mat[None, :, :]) ** 2, axis=2)
                new_labels = np.argmin(sq_d, axis=1)
                if np.array_equal(new_labels, labels) and _it > 0:
                    break
                labels = new_labels
                for j in range(k):
                    mask = labels == j
                    if np.any(mask):
                        c_mat[j] = X_norm[mask].mean(axis=0)

            sil = _silhouette_score(X_norm, labels)
            if sil > best_sil:
                best_sil = sil
                best_labels = labels.copy()
                best_centroids = c_mat * std + mean
                best_k = k

    return best_labels, best_centroids, round(float(best_sil), 3), best_k


def chronological_ridge_attribution(
    X: np.ndarray,
    y: np.ndarray,
    feature_names: list[str],
    feature_labels: list[str] | None = None,
    holdout_days: int = 14,
    lam: float = 2.5,
) -> dict:
    """
    Fit standardized Ridge regression strictly on chronological training split X[:-holdout_days],
    evaluate out-of-sample WMAPE vs day-of-week seasonal mean baseline, and rank causal drivers.
    """
    X_arr = np.asarray(X, dtype=float)
    y_arr = np.asarray(y, dtype=float)
    n, d = X_arr.shape
    labels = feature_labels if feature_labels and len(feature_labels) == d else feature_names

    if n < holdout_days + 10 or y_arr.sum() <= 0:
        return {
            "holdoutWmapePct": 0.0,
            "baselineWmapePct": 0.0,
            "r2Train": 0.0,
            "drivers": [],
        }

    split = n - holdout_days
    X_tr, X_te = X_arr[:split], X_arr[split:]
    y_tr, y_te = y_arr[:split], y_arr[split:]

    # Fit preprocessing strictly on training split
    mu_x = X_tr.mean(axis=0)
    sd_x = np.where(X_tr.std(axis=0) > 1e-6, X_tr.std(axis=0), 1.0)
    X_tr_z = (X_tr - mu_x) / sd_x
    X_te_z = (X_te - mu_x) / sd_x

    mu_y = float(y_tr.mean())
    y_tr_c = y_tr - mu_y

    # Closed-form Ridge: (X^T X + lam * I)^-1 X^T y
    gram = X_tr_z.T @ X_tr_z + lam * np.eye(d, dtype=float)
    beta = np.linalg.solve(gram, X_tr_z.T @ y_tr_c)

    y_tr_pred = mu_y + X_tr_z @ beta
    y_te_pred = np.maximum(0.0, mu_y + X_te_z @ beta)

    ss_res = float(np.sum((y_tr - y_tr_pred) ** 2))
    ss_tot = max(1e-9, float(np.sum((y_tr - mu_y) ** 2)))
    r2_train = max(0.0, min(1.0, 1.0 - ss_res / ss_tot))

    denom_te = max(1e-9, float(np.sum(np.abs(y_te))))
    ridge_wmape = float(np.sum(np.abs(y_te - y_te_pred)) / denom_te * 100.0)

    # Naive weekday seasonal baseline fit strictly on training window
    dow_means = [
        float(y_tr[i::7].mean()) if len(y_tr[i::7]) > 0 else mu_y for i in range(7)
    ]
    baseline_pred = np.array([dow_means[(split + h) % 7] for h in range(holdout_days)], dtype=float)
    baseline_wmape = float(np.sum(np.abs(y_te - baseline_pred)) / denom_te * 100.0)

    abs_beta = np.abs(beta)
    total_abs = max(1e-9, float(abs_beta.sum()))
    drivers = []
    for i in range(d):
        coef_usd = float(beta[i])
        drivers.append(
            {
                "feature": feature_names[i],
                "label": labels[i],
                "coefUsdPerSd": round(coef_usd, 2),
                "importancePct": round(float(abs_beta[i] / total_abs * 100.0), 1),
                "direction": "positive" if coef_usd >= 0 else "negative",
            }
        )
    drivers.sort(key=lambda r: r["importancePct"], reverse=True)

    return {
        "holdoutWmapePct": round(min(200.0, ridge_wmape), 1),
        "baselineWmapePct": round(min(200.0, baseline_wmape), 1),
        "r2Train": round(r2_train, 3),
        "drivers": drivers,
    }


def compute_did_evaluation(
    pre_target: np.ndarray,
    post_target: np.ndarray,
    pre_control: np.ndarray,
    post_control: np.ndarray,
    seed: int = 42,
) -> dict:
    """
    Compute Difference-in-Differences treatment effect using an intra-store control shift.
    Checks for shared trend removal, bootstrap 95% CI, Welch p-value, and shift cannibalization.
    """
    pre_t = np.asarray(pre_target, dtype=float)
    post_t = np.asarray(post_target, dtype=float)
    pre_c = np.asarray(pre_control, dtype=float)
    post_c = np.asarray(post_control, dtype=float)

    m_pre_t = float(pre_t.mean()) if len(pre_t) > 0 else 0.0
    m_post_t = float(post_t.mean()) if len(post_t) > 0 else 0.0
    m_pre_c = float(pre_c.mean()) if len(pre_c) > 0 else 0.0
    m_post_c = float(post_c.mean()) if len(post_c) > 0 else 0.0

    delta_t = m_post_t - m_pre_t
    delta_c = m_post_c - m_pre_c
    # Scale control change by pre-period target/control ratio so proportional macro shocks cancel cleanly
    scale = (m_pre_t / m_pre_c) if m_pre_c > 1e-6 else 1.0
    did_lift = delta_t - delta_c * scale
    did_lift_pct = (did_lift / max(1e-6, m_pre_t)) * 100.0 if m_pre_t > 0 else 0.0
    control_change_pct = (delta_c / max(1e-6, m_pre_c)) * 100.0 if m_pre_c > 0 else 0.0

    # Paired/independent bootstrap CI on DiD estimator
    rng = np.random.default_rng(seed)
    n_boot = 500
    if min(len(pre_t), len(post_t), len(pre_c), len(post_c)) >= 2:
        lifts = np.empty(n_boot, dtype=float)
        for b in range(n_boot):
            bt_pre_t = float(rng.choice(pre_t, size=len(pre_t), replace=True).mean())
            bt_post_t = float(rng.choice(post_t, size=len(post_t), replace=True).mean())
            bt_pre_c = float(rng.choice(pre_c, size=len(pre_c), replace=True).mean())
            bt_post_c = float(rng.choice(post_c, size=len(post_c), replace=True).mean())
            bt_scale = (bt_pre_t / bt_pre_c) if bt_pre_c > 1e-6 else 1.0
            lifts[b] = (bt_post_t - bt_pre_t) - (bt_post_c - bt_pre_c) * bt_scale
        ci_lo, ci_hi = np.percentile(lifts, [2.5, 97.5])
        se = max(1e-9, float(lifts.std(ddof=1)))
        z_val = abs(did_lift) / se
        p_val = math.erfc(z_val / math.sqrt(2.0))
    else:
        ci_lo, ci_hi, p_val = did_lift, did_lift, 1.0

    cannibalized = control_change_pct < -5.0
    if cannibalized or did_lift < 0:
        verdict = "negative_or_cannibalized"
    elif ci_lo > 0 and p_val < 0.05:
        verdict = "significant_positive"
    else:
        verdict = "inconclusive"

    return {
        "preTargetMeanUsd": round(m_pre_t, 2),
        "postTargetMeanUsd": round(m_post_t, 2),
        "preControlMeanUsd": round(m_pre_c, 2),
        "postControlMeanUsd": round(m_post_c, 2),
        "didLiftUsdPerDay": round(did_lift, 2),
        "didLiftPct": round(did_lift_pct, 2),
        "ciLowUsd": round(float(ci_lo), 2),
        "ciHighUsd": round(float(ci_hi), 2),
        "pValue": round(min(1.0, max(0.0, float(p_val))), 5),
        "controlChangePct": round(control_change_pct, 2),
        "cannibalizationFlag": bool(cannibalized),
        "verdict": verdict,
    }


def run_shift_diagnostics(conn: psycopg.Connection) -> dict:
    t0 = time.perf_counter()
    SHIFT_HOURS = {"morning": 4.0, "afternoon": 3.0, "evening": 5.0}
    SHIFT_LABELS = {
        "morning": "Morning (08:00-11:59)",
        "afternoon": "Afternoon (12:00-16:59)",
        "evening": "Evening (17:00-21:59)",
    }

    with conn.cursor() as cur:
        # 1. Receipt-level summary by shift over complete 60d window
        cur.execute("""
            WITH line_agg AS (
              SELECT
                sale_id,
                SUM(qty_packs)::int AS packs,
                COUNT(*)::int AS line_count,
                SUM(CASE WHEN pack_qty > 1 THEN 1 ELSE 0 END)::int AS multipack_lines
              FROM sale_lines
              GROUP BY sale_id
            ),
            base AS (
              SELECT
                DATE(s.sold_at) AS sale_day,
                EXTRACT(ISODOW FROM s.sold_at)::int AS dow,
                EXTRACT(HOUR FROM s.sold_at)::int AS hr,
                CASE
                  WHEN EXTRACT(HOUR FROM s.sold_at) < 12 THEN 'morning'
                  WHEN EXTRACT(HOUR FROM s.sold_at) < 17 THEN 'afternoon'
                  ELSE 'evening'
                END AS shift_key,
                s.kind,
                s.total_cents,
                s.tax_cents,
                s.total_cost_cents,
                COALESCE(l.packs, 0) AS packs,
                COALESCE(l.line_count, 0) AS line_count,
                COALESCE(l.multipack_lines, 0) AS multipack_lines
              FROM sales s
              LEFT JOIN line_agg l ON l.sale_id = s.id
              WHERE s.sold_at >= CURRENT_DATE - interval '60 days'
                AND s.sold_at < CURRENT_DATE
            )
            SELECT
              shift_key,
              COUNT(*) FILTER (WHERE kind = 'sale')::int AS sale_receipts,
              COUNT(*) FILTER (WHERE kind <> 'sale')::int AS void_refunds,
              COALESCE(SUM(total_cents) FILTER (WHERE kind = 'sale'), 0)::bigint AS gross_cents,
              COALESCE(SUM(total_cents - tax_cents - total_cost_cents) FILTER (WHERE kind = 'sale'), 0)::bigint AS profit_cents,
              COALESCE(SUM(total_cents - tax_cents) FILTER (WHERE kind = 'sale'), 0)::bigint AS net_cents,
              COALESCE(AVG(total_cents) FILTER (WHERE kind = 'sale'), 0)::float AS avg_atv_cents,
              COALESCE(AVG(packs) FILTER (WHERE kind = 'sale'), 0)::float AS avg_packs,
              COALESCE(AVG(line_count) FILTER (WHERE kind = 'sale'), 0)::float AS avg_skus,
              COALESCE(100.0 * SUM(multipack_lines) FILTER (WHERE kind = 'sale') / NULLIF(SUM(line_count) FILTER (WHERE kind = 'sale'), 0), 0)::float AS multipack_pct,
              COUNT(DISTINCT hr)::int AS active_hours,
              COUNT(DISTINCT sale_day)::int AS active_days
            FROM base
            GROUP BY shift_key
        """)
        shift_agg_rows = cur.fetchall()

        # 2. Daily shift footfall + receipts for CIs, Welch tests & Ridge attribution
        cur.execute("""
            WITH daily_sales AS (
              SELECT
                DATE(sold_at) AS d,
                CASE
                  WHEN EXTRACT(HOUR FROM sold_at) < 12 THEN 'morning'
                  WHEN EXTRACT(HOUR FROM sold_at) < 17 THEN 'afternoon'
                  ELSE 'evening'
                END AS shift_key,
                COUNT(*) FILTER (WHERE kind = 'sale')::int AS receipts,
                COALESCE(SUM(total_cents) FILTER (WHERE kind = 'sale'), 0)::bigint AS rev_cents
              FROM sales
              WHERE sold_at >= CURRENT_DATE - interval '60 days'
                AND sold_at < CURRENT_DATE
              GROUP BY 1, 2
            ),
            daily_foot AS (
              SELECT
                DATE(bucket_start) AS d,
                CASE
                  WHEN EXTRACT(HOUR FROM bucket_start) < 12 THEN 'morning'
                  WHEN EXTRACT(HOUR FROM bucket_start) < 17 THEN 'afternoon'
                  ELSE 'evening'
                END AS shift_key,
                COALESCE(SUM(entries), 0)::int AS entries,
                COALESCE(AVG(open_lanes), 1)::float AS avg_lanes,
                COALESCE(AVG(avg_dwell_sec), 300)::float AS avg_dwell,
                BOOL_OR(weather_rain) AS weather_rain
              FROM store_footfall
              WHERE bucket_start >= CURRENT_DATE - interval '60 days'
                AND bucket_start < CURRENT_DATE
              GROUP BY 1, 2
            )
            SELECT
              COALESCE(s.d, f.d) AS day_date,
              COALESCE(s.shift_key, f.shift_key) AS shift_key,
              COALESCE(s.receipts, 0)::int AS receipts,
              COALESCE(s.rev_cents, 0)::bigint AS rev_cents,
              COALESCE(f.entries, 0)::int AS entries,
              COALESCE(f.avg_lanes, 1)::float AS avg_lanes,
              COALESCE(f.avg_dwell, 300)::float AS avg_dwell,
              COALESCE(f.weather_rain, false) AS weather_rain
            FROM daily_sales s
            FULL OUTER JOIN daily_foot f ON f.d = s.d AND f.shift_key = s.shift_key
            ORDER BY day_date ASC
        """)
        daily_shift_rows = cur.fetchall()

        # 3. Hourly profile (08..21)
        cur.execute("""
            WITH hr_sales AS (
              SELECT
                EXTRACT(HOUR FROM sold_at)::int AS hr,
                COUNT(*) FILTER (WHERE kind = 'sale')::int AS receipts,
                COALESCE(SUM(total_cents) FILTER (WHERE kind = 'sale'), 0)::bigint AS rev_cents
              FROM sales
              WHERE sold_at >= CURRENT_DATE - interval '60 days' AND sold_at < CURRENT_DATE
              GROUP BY 1
            ),
            hr_foot AS (
              SELECT
                EXTRACT(HOUR FROM bucket_start)::int AS hr,
                COALESCE(SUM(entries), 0)::int AS entries,
                COALESCE(AVG(open_lanes), 1)::float AS avg_lanes,
                COALESCE(AVG(avg_dwell_sec), 300)::float AS avg_dwell
              FROM store_footfall
              WHERE bucket_start >= CURRENT_DATE - interval '60 days' AND bucket_start < CURRENT_DATE
              GROUP BY 1
            )
            SELECT
              gs.hr::int,
              COALESCE(hs.receipts, 0)::int AS receipts,
              COALESCE(hs.rev_cents, 0)::bigint AS rev_cents,
              COALESCE(hf.entries, 0)::int AS entries,
              COALESCE(hf.avg_lanes, 1)::float AS avg_lanes,
              COALESCE(hf.avg_dwell, 0)::float AS avg_dwell
            FROM generate_series(8, 21) AS gs(hr)
            LEFT JOIN hr_sales hs ON hs.hr = gs.hr
            LEFT JOIN hr_foot hf ON hf.hr = gs.hr
            ORDER BY gs.hr ASC
        """)
        hourly_rows = cur.fetchall()

        # 4. Morning 08:00 OOS & Restock Lag Root Causes
        cur.execute("""
            WITH oos_stats AS (
              SELECT
                product_id,
                COUNT(*)::int AS snapshot_days,
                COUNT(*) FILTER (WHERE is_oos = true)::int AS oos_days,
                COALESCE(AVG(restocked_at_hour) FILTER (WHERE is_oos = true), 11)::float AS avg_restock_hr
              FROM hourly_stock_snapshots
              WHERE snapshot_hour = 8
                AND snapshot_date >= CURRENT_DATE - interval '60 days'
                AND snapshot_date < CURRENT_DATE
              GROUP BY product_id
              HAVING COUNT(*) FILTER (WHERE is_oos = true) > 0
            ),
            morning_in_stock_vel AS (
              SELECT
                sl.product_id,
                COUNT(DISTINCT DATE(s.sold_at))::int AS sold_days,
                COALESCE(SUM(sl.base_units_sold), 0)::float AS total_morning_units
              FROM sale_lines sl
              JOIN sales s ON s.id = sl.sale_id AND s.kind = 'sale'
              LEFT JOIN hourly_stock_snapshots hss
                ON hss.product_id = sl.product_id
                AND hss.snapshot_date = DATE(s.sold_at)
                AND hss.snapshot_hour = 8
              WHERE EXTRACT(HOUR FROM s.sold_at) < 12
                AND s.sold_at >= CURRENT_DATE - interval '60 days'
                AND s.sold_at < CURRENT_DATE
                AND COALESCE(hss.is_oos, false) = false
              GROUP BY sl.product_id
            ),
            in_stock_days AS (
              SELECT product_id, GREATEST(1, COUNT(*) FILTER (WHERE is_oos = false))::float AS ok_days
              FROM hourly_stock_snapshots
              WHERE snapshot_hour = 8
              GROUP BY product_id
            )
            SELECT
              p.id::text AS product_id,
              p.sku,
              p.name,
              d.name AS dept_name,
              COALESCE(ax.segment, 'B') AS segment,
              COALESCE(pb.sell_price_cents, p.avg_cost_cents * 2)::bigint AS price_cents,
              COALESCE(sup.id::text, '') AS supplier_id,
              COALESCE(sup.name, 'Default Distributor') AS supplier_name,
              o.oos_days,
              o.snapshot_days,
              o.avg_restock_hr,
              COALESCE(v.total_morning_units, 0)::float / COALESCE(isd.ok_days, 30.0) AS exp_morning_units
            FROM oos_stats o
            JOIN products p ON p.id = o.product_id
            JOIN categories c ON c.id = p.category_id
            JOIN departments d ON d.id = c.department_id
            LEFT JOIN analytics_abc_xyz ax ON ax.product_id = p.id
            LEFT JOIN product_barcodes pb ON pb.product_id = p.id AND pb.is_primary = true
            LEFT JOIN supplier_products sp ON sp.product_id = p.id AND sp.is_primary = true
            LEFT JOIN suppliers sup ON sup.id = sp.supplier_id
            LEFT JOIN morning_in_stock_vel v ON v.product_id = p.id
            LEFT JOIN in_stock_days isd ON isd.product_id = p.id
            ORDER BY (o.oos_days * GREATEST(0.6, COALESCE(v.total_morning_units, 6) / COALESCE(isd.ok_days, 30.0)) * COALESCE(pb.sell_price_cents, 200)) DESC
            LIMIT 25
        """)
        oos_rows = cur.fetchall()

        # 5. Daily 08:00 Class-A/B availability % for Ridge regression
        cur.execute("""
            SELECT
              snapshot_date,
              ROUND(100.0 * COUNT(*) FILTER (WHERE is_oos = false) / GREATEST(1, COUNT(*)), 2)::float AS avail_pct
            FROM hourly_stock_snapshots
            WHERE snapshot_hour = 8
              AND snapshot_date >= CURRENT_DATE - interval '60 days'
              AND snapshot_date < CURRENT_DATE
            GROUP BY snapshot_date
        """)
        avail_map = {str(r[0]): float(r[1]) for r in cur.fetchall()}

        # 6. Morning 15-min queue saturation data
        cur.execute("""
            WITH bucket_sales AS (
              SELECT
                date_trunc('hour', sold_at) + (FLOOR(EXTRACT(MINUTE FROM sold_at) / 15)::int * interval '15 minutes') AS b_ts,
                COUNT(*) FILTER (WHERE kind = 'sale')::int AS receipts
              FROM sales
              WHERE sold_at >= CURRENT_DATE - interval '60 days'
                AND sold_at < CURRENT_DATE
                AND EXTRACT(HOUR FROM sold_at) < 12
              GROUP BY 1
            )
            SELECT
              f.entries::int,
              f.open_lanes::int,
              f.avg_dwell_sec::int,
              COALESCE(bs.receipts, 0)::int AS receipts
            FROM store_footfall f
            LEFT JOIN bucket_sales bs ON bs.b_ts = f.bucket_start
            WHERE f.bucket_start >= CURRENT_DATE - interval '60 days'
              AND f.bucket_start < CURRENT_DATE
              AND EXTRACT(HOUR FROM f.bucket_start) < 12
              AND f.entries > 0
        """)
        queue_rows = cur.fetchall()

        # 7. Receipt sample (up to 3000) for K-Means Shopper Mission Clustering
        cur.execute("""
            SELECT
              s.id::text,
              EXTRACT(HOUR FROM s.sold_at)::float AS hr,
              COUNT(sl.id)::float AS sku_cnt,
              COALESCE(AVG(CASE WHEN sl.pack_qty > 1 THEN 1.0 ELSE 0.0 END), 0.0)::float AS multipack_ratio,
              (s.total_cents / 100.0)::float AS atv_usd,
              COALESCE(SUM(CASE WHEN d.code IN ('SWET','ENRG','WATR') THEN sl.line_total_cents ELSE 0 END)::float / GREATEST(1, s.total_cents), 0.0)::float AS morning_cat_share,
              COALESCE(SUM(CASE WHEN d.code IN ('BEER','SNCK') THEN sl.line_total_cents ELSE 0 END)::float / GREATEST(1, s.total_cents), 0.0)::float AS evening_cat_share
            FROM sales s
            JOIN sale_lines sl ON sl.sale_id = s.id
            JOIN products p ON p.id = sl.product_id
            JOIN categories c ON c.id = p.category_id
            JOIN departments d ON d.id = c.department_id
            WHERE s.kind = 'sale'
              AND s.sold_at >= CURRENT_DATE - interval '60 days'
              AND s.sold_at < CURRENT_DATE
            GROUP BY s.id, s.sold_at, s.total_cents
            ORDER BY s.sold_at DESC
            LIMIT 3000
        """)
        mission_rows = cur.fetchall()

        # 8. Top Morning Market Basket Rule (for recommendations)
        cur.execute("""
            SELECT antecedent_name, consequent_name, lift, confidence
            FROM analytics_basket_rules
            WHERE shift_bucket = 'morning'
            ORDER BY lift DESC, co_occurrences DESC
            LIMIT 1
        """)
        top_morning_rule = cur.fetchone()

    # Build shift comparison structure
    daily_by_shift: dict[str, list[tuple]] = defaultdict(list)
    day_totals: dict[str, dict[str, tuple[int, int, int, float, float, bool]]] = defaultdict(dict)
    for day_dt, sk, receipts, rev_c, entries, lanes, dwell, rain in daily_shift_rows:
        d_str = str(day_dt)
        daily_by_shift[sk].append((d_str, receipts, rev_c, entries, lanes, dwell, rain))
        day_totals[d_str][sk] = (receipts, rev_c, entries, lanes, dwell, rain)

    total_60d_rev = max(1, sum(int(r[3]) for r in shift_agg_rows))
    shift_map: dict[str, dict] = {}
    conv_arrays: dict[str, np.ndarray] = {}
    rev_hr_arrays: dict[str, np.ndarray] = {}

    for sk, sale_tx, void_ref, gross_c, profit_c, net_c, atv_c, packs, skus, mp_pct, act_hrs, act_days in shift_agg_rows:
        d_rows = daily_by_shift.get(sk, [])
        convs = np.array(
            [min(100.0, (rcpt / ent) * 100.0) for _, rcpt, _, ent, _, _, _ in d_rows if ent > 0],
            dtype=float,
        )
        conv_mean, conv_lo, conv_hi = bootstrap_ci(convs)
        hrs_per_day = float(act_hrs) if act_hrs > 0 else SHIFT_HOURS[sk]
        rev_hrs = np.array(
            [(rev_c / 100.0) / hrs_per_day for _, _, rev_c, _, _, _, _ in d_rows],
            dtype=float,
        )
        rev_hr_mean, _, _ = bootstrap_ci(rev_hrs)

        total_entries = sum(ent for _, _, _, ent, _, _, _ in d_rows)
        avg_lanes = float(np.mean([ln for _, _, _, _, ln, _, _ in d_rows])) if d_rows else 1.0
        avg_dwell = float(np.mean([dw for _, _, _, _, _, dw, _ in d_rows])) if d_rows else 300.0
        total_tx = max(1, int(sale_tx) + int(void_ref))

        conv_arrays[sk] = convs
        rev_hr_arrays[sk] = rev_hrs

        shift_map[sk] = {
            "shiftKey": sk,
            "label": SHIFT_LABELS[sk],
            "saleReceipts": int(sale_tx),
            "voidRefundCount": int(void_ref),
            "voidRefundRatePct": round(float(void_ref) / total_tx * 100.0, 2),
            "grossSalesCents": int(gross_c),
            "netSalesCents": int(net_c),
            "grossProfitCents": int(profit_c),
            "grossMarginPct": round(float(profit_c) / max(1, int(net_c)) * 100.0, 2),
            "revenueSharePct": round(float(gross_c) / total_60d_rev * 100.0, 1),
            "revenuePerOpenHourUsd": round(rev_hr_mean, 2),
            "atvCents": int(round(atv_c)),
            "avgPacks": round(float(packs), 2),
            "avgSkus": round(float(skus), 2),
            "multipackLinePct": round(float(mp_pct), 2),
            "walkInEntries": int(total_entries),
            "conversionPct": round(conv_mean, 1),
            "conversionCiLow": round(conv_lo, 1),
            "conversionCiHigh": round(conv_hi, 1),
            "avgOpenLanes": round(avg_lanes, 2),
            "avgDwellSec": int(round(avg_dwell)),
            "activeHoursObserved": int(act_hrs),
        }

    ordered_shifts = [shift_map[k] for k in ("morning", "afternoon", "evening") if k in shift_map]
    p_conv_morn_vs_aft = welch_ttest_pvalue(
        conv_arrays.get("morning", np.array([])),
        conv_arrays.get("afternoon", np.array([])),
    )
    p_rev_morn_vs_aft = welch_ttest_pvalue(
        rev_hr_arrays.get("morning", np.array([])),
        rev_hr_arrays.get("afternoon", np.array([])),
    )

    # Hourly profile + inactive hour hygiene detection
    hourly_profile = []
    inactive_hours = []
    for hr, rcpt, rev_c, ent, lanes, dwell in hourly_rows:
        if int(rcpt) == 0 and int(ent) == 0:
            inactive_hours.append(int(hr))
        conv = round(min(100.0, (int(rcpt) / int(ent)) * 100.0), 1) if int(ent) > 0 else 0.0
        hourly_profile.append(
            {
                "hour": int(hr),
                "shiftKey": "morning" if hr < 12 else ("afternoon" if hr < 17 else "evening"),
                "walkIns": int(ent),
                "receipts": int(rcpt),
                "conversionPct": conv,
                "revenueCents": int(rev_c),
                "avgOpenLanes": round(float(lanes), 2),
                "avgDwellSec": int(round(dwell)),
            }
        )

    # Morning OOS root causes
    oos_items = []
    total_lost_rev_cents = 0
    for pid, sku, name, dept, seg, price_c, sup_id, sup_name, oos_d, snap_d, restock_hr, exp_u in oos_rows:
        eff_rate = max(0.8, round(float(exp_u), 2))
        est_lost = int(round(int(oos_d) * eff_rate * int(price_c)))
        total_lost_rev_cents += est_lost
        oos_items.append(
            {
                "productId": pid,
                "sku": sku,
                "name": name,
                "departmentName": dept,
                "abcSegment": seg,
                "oosDays": int(oos_d),
                "snapshotDays": int(snap_d),
                "avgRestockHour": round(float(restock_hr), 1),
                "expectedMorningUnitsPerDay": eff_rate,
                "estLostRevenueCents": est_lost,
                "suggestedPreOpenPickUnits": int(math.ceil(eff_rate * 2.0)),
                "supplierId": sup_id,
                "supplierName": sup_name,
            }
        )

    # Queue saturation curve
    bins = [
        ("1-3 / lane", 1.0, 3.99),
        ("4-6 / lane", 4.0, 6.99),
        ("7-9 / lane", 7.0, 9.99),
        ("10+ / lane", 10.0, 999.0),
    ]
    queue_curve = []
    for label, lo, hi in bins:
        sub = [
            (min(100.0, (rcpt / ent) * 100.0), dwell, ent, ln)
            for ent, ln, dwell, rcpt in queue_rows
            if lo <= (ent / max(1, ln)) <= hi
        ]
        if sub:
            queue_curve.append(
                {
                    "loadBin": label,
                    "buckets": len(sub),
                    "conversionPct": round(float(np.mean([s[0] for s in sub])), 1),
                    "avgDwellSec": int(round(float(np.mean([s[1] for s in sub])))),
                    "avgEntries": round(float(np.mean([s[2] for s in sub])), 1),
                }
            )
    baseline_q_conv = queue_curve[0]["conversionPct"] if queue_curve else 75.0
    knee_bin = next(
        (b["loadBin"] for b in queue_curve if baseline_q_conv - b["conversionPct"] >= 6.0),
        queue_curve[-1]["loadBin"] if len(queue_curve) > 1 else "None detected",
    )

    # K-Means shopper mission clustering
    missions_out = {"silhouetteScore": 0.0, "k": 0, "clusters": []}
    if len(mission_rows) >= 30:
        X_m = np.array(
            [[hr, sku_c, mp_r, atv, m_sh, e_sh] for _, hr, sku_c, mp_r, atv, m_sh, e_sh in mission_rows],
            dtype=float,
        )
        m_labels, centroids, sil_score, best_k = kmeans_missions(X_m, k_candidates=(3, 4))
        clusters = []
        for c_id in range(best_k):
            mask = m_labels == c_id
            sub = X_m[mask]
            if len(sub) == 0:
                continue
            avg_hr = float(sub[:, 0].mean())
            avg_skus = float(sub[:, 1].mean())
            mp_pct = float(sub[:, 2].mean()) * 100.0
            avg_atv = float(sub[:, 3].mean())
            morn_share = float((sub[:, 0] < 12).mean()) * 100.0
            aft_share = float(((sub[:, 0] >= 12) & (sub[:, 0] < 17)).mean()) * 100.0
            eve_share = float((sub[:, 0] >= 17).mean()) * 100.0

            if avg_hr < 12.2 and avg_skus <= 3.6:
                cname = "Morning Commuter Grab & Go"
            elif mp_pct >= 28.0 or avg_atv >= 18.5:
                cname = "Multi-Pack Stock-Up Run"
            elif avg_hr >= 16.5 and float(sub[:, 5].mean()) >= 0.25:
                cname = "Evening Social & Snack Run"
            else:
                cname = "Midday Quick Top-Up"

            clusters.append(
                {
                    "clusterId": int(c_id),
                    "name": cname,
                    "receipts": int(len(sub)),
                    "sharePct": round(float(len(sub)) / len(X_m) * 100.0, 1),
                    "avgHour": round(avg_hr, 1),
                    "avgSkus": round(avg_skus, 2),
                    "avgAtvUsd": round(avg_atv, 2),
                    "multipackPct": round(mp_pct, 1),
                    "morningSharePct": round(morn_share, 1),
                    "afternoonSharePct": round(aft_share, 1),
                    "eveningSharePct": round(eve_share, 1),
                }
            )
        clusters.sort(key=lambda c: c["receipts"], reverse=True)
        missions_out = {"silhouetteScore": sil_score, "k": best_k, "clusters": clusters}

    # Chronological Ridge Regression Driver Attribution for Daily Morning Revenue
    sorted_days = sorted(day_totals.keys())
    X_ridge_rows = []
    y_ridge_rows = []
    for idx_d, d_str in enumerate(sorted_days):
        morn = day_totals[d_str].get("morning")
        if not morn:
            continue
        prev_eve = day_totals[sorted_days[idx_d - 1]].get("evening") if idx_d > 0 else None
        prev_eve_rev = (prev_eve[1] / 100.0) if prev_eve else 1200.0
        _, rev_c, entries, lanes, _, rain = morn
        avail_8 = avail_map.get(d_str, 85.0)
        # Parse day of week from YYYY-MM-DD
        yr, mo, dy = [int(x) for x in d_str.split("-")]
        # Tomohiko Sakamoto weekday (0=Sun..6=Sat)
        t_sak = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4]
        y_w = yr - (1 if mo < 3 else 0)
        dow = (y_w + y_w // 4 - y_w // 100 + y_w // 400 + t_sak[mo - 1] + dy) % 7
        is_wknd = 1.0 if dow in (0, 5, 6) else 0.0

        X_ridge_rows.append(
            [
                float(entries),
                float(avail_8),
                float(lanes),
                float(prev_eve_rev),
                1.0 if rain else 0.0,
                is_wknd,
            ]
        )
        y_ridge_rows.append(float(rev_c) / 100.0)

    driver_attr = chronological_ridge_attribution(
        np.array(X_ridge_rows, dtype=float) if X_ridge_rows else np.zeros((0, 6)),
        np.array(y_ridge_rows, dtype=float),
        feature_names=[
            "walk_ins",
            "avail_8am_pct",
            "open_lanes",
            "prior_eve_rev_usd",
            "rain_flag",
            "is_weekend",
        ],
        feature_labels=[
            "Morning Walk-In Traffic",
            "08:00 AM Top-SKU Availability %",
            "Open Checkout Lanes (08–11)",
            "Prior-Evening Rush Carryover",
            "Rainy Weather Flag",
            "Fri–Sun Weekend Day",
        ],
        holdout_days=14,
    )

    morn_stats = shift_map.get("morning", {})
    aft_stats = shift_map.get("afternoon", {})
    morn_conv = float(morn_stats.get("conversionPct", 0.0))
    aft_conv = float(aft_stats.get("conversionPct", 0.0))
    conv_gap = aft_conv - morn_conv
    if conv_gap >= 7.0 and total_lost_rev_cents > 0:
        bottleneck = "Dual Deficit: Morning 08:00 Stockouts & Single-Lane Conversion Loss + Low Early Traffic"
    elif conv_gap >= 7.0:
        bottleneck = "In-Store Execution Deficit (Low Morning Conversion vs Afternoon)"
    else:
        bottleneck = "Early-Morning Traffic Deficit (08:00–10:59 Commuter Attraction)"

    top_rule_label = (
        f"{top_morning_rule[0]} + {top_morning_rule[1]} ({top_morning_rule[2]}x lift)"
        if top_morning_rule
        else "RTD Coffee + Biscuits (Morning Pair)"
    )

    recommendations = [
        {
            "priority": "P1",
            "title": "Shift Top-24 Class-A Restocking to 07:45 Pre-Open",
            "evidence": f"{len(oos_items)} high-velocity SKUs stocked out at 08:00 AM across 60d (~${total_lost_rev_cents / 100:,.2f} est. lost morning sales; avg restock waits until 11:00 AM).",
            "actionType": "create_po",
            "impactEstimate": f"+${round(total_lost_rev_cents / 100.0 * 0.7):,}/60d recovered",
        },
        {
            "priority": "P2",
            "title": "Open Express Float Lane During 08:15–09:30 Peak",
            "evidence": f"Morning conversion drops to {queue_curve[-1]['conversionPct'] if queue_curve else 58}% at {knee_bin} load with short {morn_stats.get('avgDwellSec', 200)}s dwell.",
            "actionType": "staffing_float",
            "impactEstimate": "+6–9 pts morning conversion",
        },
        {
            "priority": "P3",
            "title": "Activate 08:00–11:59 Commuter Combo Daypart Promo",
            "evidence": f"Early morning (08–10) traffic is {morn_stats.get('revenueSharePct', 22)}% of store sales; morning basket rule highlights {top_rule_label}.",
            "actionType": "create_promo",
            "impactEstimate": "+12–18% morning traffic & UPT",
        },
        {
            "priority": "P4",
            "title": "Re-Merchandise Entrance Zone for Grab-and-Go Missions",
            "evidence": f"K-Means (Silhouette {missions_out['silhouetteScore']}) isolates quick morning runs averaging {morn_stats.get('avgSkus', 3.2)} SKUs and {morn_stats.get('multipackLinePct', 18)}% multipack share.",
            "actionType": "merchandising",
            "impactEstimate": "+0.4 units/basket in morning",
        },
    ]

    comparison_payload = {
        "shifts": ordered_shifts,
        "morningVsAfternoonConversionPValue": p_conv_morn_vs_aft,
        "morningVsAfternoonRevPerHrPValue": p_rev_morn_vs_aft,
        "dataHygiene": {
            "excludedPartialCurrentDate": True,
            "inactiveZeroReceiptHours": inactive_hours,
        },
    }

    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO analytics_shift_diagnostics (
                id, window_days, primary_bottleneck, morning_share_pct,
                morning_conversion_pct, afternoon_conversion_pct, evening_conversion_pct,
                morning_est_lost_revenue_cents,
                shift_comparison_json, hourly_profile_json, oos_root_causes_json,
                queue_saturation_json, driver_attribution_json, shopper_missions_json,
                recommendations_json, computed_at
            ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now())
            ON CONFLICT (id) DO UPDATE SET
                window_days = EXCLUDED.window_days,
                primary_bottleneck = EXCLUDED.primary_bottleneck,
                morning_share_pct = EXCLUDED.morning_share_pct,
                morning_conversion_pct = EXCLUDED.morning_conversion_pct,
                afternoon_conversion_pct = EXCLUDED.afternoon_conversion_pct,
                evening_conversion_pct = EXCLUDED.evening_conversion_pct,
                morning_est_lost_revenue_cents = EXCLUDED.morning_est_lost_revenue_cents,
                shift_comparison_json = EXCLUDED.shift_comparison_json,
                hourly_profile_json = EXCLUDED.hourly_profile_json,
                oos_root_causes_json = EXCLUDED.oos_root_causes_json,
                queue_saturation_json = EXCLUDED.queue_saturation_json,
                driver_attribution_json = EXCLUDED.driver_attribution_json,
                shopper_missions_json = EXCLUDED.shopper_missions_json,
                recommendations_json = EXCLUDED.recommendations_json,
                computed_at = now()
            """,
            (
                "latest_60d",
                60,
                bottleneck,
                float(morn_stats.get("revenueSharePct", 0.0)),
                morn_conv,
                aft_conv,
                float(shift_map.get("evening", {}).get("conversionPct", 0.0)),
                int(total_lost_rev_cents),
                json.dumps(comparison_payload),
                json.dumps(hourly_profile),
                json.dumps(oos_items),
                json.dumps({"thresholdBin": knee_bin, "bins": queue_curve}),
                json.dumps(driver_attr),
                json.dumps(missions_out),
                json.dumps(recommendations),
            ),
        )

        # Evaluate all saved shift DiD experiments
        cur.execute("""
            SELECT id::text, target_shift, control_shift, pre_start_date, pre_end_date, post_start_date, post_end_date
            FROM shift_experiments
        """)
        exp_rows = cur.fetchall()
        for exp_id, t_shift, c_shift, pre_s, pre_e, post_s, post_e in exp_rows:
            pre_t_arr = np.array(
                [r[2] / 100.0 for r in daily_by_shift.get(t_shift, []) if str(pre_s) <= r[0] <= str(pre_e)],
                dtype=float,
            )
            post_t_arr = np.array(
                [r[2] / 100.0 for r in daily_by_shift.get(t_shift, []) if str(post_s) <= r[0] <= str(post_e)],
                dtype=float,
            )
            pre_c_arr = np.array(
                [r[2] / 100.0 for r in daily_by_shift.get(c_shift, []) if str(pre_s) <= r[0] <= str(pre_e)],
                dtype=float,
            )
            post_c_arr = np.array(
                [r[2] / 100.0 for r in daily_by_shift.get(c_shift, []) if str(post_s) <= r[0] <= str(post_e)],
                dtype=float,
            )
            did_res = compute_did_evaluation(pre_t_arr, post_t_arr, pre_c_arr, post_c_arr)
            cur.execute(
                "UPDATE shift_experiments SET results_json = %s WHERE id = %s::uuid",
                (json.dumps(did_res), exp_id),
            )
    conn.commit()
    print(
        f"[Shift Diagnostics] Computed 60d shift funnel, {len(oos_items)} OOS SKUs, Silhouette={missions_out['silhouetteScore']} in {time.perf_counter() - t0:.2f}s"
    )
    return comparison_payload


def run_loss_prevention_anomalies(conn: psycopg.Connection) -> int:
    t0 = time.perf_counter()
    with conn.cursor() as cur:
        cur.execute("""
            SELECT
                cashier_name,
                COUNT(*)::int AS total_tx,
                COUNT(*) FILTER (WHERE kind = 'void')::int AS voids,
                COUNT(*) FILTER (WHERE kind = 'refund')::int AS refunds
            FROM sales
            WHERE sold_at >= now() - interval '60 days'
            GROUP BY cashier_name
        """)
        sales_by_cashier = cur.fetchall()

        cur.execute("""
            SELECT actor, COUNT(*)::int AS no_sales
            FROM audit_logs
            WHERE action = 'no_sale_drawer' AND created_at >= now() - interval '60 days'
            GROUP BY actor
        """)
        no_sale_map = {r[0]: int(r[1]) for r in cur.fetchall()}

    if not sales_by_cashier:
        return 0

    raw_rows = [
        (cashier, int(total), int(voids), int(refunds), no_sale_map.get(cashier, 0))
        for cashier, total, voids, refunds in sales_by_cashier
    ]
    scored = score_cashiers_robust(raw_rows)
    records = [
        (str(uuid.uuid4()), cashier, total, voids, refunds, no_sales, v_rate, robust_z, risk)
        for cashier, total, voids, refunds, no_sales, v_rate, robust_z, risk in scored
    ]

    with conn.cursor() as cur:
        cur.execute("DELETE FROM analytics_lp_anomalies;")
        cur.executemany(
            """
            INSERT INTO analytics_lp_anomalies (
                id, cashier_name, total_sales_count, void_count, refund_count,
                no_sale_drawer_count, void_rate_pct, z_score, risk_level
            ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
            """,
            records,
        )
    conn.commit()
    print(
        f"[Loss Prevention] Scored {len(records)} cashiers in {time.perf_counter() - t0:.2f}s"
    )
    return len(records)


# ============================================================================
# MILESTONE 1-3: SUPPLIER OTIF, PHANTOM STOCK, MARKDOWNS, RFM & STAFFING
# ============================================================================


def compute_supplier_otif_metrics(deliveries: list[dict], expected_lead_days: int) -> dict:
    """Compute empirical OTIF, cost variance rate, lead-time mean/std, and A-D grade."""
    n = len(deliveries)
    fallback_std = round(max(0.4, float(expected_lead_days) * 0.25), 2)
    if n == 0:
        return {
            "on_time_rate_pct": 100.0,
            "in_full_rate_pct": 100.0,
            "otif_rate_pct": 100.0,
            "cost_variance_rate_pct": 0.0,
            "avg_lead_time_days": float(expected_lead_days),
            "lead_time_std_days": fallback_std,
            "grade": "B",
        }

    on_time_cnt = 0
    in_full_cnt = 0
    otif_cnt = 0
    cost_var_cnt = 0
    lead_samples: list[float] = []

    for d in deliveries:
        lead = max(0.1, float(d.get("lead_days", expected_lead_days)))
        lead_samples.append(lead)
        ordered = max(0, int(d.get("ordered_units", 0)))
        received = max(0, int(d.get("received_units", 0)))
        po_cost = max(0, int(d.get("po_cost_cents", 0)))
        inv_cost = max(0, int(d.get("invoice_cost_cents", 0)))

        is_on_time = lead <= float(expected_lead_days) + 0.5
        is_in_full = received >= ordered if ordered > 0 else True
        if is_on_time:
            on_time_cnt += 1
        if is_in_full:
            in_full_cnt += 1
        if is_on_time and is_in_full:
            otif_cnt += 1
        if po_cost > 0 and abs(inv_cost - po_cost) > max(10, int(0.01 * po_cost)):
            cost_var_cnt += 1

    on_time_pct = round(100.0 * on_time_cnt / n, 1)
    in_full_pct = round(100.0 * in_full_cnt / n, 1)
    otif_pct = round(100.0 * otif_cnt / n, 1)
    cost_var_pct = round(100.0 * cost_var_cnt / n, 1)
    avg_lead = round(float(np.mean(lead_samples)), 2)
    std_lead = (
        round(max(0.25, float(np.std(lead_samples, ddof=1))), 2)
        if n >= 2
        else fallback_std
    )

    if otif_pct >= 92.0 and cost_var_pct <= 5.0:
        grade = "A"
    elif otif_pct >= 75.0 and cost_var_pct <= 20.0:
        grade = "B"
    elif otif_pct >= 55.0:
        grade = "C"
    else:
        grade = "D"

    return {
        "on_time_rate_pct": on_time_pct,
        "in_full_rate_pct": in_full_pct,
        "otif_rate_pct": otif_pct,
        "cost_variance_rate_pct": cost_var_pct,
        "avg_lead_time_days": avg_lead,
        "lead_time_std_days": std_lead,
        "grade": grade,
    }


def compute_phantom_prob(
    book_stock: int,
    avg_daily_units: float,
    days_since_last_sale: float,
    void_refund_ratio: float = 0.0,
) -> float:
    """
    Posterior anomaly score in [0.0, 0.99] estimating likelihood that positive
    book stock is phantom/shrunk rather than physically on the shelf.
    """
    if book_stock <= 0 or avg_daily_units <= 0.10:
        return 0.0
    quiet_days = max(0.0, days_since_last_sale - 1.5)
    p_zero_sales = 1.0 - math.exp(-avg_daily_units * quiet_days)
    stock_pressure = min(1.0, float(book_stock) / max(1.0, avg_daily_units * 14.0))
    void_signal = min(0.25, max(0.0, void_refund_ratio) * 2.0)
    raw = p_zero_sales * (0.72 + 0.28 * stock_pressure) + void_signal
    return round(min(0.99, max(0.0, raw)), 4)


def solve_optimal_markdown(
    qty_remaining: int,
    days_left: int,
    avg_daily_units: float,
    sell_price_cents: int,
    unit_cost_cents: int,
    elasticity: float = 1.8,
) -> dict:
    """
    Search discrete clearance discount tiers (10%..50%) using constant-elasticity demand
    lift to maximize cash recovery before batch expiry.
    """
    days_window = max(1, int(days_left))
    base_vel = max(0.05, float(avg_daily_units))
    base_sold = min(qty_remaining, int(round(base_vel * days_window)))
    baseline_rev = int(base_sold * sell_price_cents)

    best: dict | None = None
    for d_bp in (1000, 1500, 2000, 2500, 3000, 4000, 5000):
        frac = d_bp / 10000.0
        promo_price = max(1, int(round(sell_price_cents * (1.0 - frac))))
        # Respect deep cost floor when > 2 days remain
        if days_window > 2 and promo_price < int(round(unit_cost_cents * 0.65)):
            continue
        lift = min(7.0, (1.0 / max(0.40, 1.0 - frac)) ** elasticity)
        pred_units = min(qty_remaining, int(round(base_vel * days_window * lift)))
        expected_rev = int(pred_units * promo_price)
        # Small preference for actually moving higher fraction of expiring stock
        utility = expected_rev + (pred_units * max(1, int(unit_cost_cents * 0.08)))
        if best is None or utility > best["_utility"]:
            best = {
                "recommended_discount_bp": d_bp,
                "recommended_promo_price_cents": promo_price,
                "predicted_clearance_units": pred_units,
                "expected_recovery_cents": expected_rev,
                "baseline_no_promo_recovery_cents": baseline_rev,
                "_utility": utility,
            }

    if best is None:
        promo_price = max(1, int(round(sell_price_cents * 0.8)))
        pred_units = base_sold
        return {
            "recommended_discount_bp": 2000,
            "recommended_promo_price_cents": promo_price,
            "predicted_clearance_units": pred_units,
            "expected_recovery_cents": int(pred_units * promo_price),
            "baseline_no_promo_recovery_cents": baseline_rev,
        }
    best.pop("_utility", None)
    return best


def score_rfm_segment(recency_days: float, frequency_60d: int, monetary_cents: int) -> str:
    if recency_days <= 10.0 and frequency_60d >= 4 and monetary_cents >= 10000:
        return "Champions"
    if recency_days <= 18.0 and frequency_60d >= 3:
        return "Loyal"
    if 14.0 <= recency_days <= 32.0 and (frequency_60d >= 1 or monetary_cents >= 4000):
        return "At-Risk"
    if recency_days > 32.0:
        return "Hibernating"
    return "New"


def recommend_hourly_lanes(
    predicted_entries: float,
    conversion_rate: float = 0.72,
    service_rate_per_lane_hr: float = 22.0,
    min_lanes: int = 1,
    max_lanes: int = 8,
) -> int:
    """Compute queue-safe checkout lanes targeting <=78% utilization."""
    predicted_tx = max(0.0, float(predicted_entries)) * conversion_rate
    cap_per_lane = max(5.0, service_rate_per_lane_hr * 0.78)
    lanes = int(math.ceil(predicted_tx / cap_per_lane))
    return max(min_lanes, min(max_lanes, lanes))


def run_supplier_scorecards(conn: psycopg.Connection) -> dict[str, float]:
    t0 = time.perf_counter()
    with conn.cursor() as cur:
        cur.execute("SELECT id::text, default_lead_time_days FROM suppliers")
        sup_rows = cur.fetchall()

        cur.execute("""
            SELECT
                gr.supplier_id::text,
                GREATEST(0.2, EXTRACT(EPOCH FROM (gr.received_at - COALESCE(po.created_at, gr.received_at - interval '3 days'))) / 86400.0)::float AS lead_days,
                COALESCE(po.total_cases, 0)::int AS ordered_cases,
                COALESCE(gl_agg.paid_cases, 0)::int AS received_cases,
                COALESCE(po.estimated_cost_cents, 0)::bigint AS po_cost_cents,
                gr.total_invoice_cents::bigint AS inv_cost_cents
            FROM goods_receipts gr
            LEFT JOIN purchase_orders po ON po.id = gr.po_id
            LEFT JOIN (
                SELECT grn_id, SUM(paid_cases)::int AS paid_cases
                FROM grn_lines
                GROUP BY grn_id
            ) gl_agg ON gl_agg.grn_id = gr.id
            WHERE gr.received_at >= now() - interval '90 days'
        """)
        grn_rows = cur.fetchall()

        cur.execute("""
            SELECT supplier_id::text, COALESCE(SUM(financial_impact_cents), 0)::bigint
            FROM grn_variances
            WHERE created_at >= now() - interval '90 days'
            GROUP BY supplier_id
        """)
        var_map = {str(r[0]): int(r[1]) for r in cur.fetchall()}

        cur.execute("""
            SELECT supplier_id::text, COUNT(*)::int
            FROM purchase_orders
            WHERE created_at >= now() - interval '90 days'
            GROUP BY supplier_id
        """)
        po_cnt_map = {str(r[0]): int(r[1]) for r in cur.fetchall()}

    by_sup: dict[str, list[dict]] = defaultdict(list)
    for sup_id, lead_days, ord_cases, rec_cases, po_cost, inv_cost in grn_rows:
        by_sup[str(sup_id)].append({
            "lead_days": float(lead_days),
            "ordered_units": int(ord_cases),
            "received_units": int(rec_cases),
            "po_cost_cents": int(po_cost),
            "invoice_cost_cents": int(inv_cost),
        })

    records = []
    std_map: dict[str, float] = {}
    for sup_id, default_lead in sup_rows:
        deliveries = by_sup.get(str(sup_id), [])
        m = compute_supplier_otif_metrics(deliveries, int(default_lead))
        std_map[str(sup_id)] = m["lead_time_std_days"]
        records.append((
            str(sup_id),
            po_cnt_map.get(str(sup_id), len(deliveries)),
            len(deliveries),
            m["on_time_rate_pct"],
            m["in_full_rate_pct"],
            m["otif_rate_pct"],
            m["cost_variance_rate_pct"],
            m["avg_lead_time_days"],
            m["lead_time_std_days"],
            var_map.get(str(sup_id), 0),
            m["grade"],
        ))

    if records:
        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO analytics_supplier_scorecards (
                    supplier_id, po_count_90d, grn_count_90d, on_time_rate_pct,
                    in_full_rate_pct, otif_rate_pct, cost_variance_rate_pct,
                    avg_lead_time_days, lead_time_std_days, total_variance_cents, grade, computed_at
                ) VALUES (%s::uuid,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s, now())
                ON CONFLICT (supplier_id) DO UPDATE SET
                    po_count_90d = EXCLUDED.po_count_90d,
                    grn_count_90d = EXCLUDED.grn_count_90d,
                    on_time_rate_pct = EXCLUDED.on_time_rate_pct,
                    in_full_rate_pct = EXCLUDED.in_full_rate_pct,
                    otif_rate_pct = EXCLUDED.otif_rate_pct,
                    cost_variance_rate_pct = EXCLUDED.cost_variance_rate_pct,
                    avg_lead_time_days = EXCLUDED.avg_lead_time_days,
                    lead_time_std_days = EXCLUDED.lead_time_std_days,
                    total_variance_cents = EXCLUDED.total_variance_cents,
                    grade = EXCLUDED.grade,
                    computed_at = now()
                """,
                records,
            )
        conn.commit()
    log_event("supplier_scorecards", suppliers=len(records), elapsed_s=round(time.perf_counter() - t0, 2))
    return std_map


def run_phantom_and_markdowns(conn: psycopg.Connection) -> tuple[int, int]:
    t0 = time.perf_counter()
    with conn.cursor() as cur:
        cur.execute("""
            WITH unfolded AS (
                SELECT product_id, COALESCE(SUM(qty_delta), 0)::int AS delta
                FROM stock_movements
                WHERE folded = false
                GROUP BY product_id
            ),
            last_sale AS (
                SELECT sl.product_id, MAX(s.sold_at) AS max_sold_at
                FROM sale_lines sl
                JOIN sales s ON s.id = sl.sale_id AND s.kind = 'sale'
                GROUP BY sl.product_id
            ),
            vr AS (
                SELECT
                    sl.product_id,
                    COUNT(*) FILTER (WHERE s.kind <> 'sale')::float / GREATEST(1, COUNT(*))::float AS vr_ratio
                FROM sale_lines sl
                JOIN sales s ON s.id = sl.sale_id
                WHERE s.sold_at >= now() - interval '60 days'
                GROUP BY sl.product_id
            )
            SELECT
                p.id::text,
                COALESCE(sb.quantity, 0) + COALESCE(u.delta, 0) AS on_hand,
                COALESCE(abc.avg_daily_units, 0)::float AS avg_daily_units,
                COALESCE(EXTRACT(EPOCH FROM (now() - ls.max_sold_at)) / 86400.0, 25.0)::float AS days_since,
                COALESCE(vr.vr_ratio, 0.0)::float AS vr_ratio,
                p.avg_cost_cents::bigint
            FROM products p
            LEFT JOIN stock_baselines sb ON sb.product_id = p.id
            LEFT JOIN unfolded u ON u.product_id = p.id
            LEFT JOIN analytics_abc_xyz abc ON abc.product_id = p.id
            LEFT JOIN last_sale ls ON ls.product_id = p.id
            LEFT JOIN vr ON vr.product_id = p.id
            WHERE p.active = true
              AND (COALESCE(sb.quantity, 0) + COALESCE(u.delta, 0)) >= 3
              AND COALESCE(abc.avg_daily_units, 0) >= 0.25
        """)
        cand_rows = cur.fetchall()

    phantom_scored = []
    for pid, on_hand, avg_d, days_since, vr_ratio, avg_cost in cand_rows:
        prob = compute_phantom_prob(int(on_hand), float(avg_d), float(days_since), float(vr_ratio))
        if prob >= 0.25:
            risk_val = int(int(on_hand) * int(avg_cost) * prob)
            phantom_scored.append((
                pid,
                int(on_hand),
                round(float(avg_d), 3),
                round(float(days_since), 1),
                round(float(vr_ratio), 4),
                prob,
                risk_val,
            ))
    phantom_scored.sort(key=lambda r: (r[5], r[6]), reverse=True)
    phantom_scored = phantom_scored[:80]

    with conn.cursor() as cur:
        cur.execute("DELETE FROM analytics_phantom_stock WHERE status = 'open';")
        if phantom_scored:
            cur.executemany(
                """
                INSERT INTO analytics_phantom_stock (
                    product_id, book_stock_units, avg_daily_units, days_since_last_sale,
                    void_refund_score, phantom_prob, estimated_value_at_risk_cents, status, computed_at
                ) VALUES (%s::uuid,%s,%s,%s,%s,%s,%s,'open', now())
                ON CONFLICT (product_id) DO UPDATE SET
                    book_stock_units = EXCLUDED.book_stock_units,
                    avg_daily_units = EXCLUDED.avg_daily_units,
                    days_since_last_sale = EXCLUDED.days_since_last_sale,
                    void_refund_score = EXCLUDED.void_refund_score,
                    phantom_prob = EXCLUDED.phantom_prob,
                    estimated_value_at_risk_cents = EXCLUDED.estimated_value_at_risk_cents,
                    computed_at = now()
                """,
                phantom_scored,
            )

        # Near-expiry active/clearance batches within next 21 days
        cur.execute("""
            SELECT
                ib.id::text,
                ib.product_id::text,
                GREATEST(1, (ib.best_before_date - CURRENT_DATE)::int) AS days_left,
                ib.qty_remaining,
                pb.sell_price_cents::bigint,
                ib.unit_cost_cents::bigint,
                COALESCE(abc.avg_daily_units, 0.4)::float AS avg_daily_units
            FROM inventory_batches ib
            JOIN product_barcodes pb ON pb.product_id = ib.product_id AND pb.is_primary = true
            LEFT JOIN analytics_abc_xyz abc ON abc.product_id = ib.product_id
            WHERE ib.status IN ('active', 'clearance')
              AND ib.qty_remaining > 0
              AND ib.best_before_date <= CURRENT_DATE + interval '21 days'
            ORDER BY ib.best_before_date ASC
            LIMIT 120
        """)
        exp_rows = cur.fetchall()

        md_records = []
        for batch_id, pid, days_left, qty_rem, sell_cents, unit_cost, avg_d in exp_rows:
            sol = solve_optimal_markdown(
                int(qty_rem), int(days_left), float(avg_d), int(sell_cents), int(unit_cost)
            )
            md_records.append((
                batch_id,
                pid,
                int(days_left),
                int(qty_rem),
                int(sell_cents),
                int(unit_cost),
                sol["recommended_discount_bp"],
                sol["recommended_promo_price_cents"],
                sol["predicted_clearance_units"],
                sol["expected_recovery_cents"],
                sol["baseline_no_promo_recovery_cents"],
            ))

        cur.execute("DELETE FROM analytics_dynamic_markdowns WHERE status = 'recommended';")
        if md_records:
            cur.executemany(
                """
                INSERT INTO analytics_dynamic_markdowns (
                    batch_id, product_id, days_left, qty_remaining,
                    current_sell_price_cents, unit_cost_cents,
                    recommended_discount_bp, recommended_promo_price_cents,
                    predicted_clearance_units, expected_recovery_cents,
                    baseline_no_promo_recovery_cents, status, computed_at
                ) VALUES (%s::uuid,%s::uuid,%s,%s,%s,%s,%s,%s,%s,%s,%s,'recommended', now())
                ON CONFLICT (batch_id) DO UPDATE SET
                    days_left = EXCLUDED.days_left,
                    qty_remaining = EXCLUDED.qty_remaining,
                    current_sell_price_cents = EXCLUDED.current_sell_price_cents,
                    recommended_discount_bp = EXCLUDED.recommended_discount_bp,
                    recommended_promo_price_cents = EXCLUDED.recommended_promo_price_cents,
                    predicted_clearance_units = EXCLUDED.predicted_clearance_units,
                    expected_recovery_cents = EXCLUDED.expected_recovery_cents,
                    baseline_no_promo_recovery_cents = EXCLUDED.baseline_no_promo_recovery_cents,
                    computed_at = now()
                """,
                md_records,
            )
    conn.commit()
    log_event(
        "phantom_and_markdowns",
        phantom_flagged=len(phantom_scored),
        markdowns_computed=len(md_records),
        elapsed_s=round(time.perf_counter() - t0, 2),
    )
    return len(phantom_scored), len(md_records)


def run_loyalty_staffing_and_tasks(conn: psycopg.Connection) -> tuple[int, int, int]:
    t0 = time.perf_counter()
    with conn.cursor() as cur:
        # 1. Customer RFM Segmentation
        cur.execute("""
            SELECT
                c.id::text,
                COALESCE(EXTRACT(EPOCH FROM (now() - MAX(s.sold_at))) / 86400.0, 90.0)::float AS recency_days,
                COUNT(s.id) FILTER (WHERE s.sold_at >= now() - interval '60 days')::int AS freq_60d,
                COALESCE(SUM(s.total_cents), c.lifetime_spend_cents)::bigint AS monetary_cents,
                MAX(s.sold_at) AS latest_visit
            FROM customers c
            LEFT JOIN sales s ON s.customer_id = c.id AND s.kind = 'sale'
            GROUP BY c.id, c.lifetime_spend_cents
        """)
        cust_rows = cur.fetchall()
        rfm_updates = []
        for cid, rec_days, freq, mon_cents, latest_visit in cust_rows:
            seg = score_rfm_segment(float(rec_days), int(freq), int(mon_cents))
            rfm_updates.append((seg, int(freq), int(mon_cents), latest_visit, cid))

        if rfm_updates:
            cur.executemany(
                """
                UPDATE customers
                SET rfm_segment = %s,
                    visits_60d = %s,
                    lifetime_spend_cents = %s,
                    last_visit_at = COALESCE(%s, last_visit_at)
                WHERE id = %s::uuid
                """,
                rfm_updates,
            )

        # 2. Hourly Staffing Planner (Today + Tomorrow based on trailing footfall by hour)
        cur.execute("""
            SELECT
                EXTRACT(HOUR FROM bucket_start)::int AS hr,
                (SUM(entries) / GREATEST(1, COUNT(DISTINCT DATE(bucket_start))))::float AS avg_entries_hr
            FROM store_footfall
            WHERE bucket_start >= CURRENT_DATE - interval '28 days'
              AND EXTRACT(HOUR FROM bucket_start) BETWEEN 8 AND 21
            GROUP BY EXTRACT(HOUR FROM bucket_start)
            ORDER BY hr
        """)
        hr_footfall = {int(r[0]): float(r[1]) for r in cur.fetchall()}

        cur.execute("SELECT current_setting('TIMEZONE'), CURRENT_DATE::text, (CURRENT_DATE + 1)::text")
        _, today_str, tomorrow_str = cur.fetchone()

        roster_records = []
        for target_date in (today_str, tomorrow_str):
            for hr in range(8, 22):
                pred_entries = round(hr_footfall.get(hr, 28.0 if 10 <= hr <= 20 else 16.0), 1)
                pred_tx = round(pred_entries * 0.72, 1)
                lanes = recommend_hourly_lanes(pred_entries)
                bucket = "morning" if hr < 12 else ("afternoon" if hr < 17 else "evening")
                roster_records.append((target_date, hr, bucket, pred_entries, pred_tx, lanes))

        if roster_records:
            cur.executemany(
                """
                INSERT INTO shift_rosters (
                    plan_date, hour, shift_bucket, predicted_entries, predicted_transactions, recommended_lanes
                ) VALUES (%s::date,%s,%s,%s,%s,%s)
                ON CONFLICT (plan_date, hour) DO UPDATE SET
                    shift_bucket = EXCLUDED.shift_bucket,
                    predicted_entries = EXCLUDED.predicted_entries,
                    predicted_transactions = EXCLUDED.predicted_transactions,
                    recommended_lanes = EXCLUDED.recommended_lanes
                """,
                roster_records,
            )

        # 3. Today's Store Tasks Checklist (restock, cycle_count, expiry_markdown, shelf_tag)
        cur.execute("SELECT COUNT(*)::int FROM store_tasks WHERE task_date = CURRENT_DATE")
        existing_tasks = int(cur.fetchone()[0])
        tasks_inserted = 0
        if existing_tasks == 0:
            task_rows = []
            cur.execute("""
                SELECT p.id::text, p.name, p.aisle_location, df.safety_stock_units, df.current_stock_units
                FROM analytics_demand_forecasts df
                JOIN products p ON p.id = df.product_id
                WHERE df.urgency IN ('critical', 'reorder_now')
                ORDER BY df.current_stock_units ASC
                LIMIT 6
            """)
            for pid, name, aisle, safety, cur_stock in cur.fetchall():
                qty_needed = max(6, int(safety) - int(cur_stock))
                task_rows.append((
                    today_str, "morning", "restock", 1,
                    f"Pre-open replenish: {name}", aisle, pid, qty_needed
                ))

            cur.execute("""
                SELECT p.id::text, p.name, p.aisle_location, ps.book_stock_units
                FROM analytics_phantom_stock ps
                JOIN products p ON p.id = ps.product_id
                WHERE ps.status = 'open'
                ORDER BY ps.phantom_prob DESC
                LIMIT 4
            """)
            for pid, name, aisle, book in cur.fetchall():
                task_rows.append((
                    today_str, "morning", "cycle_count", 1,
                    f"Blind physical count: {name} (book={book})", aisle, pid, int(book)
                ))

            cur.execute("""
                SELECT p.id::text, p.name, p.aisle_location, dm.qty_remaining, dm.recommended_discount_bp
                FROM analytics_dynamic_markdowns dm
                JOIN products p ON p.id = dm.product_id
                WHERE dm.status = 'recommended'
                ORDER BY dm.days_left ASC
                LIMIT 4
            """)
            for pid, name, aisle, qty_rem, disc_bp in cur.fetchall():
                task_rows.append((
                    today_str, "afternoon", "expiry_markdown", 2,
                    f"Apply {disc_bp // 100}% markdown sticker: {name}", aisle, pid, int(qty_rem)
                ))

            cur.execute("SELECT COUNT(*)::int FROM shelf_tag_queue WHERE status = 'pending'")
            pending_tags = int(cur.fetchone()[0])
            if pending_tags > 0:
                task_rows.append((
                    today_str, "morning", "shelf_tag", 1,
                    f"Walk aisles & hang {pending_tags} queued 07:30 shelf tags", "ALL", None, pending_tags
                ))

            if task_rows:
                cur.executemany(
                    """
                    INSERT INTO store_tasks (
                        task_date, shift_bucket, task_type, priority,
                        title, aisle_location, product_id, target_qty
                    ) VALUES (%s::date,%s,%s,%s,%s,%s,%s::uuid,%s)
                    """,
                    task_rows,
                )
                tasks_inserted = len(task_rows)

    conn.commit()
    log_event(
        "loyalty_staffing_tasks",
        customers_scored=len(rfm_updates),
        roster_slots=len(roster_records),
        tasks_created=tasks_inserted,
        elapsed_s=round(time.perf_counter() - t0, 2),
    )
    return len(rfm_updates), len(roster_records), tasks_inserted


def main() -> None:
    log_event("pipeline_start", database_configured=bool(DATABASE_URL))
    with psycopg.connect(DATABASE_URL) as conn:
        supplier_std_map = run_supplier_scorecards(conn)
        run_abc_xyz_and_forecasts(conn, supplier_std_map)
        run_market_basket(conn)
        run_loss_prevention_anomalies(conn)
        run_shift_diagnostics(conn)
        run_phantom_and_markdowns(conn)
        run_loyalty_staffing_and_tasks(conn)
    log_event("pipeline_complete", status="ok")


if __name__ == "__main__":
    main()
