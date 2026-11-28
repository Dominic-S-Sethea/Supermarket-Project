import json
import math
import numpy as np

from run_all import (
    _mine_basket_subset,
    bootstrap_ci,
    chronological_ridge_attribution,
    compute_did_evaluation,
    compute_phantom_prob,
    compute_promo_roi_metrics,
    compute_supplier_otif_metrics,
    croston_holdout_wmape,
    croston_sba_forecast,
    evaluate_data_quality_contracts,
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


# ============================================================================
# WAVE 2 PHASE 3: PROMO ROI ATTRIBUTION & 12-CHECK DATA-QUALITY CONTRACTS
# ============================================================================


def test_promo_roi_profit_accretive_with_strong_velocity_lift():
    res = compute_promo_roi_metrics(
        discounted_units=200,
        discounted_revenue_cents=100_000,
        discounted_tax_cents=9_000,
        discounted_cogs_cents=55_000,
        discount_given_cents=8_000,
        promo_active_days=10,
        baseline_units=100,
        baseline_days=10,
    )
    assert res["verdict"] == "profit_accretive"
    assert res["velocity_lift_pct"] == 100.0
    assert res["net_margin_bp"] > 3000
    assert res["estimated_profit_delta_cents"] > 0


def test_promo_roi_margin_dilutive_when_discount_destroys_profit():
    res = compute_promo_roi_metrics(
        discounted_units=100,
        discounted_revenue_cents=25_000,
        discounted_tax_cents=2_000,
        discounted_cogs_cents=22_000,
        discount_given_cents=12_000,
        promo_active_days=10,
        baseline_units=95,
        baseline_days=10,
    )
    assert res["verdict"] == "margin_dilutive"
    assert res["estimated_profit_delta_cents"] < 0
    assert res["net_margin_bp"] < 500


def test_promo_roi_insufficient_data_on_low_volume():
    res = compute_promo_roi_metrics(
        discounted_units=3,
        discounted_revenue_cents=1200,
        discounted_tax_cents=100,
        discounted_cogs_cents=600,
        discount_given_cents=200,
        promo_active_days=2,
        baseline_units=20,
        baseline_days=10,
    )
    assert res["verdict"] == "insufficient_data"


def test_promo_roi_handles_zero_baseline_zero_revenue_and_non_finite():
    res_zero = compute_promo_roi_metrics(0, 0, 0, 0, 0, 0, 0, 0)
    assert res_zero["verdict"] == "insufficient_data"
    assert res_zero["velocity_lift_pct"] == 0.0
    assert res_zero["net_margin_bp"] == 0

    res_no_base = compute_promo_roi_metrics(
        discounted_units=50,
        discounted_revenue_cents=25_000,
        discounted_tax_cents=2_000,
        discounted_cogs_cents=12_000,
        discount_given_cents=1_500,
        promo_active_days=5,
        baseline_units=0,
        baseline_days=0,
    )
    assert res_no_base["velocity_lift_pct"] == 100.0
    assert res_no_base["verdict"] == "profit_accretive"


def test_promo_roi_margin_neutral_boundary():
    res = compute_promo_roi_metrics(
        discounted_units=100,
        discounted_revenue_cents=50_000,
        discounted_tax_cents=4_000,
        discounted_cogs_cents=40_000,
        discount_given_cents=200,
        promo_active_days=10,
        baseline_units=100,
        baseline_days=10,
    )
    assert res["verdict"] == "margin_neutral"
    assert res["net_margin_bp"] >= 500


def _clean_dq_snapshot() -> dict[str, int]:
    return {
        "abc_xyz_count": 3120,
        "abc_xyz_invalid_classes": 0,
        "abc_xyz_non_finite": 0,
        "forecasts_count": 3120,
        "forecasts_bad_rows": 0,
        "basket_bad_rows": 0,
        "lp_bad_rows": 0,
        "supplier_count": 7,
        "supplier_bad_rows": 0,
        "phantom_bad_rows": 0,
        "markdown_bad_rows": 0,
        "promo_roi_bad_rows": 0,
        "shift_diag_count": 1,
        "negative_batches": 0,
    }


def test_dq_contracts_pass_on_healthy_snapshot():
    passed, checks = evaluate_data_quality_contracts(_clean_dq_snapshot())
    assert passed is True
    assert len(checks) == 12
    assert all(c["passed"] is True for c in checks)


def test_dq_contracts_fail_on_empty_abc_xyz_or_nan_values():
    snap = _clean_dq_snapshot()
    snap["abc_xyz_count"] = 0
    snap["abc_xyz_non_finite"] = 2
    passed, checks = evaluate_data_quality_contracts(snap)
    assert passed is False
    by_name = {c["name"]: c["passed"] for c in checks}
    assert by_name["abc_xyz_non_empty"] is False
    assert by_name["abc_xyz_finite_values"] is False


def test_dq_contracts_fail_on_negative_fefo_batch_and_invalid_phantom_prob():
    snap = _clean_dq_snapshot()
    snap["negative_batches"] = 1
    snap["phantom_bad_rows"] = 3
    passed, checks = evaluate_data_quality_contracts(snap)
    assert passed is False
    by_name = {c["name"]: c["passed"] for c in checks}
    assert by_name["inventory_batches_non_negative"] is False
    assert by_name["phantom_stock_valid_prob"] is False


def test_dq_contracts_fail_on_invalid_supplier_grade_and_basket_bounds():
    snap = _clean_dq_snapshot()
    snap["supplier_bad_rows"] = 1
    snap["basket_bad_rows"] = 4
    passed, checks = evaluate_data_quality_contracts(snap)
    assert passed is False
    by_name = {c["name"]: c["passed"] for c in checks}
    assert by_name["supplier_scorecards_valid_grades"] is False
    assert by_name["basket_rules_valid_bounds"] is False


def test_dq_contracts_fail_on_bad_promo_roi_and_missing_shift_diagnostics():
    snap = _clean_dq_snapshot()
    snap["promo_roi_bad_rows"] = 1
    snap["shift_diag_count"] = 0
    passed, checks = evaluate_data_quality_contracts(snap)
    assert passed is False
    by_name = {c["name"]: c["passed"] for c in checks}
    assert by_name["promo_roi_valid_verdicts"] is False
    assert by_name["shift_diagnostics_fresh"] is False


def test_markdown_elasticity_never_recommends_below_zero_recovery():
    sol = solve_optimal_markdown(
        qty_remaining=100,
        days_left=1,
        avg_daily_units=10.0,
        sell_price_cents=150,
        unit_cost_cents=140,
        elasticity=2.5,
    )
    assert sol["expected_recovery_cents"] >= 0
    assert sol["recommended_promo_price_cents"] >= 1
    assert 0 <= sol["recommended_discount_bp"] <= 9500


def test_supplier_otif_handles_partial_and_cost_savings_deliveries():
    deliveries = [
        {"lead_days": 3.0, "ordered_units": 100, "received_units": 98, "po_cost_cents": 50_000, "invoice_cost_cents": 49_000},
        {"lead_days": 2.5, "ordered_units": 100, "received_units": 100, "po_cost_cents": 50_000, "invoice_cost_cents": 50_000},
    ]
    res = compute_supplier_otif_metrics(deliveries, expected_lead_days=3)
    assert res["on_time_rate_pct"] == 100.0
    assert res["in_full_rate_pct"] == 50.0
    assert res["otif_rate_pct"] == 50.0
    assert res["cost_variance_rate_pct"] == 50.0
    assert res["grade"] in ("C", "D")


def test_analytics_http_worker_auth_and_recompute_lock():
    import threading
    import urllib.error
    import urllib.request
    from run_all import create_worker_server

    started = threading.Event()
    release = threading.Event()
    calls = []

    def fake_pipeline():
        calls.append(1)
        started.set()
        release.wait(timeout=2.0)
        return {"ok": True, "status": "ok", "dq_passed": True, "elapsed_s": 0.01}

    server, auth_required = create_worker_server(
        host="127.0.0.1",
        port=0,
        worker_token="test-secret-token",
        pipeline_fn=fake_pipeline,
    )
    assert auth_required is True
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health") as resp:
            assert resp.status == 200
            body = json.loads(resp.read().decode("utf-8"))
            assert body == {"status": "ok", "busy": False}

        # Unauthorized recompute -> 401
        req_unauth = urllib.request.Request(f"http://127.0.0.1:{port}/recompute", method="POST", data=b"")
        try:
            urllib.request.urlopen(req_unauth)
            assert False, "Expected 401 for missing bearer token"
        except urllib.error.HTTPError as err:
            assert err.code == 401

        # Authorized recompute in flight + concurrent second recompute -> 409
        first_result: dict[str, object] = {}

        def invoke_first():
            req = urllib.request.Request(
                f"http://127.0.0.1:{port}/recompute",
                method="POST",
                data=b"",
                headers={"Authorization": "Bearer test-secret-token"},
            )
            with urllib.request.urlopen(req) as resp:
                first_result["status"] = resp.status
                first_result["body"] = json.loads(resp.read().decode("utf-8"))

        t1 = threading.Thread(target=invoke_first)
        t1.start()
        assert started.wait(timeout=2.0)

        req_conflict = urllib.request.Request(
            f"http://127.0.0.1:{port}/recompute",
            method="POST",
            data=b"",
            headers={"Authorization": "Bearer test-secret-token"},
        )
        try:
            urllib.request.urlopen(req_conflict)
            assert False, "Expected 409 while recompute lock is held"
        except urllib.error.HTTPError as err:
            assert err.code == 409

        release.set()
        t1.join(timeout=2.0)
        assert first_result["status"] == 200
        assert first_result["body"]["ok"] is True
        assert len(calls) == 1
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2.0)


