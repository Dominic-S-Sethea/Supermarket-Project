import { useEffect, useState } from "react";
import { formatBp, formatMoney, type UserRole } from "@supermarket/shared";
import {
  Gift,
  PauseCircle,
  PlayCircle,
  Plus,
  RefreshCw,
  Search,
  Tag,
  Ticket,
  Users,
} from "lucide-react";
import { apiGet, apiPatch, apiPost } from "../api";

interface CustomerRow {
  id: string;
  phone: string;
  fullName: string;
  email: string | null;
  pointsBalance: number;
  lifetimeSpendCents: number;
  visits60d: number;
  rfmSegment: string;
  lastVisitAt: string | null;
}

interface CustomerSummary {
  totalCustomers: number;
  totalPoints: number;
  avgLifetimeSpendCents: number;
  segmentCounts: Record<string, number>;
}

interface CouponRow {
  id: string;
  code: string;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  rfmSegment: string | null;
  discountCents: number;
  minBasketCents: number;
  validFrom: string;
  validUntil: string;
  redeemedSaleId: string | null;
  redeemedAt: string | null;
  status: "active" | "redeemed" | "expired";
}

interface CouponSummary {
  activeCount: number;
  redeemedCount: number;
  expiredCount: number;
  totalActiveValueCents: number;
}

interface PromoRow {
  id: string;
  name: string;
  promoType: string;
  priority: number;
  combinable: boolean;
  minMarginGuardBp: number | null;
  daypartStartHour: number | null;
  daypartEndHour: number | null;
  startsAt: string;
  endsAt: string;
  active: boolean;
  rulesJson: Record<string, unknown>;
}

interface PromoRoiRow {
  promotionId: string;
  promotionName: string;
  promoType: string;
  discountedUnits60d: number;
  discountedRevenueCents: number;
  discountGivenCents: number;
  baselineDailyUnits: number;
  promoDailyUnits: number;
  velocityLiftPct: number;
  netMarginBp: number;
  estimatedProfitDeltaCents: number;
  verdict: "profit_accretive" | "margin_neutral" | "margin_dilutive" | "insufficient_data";
}

type LoyaltySubTab = "customers" | "coupons" | "promotions";

function rfmBadgeClass(seg: string): string {
  const s = seg.toLowerCase();
  if (s.includes("champion")) return "tag-green";
  if (s.includes("loyal")) return "tag-blue";
  if (s.includes("risk") || s.includes("lapsed")) return "tag-red";
  return "tag-neutral";
}

