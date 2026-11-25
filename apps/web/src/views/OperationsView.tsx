import { useEffect, useState } from "react";
import {
  computeEffectiveUnitCostCents,
  formatBp,
  formatMoney,
  type UserRole,
} from "@supermarket/shared";
import { AlertTriangle, Award, Check, ClipboardList, FileUp, Ghost, PackageCheck, Percent, Search, Sparkles, Trash2 } from "lucide-react";
import { apiGet, apiPost } from "../api";
import { FloorTasksTab } from "../components/FloorTasksTab";
import { ShelfIntegrityTab } from "../components/ShelfIntegrityTab";
import { SupplierMatchTab } from "../components/SupplierMatchTab";

interface MarginAlert {
  id: string;
  productId: string;
  sku: string;
  name: string;
  brand: string;
  previousCostCents: number;
  newCostCents: number;
  currentSellPriceCents: number;
  resultingMarginBp: number;
  minMarginBp: number;
  suggestedSellPriceCents: number;
}

interface ExpiryBatch {
  batchId: string;
  productId: string;
  sku: string;
  name: string;
  brand: string;
  departmentName: string;
  aisleLocation: string;
  lotCode: string;
  bestBeforeDate: string;
  qtyRemaining: number;
  unitCostCents: number;
  atRiskCostCents: number;
  daysLeft: number;
  status: string;
}

interface SupplierOption {
  id: string;
  name: string;
}

interface ProductPick {
  id: string;
  sku: string;
  name: string;
  avgCostCents: number;
  primarySellPriceCents: number;
}

interface ParsedInvoiceResponse {
  mode: string;
  model: string;
  note: string | null;
  supplierId: string | null;
  supplierName: string;
  invoiceNumber: string;
  lines: {
    description: string;
    caseQty: number;
    paidCases: number;
    freeBonusCases: number;
    invoiceLineTotalCents: number;
    bestBeforeDate: string;
    matchedProductId: string | null;
    matchedSku: string | null;
    matchedName: string | null;
    currentAvgCostCents: number;
    effectiveUnitCostCents: number;
    costDeltaPct: number;
    matchConfidence: number;
  }[];
  triage: {
    model: string;
    summary: string;
    recommendedAction: string;
    questions: { label: string; probability: number; confidence: number; verdict: string }[];
  };
}

type OpsSubTab = "receiving" | "shelf" | "tasks" | "suppliers";