def test_lp_risk_levels_match_dq_contract():
    import inspect
    from run_all import score_cashiers_robust, validate_pipeline_data_quality

    rows = [
        ("Alice", 200, 1, 0, 0),
        ("Bob", 200, 1, 0, 0),
        ("Carol", 200, 5, 0, 0),
        ("Dave", 200, 18, 2, 1),
    ]
    scored = score_cashiers_robust(rows)
    emitted_levels = {entry[7] for entry in scored}
    assert emitted_levels.issubset({"normal", "elevated", "high"})
    assert "elevated" in emitted_levels or "high" in emitted_levels

    dq_source = inspect.getsource(validate_pipeline_data_quality)
    assert "('normal','elevated','high')" in dq_source
    assert "'watch'" not in dq_source


def test_analytics_http_worker_fails_closed_without_token_and_binds_loopback(monkeypatch):
    import threading
    import urllib.error
    import urllib.request
    from run_all import create_worker_server

    monkeypatch.delenv("ANALYTICS_WORKER_TOKEN", raising=False)
    monkeypatch.delenv("ANALYTICS_ALLOW_UNAUTHENTICATED_DEV", raising=False)
    monkeypatch.delenv("ANALYTICS_WORKER_HOST", raising=False)

    calls = []

    def fake_pipeline():
        calls.append(1)
        return {"ok": True}

    server, auth_required = create_worker_server(
        host=None,
        port=0,
        worker_token="",
        pipeline_fn=fake_pipeline,
    )
    assert auth_required is True
    assert server.server_address[0] == "127.0.0.1"
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{port}/recompute", method="POST", data=b"")
        try:
            urllib.request.urlopen(req)
            assert False, "Expected 401 when worker token is missing"
        except urllib.error.HTTPError as err:
            assert err.code == 401
        assert calls == []
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2.0)


