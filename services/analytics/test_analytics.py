import json
import math
import numpy as np

from run_all import (
    _mine_basket_subset,
    bootstrap_ci,
    chronological_ridge_attribution,
    compute_did_evaluation,
    compute_phantom_prob,
    compute_supplier_otif_metrics,
    croston_holdout_wmape,
    croston_sba_forecast,
    kmeans_missions,
    recommend_abc_xyz_action,
    recommend_hourly_lanes,
    safe_float,
    safe_json_dumps,
    score_cashiers_robust,
    score_rfm_segment,
    solve_optimal_markdown,
    weekend_ets_forecast,
    welch_ttest_pvalue,
)


def test_weekend_ets_has_no_holdout_leakage():
    # Stable 46-day history around 10/day followed by a sharp regime jump to 30/day in the last 14 days.
    # Because seasonal indices and level are trained strictly on series[:-14], holdout WMAPE must reflect the jump (~67%)
    # instead of leaking holdout values into training!
    series = np.array([10.0] * 46 + [30.0] * 14)
    fc, wmape = weekend_ets_forecast(series)
    assert fc > 15.0
    assert wmape > 50.0


def test_croston_sba_and_genuine_holdout_wmape():
    intermittent = np.zeros(60, dtype=float)
    intermittent[[4, 15, 28, 40, 52]] = [3.0, 2.0, 4.0, 3.0, 3.0]
    daily_fc = croston_sba_forecast(intermittent)
    assert 0.1 < daily_fc < 0.6
    wmape = croston_holdout_wmape(intermittent)
    assert wmape != 28.5  # must be computed dynamically, not hardcoded
    assert 0.0 <= wmape <= 200.0


def test_mad_robust_z_detects_single_cashier_outlier_including_no_sales():
    # 4 normal cashiers (~1% void, 0.5% refund, ~1% no-sale) and 1 high-risk outlier
    rows = [
        ("Elena", 2000, 22, 10, 18),
        ("Liam", 2000, 26, 12, 20),
        ("Mei", 2000, 18, 8, 15),
        ("Samira", 2000, 24, 10, 16),
        ("Jordan", 2000, 136, 14, 114),
    ]
    scored = {r[0]: r for r in score_cashiers_robust(rows)}
    assert scored["Jordan"][7] == "high"
    assert scored["Jordan"][6] > 2.5
    assert scored["Elena"][7] == "normal"

    # Also flags an outlier with moderate voids (2.5%) + heavy no-sale drawer opens + refunds
    rows_nosale = [
        ("A", 1000, 10, 5, 10),
        ("B", 1000, 12, 6, 12),
        ("C", 1000, 11, 5, 11),
        ("D", 1000, 10, 4, 10),
        ("Sneaky", 1000, 25, 35, 90),
    ]
    scored_ns = {r[0]: r for r in score_cashiers_robust(rows_nosale)}
    assert scored_ns["Sneaky"][7] == "high"


def test_abc_xyz_action_recommendations():
    assert "zero stockout" in recommend_abc_xyz_action("AX", 12.0).lower()
    assert "capital trap" in recommend_abc_xyz_action("CZ", 180.0).lower()


def test_bootstrap_ci_and_welch_pvalue():
    low_group = np.array([58.0, 60.0, 57.5, 61.0, 59.0, 60.5, 58.5, 62.0])
    high_group = np.array([80.0, 82.0, 81.5, 79.0, 83.0, 81.0, 80.5, 82.5])
    mean_val, lo, hi = bootstrap_ci(low_group)
    assert lo < mean_val < hi
    assert 58.0 <= mean_val <= 61.0
    p_val = welch_ttest_pvalue(low_group, high_group)
    assert p_val < 0.001


