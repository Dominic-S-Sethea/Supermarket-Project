import { useCallback, useEffect, useState } from "react";
import type { PaymentProviderKind, StoreSettingsDto } from "@supermarket/shared/dtos";
import { RefreshCw, Save, Store } from "lucide-react";
import { apiGet, apiPatch } from "../api";

export function StoreSettingsTab({
  onSaved,
}: {
  onSaved?: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const [storeName, setStoreName] = useState("");
  const [legalName, setLegalName] = useState("");
  const [address, setAddress] = useState("");
  const [taxId, setTaxId] = useState("");
  const [primaryCurrency, setPrimaryCurrency] = useState<"USD" | "EUR" | "THB" | "SGD">("USD");
  const [secondaryCurrency, setSecondaryCurrency] = useState<string>("KHR");
  const [secondaryFxRate, setSecondaryFxRate] = useState("4100");
  const [secondaryRoundingStep, setSecondaryRoundingStep] = useState("100");
  const [cashSkimLimitUsd, setCashSkimLimitUsd] = useState("500.00");
  const [receiptHeader, setReceiptHeader] = useState("");
  const [receiptFooter, setReceiptFooter] = useState("");

  const [defaultQrRail, setDefaultQrRail] = useState<"khqr" | "promptpay" | "paynow">("khqr");
  const [paymentProvider, setPaymentProvider] = useState<PaymentProviderKind>("mock_sandbox");
  const [khqrAccountId, setKhqrAccountId] = useState("");
  const [khqrMerchantId, setKhqrMerchantId] = useState("");
  const [khqrAcquiringBank, setKhqrAcquiringBank] = useState("");
  const [khqrCity, setKhqrCity] = useState("");
  const [promptpayProxy, setPromptpayProxy] = useState("");
  const [paynowUen, setPaynowUen] = useState("");
  const [thbFxRate, setThbFxRate] = useState("");
  const [sgdFxRate, setSgdFxRate] = useState("");
  const [existingRailRates, setExistingRailRates] = useState<Record<string, number>>({});
  const [fiscalProvider, setFiscalProvider] = useState<"local_hash_chain" | "fiskaly_tse">(
    "local_hash_chain"
  );

  const hydrate = useCallback((s: StoreSettingsDto) => {
    setStoreName(s.storeName);
    setLegalName(s.legalName);
    setAddress(s.address);
    setTaxId(s.taxId);
    setPrimaryCurrency(
      (["USD", "EUR", "THB", "SGD"].includes(s.primaryCurrency)
        ? s.primaryCurrency
        : "USD") as "USD" | "EUR" | "THB" | "SGD"
    );
    setSecondaryCurrency(s.secondaryCurrency ?? "");
    setSecondaryFxRate(String(s.secondaryFxRate));
    setSecondaryRoundingStep(String(s.secondaryRoundingStep));
    setCashSkimLimitUsd((s.cashSkimLimitCents / 100).toFixed(2));
    setReceiptHeader(s.receiptHeader);
    setReceiptFooter(s.receiptFooter);
    setDefaultQrRail(s.defaultQrRail);
    setPaymentProvider(s.paymentProvider);
    setKhqrAccountId(s.khqrAccountId);
    setKhqrMerchantId(s.khqrMerchantId ?? "");
    setKhqrAcquiringBank(s.khqrAcquiringBank);
    setKhqrCity(s.khqrCity);
    setPromptpayProxy(s.promptpayProxy);
    setPaynowUen(s.paynowUen);
    const rates = s.railFxRatesJson ?? {};
    setExistingRailRates(rates);
    setThbFxRate(typeof rates.THB === "number" ? String(rates.THB) : "");
    setSgdFxRate(typeof rates.SGD === "number" ? String(rates.SGD) : "");
    setFiscalProvider(s.fiscalProvider);
  }, []);

  const loadSettings = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiGet<{ settings: StoreSettingsDto }>("/api/store-settings", signal);
        if (!signal?.aborted) {
          hydrate(res.settings);
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setError(err instanceof Error ? err.message : "Failed loading flagship store settings.");
        }
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [hydrate]
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadSettings(controller.signal);
    return () => controller.abort();
  }, [loadSettings]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setError(null);
    setFeedback(null);

    const fxNum = Number(secondaryFxRate);
    const stepNum = Number(secondaryRoundingStep);
    const skimUsd = Number(cashSkimLimitUsd);
    if (!Number.isFinite(fxNum) || fxNum <= 0) {
      setError("Secondary currency FX rate must be a positive number.");
      return;
    }
    if (!Number.isFinite(stepNum) || stepNum < 1) {
      setError("Secondary currency rounding step must be at least 1.");
      return;
    }
    if (!Number.isFinite(skimUsd) || skimUsd < 10) {
      setError("Cash drawer skim limit must be at least $10.00.");
      return;
    }

    const nextRailRates: Record<string, number> = { ...existingRailRates };
    if (thbFxRate.trim()) {
      const thbNum = Number(thbFxRate);
      if (!Number.isFinite(thbNum) || thbNum <= 0) {
        setError("PromptPay THB FX rate must be a positive number.");
        return;
      }
      nextRailRates.THB = thbNum;
    } else {
      delete nextRailRates.THB;
    }
    if (sgdFxRate.trim()) {
      const sgdNum = Number(sgdFxRate);
      if (!Number.isFinite(sgdNum) || sgdNum <= 0) {
        setError("PayNow SGD FX rate must be a positive number.");
        return;
      }
      nextRailRates.SGD = sgdNum;
    } else {
      delete nextRailRates.SGD;
    }

    setSaving(true);
    try {
      const res = await apiPatch<{ settings: StoreSettingsDto }>("/api/store-settings", {
        storeName: storeName.trim(),
        legalName: legalName.trim(),
        address: address.trim(),
        taxId: taxId.trim(),
        primaryCurrency,
        secondaryCurrency: secondaryCurrency ? secondaryCurrency : null,
        secondaryFxRate: fxNum,
        secondaryRoundingStep: Math.round(stepNum),
        railFxRatesJson: Object.keys(nextRailRates).length > 0 ? nextRailRates : null,
        cashSkimLimitCents: Math.round(skimUsd * 100),
        receiptHeader: receiptHeader.trim(),
        receiptFooter: receiptFooter.trim(),
        defaultQrRail,
        paymentProvider,
        khqrAccountId: khqrAccountId.trim(),
        khqrMerchantId: khqrMerchantId.trim() ? khqrMerchantId.trim() : null,
        khqrAcquiringBank: khqrAcquiringBank.trim(),
        khqrCity: khqrCity.trim(),
        promptpayProxy: promptpayProxy.trim(),
        paynowUen: paynowUen.trim(),
        fiscalProvider,
      });
      hydrate(res.settings);
      setFeedback(
        `Saved store settings (${res.settings.primaryCurrency}${
          res.settings.secondaryCurrency
            ? ` + ${res.settings.secondaryCurrency} @ ${res.settings.secondaryFxRate.toLocaleString()}`
            : ""
        }, default rail ${res.settings.defaultQrRail.toUpperCase()}). POS bootstrap updated immediately.`
      );
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed saving store settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2 className="panel-title">
            <Store size={15} aria-hidden="true" style={{ verticalAlign: "middle", marginRight: 6 }} />
            Flagship Store Identity, Dual-Currency FX &amp; SE Asia EMVCo QR Rails
          </h2>
          <p className="panel-desc">
            Changes update PostgreSQL, write an immutable audit entry, and invalidate POS bootstrap ETags immediately across all lanes.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          disabled={loading || saving}
          onClick={() => void loadSettings()}
        >
          <RefreshCw size={13} aria-hidden="true" /> Reload
        </button>
      </div>

      {error && (
        <div className="banner banner-red" role="alert" style={{ marginBottom: 14 }}>
          <span>{error}</span>
          <button type="button" className="btn btn-sm" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {feedback && (
        <div id="store-settings-saved-banner" className="banner banner-green" role="status" style={{ marginBottom: 14 }}>
          <span>{feedback}</span>
          <button type="button" className="btn btn-sm" onClick={() => setFeedback(null)}>
            Dismiss
          </button>
        </div>
      )}

      {loading ? (
        <div style={{ padding: "16px 0", color: "var(--ink-muted)" }}>
          Loading flagship store configuration...
        </div>
      ) : (
        <form className="stack-md" onSubmit={(e) => void handleSave(e)}>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="settings-store-name">Flagship Store Name</label>
              <input
                id="settings-store-name"
                className="input"
                value={storeName}
                onChange={(e) => setStoreName(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="settings-legal-name">Legal Entity Name</label>
              <input
                id="settings-legal-name"
                className="input"
                value={legalName}
                onChange={(e) => setLegalName(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="settings-address">Store Street Address</label>
              <input
                id="settings-address"
                className="input"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="settings-tax-id">VAT / Tax Registration ID</label>
              <input
                id="settings-tax-id"
                className="input mono"
                value={taxId}
                onChange={(e) => setTaxId(e.target.value)}
                required
              />
            </div>
          </div>

          <div
            style={{
              padding: 14,
              borderRadius: 8,
              border: "1px solid var(--border-hairline)",
              background: "var(--bg-canvas)",
            }}
          >
            <h3 style={{ margin: "0 0 10px", fontSize: 13.5 }}>
              Dual-Currency Cash &amp; Drawer Skim Thresholds
            </h3>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="settings-primary-currency">Primary Ledger Currency</label>
                <select
                  id="settings-primary-currency"
                  className="select"
                  value={primaryCurrency}
                  onChange={(e) =>
                    setPrimaryCurrency(e.target.value as "USD" | "EUR" | "THB" | "SGD")
                  }
                >
                  <option value="USD">USD ($)</option>
                  <option value="EUR">EUR (€)</option>
                  <option value="THB">THB (฿)</option>
                  <option value="SGD">SGD (S$)</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="settings-secondary-currency">Secondary Cash Currency</label>
                <select
                  id="settings-secondary-currency"
                  className="select"
                  value={secondaryCurrency}
                  onChange={(e) => setSecondaryCurrency(e.target.value)}
                >
                  <option value="KHR">KHR (Cambodian Riel ៛)</option>
                  <option value="THB">THB (Thai Baht ฿)</option>
                  <option value="USD">USD (US Dollar $)</option>
                  <option value="EUR">EUR (Euro €)</option>
                  <option value="">Disabled (Single Currency)</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="settings-fx-rate">
                  Exchange Rate (1 {primaryCurrency} = X {secondaryCurrency || "Secondary"})
                </label>
                <input
                  id="settings-fx-rate"
                  type="number"
                  step="any"
                  min="0.01"
                  className="input mono"
                  value={secondaryFxRate}
                  onChange={(e) => setSecondaryFxRate(e.target.value)}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="settings-rounding-step">Secondary Currency Rounding Step</label>
                <input
                  id="settings-rounding-step"
                  type="number"
                  step="1"
                  min="1"
                  className="input mono"
                  value={secondaryRoundingStep}
                  onChange={(e) => setSecondaryRoundingStep(e.target.value)}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="settings-skim-limit">Cash Drawer Skim Alert Limit ({primaryCurrency})</label>
                <input
                  id="settings-skim-limit"
                  type="number"
                  step="0.01"
                  min="10"
                  className="input mono"
                  value={cashSkimLimitUsd}
                  onChange={(e) => setCashSkimLimitUsd(e.target.value)}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="settings-fiscal-provider">Fiscal Signing Mode (Milestone 3)</label>
                <select
                  id="settings-fiscal-provider"
                  className="select"
                  value={fiscalProvider}
                  onChange={(e) =>
                    setFiscalProvider(e.target.value as "local_hash_chain" | "fiskaly_tse")
                  }
                >
                  <option value="local_hash_chain">Local Hash-Chained Ledger (Default)</option>
                  <option value="fiskaly_tse">EU KassenSichV / Fiskaly Cloud TSE</option>
                </select>
              </div>
            </div>
          </div>

          <div
            style={{
              padding: 14,
              borderRadius: 8,
              border: "1px solid var(--border-hairline)",
              background: "var(--bg-canvas)",
            }}
          >
            <h3 style={{ margin: "0 0 10px", fontSize: 13.5 }}>
              SE Asia EMVCo Dynamic QR Merchant Identifiers
            </h3>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="settings-default-qr-rail">Default POS QR Rail</label>
                <select
                  id="settings-default-qr-rail"
                  className="select"
                  value={defaultQrRail}
                  onChange={(e) =>
                    setDefaultQrRail(e.target.value as "khqr" | "promptpay" | "paynow")
                  }
                >
                  <option value="khqr">KHQR (Cambodia Bakong)</option>
                  <option value="promptpay">PromptPay (Thailand BOT)</option>
                  <option value="paynow">PayNow (Singapore ABS)</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="settings-payment-provider">Payment Settlement Provider</label>
                <select
                  id="settings-payment-provider"
                  className="select"
                  value={paymentProvider}
                  onChange={(e) => setPaymentProvider(e.target.value as PaymentProviderKind)}
                >
                  <option value="mock_sandbox">EMVCo Sandbox (Instant Simulate / Webhook)</option>
                  <option value="bakong_khqr">NBC Bakong KHQR Open API</option>
                  <option value="promptpay_gateway">Thailand PromptPay Acquirer Gateway</option>
                  <option value="paynow_gateway">Singapore PayNow Corporate Gateway</option>
                  <option value="stripe_terminal">Stripe Terminal / Card Reader</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="settings-khqr-account">KHQR Bakong Account ID</label>
                <input
                  id="settings-khqr-account"
                  className="input mono"
                  value={khqrAccountId}
                  onChange={(e) => setKhqrAccountId(e.target.value)}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="settings-khqr-merchant">KHQR Merchant ID (Optional)</label>
                <input
                  id="settings-khqr-merchant"
                  className="input mono"
                  value={khqrMerchantId}
                  onChange={(e) => setKhqrMerchantId(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="settings-khqr-bank">KHQR Acquiring Bank</label>
                <input
                  id="settings-khqr-bank"
                  className="input"
                  value={khqrAcquiringBank}
                  onChange={(e) => setKhqrAcquiringBank(e.target.value)}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="settings-khqr-city">Merchant City</label>
                <input
                  id="settings-khqr-city"
                  className="input"
                  value={khqrCity}
                  onChange={(e) => setKhqrCity(e.target.value)}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="settings-promptpay-proxy">Thailand PromptPay Proxy (Phone / Tax ID)</label>
                <input
                  id="settings-promptpay-proxy"
                  className="input mono"
                  value={promptpayProxy}
                  onChange={(e) => setPromptpayProxy(e.target.value)}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="settings-paynow-uen">Singapore PayNow UEN</label>
                <input
                  id="settings-paynow-uen"
                  className="input mono"
                  value={paynowUen}
                  onChange={(e) => setPaynowUen(e.target.value)}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="settings-thb-fx">
                  PromptPay Cross-Border FX (1 {primaryCurrency} = X THB, optional)
                </label>
                <input
                  id="settings-thb-fx"
                  type="number"
                  step="any"
                  min="0.01"
                  placeholder="e.g. 35.0"
                  className="input mono"
                  value={thbFxRate}
                  onChange={(e) => setThbFxRate(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="settings-sgd-fx">
                  PayNow Cross-Border FX (1 {primaryCurrency} = X SGD, optional)
                </label>
                <input
                  id="settings-sgd-fx"
                  type="number"
                  step="any"
                  min="0.01"
                  placeholder="e.g. 1.35"
                  className="input mono"
                  value={sgdFxRate}
                  onChange={(e) => setSgdFxRate(e.target.value)}
                />
              </div>
            </div>
          </div>

          <div className="form-grid">
            <div className="field">
              <label htmlFor="settings-receipt-header">80mm Receipt &amp; CFD Header Line</label>
              <input
                id="settings-receipt-header"
                className="input"
                value={receiptHeader}
                onChange={(e) => setReceiptHeader(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="settings-receipt-footer">80mm Receipt &amp; CFD Footer Message</label>
              <input
                id="settings-receipt-footer"
                className="input"
                value={receiptFooter}
                onChange={(e) => setReceiptFooter(e.target.value)}
              />
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              id="save-store-settings-btn"
              type="submit"
              className="btn btn-primary"
              disabled={saving}
            >
              <Save size={14} aria-hidden="true" />{" "}
              {saving ? "Saving Settings..." : "Save Store & QR Rail Settings"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