def test_measured_unit_valuation_and_markdown_scaling():
    import inspect
    from run_all import (
        compute_inventory_value_cents,
        run_loyalty_staffing_and_tasks,
        solve_optimal_markdown,
        unit_cost_divisor,
    )

    assert unit_cost_divisor("each") == 1.0
    assert unit_cost_divisor("weight_g") == 1000.0
    assert unit_cost_divisor("volume_ml") == 1000.0

    # 65,000g @ 110c/kg ($1.10/kg) = $71.50 (7150c), NOT $71,500
    assert compute_inventory_value_cents(65000, 110, "weight_g") == 7150
    assert compute_inventory_value_cents(500, 400, "volume_ml") == 200
    assert compute_inventory_value_cents(10, 110, "each") == 1100

    # Weighted batch 20,000g (20 kg) at $4.00/kg sell, $2.20/kg cost, 5,000g/day velocity over 3 days
    sol = solve_optimal_markdown(
        qty_remaining=20000,
        days_left=3,
        avg_daily_units=5000.0,
        sell_price_cents=400,
        unit_cost_cents=220,
        unit_mode="weight_g",
    )
    assert sol["baseline_no_promo_recovery_cents"] == 6000
    assert 6000 <= sol["expected_recovery_cents"] <= 8000

    loyalty_src = inspect.getsource(run_loyalty_staffing_and_tasks)
    assert "CASE WHEN s.kind = 'sale' THEN s.total_cents ELSE -s.total_cents END" in loyalty_src