export function OperationsView({
  suppliers,
  userRole = "owner",
  onCountsChanged,
}: {
  suppliers: SupplierOption[];
  userRole?: UserRole;
  onCountsChanged?: () => void;
}) {
  const canManage = userRole === "owner" || userRole === "manager";
  const [subTab, setSubTab] = useState<OpsSubTab>("receiving");

  const [marginAlerts, setMarginAlerts] = useState<MarginAlert[]>([]);
  const [expiryBatches, setExpiryBatches] = useState<ExpiryBatch[]>([]);
  const [horizonDays, setHorizonDays] = useState(45);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [skuSearch, setSkuSearch] = useState("");
  const [productOptions, setProductOptions] = useState<ProductPick[]>([]);
  const [selectedProdId, setSelectedProdId] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // GRN Bonus-Case Receiving Form
  const [supplierId, setSupplierId] = useState(suppliers[0]?.id ?? "");
  const [invoiceNo, setInvoiceNo] = useState(
    `INV-${new Date().getFullYear()}-${String(Math.floor(10000 + Math.random() * 89999))}`
  );
  const [caseQty, setCaseQty] = useState(24);
  const [paidCases, setPaidCases] = useState(10);
  const [freeBonusCases, setFreeBonusCases] = useState(1);
  const [invoiceTotalUsd, setInvoiceTotalUsd] = useState("288.00");
  const [bestBefore, setBestBefore] = useState(
    new Date(Date.now() + 180 * 86400_000).toISOString().slice(0, 10)
  );
  const [scanningInvoice, setScanningInvoice] = useState(false);
  const [scannedInvoice, setScannedInvoice] = useState<ParsedInvoiceResponse | null>(null);

  // Keep supplier selection hydrated once metadata arrives asynchronously
  useEffect(() => {
    if (!supplierId && suppliers.length > 0) {
      setSupplierId(suppliers[0].id);
    }
  }, [suppliers, supplierId]);

  const loadAll = async (days = horizonDays, signal?: AbortSignal) => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const [ma, exp] = await Promise.all([
        canManage
          ? apiGet<{ alerts: MarginAlert[] }>("/api/inventory/margin-alerts", signal)
          : Promise.resolve({ alerts: [] }),
        apiGet<{ items: ExpiryBatch[] }>(`/api/inventory/expiry-alerts?days=${days}`, signal),
      ]);
      if (signal?.aborted) return;
      setMarginAlerts(ma.alerts);
      setExpiryBatches(exp.items);
      onCountsChanged?.();
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setErrorMsg(err instanceof Error ? err.message : "Failed loading operations data");
      }
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void loadAll(horizonDays, controller.signal);
    return () => controller.abort();
  }, [horizonDays, canManage]);

  // Searchable 3,120-SKU picker for GRN receiving (manager/owner only)
  useEffect(() => {
    if (!canManage) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const qs = new URLSearchParams({ page: "1", pageSize: "20" });
          if (skuSearch.trim()) qs.set("search", skuSearch.trim());
          const res = await apiGet<{ items: ProductPick[] }>(
            `/api/products?${qs.toString()}`,
            controller.signal
          );
          if (controller.signal.aborted) return;
          setProductOptions(res.items);
          if (res.items.length > 0 && !res.items.some((i) => i.id === selectedProdId)) {
            setSelectedProdId(res.items[0].id);
          }
        } catch (err) {
          if ((err as Error).name !== "AbortError") {
            setErrorMsg(err instanceof Error ? err.message : "Failed searching SKUs");
          }
        }
      })();
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [skuSearch, canManage]);

  const paidUnits = paidCases * caseQty;
  const freeUnits = freeBonusCases * caseQty;
  const parsedInvoice = Number(invoiceTotalUsd);
  const invoiceCents = Number.isFinite(parsedInvoice) && parsedInvoice >= 0 ? Math.round(parsedInvoice * 100) : 0;
  const effectiveUnitCost = computeEffectiveUnitCostCents(invoiceCents, paidUnits, freeUnits);
  const paidOnlyCost = paidUnits > 0 ? Math.round(invoiceCents / paidUnits) : 0;

  const handleApplySuggestedPrice = async (alertId: string, sku: string) => {
    if (busyAction) return;
    setErrorMsg(null);
    setBusyAction(`price-${alertId}`);
    try {
      const res = await apiPost<{ newSellPriceCents: number; updatedPackTiers?: number }>(
        `/api/inventory/margin-alerts/${alertId}/apply-price`,
        {}
      );
      setFeedback(
        `Updated ${sku} shelf price to ${formatMoney(res.newSellPriceCents)} (scaled ${res.updatedPackTiers ?? 1} barcode tiers) and resolved alert.`
      );
      await loadAll();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed updating price");
    } finally {
      setBusyAction(null);
    }
  };

  const handleBatchAction = async (
    batchId: string,
    action: "clearance" | "write_off",
    sku: string
  ) => {
    if (busyAction) return;
    setErrorMsg(null);
    setBusyAction(`batch-${batchId}-${action}`);
    try {
      await apiPost(`/api/inventory/batches/${batchId}/action`, {
        action,
        discountPct: 30,
      });
      setFeedback(
        action === "clearance"
          ? `Marked batch for ${sku} as 30% Clearance Markdown.`
          : `Wrote off expired ${sku} batch to immutable spoilage ledger.`
      );
      await loadAll();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed updating batch");
    } finally {
      setBusyAction(null);
    }
  };

  const handlePostGrn = async () => {
    if (busyAction) return;
    setErrorMsg(null);
    if (!supplierId || !selectedProdId) {
      setErrorMsg("Select both a supplier and a product before posting a GRN.");
      return;
    }
    if (!invoiceNo.trim()) {
      setErrorMsg("Enter a supplier invoice number before posting a GRN.");
      return;
    }
    if (!Number.isFinite(parsedInvoice) || parsedInvoice < 0) {
      setErrorMsg("Invoice total must be a valid non-negative USD amount.");
      return;
    }
    if (paidUnits + freeUnits <= 0) {
      setErrorMsg("Paid cases + free bonus cases must be greater than 0.");
      return;
    }
    setBusyAction("grn");
    try {
      const res = await apiPost<{
        grnId: string;
        marginAlertsTriggered: number;
      }>("/api/purchasing/grn", {
        supplierId,
        invoiceNumber: invoiceNo.trim(),
        lines: [
          {
            productId: selectedProdId,
            caseQty,
            paidCases,
            freeBonusCases,
            invoiceLineTotalCents: invoiceCents,
            bestBeforeDate: bestBefore || undefined,
          },
        ],
      });
      setInvoiceNo(
        `INV-${new Date().getFullYear()}-${String(Math.floor(10000 + Math.random() * 89999))}`
      );
      setFeedback(
        `Posted GRN (+${paidUnits + freeUnits} base units added to ledger, effective cost ${formatMoney(effectiveUnitCost)}/unit). Margin alerts triggered: ${res.marginAlertsTriggered}.`
      );
      await loadAll();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed posting GRN");
    } finally {
      setBusyAction(null);
    }
  };

  const handleInvoiceFileUpload = async (file: File) => {
    setErrorMsg(null);
    setScanningInvoice(true);
    try {
      const lowerName = file.name.toLowerCase();
      const isText =
        file.type.startsWith("text/") ||
        lowerName.endsWith(".txt") ||
        lowerName.endsWith(".csv");
      if (isText) {
        const textContent = await file.text();
        const res = await apiPost<ParsedInvoiceResponse>("/api/ai/grn/parse-invoice", {
          fileName: file.name,
          mimeType: lowerName.endsWith(".csv") ? "text/csv" : file.type || "text/plain",
          textContent,
        });
        setScannedInvoice(res);
      } else {
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const base64Data = btoa(binary);
        const res = await apiPost<ParsedInvoiceResponse>("/api/ai/grn/parse-invoice", {
          fileName: file.name,
          mimeType: file.type || "image/png",
          base64Data,
        });
        setScannedInvoice(res);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed scanning supplier invoice");
    } finally {
      setScanningInvoice(false);
    }
  };

  const handleSampleInvoiceScan = async () => {
    setErrorMsg(null);
    setScanningInvoice(true);
    try {
      const sampleProd = productOptions[0];
      const sampleText = [
        `Supplier: ${suppliers[0]?.name ?? "Summit Brewing & Beer Supply"}`,
        `Invoice: INV-2026-99142`,
        `Date: ${new Date().toISOString().slice(0, 10)}`,
        `${sampleProd?.sku ?? "BEER-0001"} ${sampleProd?.name ?? "Heineken Original"} | 24 | 10 | 1 | 315.00 | ${new Date(Date.now() + 150 * 86400_000).toISOString().slice(0, 10)}`,
      ].join("\n");
      const res = await apiPost<ParsedInvoiceResponse>("/api/ai/grn/parse-invoice", {
        fileName: "sample-distributor-invoice.txt",
        mimeType: "text/plain",
        textContent: sampleText,
      });
      setScannedInvoice(res);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed scanning sample invoice");
    } finally {
      setScanningInvoice(false);
    }
  };

  const applyScannedLineToGrn = (line: ParsedInvoiceResponse["lines"][number]) => {
    if (!scannedInvoice) return;
    if (scannedInvoice.supplierId) setSupplierId(scannedInvoice.supplierId);
    setInvoiceNo(scannedInvoice.invoiceNumber);
    if (line.matchedProductId) {
      setSelectedProdId(line.matchedProductId);
      setSkuSearch(line.matchedSku ?? "");
    }
    setCaseQty(line.caseQty);
    setPaidCases(line.paidCases);
    setFreeBonusCases(line.freeBonusCases);
    setInvoiceTotalUsd((line.invoiceLineTotalCents / 100).toFixed(2));
    setBestBefore(line.bestBeforeDate);
    setFeedback(
      `Loaded ${line.matchedSku ?? line.description} from AI Invoice Scanner into the GRN form.`
    );
  };

  const totalAtRiskCents = expiryBatches.reduce((s, b) => s + b.atRiskCostCents, 0);

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>Receiving (GRN), FEFO Expiry &amp; Operations</h1>
          <p className="page-subtitle">
            {canManage
              ? "Protect your 1–3% supermarket net profit across receiving, vendor OTIF scorecards, 3-way dock variance matching, and FEFO expiry control."
              : "Monitor FEFO Best-Before batches across aisles and flag near-expiry stock for Store Manager clearance or write-off."}
          </p>
        </div>
        <div className="subtab-bar" role="tablist">
          <button
            id="ops-subtab-receiving"
            role="tab"
            aria-selected={subTab === "receiving"}
            className={`subtab-btn ${subTab === "receiving" ? "active" : ""}`}
            onClick={() => setSubTab("receiving")}
          >
            <PackageCheck size={14} /> Receiving &amp; FEFO
          </button>
          <button
            id="ops-subtab-shelf"
            role="tab"
            aria-selected={subTab === "shelf"}
            className={`subtab-btn ${subTab === "shelf" ? "active" : ""}`}
            onClick={() => setSubTab("shelf")}
          >
            <Ghost size={14} /> Shelf Integrity &amp; 07:30 Tags
          </button>
          <button
            id="ops-subtab-tasks"
            role="tab"
            aria-selected={subTab === "tasks"}
            className={`subtab-btn ${subTab === "tasks" ? "active" : ""}`}
            onClick={() => setSubTab("tasks")}
          >
            <ClipboardList size={14} /> Daily Floor Tasks
          </button>
          {canManage && (
            <button
              id="ops-subtab-suppliers"
              role="tab"
              aria-selected={subTab === "suppliers"}
              className={`subtab-btn ${subTab === "suppliers" ? "active" : ""}`}
              onClick={() => setSubTab("suppliers")}
            >
              <Award size={14} /> Supplier OTIF &amp; 3-Way Match
            </button>
          )}
        </div>
      </header>

      {!canManage && (
        <div className="banner banner-amber" style={{ marginBottom: 14 }}>
          <span>
            Signed in as <strong className="mono">{userRole}</strong>: FEFO expiry monitoring, phantom stock blind counts, 07:30 shelf tag batch printing, and daily floor checklist completion are enabled. GRN receiving, markdown approvals, and price overrides require Store Manager or Owner approval.
          </span>
        </div>
      )}

      {errorMsg && (
        <div className="banner banner-red" style={{ marginBottom: 14 }}>
          <span>{errorMsg}</span>
          <button className="btn btn-sm" onClick={() => setErrorMsg(null)}>
            Dismiss
          </button>
        </div>
      )}

      {feedback && (
        <div className="banner banner-green" style={{ marginBottom: 16 }}>
          <span>{feedback}</span>
          <button className="btn btn-sm" onClick={() => setFeedback(null)}>
            Dismiss
          </button>
        </div>
      )}

      {subTab === "suppliers" && canManage ? (
        <SupplierMatchTab
          canManage={canManage}
          onFeedback={(msg) => {
            setErrorMsg(null);
            setFeedback(msg);
          }}
          onError={(msg) => setErrorMsg(msg)}
        />
      ) : subTab === "shelf" ? (
        <ShelfIntegrityTab
          canManage={canManage}
          onFeedback={(msg) => {
            setErrorMsg(null);
            setFeedback(msg);
            onCountsChanged?.();
          }}
          onError={(msg) => setErrorMsg(msg)}
        />
      ) : subTab === "tasks" ? (
        <FloorTasksTab
          onFeedback={(msg) => {
            setErrorMsg(null);
            setFeedback(msg);
          }}
          onError={(msg) => setErrorMsg(msg)}
        />
      ) : (
        <>
          {canManage && (
        <>
          {/* Multimodal AI Invoice -> GRN Scanner */}
          <section className="panel" style={{ marginBottom: 20 }}>
            <div className="panel-header">
              <div>
                <h2 className="panel-title">
                  <Sparkles size={15} style={{ verticalAlign: "middle", marginRight: 6, color: "var(--accent-primary)" }} />
                  Multimodal AI Supplier Invoice → GRN Scanner
                </h2>
                <p className="panel-desc">
                  Upload a distributor invoice image, PDF, CSV, or delivery note to extract paid + free bonus cases, match SKUs, and run calibrated cost-creep triage.
                </p>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <label className="btn btn-sm" style={{ cursor: "pointer" }}>
                  <FileUp size={13} /> {scanningInvoice ? "Scanning..." : "Upload Invoice (PNG/PDF/CSV/TXT)"}
                  <input
                    type="file"
                    accept=".png,.jpg,.jpeg,.webp,.pdf,.txt,.csv"
                    style={{ display: "none" }}
                    disabled={scanningInvoice}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (file) void handleInvoiceFileUpload(file);
                    }}
                  />
                </label>
                <button
                  id="scan-sample-invoice-btn"
                  className="btn btn-primary btn-sm"
                  disabled={scanningInvoice}
                  onClick={() => void handleSampleInvoiceScan()}
                >
                  <Sparkles size={13} /> Try Sample Invoice
                </button>
              </div>
            </div>

            {scannedInvoice && (
              <div className="stack-md" style={{ gap: 12 }}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <span className="tag tag-green mono">{scannedInvoice.model}</span>
                  <span className="tag tag-neutral">
                    {scannedInvoice.supplierName} · {scannedInvoice.invoiceNumber}
                  </span>
                  {scannedInvoice.note && (
                    <span className="tag tag-amber">{scannedInvoice.note}</span>
                  )}
                </div>

                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Extracted Item → Catalog Match</th>
                        <th className="text-right">Paid + Bonus</th>
                        <th className="text-right">Line Total</th>
                        <th className="text-right">Eff. Unit Cost</th>
                        <th className="text-right">Cost Delta</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {scannedInvoice.lines.map((l, idx) => (
                        <tr key={`${l.description}-${idx}`}>
                          <td>
                            <div style={{ fontWeight: 600 }}>
                              {l.matchedSku ? `${l.matchedSku} — ${l.matchedName}` : l.description}
                            </div>
                            <div style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                              Confidence {Math.round(l.matchConfidence * 100)}% · BBD {l.bestBeforeDate}
                            </div>
                          </td>
                          <td className="text-right mono">
                            {l.paidCases} + {l.freeBonusCases} free (×{l.caseQty})
                          </td>
                          <td className="text-right mono">{formatMoney(l.invoiceLineTotalCents)}</td>
                          <td className="text-right mono">{formatMoney(l.effectiveUnitCostCents)}</td>
                          <td className="text-right">
                            <span className={`tag mono ${l.costDeltaPct > 8 ? "tag-red" : "tag-green"}`}>
                              {l.costDeltaPct > 0 ? `+${l.costDeltaPct}%` : `${l.costDeltaPct}%`}
                            </span>
                          </td>
                          <td className="text-right">
                            <button
                              className="btn btn-primary btn-sm"
                              onClick={() => applyScannedLineToGrn(l)}
                            >
                              Load into GRN Form
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="triage-box">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <strong style={{ fontSize: 12.5 }}>
                      Calibrated Invoice Discrepancy Triage ({scannedInvoice.triage.model})
                    </strong>
                    <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-secondary)" }}>
                      {scannedInvoice.triage.summary}
                    </span>
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--ink-primary)", marginTop: 4 }}>
                    {scannedInvoice.triage.recommendedAction}
                  </div>
                </div>
              </div>
            )}
          </section>

          <div className="grid-asymmetric">
            {/* Margin Erosion Alerts */}
            <section className="panel">
              <div className="panel-header">
                <div>
                  <h2 className="panel-title">
                    <AlertTriangle size={15} style={{ verticalAlign: "middle", marginRight: 6, color: "var(--accent-crimson)" }} />
                    Active Vendor Margin-Erosion Alerts ({marginAlerts.length})
                  </h2>
                  <p className="panel-desc">
                    Triggered automatically on Goods Receipt when a distributor cost increase compresses tax-exclusive net margin below category floor.
                  </p>
                </div>
              </div>

              {loading && marginAlerts.length === 0 ? (
                <div style={{ color: "var(--ink-muted)", padding: "12px 0" }}>
                  Loading margin alerts...
                </div>
              ) : marginAlerts.length === 0 ? (
                <div className="banner banner-green">
                  All product retail prices currently meet target margin floors!
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>SKU / Product</th>
                        <th className="text-right">Old → New Cost</th>
                        <th className="text-right">Current Price</th>
                        <th className="text-right">Compressed Margin</th>
                        <th className="text-right">Suggested Price</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {marginAlerts.map((a) => (
                        <tr key={a.id}>
                          <td>
                            <div style={{ fontWeight: 600 }}>{a.name}</div>
                            <div className="mono" style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                              {a.sku} · Floor {formatBp(a.minMarginBp)}
                            </div>
                          </td>
                          <td className="text-right mono">
                            {formatMoney(a.previousCostCents)} →{" "}
                            <strong style={{ color: "var(--accent-crimson)" }}>
                              {formatMoney(a.newCostCents)}
                            </strong>
                          </td>
                          <td className="text-right mono">{formatMoney(a.currentSellPriceCents)}</td>
                          <td className="text-right">
                            <span className="tag tag-red mono">{formatBp(a.resultingMarginBp)}</span>
                          </td>
                          <td className="text-right mono" style={{ fontWeight: 700, color: "var(--accent-primary)" }}>
                            {formatMoney(a.suggestedSellPriceCents)}
                          </td>
                          <td className="text-right">
                            <button
                              className="btn btn-primary btn-sm"
                              disabled={busyAction !== null}
                              onClick={() => void handleApplySuggestedPrice(a.id, a.sku)}
                            >
                              <Check size={13} />{" "}
                              {busyAction === `price-${a.id}` ? "Applying..." : "Apply Price"}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* Bonus-Case GRN Receiving Builder */}
            <section className="panel">
              <div className="panel-header">
                <div>
                  <h2 className="panel-title">
                    <PackageCheck size={15} style={{ verticalAlign: "middle", marginRight: 6 }} />
                    Receive Goods (GRN + Free Bonus Cases)
                  </h2>
                  <p className="panel-desc">
                    Supports distributor &ldquo;Buy 10 Cases Get 1 Free&rdquo; rebates and computes true effective unit cost + MWAC.
                  </p>
                </div>
              </div>

              <div className="stack-md" style={{ gap: 11 }}>
                <div className="field">
                  <label>Supplier &amp; Invoice #</label>
                  <div className="form-grid">
                    <select
                      className="select"
                      value={supplierId}
                      onChange={(e) => setSupplierId(e.target.value)}
                      disabled={busyAction !== null}
                    >
                      {suppliers.length === 0 ? (
                        <option value="">Loading suppliers...</option>
                      ) : (
                        suppliers.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))
                      )}
                    </select>
                    <input
                      className="input mono"
                      value={invoiceNo}
                      onChange={(e) => setInvoiceNo(e.target.value)}
                      disabled={busyAction !== null}
                    />
                  </div>
                </div>

                <div className="field">
                  <label>Search &amp; Select Any of 3,120+ SKUs</label>
                  <div className="search-box" style={{ maxWidth: "100%", marginBottom: 6 }}>
                    <Search size={14} className="search-icon" />
                    <input
                      id="grn-sku-search"
                      className="input"
                      placeholder="Filter by SKU, brand, product, or barcode..."
                      value={skuSearch}
                      onChange={(e) => setSkuSearch(e.target.value)}
                    />
                  </div>
                  <select
                    className="select"
                    value={selectedProdId}
                    onChange={(e) => setSelectedProdId(e.target.value)}
                    disabled={busyAction !== null}
                  >
                    {productOptions.length === 0 ? (
                      <option value="">No matching SKUs found</option>
                    ) : (
                      productOptions.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.sku} — {p.name} (Cost {formatMoney(p.avgCostCents)})
                        </option>
                      ))
                    )}
                  </select>
                </div>

                <div className="form-grid">
                  <div className="field">
                    <label>Units per Case</label>
                    <input
                      className="input mono"
                      type="number"
                      min={1}
                      value={caseQty}
                      onChange={(e) => setCaseQty(Math.max(1, Math.trunc(Number(e.target.value) || 1)))}
                      disabled={busyAction !== null}
                    />
                  </div>
                  <div className="field">
                    <label>Invoice Line Total ($)</label>
                    <input
                      className="input mono"
                      value={invoiceTotalUsd}
                      onChange={(e) => setInvoiceTotalUsd(e.target.value)}
                      disabled={busyAction !== null}
                    />
                  </div>
                  <div className="field">
                    <label>Paid Cases</label>
                    <input
                      className="input mono"
                      type="number"
                      min={0}
                      value={paidCases}
                      onChange={(e) => setPaidCases(Math.max(0, Math.trunc(Number(e.target.value) || 0)))}
                      disabled={busyAction !== null}
                    />
                  </div>
                  <div className="field">
                    <label>Free Bonus Cases</label>
                    <input
                      className="input mono"
                      type="number"
                      min={0}
                      value={freeBonusCases}
                      onChange={(e) => setFreeBonusCases(Math.max(0, Math.trunc(Number(e.target.value) || 0)))}
                      disabled={busyAction !== null}
                    />
                  </div>
                </div>

                <div className="field">
                  <label>Carton Best-Before Date (FEFO Batch)</label>
                  <input
                    className="input mono"
                    type="date"
                    value={bestBefore}
                    onChange={(e) => setBestBefore(e.target.value)}
                    disabled={busyAction !== null}
                  />
                </div>

                <div className="totals-box">
                  <div className="total-row">
                    <span>Total Base Units Added</span>
                    <strong className="mono">
                      +{paidUnits + freeUnits} ({paidUnits} paid + {freeUnits} bonus)
                    </strong>
                  </div>
                  <div className="total-row">
                    <span>Invoice Cost / Paid Unit</span>
                    <span className="mono">{formatMoney(paidOnlyCost)}</span>
                  </div>
                  <div className="total-row" style={{ color: "var(--accent-primary)", fontWeight: 700 }}>
                    <span>True Effective Unit Cost (incl. Free Cases)</span>
                    <span className="mono">{formatMoney(effectiveUnitCost)}</span>
                  </div>
                </div>

                <button
                  id="post-grn-btn"
                  className="btn btn-primary"
                  disabled={busyAction !== null || !supplierId || !selectedProdId}
                  onClick={() => void handlePostGrn()}
                >
                  {busyAction === "grn"
                    ? "Posting GRN..."
                    : "Post GRN to Stock Ledger & Check Margin"}
                </button>
              </div>
            </section>
          </div>
        </>
      )}

      {/* FEFO Best-Before Expiry Console */}
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2 className="panel-title">
              FEFO Packaged Best-Before Expiry Action Queue ({expiryBatches.length} Batches ·{" "}
              <span className="mono">{formatMoney(totalAtRiskCents)}</span> at risk)
            </h2>
            <p className="panel-desc">
              Spot slow-moving beer, beverages, snacks, and noodles approaching Best-Before date early enough to recover cash via clearance discounts.
            </p>
          </div>
          <select
            className="select"
            value={horizonDays}
            onChange={(e) => setHorizonDays(Number(e.target.value))}
          >
            <option value={14}>Expiring within 14 days</option>
            <option value={30}>Expiring within 30 days</option>
            <option value={45}>Expiring within 45 days</option>
            <option value={60}>Expiring within 60 days</option>
          </select>
        </div>

        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Days Left</th>
                <th>Product &amp; Aisle</th>
                <th>Lot / Best-Before</th>
                <th>Status</th>
                <th className="text-right">Remaining Qty</th>
                <th className="text-right">At-Risk Cost</th>
                {canManage && <th className="text-right">Action</th>}
              </tr>
            </thead>
            <tbody>
              {loading && expiryBatches.length === 0 ? (
                <tr>
                  <td colSpan={canManage ? 7 : 6}>Loading FEFO expiry batches...</td>
                </tr>
              ) : expiryBatches.length === 0 ? (
                <tr>
                  <td
                    colSpan={canManage ? 7 : 6}
                    style={{ textAlign: "center", color: "var(--ink-muted)", padding: "20px 12px" }}
                  >
                    No packaged batches expiring within {horizonDays} days.
                  </td>
                </tr>
              ) : (
                expiryBatches.slice(0, 35).map((b) => (
                  <tr key={b.batchId}>
                    <td>
                      <span
                        className={`tag mono ${
                          b.daysLeft <= 14 ? "tag-red" : b.daysLeft <= 30 ? "tag-amber" : "tag-neutral"
                        }`}
                      >
                        {b.daysLeft}d
                      </span>
                    </td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{b.name}</div>
                      <div style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                        {b.sku} · {b.departmentName} · Aisle {b.aisleLocation}
                      </div>
                    </td>
                    <td className="mono">
                      <div>{b.bestBeforeDate}</div>
                      <div style={{ fontSize: 11, color: "var(--ink-muted)" }}>{b.lotCode}</div>
                    </td>
                    <td>
                      <span className={`tag ${b.status === "clearance" ? "tag-amber" : "tag-blue"}`}>
                        {b.status}
                      </span>
                    </td>
                    <td className="text-right mono">{b.qtyRemaining}</td>
                    <td className="text-right mono" style={{ fontWeight: 600 }}>
                      {formatMoney(b.atRiskCostCents)}
                    </td>
                    {canManage && (
                      <td className="text-right">
                        <div style={{ display: "inline-flex", gap: 6 }}>
                          {b.status !== "clearance" && (
                            <button
                              className="btn btn-amber btn-sm"
                              disabled={busyAction !== null}
                              onClick={() => void handleBatchAction(b.batchId, "clearance", b.sku)}
                            >
                              <Percent size={12} /> 30% Clearance
                            </button>
                          )}
                          <button
                            className="btn btn-sm"
                            disabled={busyAction !== null}
                            onClick={() => void handleBatchAction(b.batchId, "write_off", b.sku)}
                          >
                            <Trash2 size={12} /> Write Off
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
        </>
      )}
    </div>
  );
}
