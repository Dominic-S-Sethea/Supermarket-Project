import { useCallback, useEffect, useState } from "react";
import { buildValidEan13 } from "@supermarket/shared/barcodes";
import type { UserRole } from "@supermarket/shared/dtos";
import { computeLegalUnitPrice, formatBp, formatMeasure, formatMoney } from "@supermarket/shared/money";
import { Download, Search, Sparkles, Upload } from "lucide-react";
import { apiDelete, apiGet, apiPatch, apiPost } from "../api";
import {
  CatalogCsvImportModal,
  CatalogInspectorDrawer,
  type CatalogProductItem,
  type CsvPreviewResponse,
  type StatusNotice,
} from "../components/CatalogModals";

interface DepartmentOption {
  id: string;
  name: string;
}

const SAMPLE_DIRTY_CSV = `sku,name,brand,barcode,pack_qty,pack_label,unit_cost,sell_price,category
BEV-NEW1,Craft Ginger Beer 330ml Can,Bundaberg,${buildValidEan13("931", 700101)},1,Single Can,1.10,1.95,Cola & Sparkling Soda
NDL-NEW2,Sapporo Tonkotsu Deluxe 110g,Sapporo Ichiban,${buildValidEan13("490", 700102)},1,Single Pack,0.85,1.45,Soup Packet Noodles
SNK-NEW3,Sea Salt Kettle Chips 150g,Kettle Brand,${buildValidEan13("084", 700103)},1,Single Bag,1.40,2.65,Potato Chips
BAD-CHK1,Corrupt Check Digit Test,TestBrand,8851000001009,1,Single,0.90,1.50,Potato Chips
BAD-MRG2,Below Cost Error Item,TestBrand,${buildValidEan13("885", 700105)},1,Single,2.50,1.99,Potato Chips`;