def test_kmeans_missions_recovers_distinct_clusters():
    rng = np.random.default_rng(7)
    c1 = rng.normal([9.0, 2.0, 0.05, 5.0, 0.85, 0.05], [0.5, 0.4, 0.03, 1.0, 0.08, 0.03], size=(30, 6))
    c2 = rng.normal([13.0, 4.0, 0.15, 14.0, 0.20, 0.25], [0.6, 0.5, 0.04, 1.5, 0.08, 0.06], size=(30, 6))
    c3 = rng.normal([19.0, 6.0, 0.65, 32.0, 0.05, 0.75], [0.6, 0.6, 0.08, 3.0, 0.04, 0.08], size=(30, 6))
    X = np.vstack([c1, c2, c3])
    labels, _, sil, best_k = kmeans_missions(X, k_candidates=(3, 4), seed=42)
    assert best_k == 3
    assert sil > 0.55
    assert len(set(labels.tolist())) == 3


def test_chronological_ridge_attribution_no_leakage():
    rng = np.random.default_rng(123)
    n = 60
    walk_ins = rng.normal(120.0, 22.0, size=n)
    avail = rng.normal(82.0, 8.0, size=n)
    lanes = rng.choice([1.0, 2.0], size=n)
    noise = rng.normal(0.0, 12.0, size=n)
    # True data generating process strongly driven by walk_ins and avail
    y = 120.0 + 4.5 * walk_ins + 3.2 * avail + 35.0 * lanes + noise
    X = np.column_stack([walk_ins, avail, lanes])
    res = chronological_ridge_attribution(
        X, y, feature_names=["walk_ins", "avail_8am_pct", "open_lanes"], holdout_days=14
    )
    assert res["drivers"][0]["feature"] == "walk_ins"
    assert res["holdoutWmapePct"] < res["baselineWmapePct"]


def test_compute_did_evaluation_lift_and_cannibalization():
    # Pre vs Post where Afternoon grows by +$20 due to payday macro shock, Morning grows by +$140 -> true DiD > $100
    pre_m = np.array([500.0] * 14)
    post_m = np.array([640.0] * 14)
    pre_a = np.array([1000.0] * 14)
    post_a = np.array([1040.0] * 14)
    res_pos = compute_did_evaluation(pre_m, post_m, pre_a, post_a)
    assert res_pos["didLiftUsdPerDay"] > 100.0
    assert res_pos["verdict"] == "significant_positive"
    assert res_pos["cannibalizationFlag"] is False

    # Control drop > 5% triggers cannibalization flag
    post_a_drop = np.array([850.0] * 14)
    res_can = compute_did_evaluation(pre_m, post_m, pre_a, post_a_drop)
    assert res_can["cannibalizationFlag"] is True
    assert res_can["verdict"] == "negative_or_cannibalized"


def test_compute_phantom_prob_bounds_and_monotonicity():
    low = compute_phantom_prob(book_stock=20, avg_daily_units=1.5, days_since_last_sale=1.0)
    high = compute_phantom_prob(book_stock=20, avg_daily_units=1.5, days_since_last_sale=12.0, void_refund_ratio=0.05)
    zero_vel = compute_phantom_prob(book_stock=20, avg_daily_units=0.05, days_since_last_sale=15.0)
    assert 0.0 <= low < high <= 0.99
    assert high > 0.7
    assert zero_vel == 0.0


def test_solve_optimal_markdown_maximizes_recovery():
    sol = solve_optimal_markdown(
        qty_remaining=24,
        days_left=4,
        avg_daily_units=2.2,
        sell_price_cents=500,
        unit_cost_cents=280,
    )
    assert 1000 <= sol["recommended_discount_bp"] <= 5000
    assert sol["expected_recovery_cents"] >= sol["baseline_no_promo_recovery_cents"]
    assert sol["predicted_clearance_units"] <= 24


def test_compute_supplier_otif_metrics_grade_and_std():
    strong_deliveries = [
        {"lead_days": 2.0, "ordered_units": 10, "received_units": 10, "po_cost_cents": 10000, "invoice_cost_cents": 10000},
        {"lead_days": 2.2, "ordered_units": 10, "received_units": 10, "po_cost_cents": 10000, "invoice_cost_cents": 10000},
    ]
    res_a = compute_supplier_otif_metrics(strong_deliveries, expected_lead_days=2)
    assert res_a["grade"] == "A"
    assert res_a["otif_rate_pct"] == 100.0
    assert res_a["lead_time_std_days"] >= 0.25

    weak_deliveries = [
        {"lead_days": 6.0, "ordered_units": 10, "received_units": 7, "po_cost_cents": 10000, "invoice_cost_cents": 11500},
        {"lead_days": 4.0, "ordered_units": 10, "received_units": 8, "po_cost_cents": 10000, "invoice_cost_cents": 11000},
    ]
    res_d = compute_supplier_otif_metrics(weak_deliveries, expected_lead_days=2)
    assert res_d["grade"] == "D"
    assert res_d["otif_rate_pct"] == 0.0
    assert res_d["cost_variance_rate_pct"] == 100.0
    assert res_d["lead_time_std_days"] > 1.0