def test_welch_ttest_exact_student_t_and_zero_variance():
    from run_all import welch_ttest_pvalue

    # Tiny n=2 vs n=2 must use finite-df Student-t (less aggressive than normal approx erfc)
    p_tiny = welch_ttest_pvalue(np.array([10.0, 12.0]), np.array([15.0, 17.0]))
    assert 0.04 < p_tiny < 0.12

    assert welch_ttest_pvalue(np.array([5.0, 5.0, 5.0]), np.array([5.0, 5.0, 5.0])) == 1.0
    assert welch_ttest_pvalue(np.array([5.0, 5.0, 5.0]), np.array([9.0, 9.0, 9.0])) == 0.0


def test_compute_did_paired_bootstrap_cancels_common_shocks():
    from run_all import compute_did_evaluation

    # Large shared weekday/weekend oscillation affecting target & control proportionally:
    # Target and control move together cleanly -> true DiD lift is 0.0 and must NOT flag false positive
    pre_c = np.array([1000.0, 2000.0] * 7)
    post_c = np.array([1100.0, 2200.0] * 7)
    pre_t = np.array([500.0, 1000.0] * 7)
    post_t = np.array([550.0, 1100.0] * 7)

    res = compute_did_evaluation(pre_t, post_t, pre_c, post_c)
    assert abs(res["didLiftUsdPerDay"]) < 1e-6
    assert res["verdict"] == "inconclusive"
    assert res["ciLowUsd"] <= 0.0 <= res["ciHighUsd"]


def test_daypart_sql_clause_and_uuid_filter():
    from run_all import build_daypart_sql_clause, filter_valid_uuids

    assert build_daypart_sql_clause(None, None) == ("", [])
    assert build_daypart_sql_clause(8, 8) == ("", [])

    clause_std, params_std = build_daypart_sql_clause(8, 12)
    assert ">=" in clause_std and "AND EXTRACT(HOUR" in clause_std
    assert params_std == [8, 12]

    clause_wrap, params_wrap = build_daypart_sql_clause(22, 6)
    assert " OR EXTRACT(HOUR" in clause_wrap
    assert params_wrap == [22, 6]

    uuids = filter_valid_uuids(["01950000-0000-7000-8000-000000000001", "not-a-uuid", None])
    assert uuids == ["01950000-0000-7000-8000-000000000001"]


def test_analytics_pipeline_decoupled_tx_and_timeouts():
    import inspect
    import run_all

    pipeline_src = inspect.getsource(run_all.run_pipeline)
    assert "statement_timeout" in pipeline_src
    assert "lock_timeout" in pipeline_src
    assert 'run_status = "ok" if dq_passed else "dq_failed"' in pipeline_src
    assert "pipeline_error" in pipeline_src
    # Stages must NOT run inside a single monolithic transaction block
    assert "with conn.transaction():\n            supplier_std_map" not in pipeline_src

    basket_src = inspect.getsource(run_all._run_market_basket_impl)
    assert "fetchmany(5000)" in basket_src

    lp_src = inspect.getsource(run_all.run_loss_prevention_anomalies)
    assert "orig.cashier_name" in lp_src
    assert "details_json->>'cashierName'" in lp_src

    sup_src = inspect.getsource(run_all.run_supplier_scorecards)
    assert "GROUP BY gr.supplier_id, gr.po_id" in sup_src

    shift_src = inspect.getsource(run_all._run_shift_diagnostics_impl)
    assert "WHERE status = 'active'" in shift_src
    assert "generate_series" in shift_src

    loyalty_src = inspect.getsource(run_all.run_loyalty_staffing_and_tasks)
    assert "SET LOCAL lock_timeout = '2s'" in loyalty_src
    assert "range(0, len(rfm_updates), 50)" in loyalty_src
    assert "rfm_segment IS DISTINCT FROM" in loyalty_src


def test_build_pg_connect_kwargs_special_char_password():
    from run_all import build_pg_connect_kwargs

    # Explicit PG* variables preserve raw special characters safely without URL parsing corruption
    kwargs = build_pg_connect_kwargs({
        "PGHOST": "postgres",
        "PGPORT": "5432",
        "PGUSER": "supermarket",
        "PGPASSWORD": "p@ss:w#rd/%1?x=2",
        "PGDATABASE": "supermarket_os",
    })
    assert kwargs == {
        "host": "postgres",
        "port": 5432,
        "user": "supermarket",
        "password": "p@ss:w#rd/%1?x=2",
        "dbname": "supermarket_os",
    }

    uri_kwargs = build_pg_connect_kwargs({
        "DATABASE_URL": "postgres://u:p@localhost:5433/db",
        "PGHOST": "ignored",
    })
    assert uri_kwargs == {"conninfo": "postgres://u:p@localhost:5433/db"}