export function CatalogView({
  departments,
  userRole = "owner",
  onCatalogChanged,
}: {
  departments: DepartmentOption[];
  userRole?: UserRole;
  onCatalogChanged?: () => void;
}) {
  const canEditCatalog = userRole === "owner" || userRole === "manager";
  const canCycleCount =
    userRole === "owner" || userRole === "manager" || userRole === "stock_clerk";

  const [search, setSearch] = useState("");
  const [semanticMode, setSemanticMode] = useState(false);
  const [semanticEngine, setSemanticEngine] = useState<string | null>(null);
  const [deptId, setDeptId] = useState("");
  const [segment, setSegment] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: CatalogProductItem[]; total: number; pageSize: number }>({
    items: [],
    total: 0,
    pageSize: 40,
  });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CatalogProductItem | null>(null);

  // Add Barcode form
  const [newBc, setNewBc] = useState("");
  const [newPackQty, setNewPackQty] = useState(6);
  const [newPackLabel, setNewPackLabel] = useState("6-Pack");
  const [newPackPrice, setNewPackPrice] = useState("9.50");
  const [drawerNotice, setDrawerNotice] = useState<StatusNotice | null>(null);
  const [drawerBusy, setDrawerBusy] = useState(false);
  const [zplOutput, setZplOutput] = useState<string | null>(null);
  const [cycleQty, setCycleQty] = useState("");
  const [recallReasonInput, setRecallReasonInput] = useState("");

  // CSV Import Wizard modal
  const [showImport, setShowImport] = useState(false);
  const [csvText, setCsvText] = useState(SAMPLE_DIRTY_CSV);
  const [preview, setPreview] = useState<CsvPreviewResponse | null>(null);
  const [importNotice, setImportNotice] = useState<StatusNotice | null>(null);
  const [importBusy, setImportBusy] = useState(false);

  const openInspector = (item: CatalogProductItem) => {
    setSelected(item);
    setZplOutput(null);
    setDrawerNotice(null);
    setRecallReasonInput(item.recallReason ?? "");
    setNewBc(buildValidEan13("887", Math.floor(100000 + Math.random() * 899999)));
  };

  const loadProducts = useCallback(async (p = page, signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(null);
    try {
      if (semanticMode && search.trim().length >= 2) {
        const res = await apiGet<{ engine: string; items: CatalogProductItem[] }>(
          `/api/ai/search/semantic?q=${encodeURIComponent(search.trim())}&limit=40`,
          signal
        );
        if (signal?.aborted) return;
        setSemanticEngine(res.engine);
        setData({ items: res.items, total: res.items.length, pageSize: 40 });
        setSelected((prev) => {
          if (!prev) return prev;
          return res.items.find((i) => i.id === prev.id) ?? prev;
        });
        return;
      }

      setSemanticEngine(null);
      const qs = new URLSearchParams({
        page: String(p),
        pageSize: "40",
      });
      if (search.trim()) qs.set("search", search.trim());
      if (deptId) qs.set("departmentId", deptId);
      if (segment) qs.set("segment", segment);
      const res = await apiGet<{ items: CatalogProductItem[]; total: number; pageSize: number }>(
        `/api/products?${qs.toString()}`,
        signal
      );
      if (signal?.aborted) return;
      setData(res);
      setSelected((prev) => {
        if (!prev) return prev;
        return res.items.find((i) => i.id === prev.id) ?? prev;
      });
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setLoadError(err instanceof Error ? err.message : "Failed loading catalog");
      }
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, [page, search, deptId, segment, semanticMode]);

  useEffect(() => {
    const controller = new AbortController();
    const t = setTimeout(() => {
      void loadProducts(page, controller.signal);
    }, 140);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [page, loadProducts]);

  const handleAddBarcode = async () => {
    if (!selected || drawerBusy) return;
    setDrawerNotice(null);
    const parsedPrice = Number(newPackPrice);
    if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
      setDrawerNotice({ kind: "red", text: "Pack sell price must be greater than $0.00." });
      return;
    }
    if (!Number.isInteger(newPackQty) || newPackQty < 1) {
      setDrawerNotice({ kind: "red", text: "Base units in pack must be an integer >= 1." });
      return;
    }
    const cents = Math.round(parsedPrice * 100);
    setDrawerBusy(true);
    try {
      await apiPost(`/api/products/${selected.id}/barcodes`, {
        barcode: newBc.trim(),
        packQty: newPackQty,
        packLabel: newPackLabel.trim(),
        sellPriceCents: cents,
        isOrderableCase: newPackQty >= 12,
      });
      setNewBc("");
      setDrawerNotice({ kind: "green", text: "Added new Multi-UOM barcode tier successfully." });
      await loadProducts(page);
    } catch (err) {
      setDrawerNotice({
        kind: "red",
        text: err instanceof Error ? err.message : "Failed adding barcode",
      });
    } finally {
      setDrawerBusy(false);
    }
  };

  const handleDeleteBarcode = async (barcodeId: string) => {
    if (!selected || drawerBusy) return;
    setDrawerNotice(null);
    setDrawerBusy(true);
    try {
      await apiDelete(`/api/products/${selected.id}/barcodes/${barcodeId}`);
      setDrawerNotice({ kind: "green", text: "Removed barcode tier." });
      await loadProducts(page);
    } catch (err) {
      setDrawerNotice({
        kind: "red",
        text: err instanceof Error ? err.message : "Failed removing barcode",
      });
    } finally {
      setDrawerBusy(false);
    }
  };

  const handleGenerateZpl = async (productId: string) => {
    if (drawerBusy) return;
    setDrawerNotice(null);
    setDrawerBusy(true);
    try {
      const res = await apiPost<{ zpl: string }>("/api/labels/zpl", {
        productIds: [productId],
      });
      setZplOutput(res.zpl);
    } catch (err) {
      setDrawerNotice({
        kind: "red",
        text: err instanceof Error ? err.message : "Failed generating ZPL",
      });
    } finally {
      setDrawerBusy(false);
    }
  };

  const handleCycleCount = async () => {
    if (!selected || cycleQty === "" || drawerBusy) return;
    setDrawerNotice(null);
    const parsedQty = Number(cycleQty);
    if (!Number.isInteger(parsedQty) || parsedQty < 0) {
      setDrawerNotice({ kind: "red", text: "Physical count must be a non-negative integer." });
      return;
    }
    setDrawerBusy(true);
    try {
      const res = await apiPost<{ expectedUnits: number; varianceUnits: number }>(
        "/api/inventory/cycle-count",
        {
          productId: selected.id,
          countedBaseUnits: parsedQty,
        }
      );
      setCycleQty("");
      setDrawerNotice({
        kind: "green",
        text: `Blind cycle count posted to ledger (Expected ${res.expectedUnits}, Variance ${res.varianceUnits >= 0 ? "+" : ""}${res.varianceUnits} units).`,
      });
      await loadProducts(page);
    } catch (err) {
      setDrawerNotice({
        kind: "red",
        text: err instanceof Error ? err.message : "Failed posting cycle count",
      });
    } finally {
      setDrawerBusy(false);
    }
  };

  const handleToggleRecall = async (productId: string, recalled: boolean) => {
    if (drawerBusy) return;
    setDrawerNotice(null);
    if (recalled && recallReasonInput.trim().length < 3) {
      setDrawerNotice({ kind: "red", text: "Enter a recall reason (at least 3 characters)." });
      return;
    }
    setDrawerBusy(true);
    try {
      const res = await apiPatch<{
        product: { id: string; sku: string; recalled: boolean; recallReason: string | null };
      }>(`/api/products/${productId}/recall`, {
        recalled,
        reason: recalled ? recallReasonInput.trim() : null,
      });
      setSelected((prev) =>
        prev && prev.id === productId
          ? { ...prev, recalled: res.product.recalled, recallReason: res.product.recallReason }
          : prev
      );
      if (!recalled) setRecallReasonInput("");
      setDrawerNotice({
        kind: "green",
        text: recalled
          ? `Food-safety recall ACTIVE on ${res.product.sku}. POS checkout is now hard-blocked across all lanes.`
          : `Cleared food-safety recall on ${res.product.sku}. Item re-enabled for POS checkout.`,
      });
      await loadProducts(page);
      onCatalogChanged?.();
    } catch (err) {
      setDrawerNotice({
        kind: "red",
        text: err instanceof Error ? err.message : "Failed updating food-safety recall status",
      });
    } finally {
      setDrawerBusy(false);
    }
  };

  const handlePreviewCsv = async () => {
    if (importBusy) return;
    setImportNotice(null);
    setImportBusy(true);
    try {
      const res = await apiPost<CsvPreviewResponse>("/api/import/preview", { csvText });
      setPreview(res);
    } catch (err) {
      setImportNotice({
        kind: "red",
        text: err instanceof Error ? err.message : "Failed previewing CSV",
      });
    } finally {
      setImportBusy(false);
    }
  };

  const handleCommitCsv = async () => {
    if (!preview || importBusy) return;
    const readyRows = preview.rows.filter((r) => r.status === "ready");
    if (readyRows.length === 0) return;
    setImportBusy(true);
    setImportNotice(null);
    try {
      const res = await apiPost<{ imported: number; skipped: number }>("/api/import/commit", {
        rows: readyRows,
      });
      setImportNotice({
        kind: "green",
        text: `Committed ${res.imported} new SKUs to PostgreSQL (${res.skipped} skipped).`,
      });
      setPreview(null);
      setPage(1);
      await loadProducts(1);
      onCatalogChanged?.();
    } catch (err) {
      setImportNotice({
        kind: "red",
        text: err instanceof Error ? err.message : "Failed committing CSV",
      });
    } finally {
      setImportBusy(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>Catalog &amp; Multi-UOM Barcodes</h1>
          <p className="page-subtitle">
            Search <strong className="mono">{data.total.toLocaleString()}</strong> packaged &amp; fresh SKUs by name, SKU, brand, PLU, or any Single / Multi-Pack / Case barcode.
          </p>
        </div>
        {(canEditCatalog || canCycleCount) && (
          <div className="header-actions">
            {canCycleCount && (
              <a
                id="export-scale-plu-btn"
                className="btn"
                href="/api/exports/scale-plu.csv"
                download="scale-plu.csv"
              >
                <Download size={14} aria-hidden="true" /> Scale PLU CSV
              </a>
            )}
            {canEditCatalog && (
              <button
                id="open-csv-wizard-btn"
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setShowImport(true);
                  setPreview(null);
                  setImportNotice(null);
                }}
              >
                <Upload size={14} aria-hidden="true" /> Bulk CSV Onboarding Wizard
              </button>
            )}
          </div>
        )}
      </header>

      {loadError && (
        <div className="banner banner-red" role="alert" style={{ marginBottom: 14 }}>
          <span>{loadError}</span>
          <button type="button" className="btn btn-sm" onClick={() => void loadProducts(page)}>
            Retry
          </button>
        </div>
      )}

      <section className="panel">
        <div className="toolbar">
          <div className="search-box">
            <Search size={15} className="search-icon" aria-hidden="true" />
            <input
              id="catalog-search-input"
              aria-label="Search catalog by product, brand, SKU, or barcode"
              className="input"
              placeholder={
                semanticMode
                  ? "Semantic intent (e.g. alcohol free beer, spicy dry noodles, zero sugar energy)..."
                  : "Scan barcode or search brand, product, SKU (e.g. Heineken, Indomie, 885...)"
              }
              value={search}
              onChange={(e) => {
                setPage(1);
                setSearch(e.target.value);
              }}
            />
          </div>
          {canEditCatalog && (
            <button
              id="toggle-semantic-search-btn"
              type="button"
              className={`btn ${semanticMode ? "btn-primary" : ""}`}
              aria-pressed={semanticMode}
              onClick={() => {
                setPage(1);
                setSemanticMode((m) => !m);
              }}
            >
              <Sparkles size={14} aria-hidden="true" />{" "}
              {semanticMode ? "Semantic AI: ON" : "Semantic AI Search"}
            </button>
          )}
          {semanticEngine && (
            <span className="tag tag-green mono">{semanticEngine}</span>
          )}
          <select
            id="catalog-dept-filter"
            aria-label="Filter catalog by department"
            className="select"
            value={deptId}
            disabled={semanticMode && search.trim().length >= 2}
            onChange={(e) => {
              setPage(1);
              setDeptId(e.target.value);
            }}
          >
            <option value="">All Departments</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <select
            id="catalog-segment-filter"
            aria-label="Filter catalog by ABC-XYZ segment"
            className="select"
            value={segment}
            disabled={semanticMode && search.trim().length >= 2}
            onChange={(e) => {
              setPage(1);
              setSegment(e.target.value);
            }}
          >
            <option value="">All ABC-XYZ Segments</option>
            {["AX", "AY", "AZ", "BX", "BY", "BZ", "CX", "CY", "CZ"].map((s) => (
              <option key={s} value={s}>
                Segment {s}
              </option>
            ))}
          </select>
        </div>

        {semanticMode && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
            {["alcohol free beer", "spicy dry noodles", "zero sugar energy"].map((q) => (
              <button
                key={q}
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setPage(1);
                  setSearch(q);
                }}
              >
                <Sparkles size={11} aria-hidden="true" /> {q}
              </button>
            ))}
          </div>
        )}

        <div className="table-wrap" role="region" aria-label="Product catalog table" tabIndex={0}>
          <table className="data-table">
            <thead>
              <tr>
                <th>SKU / Aisle</th>
                <th>Product &amp; Brand</th>
                <th>Department</th>
                <th>Multi-UOM Barcodes</th>
                <th className="text-right">Base Cost</th>
                <th className="text-right">Single Price</th>
                <th className="text-right">Margin</th>
                <th className="text-right">On Hand</th>
                <th>ABC-XYZ</th>
              </tr>
            </thead>
            <tbody>
              {loading && data.items.length === 0 ? (
                <tr>
                  <td colSpan={9}>Searching catalog...</td>
                </tr>
              ) : data.items.length === 0 ? (
                <tr>
                  <td colSpan={9} style={{ textAlign: "center", color: "var(--ink-muted)", padding: "24px 12px" }}>
                    No SKUs matched your current search or filter criteria.
                  </td>
                </tr>
              ) : (
                data.items.map((item) => {
                  const isMeasured = item.unitMode === "weight_g" || item.unitMode === "volume_ml";
                  const legalUnitPrice = computeLegalUnitPrice(
                    item.primarySellPriceCents,
                    item.netContentAmount ?? null,
                    item.netContentUnit ?? null,
                    item.unitMode ?? "each"
                  );
                  const lowStock = isMeasured ? item.onHandUnits <= 1000 : item.onHandUnits <= 12;
                  return (
                    <tr
                      key={item.id}
                      className="clickable"
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest("button, a, input, select")) return;
                        openInspector(item);
                      }}
                    >
                      <td>
                        <div className="mono" style={{ fontWeight: 600 }}>
                          {item.sku}
                        </div>
                        <div style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                          Aisle {item.aisleLocation}
                          {item.pluCode ? ` · PLU ${item.pluCode}` : ""}
                        </div>
                      </td>
                      <td>
                        <div>
                          <button
                            type="button"
                            className="table-row-btn"
                            aria-label={`Inspect ${item.name} (${item.sku})`}
                            onClick={() => openInspector(item)}
                          >
                            {item.name}
                          </button>{" "}
                          {item.recalled && <span className="tag tag-red">RECALLED</span>}
                          {item.requiresAgeCheck && <span className="tag tag-amber">18+/21+</span>}
                          {typeof item.similarityScore === "number" && (
                            <span className="tag tag-green mono" style={{ marginLeft: 4 }}>
                              {Math.round(item.similarityScore * 100)}% match
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: 12, color: "var(--ink-secondary)" }}>
                          {item.brand} · {item.categoryName}
                          {Array.isArray(item.allergens) && item.allergens.length > 0 && (
                            <span className="mono" style={{ marginLeft: 6, fontSize: 11, color: "var(--accent-amber-ink)" }}>
                              [{item.allergens.map((a) => a.toUpperCase()).join(", ")}]
                            </span>
                          )}
                        </div>
                      </td>
                      <td>{item.departmentName}</td>
                      <td>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                          {item.barcodes.map((b) => (
                            <span key={b.id} className="tag tag-neutral mono">
                              {isMeasured ? (item.unitMode === "volume_ml" ? "1L" : "1kg") : `${b.packQty}×`} (
                              {formatMoney(b.sellPriceCents)})
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="text-right mono">
                        {typeof item.avgCostCents === "number" ? formatMoney(item.avgCostCents) : "—"}
                      </td>
                      <td className="text-right mono">
                        <div style={{ fontWeight: 600 }}>{formatMoney(item.primarySellPriceCents)}</div>
                        {legalUnitPrice && (
                          <div style={{ fontSize: 10.5, color: "var(--ink-muted)" }}>{legalUnitPrice}</div>
                        )}
                      </td>
                      <td className="text-right">
                        {typeof item.marginBp === "number" ? (
                          <span
                            className={`tag mono ${
                              item.marginBp < (item.minMarginBp ?? 0)
                                ? "tag-red"
                                : item.marginBp >= 2600
                                  ? "tag-green"
                                  : "tag-neutral"
                            }`}
                          >
                            {formatBp(item.marginBp)}
                          </span>
                        ) : (
                          <span style={{ color: "var(--ink-muted)" }}>—</span>
                        )}
                      </td>
                      <td className="text-right mono">
                        <span
                          style={{
                            fontWeight: 600,
                            color: lowStock ? "var(--accent-crimson)" : "inherit",
                          }}
                        >
                          {isMeasured
                            ? formatMeasure(item.onHandUnits, item.unitMode)
                            : item.onHandUnits}
                        </span>
                        {!isMeasured && (
                          <>
                            {" "}
                            <span style={{ fontSize: 11, color: "var(--ink-muted)" }}>
                              {item.baseUnitLabel}s
                            </span>
                          </>
                        )}
                      </td>
                      <td>
                        {item.segment ? (
                          <span
                            className={`tag mono ${
                              item.segment.startsWith("A")
                                ? "tag-green"
                                : item.segment.startsWith("B")
                                  ? "tag-blue"
                                  : "tag-neutral"
                            }`}
                          >
                            {item.segment}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="pagination">
          <span>
            Showing page <strong>{page}</strong> of <strong>{totalPages}</strong> (
            <span className="mono">{data.total.toLocaleString()}</span> total SKUs)
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="btn btn-sm"
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={page >= totalPages || loading}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </div>
      </section>

      <CatalogInspectorDrawer
        selected={selected}
        canEditCatalog={canEditCatalog}
        canCycleCount={canCycleCount}
        drawerNotice={drawerNotice}
        drawerBusy={drawerBusy}
        zplOutput={zplOutput}
        newBc={newBc}
        newPackLabel={newPackLabel}
        newPackQty={newPackQty}
        newPackPrice={newPackPrice}
        cycleQty={cycleQty}
        recallReasonInput={recallReasonInput}
        onNewBcChange={setNewBc}
        onNewPackLabelChange={setNewPackLabel}
        onNewPackQtyChange={setNewPackQty}
        onNewPackPriceChange={setNewPackPrice}
        onCycleQtyChange={setCycleQty}
        onRecallReasonChange={setRecallReasonInput}
        onAddBarcode={() => void handleAddBarcode()}
        onDeleteBarcode={(barcodeId) => void handleDeleteBarcode(barcodeId)}
        onGenerateZpl={(productId) => void handleGenerateZpl(productId)}
        onCycleCount={() => void handleCycleCount()}
        onToggleRecall={(productId, recalled) => void handleToggleRecall(productId, recalled)}
        onClose={() => setSelected(null)}
      />

      {canEditCatalog && (
        <CatalogCsvImportModal
          open={showImport}
          csvText={csvText}
          preview={preview}
          importNotice={importNotice}
          importBusy={importBusy}
          onCsvTextChange={setCsvText}
          onPreviewCsv={() => void handlePreviewCsv()}
          onCommitCsv={() => void handleCommitCsv()}
          onClose={() => setShowImport(false)}
        />
      )}
    </div>
  );
}