def test_score_rfm_segment_and_recommend_hourly_lanes():
    assert score_rfm_segment(3.0, 6, 15000) == "Champions"
    assert score_rfm_segment(12.0, 3, 5000) == "Loyal"
    assert score_rfm_segment(24.0, 2, 6000) == "At-Risk"
    assert score_rfm_segment(45.0, 0, 1200) == "Hibernating"
    assert score_rfm_segment(5.0, 1, 2000) == "New"

    assert recommend_hourly_lanes(12.0) == 1
    assert recommend_hourly_lanes(90.0) >= 3
    assert recommend_hourly_lanes(999.0, max_lanes=8) == 8


# ============================================================================
# PHASE 3 HARDENING REGRESSION TESTS: SPARSE DATA, NaN/Inf & DEGENERATE INPUTS
# ============================================================================


def test_forecasting_handles_empty_sparse_negative_and_non_finite_series():
    for bad in [
        np.array([], dtype=float),
        np.zeros(60, dtype=float),
        np.array([5.0], dtype=float),
        np.array([np.nan, np.inf, -np.inf, -3.0, 2.0] * 12, dtype=float),
    ]:
        c_fc = croston_sba_forecast(bad, alpha=np.nan)
        c_wmape = croston_holdout_wmape(bad)
        ets_fc, ets_wmape = weekend_ets_forecast(bad, alpha=0.0)
        for v in (c_fc, c_wmape, ets_fc, ets_wmape):
            assert math.isfinite(v)
            assert v >= 0.0
        assert c_wmape <= 200.0
        assert ets_wmape <= 200.0

    # Zero-holdout after positive training must stay finite and bounded
    tail_zero = np.array([4.0] * 46 + [0.0] * 14, dtype=float)
    ets_fc, ets_wmape = weekend_ets_forecast(tail_zero)
    assert math.isfinite(ets_fc) and ets_fc >= 0.0
    assert math.isfinite(ets_wmape) and 0.0 <= ets_wmape <= 200.0


def test_kmeans_missions_handles_identical_points_empty_and_nan_without_crashing():
    # Previously raised ValueError: probabilities do not sum to 1 when all rows were identical
    identical = np.ones((40, 6), dtype=float) * 7.5
    labels, centroids, sil, best_k = kmeans_missions(identical, k_candidates=(3, 4))
    assert len(labels) == 40
    assert best_k == 1
    assert sil == 0.0
    assert np.all(np.isfinite(centroids))

    # Empty & NaN/Inf inputs
    empty_l, empty_c, empty_s, empty_k = kmeans_missions(np.zeros((0, 6), dtype=float))
    assert len(empty_l) == 0 and empty_k == 1 and empty_s == 0.0 and empty_c.shape == (1, 6)

    noisy = np.array([[np.nan, np.inf, -np.inf, 1.0, 2.0, 3.0]] * 15 + [[1.0, 2.0, 3.0, 4.0, 5.0, 6.0]] * 15)
    l2, c2, s2, _ = kmeans_missions(noisy, k_candidates=(2, 3))
    assert len(l2) == 30
    assert math.isfinite(s2)
    assert np.all(np.isfinite(c2))