export function LoyaltyPromosView({ userRole = "owner" }: { userRole?: UserRole }) {
  const canManage = userRole === "owner" || userRole === "manager";
  const [subTab, setSubTab] = useState<LoyaltySubTab>("customers");

  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [custSummary, setCustSummary] = useState<CustomerSummary | null>(null);
  const [custSearch, setCustSearch] = useState("");
  const [segFilter, setSegFilter] = useState("all");

  const [coupons, setCoupons] = useState<CouponRow[]>([]);
  const [couponSummary, setCouponSummary] = useState<CouponSummary | null>(null);
  const [couponFilter, setCouponFilter] = useState("all");

  const [promos, setPromos] = useState<PromoRow[]>([]);
  const [promoRoi, setPromoRoi] = useState<PromoRoiRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Enroll customer form
  const [newPhone, setNewPhone] = useState("");
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");

  // Issue coupon form
  const [couponCode, setCouponCode] = useState("");
  const [couponCustomerId, setCouponCustomerId] = useState("");
  const [couponSegment, setCouponSegment] = useState("");
  const [couponDiscountUsd, setCouponDiscountUsd] = useState("5.00");
  const [couponMinBasketUsd, setCouponMinBasketUsd] = useState("25.00");
  const [couponValidDays, setCouponValidDays] = useState(30);

  // Create promo form
  const [promoName, setPromoName] = useState("");
  const [promoType, setPromoType] = useState<
    "basket_threshold" | "clearance" | "bogo" | "mix_and_match" | "tier_price"
  >("basket_threshold");
  const [promoMinBasketUsd, setPromoMinBasketUsd] = useState("30.00");
  const [promoFlatDiscountUsd, setPromoFlatDiscountUsd] = useState("3.00");
  const [promoDiscountPct, setPromoDiscountPct] = useState(15);
  const [promoDaypart, setPromoDaypart] = useState<"all" | "morning" | "evening">("all");

  const loadAll = async (signal?: AbortSignal) => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const custQs = new URLSearchParams();
      if (custSearch.trim()) custQs.set("search", custSearch.trim());
      if (segFilter !== "all") custQs.set("segment", segFilter);
      const cpQs = couponFilter !== "all" ? `?status=${encodeURIComponent(couponFilter)}` : "";

      const [cRes, cpRes, pRes, roiRes] = await Promise.all([
        apiGet<{ summary: CustomerSummary; customers: CustomerRow[] }>(
          `/api/loyalty/customers${custQs.toString() ? `?${custQs.toString()}` : ""}`,
          signal
        ),
        apiGet<{ summary: CouponSummary; coupons: CouponRow[] }>(
          `/api/loyalty/coupons${cpQs}`,
          signal
        ),
        apiGet<{ promotions: PromoRow[] }>("/api/promotions", signal),
        apiGet<{ items: PromoRoiRow[] }>("/api/analytics/promo-roi", signal).catch(() => ({
          items: [],
        })),
      ]);
      if (signal?.aborted) return;
      setCustomers(cRes.customers);
      setCustSummary(cRes.summary);
      setCoupons(cpRes.coupons);
      setCouponSummary(cpRes.summary);
      setPromos(pRes.promotions);
      setPromoRoi(roiRes.items);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setErrorMsg(err instanceof Error ? err.message : "Failed loading loyalty & promotions");
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void loadAll(controller.signal);
    }, 120);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [custSearch, segFilter, couponFilter]);

  const handleEnrollCustomer = async () => {
    if (busy) return;
    setErrorMsg(null);
    if (newPhone.trim().length < 6 || newName.trim().length < 2) {
      setErrorMsg("Enter a valid full name and phone number (6+ characters).");
      return;
    }
    setBusy("enroll");
    try {
      const res = await apiPost<{ customer: CustomerRow }>("/api/loyalty/customers", {
        phone: newPhone.trim(),
        fullName: newName.trim(),
        email: newEmail.trim() || null,
      });
      setFeedback(`Enrolled loyalty member ${res.customer.fullName} (${res.customer.phone}).`);
      setNewPhone("");
      setNewName("");
      setNewEmail("");
      await loadAll();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed enrolling customer");
    } finally {
      setBusy(null);
    }
  };

  const handleIssueCoupon = async () => {
    if (busy) return;
    setErrorMsg(null);
    const discUsd = Number(couponDiscountUsd);
    const minUsd = Number(couponMinBasketUsd);
    if (!Number.isFinite(discUsd) || discUsd < 0.1 || !Number.isFinite(minUsd) || minUsd < 0) {
      setErrorMsg("Enter valid USD amounts for coupon discount (>= $0.10) and minimum basket.");
      return;
    }
    setBusy("coupon");
    try {
      const res = await apiPost<{ coupon: CouponRow }>("/api/loyalty/coupons", {
        code: couponCode.trim() || undefined,
        customerId: couponCustomerId || null,
        rfmSegment: couponSegment || null,
        discountCents: Math.round(discUsd * 100),
        minBasketCents: Math.round(minUsd * 100),
        validDays: couponValidDays,
      });
      setFeedback(
        `Issued single-use coupon ${res.coupon.code} (${formatMoney(res.coupon.discountCents)} off, min basket ${formatMoney(res.coupon.minBasketCents)}).`
      );
      setCouponCode("");
      await loadAll();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed issuing coupon");
    } finally {
      setBusy(null);
    }
  };

  const handleCreatePromo = async () => {
    if (busy) return;
    setErrorMsg(null);
    if (promoName.trim().length < 3) {
      setErrorMsg("Promotion name must be at least 3 characters.");
      return;
    }
    setBusy("promo");
    try {
      const rulesJson: Record<string, unknown> =
        promoType === "basket_threshold"
          ? {
              minBasketCents: Math.max(100, Math.round((Number(promoMinBasketUsd) || 25) * 100)),
              flatDiscountCents: Math.max(50, Math.round((Number(promoFlatDiscountUsd) || 3) * 100)),
            }
          : promoType === "bogo"
            ? { buyQty: 2, getQty: 1, discountBp: 10000 }
            : promoType === "mix_and_match"
              ? { requiredQty: 3, bundlePriceCents: 500 }
              : { discountBp: Math.min(8000, Math.max(500, promoDiscountPct * 100)) };

      const daypartStartHour =
        promoDaypart === "morning" ? 8 : promoDaypart === "evening" ? 17 : null;
      const daypartEndHour =
        promoDaypart === "morning" ? 12 : promoDaypart === "evening" ? 21 : null;

      await apiPost("/api/promotions", {
        name: promoName.trim(),
        promoType,
        priority: 20,
        combinable: promoType === "basket_threshold",
        minMarginGuardBp: 500,
        daypartStartHour,
        daypartEndHour,
        rulesJson,
      });
      setFeedback(`Created active promotion "${promoName.trim()}" and synced to POS catalog.`);
      setPromoName("");
      await loadAll();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed creating promotion");
    } finally {
      setBusy(null);
    }
  };

  const handleTogglePromo = async (promo: PromoRow) => {
    if (busy) return;
    setBusy(`toggle-${promo.id}`);
    setErrorMsg(null);
    try {
      await apiPatch(`/api/promotions/${promo.id}`, { active: !promo.active });
      setFeedback(
        `${promo.active ? "Paused" : "Activated"} promotion "${promo.name}".`
      );
      await loadAll();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed toggling promotion");
    } finally {
      setBusy(null);
    }
  };

  const segments = Object.keys(custSummary?.segmentCounts ?? {});
  const activePromoCount = promos.filter((p) => p.active).length;

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>Loyalty CRM, Targeted Coupons &amp; Promotions</h1>
          <p className="page-subtitle">
            Manage RFM shopper segments, issue single-use POS coupons with atomic double-redeem locking, and configure daypart promotions.
          </p>
        </div>
        <div className="subtab-bar" role="tablist">
          <button
            id="loyalty-subtab-customers"
            role="tab"
            aria-selected={subTab === "customers"}
            className={`subtab-btn ${subTab === "customers" ? "active" : ""}`}
            onClick={() => setSubTab("customers")}
          >
            <Users size={14} /> Customers ({custSummary?.totalCustomers ?? 0})
          </button>
          <button
            id="loyalty-subtab-coupons"
            role="tab"
            aria-selected={subTab === "coupons"}
            className={`subtab-btn ${subTab === "coupons" ? "active" : ""}`}
            onClick={() => setSubTab("coupons")}
          >
            <Ticket size={14} /> Coupons ({couponSummary?.activeCount ?? 0} Active)
          </button>
          <button
            id="loyalty-subtab-promotions"
            role="tab"
            aria-selected={subTab === "promotions"}
            className={`subtab-btn ${subTab === "promotions" ? "active" : ""}`}
            onClick={() => setSubTab("promotions")}
          >
            <Tag size={14} /> Promotions ({activePromoCount} Active)
          </button>
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

      <div className="kpi-strip">
        <div className="kpi-tile">
          <div className="kpi-label">Loyalty Members</div>
          <div className="kpi-value">{custSummary?.totalCustomers ?? 0}</div>
          <div className="kpi-meta">
            Avg lifetime spend {formatMoney(custSummary?.avgLifetimeSpendCents ?? 0)}
          </div>
        </div>
        <div className="kpi-tile">
          <div className="kpi-label">Outstanding Points Liability</div>
          <div className="kpi-value">{(custSummary?.totalPoints ?? 0).toLocaleString()} pts</div>
          <div className="kpi-meta">Accrued at 1 point per $1 spent at POS</div>
        </div>
        <div className="kpi-tile">
          <div className="kpi-label">Active Single-Use Coupons</div>
          <div className="kpi-value" style={{ color: "var(--accent-primary)" }}>
            {couponSummary?.activeCount ?? 0}
          </div>
          <div className="kpi-meta">
            {formatMoney(couponSummary?.totalActiveValueCents ?? 0)} value ·{" "}
            {couponSummary?.redeemedCount ?? 0} redeemed
          </div>
        </div>
        <div className="kpi-tile">
          <div className="kpi-label">Active POS Promotions</div>
          <div className="kpi-value">{activePromoCount}</div>
          <div className="kpi-meta">{promos.length} total rules configured</div>
        </div>
      </div>

      {/* 1. Customers Tab */}
      {subTab === "customers" && (
        <div className="grid-asymmetric">
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2 className="panel-title">RFM Loyalty Directory</h2>
                <p className="panel-desc">
                  Segmented automatically by recency, frequency, and monetary spend.
                </p>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <div className="search-box" style={{ maxWidth: 220 }}>
                  <Search size={14} className="search-icon" />
                  <input
                    id="loyalty-customer-search"
                    className="input"
                    placeholder="Phone or name..."
                    value={custSearch}
                    onChange={(e) => setCustSearch(e.target.value)}
                  />
                </div>
                <select
                  className="select"
                  value={segFilter}
                  onChange={(e) => setSegFilter(e.target.value)}
                >
                  <option value="all">All RFM Segments</option>
                  {segments.map((s) => (
                    <option key={s} value={s}>
                      {s} ({custSummary?.segmentCounts[s] ?? 0})
                    </option>
                  ))}
                </select>
                <button className="btn btn-sm" disabled={loading} onClick={() => void loadAll()}>
                  <RefreshCw size={13} />
                </button>
              </div>
            </div>

            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>RFM Segment</th>
                    <th className="text-right">Points</th>
                    <th className="text-right">60d Visits</th>
                    <th className="text-right">Lifetime Spend</th>
                  </tr>
                </thead>
                <tbody>
                  {loading && customers.length === 0 ? (
                    <tr>
                      <td colSpan={5}>Loading loyalty members...</td>
                    </tr>
                  ) : customers.length === 0 ? (
                    <tr>
                      <td colSpan={5} style={{ textAlign: "center", color: "var(--ink-muted)", padding: 18 }}>
                        No customers match this filter.
                      </td>
                    </tr>
                  ) : (
                    customers.map((c) => (
                      <tr key={c.id}>
                        <td>
                          <div style={{ fontWeight: 600 }}>{c.fullName}</div>
                          <div className="mono" style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                            {c.phone}
                            {c.email ? ` · ${c.email}` : ""}
                          </div>
                        </td>
                        <td>
                          <span className={`tag ${rfmBadgeClass(c.rfmSegment)}`}>{c.rfmSegment}</span>
                        </td>
                        <td className="text-right mono" style={{ fontWeight: 700 }}>
                          {c.pointsBalance.toLocaleString()}
                        </td>
                        <td className="text-right mono">{c.visits60d}</td>
                        <td className="text-right mono">{formatMoney(c.lifetimeSpendCents)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {canManage && (
            <section className="panel">
              <div className="panel-header">
                <div>
                  <h2 className="panel-title">
                    <Plus size={15} style={{ verticalAlign: "middle", marginRight: 6 }} />
                    Enroll Loyalty Member
                  </h2>
                  <p className="panel-desc">
                    Instant phone-based enrollment usable immediately at POS checkout.
                  </p>
                </div>
              </div>
              <div className="stack-md" style={{ gap: 10 }}>
                <div className="field">
                  <label htmlFor="enroll-name">Full Name</label>
                  <input
                    id="enroll-name"
                    className="input"
                    placeholder="e.g., Priya Nair"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="enroll-phone">Mobile Phone (Unique ID)</label>
                  <input
                    id="enroll-phone"
                    className="input mono"
                    placeholder="e.g., 555-0199"
                    value={newPhone}
                    onChange={(e) => setNewPhone(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="enroll-email">Email (Optional)</label>
                  <input
                    id="enroll-email"
                    className="input"
                    type="email"
                    placeholder="shopper@example.com"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                  />
                </div>
                <button
                  id="enroll-customer-btn"
                  className="btn btn-primary"
                  disabled={busy !== null}
                  onClick={() => void handleEnrollCustomer()}
                >
                  {busy === "enroll" ? "Enrolling..." : "Enroll Loyalty Customer"}
                </button>
              </div>
            </section>
          )}
        </div>
      )}

      {/* 2. Coupons Tab */}
      {subTab === "coupons" && (
        <div className="grid-asymmetric">
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2 className="panel-title">Targeted Single-Use Coupons</h2>
                <p className="panel-desc">
                  Protected by PostgreSQL row locks (`FOR UPDATE`) during POS checkout so coupons can never be double-redeemed.
                </p>
              </div>
              <select
                className="select"
                value={couponFilter}
                onChange={(e) => setCouponFilter(e.target.value)}
              >
                <option value="all">All Coupons</option>
                <option value="active">Active Only</option>
                <option value="redeemed">Redeemed</option>
                <option value="expired">Expired</option>
              </select>
            </div>

            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Target</th>
                    <th className="text-right">Discount</th>
                    <th className="text-right">Min Basket</th>
                    <th>Expires</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {coupons.length === 0 ? (
                    <tr>
                      <td colSpan={6} style={{ textAlign: "center", color: "var(--ink-muted)", padding: 18 }}>
                        No coupons match this filter.
                      </td>
                    </tr>
                  ) : (
                    coupons.map((cp) => (
                      <tr key={cp.id}>
                        <td className="mono" style={{ fontWeight: 700 }}>
                          {cp.code}
                        </td>
                        <td>
                          {cp.customerName ? (
                            <div>
                              <div style={{ fontWeight: 600 }}>{cp.customerName}</div>
                              <div className="mono" style={{ fontSize: 11, color: "var(--ink-muted)" }}>
                                {cp.customerPhone}
                              </div>
                            </div>
                          ) : cp.rfmSegment ? (
                            <span className="tag tag-blue">Segment: {cp.rfmSegment}</span>
                          ) : (
                            <span className="tag tag-neutral">Any Shopper</span>
                          )}
                        </td>
                        <td className="text-right mono" style={{ color: "var(--accent-primary)", fontWeight: 700 }}>
                          -{formatMoney(cp.discountCents)}
                        </td>
                        <td className="text-right mono">{formatMoney(cp.minBasketCents)}</td>
                        <td className="mono" style={{ fontSize: 12 }}>
                          {new Date(cp.validUntil).toISOString().slice(0, 10)}
                        </td>
                        <td>
                          <span
                            className={`tag ${
                              cp.status === "active"
                                ? "tag-green"
                                : cp.status === "redeemed"
                                  ? "tag-blue"
                                  : "tag-neutral"
                            }`}
                          >
                            {cp.status}
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {canManage && (
            <section className="panel">
              <div className="panel-header">
                <div>
                  <h2 className="panel-title">
                    <Gift size={15} style={{ verticalAlign: "middle", marginRight: 6 }} />
                    Issue Targeted Coupon
                  </h2>
                  <p className="panel-desc">
                    Generate a win-back or VIP voucher validated live at the checkout lane.
                  </p>
                </div>
              </div>
              <div className="stack-md" style={{ gap: 10 }}>
                <div className="field">
                  <label htmlFor="coupon-code-input">Coupon Code (leave blank to auto-generate)</label>
                  <input
                    id="coupon-code-input"
                    className="input mono"
                    placeholder="e.g., MORNING5"
                    value={couponCode}
                    onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
                  />
                </div>
                <div className="form-grid">
                  <div className="field">
                    <label htmlFor="coupon-discount-usd">Discount ($)</label>
                    <input
                      id="coupon-discount-usd"
                      className="input mono"
                      value={couponDiscountUsd}
                      onChange={(e) => setCouponDiscountUsd(e.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="coupon-min-basket-usd">Min Basket ($)</label>
                    <input
                      id="coupon-min-basket-usd"
                      className="input mono"
                      value={couponMinBasketUsd}
                      onChange={(e) => setCouponMinBasketUsd(e.target.value)}
                    />
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="coupon-customer-select">Restrict to Specific Customer (Optional)</label>
                  <select
                    id="coupon-customer-select"
                    className="select"
                    value={couponCustomerId}
                    onChange={(e) => setCouponCustomerId(e.target.value)}
                  >
                    <option value="">Open to any shopper</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.fullName} ({c.phone}) · {c.rfmSegment}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-grid">
                  <div className="field">
                    <label>Target RFM Segment (Tag)</label>
                    <select
                      className="select"
                      value={couponSegment}
                      onChange={(e) => setCouponSegment(e.target.value)}
                    >
                      <option value="">None</option>
                      <option value="At Risk">At Risk (Win-back)</option>
                      <option value="Champions">Champions (VIP)</option>
                      <option value="Loyal">Loyal</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>Valid Days</label>
                    <input
                      className="input mono"
                      type="number"
                      min={1}
                      max={365}
                      value={couponValidDays}
                      onChange={(e) => setCouponValidDays(Math.max(1, Number(e.target.value) || 30))}
                    />
                  </div>
                </div>
                <button
                  id="issue-coupon-btn"
                  className="btn btn-primary"
                  disabled={busy !== null}
                  onClick={() => void handleIssueCoupon()}
                >
                  {busy === "coupon" ? "Issuing..." : "Issue Single-Use Coupon"}
                </button>
              </div>
            </section>
          )}
        </div>
      )}

      {/* 3. Promotions Tab */}
      {subTab === "promotions" && (
        <>
          <div className="grid-asymmetric">
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2 className="panel-title">Active &amp; Daypart POS Promotions ({promos.length})</h2>
                <p className="panel-desc">
                  Synced to offline-first POS lanes with floor-price margin guards and daypart time windows.
                </p>
              </div>
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Promotion</th>
                    <th>Type</th>
                    <th>Daypart</th>
                    <th className="text-right">Margin Floor</th>
                    <th>Status</th>
                    {canManage && <th className="text-right">Control</th>}
                  </tr>
                </thead>
                <tbody>
                  {promos.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{p.name}</div>
                        <div className="mono" style={{ fontSize: 11, color: "var(--ink-muted)" }}>
                          Priority #{p.priority} · {p.combinable ? "Combinable" : "Exclusive"} · Ends{" "}
                          {new Date(p.endsAt).toISOString().slice(0, 10)}
                        </div>
                      </td>
                      <td>
                        <span className="tag tag-blue">{p.promoType.replace(/_/g, " ")}</span>
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {p.daypartStartHour !== null && p.daypartEndHour !== null
                          ? `${String(p.daypartStartHour).padStart(2, "0")}:00–${String(p.daypartEndHour).padStart(2, "0")}:00`
                          : "All Day"}
                      </td>
                      <td className="text-right mono">
                        {p.minMarginGuardBp !== null ? formatBp(p.minMarginGuardBp) : "None"}
                      </td>
                      <td>
                        <span className={`tag ${p.active ? "tag-green" : "tag-neutral"}`}>
                          {p.active ? "active" : "paused"}
                        </span>
                      </td>
                      {canManage && (
                        <td className="text-right">
                          <button
                            className="btn btn-sm"
                            disabled={busy !== null}
                            onClick={() => void handleTogglePromo(p)}
                          >
                            {p.active ? (
                              <>
                                <PauseCircle size={12} /> Pause
                              </>
                            ) : (
                              <>
                                <PlayCircle size={12} /> Activate
                              </>
                            )}
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {canManage && (
            <section className="panel">
              <div className="panel-header">
                <div>
                  <h2 className="panel-title">Create POS Promotion</h2>
                  <p className="panel-desc">
                    Supports storewide basket thresholds, daypart morning/evening promos, and clearance rules.
                  </p>
                </div>
              </div>
              <div className="stack-md" style={{ gap: 10 }}>
                <div className="field">
                  <label htmlFor="promo-name-input">Promotion Title</label>
                  <input
                    id="promo-name-input"
                    className="input"
                    placeholder="e.g., Morning Commuter $3 Off $25+"
                    value={promoName}
                    onChange={(e) => setPromoName(e.target.value)}
                  />
                </div>
                <div className="form-grid">
                  <div className="field">
                    <label>Promo Type</label>
                    <select
                      className="select"
                      value={promoType}
                      onChange={(e) =>
                        setPromoType(
                          e.target.value as
                            | "basket_threshold"
                            | "clearance"
                            | "bogo"
                            | "mix_and_match"
                            | "tier_price"
                        )
                      }
                    >
                      <option value="basket_threshold">Basket Threshold ($ Off)</option>
                      <option value="clearance">Clearance (% Off)</option>
                      <option value="tier_price">Tier Discount (% Off)</option>
                      <option value="bogo">Buy 2 Get 1 Free</option>
                      <option value="mix_and_match">Mix &amp; Match Bundle</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>Daypart Window</label>
                    <select
                      className="select"
                      value={promoDaypart}
                      onChange={(e) =>
                        setPromoDaypart(e.target.value as "all" | "morning" | "evening")
                      }
                    >
                      <option value="all">All Day</option>
                      <option value="morning">Morning (08:00–12:00)</option>
                      <option value="evening">Evening (17:00–21:00)</option>
                    </select>
                  </div>
                </div>
                {promoType === "basket_threshold" && (
                  <div className="form-grid">
                    <div className="field">
                      <label>Min Basket ($)</label>
                      <input
                        className="input mono"
                        value={promoMinBasketUsd}
                        onChange={(e) => setPromoMinBasketUsd(e.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label>Flat Discount ($)</label>
                      <input
                        className="input mono"
                        value={promoFlatDiscountUsd}
                        onChange={(e) => setPromoFlatDiscountUsd(e.target.value)}
                      />
                    </div>
                  </div>
                )}
                {(promoType === "clearance" || promoType === "tier_price") && (
                  <div className="field">
                    <label>Discount Percentage (%)</label>
                    <input
                      className="input mono"
                      type="number"
                      min={5}
                      max={80}
                      value={promoDiscountPct}
                      onChange={(e) => setPromoDiscountPct(Number(e.target.value) || 15)}
                    />
                  </div>
                )}
                <button
                  id="create-promo-btn"
                  className="btn btn-primary"
                  disabled={busy !== null}
                  onClick={() => void handleCreatePromo()}
                >
                  {busy === "promo" ? "Creating..." : "Publish Promotion to POS"}
                </button>
              </div>
            </section>
          )}
          </div>

          <section id="promo-roi-panel" className="panel" style={{ marginTop: 18 }}>
            <div className="panel-header">
              <div>
                <h2 className="panel-title">
                  Promotion ROI &amp; Margin Attribution (60-Day Python Analytics)
                </h2>
                <p className="panel-desc">
                  Measures incremental daily unit velocity lift vs. regular-price baseline and evaluates whether each campaign is profit-accretive or margin-dilutive.
                </p>
              </div>
            </div>
            {promoRoi.length === 0 ? (
              <div className="banner banner-amber">
                No promotion ROI rows computed yet — run the Python analytics worker to populate.
              </div>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Promotion</th>
                      <th className="text-right">Promo Units</th>
                      <th className="text-right">Base → Promo /Day</th>
                      <th className="text-right">Velocity Lift</th>
                      <th className="text-right">Discount Given</th>
                      <th className="text-right">Net Margin</th>
                      <th className="text-right">Est. Profit Δ</th>
                      <th>Verdict</th>
                    </tr>
                  </thead>
                  <tbody>
                    {promoRoi.map((r) => (
                      <tr key={r.promotionId}>
                        <td>
                          <div style={{ fontWeight: 600 }}>{r.promotionName}</div>
                          <div className="mono" style={{ fontSize: 11, color: "var(--ink-muted)" }}>
                            {r.promoType}
                          </div>
                        </td>
                        <td className="text-right mono">{r.discountedUnits60d}</td>
                        <td className="text-right mono">
                          {r.baselineDailyUnits.toFixed(1)} → {r.promoDailyUnits.toFixed(1)}
                        </td>
                        <td className="text-right mono">
                          {r.velocityLiftPct > 0 ? `+${r.velocityLiftPct}%` : `${r.velocityLiftPct}%`}
                        </td>
                        <td className="text-right mono">{formatMoney(r.discountGivenCents)}</td>
                        <td className="text-right mono">{formatBp(r.netMarginBp)}</td>
                        <td
                          className="text-right mono"
                          style={{
                            fontWeight: 700,
                            color:
                              r.estimatedProfitDeltaCents > 0
                                ? "var(--accent-primary)"
                                : r.estimatedProfitDeltaCents < 0
                                  ? "var(--accent-crimson)"
                                  : undefined,
                          }}
                        >
                          {r.estimatedProfitDeltaCents >= 0 ? "+" : ""}
                          {formatMoney(r.estimatedProfitDeltaCents)}
                        </td>
                        <td>
                          <span
                            className={`tag mono ${
                              r.verdict === "profit_accretive"
                                ? "tag-green"
                                : r.verdict === "margin_dilutive"
                                  ? "tag-red"
                                  : r.verdict === "margin_neutral"
                                    ? "tag-amber"
                                    : "tag-neutral"
                            }`}
                          >
                            {r.verdict}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