def test_chronological_ridge_handles_empty_constant_zero_holdout_and_nan():
    res_empty = chronological_ridge_attribution(np.zeros((0, 3)), np.zeros(0), ["a", "b", "c"])
    assert res_empty["drivers"] == []

    # Constant target + NaN/Inf features + zero lam + zero holdout
    X_bad = np.ones((50, 3), dtype=float)
    X_bad[0, 0] = np.nan
    X_bad[1, 1] = np.inf
    y_zero_holdout = np.array([100.0] * 36 + [0.0] * 14, dtype=float)
    res = chronological_ridge_attribution(X_bad, y_zero_holdout, ["f1", "f2", "f3"], holdout_days=14, lam=0.0)
    assert math.isfinite(res["holdoutWmapePct"])
    assert math.isfinite(res["baselineWmapePct"])
    assert math.isfinite(res["r2Train"])
    for drv in res["drivers"]:
        assert math.isfinite(drv["coefUsdPerSd"])
        assert math.isfinite(drv["importancePct"])
    # Ensure strict JSONB compatibility (allow_nan=False)
    assert json.loads(safe_json_dumps(res))["holdoutWmapePct"] == res["holdoutWmapePct"]


def test_did_bootstrap_welch_and_cashier_edge_cases():
    # Non-finite values in DiD arrays must be filtered cleanly
    did_nan = compute_did_evaluation(
        np.array([np.nan, 500.0, 510.0, np.inf]),
        np.array([620.0, 630.0, -np.inf]),
        np.array([1000.0, np.nan, 1020.0]),
        np.array([1010.0, 1030.0]),
    )
    serialized = safe_json_dumps(did_nan)
    assert "NaN" not in serialized and "Infinity" not in serialized

    # Empty arrays
    did_empty = compute_did_evaluation(np.array([]), np.array([]), np.array([]), np.array([]))
    assert did_empty["didLiftUsdPerDay"] == 0.0
    assert did_empty["pValue"] == 1.0

    assert bootstrap_ci(np.array([np.nan, np.inf])) == (0.0, 0.0, 0.0)
    assert welch_ttest_pvalue(np.array([10.0]), np.array([20.0])) == 1.0

    # Zero-tx and identical cashiers (MAD == 0) must not divide by zero
    assert score_cashiers_robust([]) == []
    identical_cashiers = [("C1", 0, 0, 0, 0), ("C2", 0, 0, 0, 0)]
    scored = score_cashiers_robust(identical_cashiers)
    assert len(scored) == 2
    assert all(math.isfinite(r[5]) and math.isfinite(r[6]) for r in scored)


def test_otif_phantom_markdown_rfm_lanes_and_json_sanitizer_edge_cases():
    otif_empty = compute_supplier_otif_metrics([], expected_lead_days=0)
    assert otif_empty["avg_lead_time_days"] == 1.0
    assert otif_empty["lead_time_std_days"] >= 0.4

    otif_nan = compute_supplier_otif_metrics(
        [{"lead_days": float("nan"), "ordered_units": -5, "received_units": 0, "po_cost_cents": -10, "invoice_cost_cents": 0}],
        expected_lead_days=3,
    )
    assert math.isfinite(otif_nan["avg_lead_time_days"])

    assert compute_phantom_prob(10, float("nan"), float("inf"), float("nan")) == 0.0
    assert 0.0 <= compute_phantom_prob(10, 5.0, 9999.0, 0.5) <= 0.99

    md_zero = solve_optimal_markdown(0, 0, float("nan"), 0, -50, elasticity=float("inf"))
    assert md_zero["predicted_clearance_units"] == 0
    assert md_zero["expected_recovery_cents"] == 0

    assert score_rfm_segment(float("nan"), 0, 0) == "Hibernating"
    assert recommend_hourly_lanes(float("nan"), conversion_rate=float("inf"), min_lanes=4, max_lanes=2) == 4
    assert _mine_basket_subset([], "all", min_co=2, min_lift=1.2, top_n=10) == []

    # JSONB sanitizer strips NaN/Inf & converts NumPy scalars cleanly
    raw = {"a": float("nan"), "b": float("inf"), "c": np.float64(-np.inf), "d": np.int64(42), "e": [np.bool_(True)]}
    parsed = json.loads(safe_json_dumps(raw))
    assert parsed == {"a": 0.0, "b": 0.0, "c": 0.0, "d": 42, "e": [True]}
    assert safe_float(float("nan"), default=1.5) == 1.5

