import { useEffect, useState } from "react";
import { buildValidEan13 } from "@supermarket/shared/barcodes";
import type { UserRole } from "@supermarket/shared/dtos";
import { computeNetMarginBp, formatBp, formatMoney } from "@supermarket/shared/money";
import { Barcode, Plus, Printer, Search, Sparkles, Upload, X } from "lucide-react";
import { apiDelete, apiGet, apiPost } from "../api";

interface BarcodeItem {
  id: string;
  barcode: string;
  packQty: number;
  packLabel: string;
  sellPriceCents: number;
  isPrimary: boolean;
  isOrderableCase: boolean;
}

interface ProductItem {
  id: string;
  sku: string;
  name: string;
  brand: string;
  departmentName: string;
  categoryName: string;
  aisleLocation: string;
  baseUnitLabel: string;
  avgCostCents?: number;
  minMarginBp?: number;
  taxRateBp?: number;
  taxInclusive?: boolean;
  requiresAgeCheck: boolean;
  onHandUnits: number;
  primaryBarcode: string;
  primarySellPriceCents: number;
  marginBp?: number;
  segment: string | null;
  units60d: number | null;
  earliestExpiry: string | null;
  barcodes: BarcodeItem[];
  similarityScore?: number;
}

interface DepartmentOption {
  id: string;
  name: string;
}

interface CsvPreviewResponse {
  totalRows: number;
  readyCount: number;
  duplicateCount: number;
  errorCount: number;
  rows: {
    rowNum: number;
    sku: string;
    name: string;
    brand: string;
    barcode: string;
    barcodeFormat: string;
    packQty: number;
    packLabel: string;
    unitCostCents: number;
    sellPriceCents: number;
    marginBp: number;
    categoryName: string;
    status: "ready" | "duplicate" | "error";
    issues: string[];
  }[];
}

interface StatusNotice {
  kind: "green" | "red";
  text: string;
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
}: {
  departments: DepartmentOption[];
  userRole?: UserRole;
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
  const [data, setData] = useState<{ items: ProductItem[]; total: number; pageSize: number }>({
    items: [],
    total: 0,
    pageSize: 40,
  });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ProductItem | null>(null);

  // Add Barcode form
  const [newBc, setNewBc] = useState("");
  const [newPackQty, setNewPackQty] = useState(6);
  const [newPackLabel, setNewPackLabel] = useState("6-Pack");
  const [newPackPrice, setNewPackPrice] = useState("9.50");
  const [drawerNotice, setDrawerNotice] = useState<StatusNotice | null>(null);
  const [drawerBusy, setDrawerBusy] = useState(false);
  const [zplOutput, setZplOutput] = useState<string | null>(null);
  const [cycleQty, setCycleQty] = useState("");

  // CSV Import Wizard modal
  const [showImport, setShowImport] = useState(false);
  const [csvText, setCsvText] = useState(SAMPLE_DIRTY_CSV);
  const [preview, setPreview] = useState<CsvPreviewResponse | null>(null);
  const [importNotice, setImportNotice] = useState<StatusNotice | null>(null);
  const [importBusy, setImportBusy] = useState(false);

  useEffect(() => {
    if (!selected && !showImport) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelected(null);
        setShowImport(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selected, showImport]);

  const loadProducts = async (p = page, signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(null);
    try {
      if (semanticMode && search.trim().length >= 2) {
        const res = await apiGet<{ engine: string; items: ProductItem[] }>(
          `/api/ai/search/semantic?q=${encodeURIComponent(search.trim())}&limit=40`,
          signal
        );
        if (signal?.aborted) return;
        setSemanticEngine(res.engine);
        setData({ items: res.items, total: res.items.length, pageSize: 40 });
        if (selected) {
          const refreshed = res.items.find((i) => i.id === selected.id);
          if (refreshed) setSelected(refreshed);
        }
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
      const res = await apiGet<{ items: ProductItem[]; total: number; pageSize: number }>(
        `/api/products?${qs.toString()}`,
        signal
      );
      if (signal?.aborted) return;
      setData(res);
      if (selected) {
        const refreshed = res.items.find((i) => i.id === selected.id);
        if (refreshed) setSelected(refreshed);
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setLoadError(err instanceof Error ? err.message : "Failed loading catalog");
      }
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    const t = setTimeout(() => {
      void loadProducts(page, controller.signal);
    }, 140);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [search, deptId, segment, page, semanticMode]);

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
            Search <strong className="mono">{data.total.toLocaleString()}</strong> packaged SKUs by name, SKU, brand, or any Single / 6-Pack / Case barcode.
          </p>
        </div>
        {canEditCatalog && (
          <div className="header-actions">
            <button
              id="open-csv-wizard-btn"
              className="btn btn-primary"
              onClick={() => {
                setShowImport(true);
                setPreview(null);
                setImportNotice(null);
              }}
            >
              <Upload size={14} /> Bulk CSV Onboarding Wizard
            </button>
          </div>
        )}
      </header>

      {loadError && (
        <div className="banner banner-red" style={{ marginBottom: 14 }}>
          <span>{loadError}</span>
          <button className="btn btn-sm" onClick={() => void loadProducts(page)}>
            Retry
          </button>
        </div>
      )}

      <section className="panel">
        <div className="toolbar">
          <div className="search-box">
            <Search size={15} className="search-icon" />
            <input
              id="catalog-search-input"
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
          <button
            id="toggle-semantic-search-btn"
            className={`btn ${semanticMode ? "btn-primary" : ""}`}
            onClick={() => {
              setPage(1);
              setSemanticMode((m) => !m);
            }}
          >
            <Sparkles size={14} /> {semanticMode ? "Semantic AI: ON" : "Semantic AI Search"}
          </button>
          {semanticEngine && (
            <span className="tag tag-green mono">{semanticEngine}</span>
          )}
          <select
            id="catalog-dept-filter"
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
                className="btn btn-sm"
                onClick={() => {
                  setPage(1);
                  setSearch(q);
                }}
              >
                <Sparkles size={11} /> {q}
              </button>
            ))}
          </div>
        )}

        <div className="table-wrap">
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
                data.items.map((item) => (
                  <tr
                    key={item.id}
                    className="clickable"
                    onClick={() => {
                      setSelected(item);
                      setZplOutput(null);
                      setDrawerNotice(null);
                      setNewBc(buildValidEan13("887", Math.floor(100000 + Math.random() * 899999)));
                    }}
                  >
                    <td>
                      <div className="mono" style={{ fontWeight: 600 }}>
                        {item.sku}
                      </div>
                      <div style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                        Aisle {item.aisleLocation}
                      </div>
                    </td>
                    <td>
                      <div style={{ fontWeight: 600 }}>
                        {item.name}{" "}
                        {item.requiresAgeCheck && <span className="tag tag-amber">18+/21+</span>}
                        {typeof item.similarityScore === "number" && (
                          <span className="tag tag-green mono" style={{ marginLeft: 4 }}>
                            {Math.round(item.similarityScore * 100)}% match
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 12, color: "var(--ink-secondary)" }}>
                        {item.brand} · {item.categoryName}
                      </div>
                    </td>
                    <td>{item.departmentName}</td>
                    <td>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                        {item.barcodes.map((b) => (
                          <span key={b.id} className="tag tag-neutral mono">
                            {b.packQty}× ({formatMoney(b.sellPriceCents)})
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="text-right mono">
                      {typeof item.avgCostCents === "number" ? formatMoney(item.avgCostCents) : "—"}
                    </td>
                    <td className="text-right mono" style={{ fontWeight: 600 }}>
                      {formatMoney(item.primarySellPriceCents)}
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
                          color: item.onHandUnits <= 12 ? "var(--accent-crimson)" : "inherit",
                        }}
                      >
                        {item.onHandUnits}
                      </span>{" "}
                      <span style={{ fontSize: 11, color: "var(--ink-muted)" }}>
                        {item.baseUnitLabel}s
                      </span>
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
                ))
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
              className="btn btn-sm"
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </button>
            <button
              className="btn btn-sm"
              disabled={page >= totalPages || loading}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </div>
      </section>

      {/* Slide-Over Multi-UOM Inspector Drawer */}
      {selected && (
        <div className="overlay" onClick={() => setSelected(null)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <div className="mono" style={{ fontSize: 12, color: "var(--ink-muted)" }}>
                  {selected.sku} · Aisle {selected.aisleLocation}
                </div>
                <h2 style={{ margin: "4px 0 0", fontSize: 19 }}>{selected.name}</h2>
                <div style={{ fontSize: 13, color: "var(--ink-secondary)", marginTop: 2 }}>
                  {selected.brand} · {selected.departmentName} / {selected.categoryName}
                </div>
              </div>
              <button className="btn btn-sm" aria-label="Close inspector" onClick={() => setSelected(null)}>
                <X size={15} />
              </button>
            </div>

            {drawerNotice && (
              <div className={`banner ${drawerNotice.kind === "red" ? "banner-red" : "banner-green"}`}>
                <span>{drawerNotice.text}</span>
              </div>
            )}

            <div className="kpi-strip" style={{ marginBottom: 0 }}>
              <div className="kpi-tile">
                <div className="kpi-label">Live Ledger Stock</div>
                <div className="kpi-value" style={{ fontSize: 20 }}>
                  {selected.onHandUnits} {selected.baseUnitLabel}s
                </div>
              </div>
              {typeof selected.avgCostCents === "number" && (
                <div className="kpi-tile">
                  <div className="kpi-label">Avg Base Cost (MWAC)</div>
                  <div className="kpi-value" style={{ fontSize: 20 }}>
                    {formatMoney(selected.avgCostCents)}
                  </div>
                </div>
              )}
            </div>

            <div>
              <div className="panel-header" style={{ marginBottom: 8 }}>
                <h3 className="panel-title">
                  <Barcode size={15} style={{ verticalAlign: "middle", marginRight: 6 }} />
                  Linked Multi-UOM Barcodes (Pack-Breaking)
                </h3>
                <button
                  className="btn btn-sm"
                  disabled={drawerBusy}
                  onClick={() => void handleGenerateZpl(selected.id)}
                >
                  <Printer size={13} /> ZPL Shelf Tag
                </button>
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Pack Tier</th>
                      <th>GS1 Barcode</th>
                      <th className="text-right">Price</th>
                      {typeof selected.avgCostCents === "number" && <th className="text-right">Net Margin</th>}
                      {canEditCatalog && <th />}
                    </tr>
                  </thead>
                  <tbody>
                    {selected.barcodes.map((b) => {
                      const tierMargin =
                        typeof selected.avgCostCents === "number"
                          ? computeNetMarginBp(
                              b.sellPriceCents,
                              selected.avgCostCents * b.packQty,
                              selected.taxRateBp ?? 0,
                              selected.taxInclusive ?? true
                            )
                          : null;
                      return (
                        <tr key={b.id}>
                          <td>
                            <strong>{b.packLabel}</strong>{" "}
                            <span className="mono" style={{ color: "var(--ink-muted)", fontSize: 11.5 }}>
                              ({b.packQty}×)
                            </span>
                          </td>
                          <td className="mono">{b.barcode}</td>
                          <td className="text-right mono">{formatMoney(b.sellPriceCents)}</td>
                          {tierMargin !== null && (
                            <td className="text-right">
                              <span
                                className={`tag mono ${
                                  tierMargin < (selected.minMarginBp ?? 0) ? "tag-red" : "tag-green"
                                }`}
                              >
                                {formatBp(tierMargin)}
                              </span>
                            </td>
                          )}
                          {canEditCatalog && (
                            <td className="text-right">
                              {!b.isPrimary && (
                                <button
                                  className="btn btn-sm"
                                  disabled={drawerBusy}
                                  onClick={() => void handleDeleteBarcode(b.id)}
                                >
                                  Remove
                                </button>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {zplOutput && (
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 5 }}>
                  Raw ZPL Thermal Label Payload (Zebra ZD421 / TSC)
                </div>
                <pre className="code-block">{zplOutput}</pre>
              </div>
            )}

            {canEditCatalog && (
              <div className="panel" style={{ background: "var(--bg-canvas)" }}>
                <h3 className="panel-title" style={{ marginBottom: 10 }}>
                  Add New Pack / Carton Barcode Tier
                </h3>
                <div className="form-grid">
                  <div className="field">
                    <label>GS1 Barcode (EAN-13 / UPC-A)</label>
                    <input
                      className="input mono"
                      value={newBc}
                      onChange={(e) => setNewBc(e.target.value)}
                      disabled={drawerBusy}
                    />
                  </div>
                  <div className="field">
                    <label>Pack Label</label>
                    <input
                      className="input"
                      value={newPackLabel}
                      onChange={(e) => setNewPackLabel(e.target.value)}
                      disabled={drawerBusy}
                    />
                  </div>
                  <div className="field">
                    <label>Base Units in Pack</label>
                    <input
                      className="input mono"
                      type="number"
                      min={1}
                      value={newPackQty}
                      onChange={(e) => setNewPackQty(Math.max(1, Math.trunc(Number(e.target.value) || 1)))}
                      disabled={drawerBusy}
                    />
                  </div>
                  <div className="field">
                    <label>Pack Sell Price ($)</label>
                    <input
                      className="input mono"
                      value={newPackPrice}
                      onChange={(e) => setNewPackPrice(e.target.value)}
                      disabled={drawerBusy}
                    />
                  </div>
                </div>
                <button
                  className="btn btn-primary btn-sm"
                  style={{ marginTop: 12 }}
                  disabled={drawerBusy}
                  onClick={() => void handleAddBarcode()}
                >
                  <Plus size={13} /> Save Pack Barcode
                </button>
              </div>
            )}

            {canCycleCount && (
              <div className="panel" style={{ background: "var(--bg-canvas)" }}>
                <h3 className="panel-title" style={{ marginBottom: 6 }}>
                  Quick Blind Cycle Count (Ledger Adjustment)
                </h3>
                <p className="panel-desc" style={{ marginBottom: 10 }}>
                  Enter physical shelf count in base units ({selected.baseUnitLabel}s). System posts an immutable count variance entry.
                </p>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    className="input mono"
                    type="number"
                    min={0}
                    placeholder={`Physical count (currently ${selected.onHandUnits})`}
                    value={cycleQty}
                    onChange={(e) => setCycleQty(e.target.value)}
                    disabled={drawerBusy}
                    style={{ flex: 1 }}
                  />
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={drawerBusy || cycleQty === ""}
                    onClick={() => void handleCycleCount()}
                  >
                    Post Adjustment
                  </button>
                </div>
              </div>
            )}
          </aside>
        </div>
      )}

      {/* Bulk CSV Onboarding Modal */}
      {showImport && canEditCatalog && (
        <div className="overlay centered" onClick={() => setShowImport(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 18 }}>3,000+ SKU Distributor CSV Import Wizard</h2>
                <p className="page-subtitle">
                  Validates GS1 EAN-13/UPC-A check digits, flags duplicates &amp; negative margins before writing to PostgreSQL.
                </p>
              </div>
              <button className="btn btn-sm" aria-label="Close import wizard" onClick={() => setShowImport(false)}>
                <X size={15} />
              </button>
            </div>

            {importNotice && (
              <div className={`banner ${importNotice.kind === "red" ? "banner-red" : "banner-green"}`}>
                <span>{importNotice.text}</span>
              </div>
            )}

            <div className="field">
              <label>Paste Distributor Price-List CSV (sample pre-loaded with 3 valid + 2 invalid test rows)</label>
              <textarea
                id="csv-import-textarea"
                className="textarea"
                rows={7}
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
                disabled={importBusy}
              />
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button
                id="validate-csv-btn"
                className="btn btn-primary"
                disabled={importBusy || !csvText.trim()}
                onClick={() => void handlePreviewCsv()}
              >
                {importBusy ? "Working..." : "Validate Check Digits & Preview"}
              </button>
              {preview && preview.readyCount > 0 && (
                <button
                  id="commit-csv-btn"
                  className="btn btn-amber"
                  disabled={importBusy}
                  onClick={() => void handleCommitCsv()}
                >
                  Commit {preview.readyCount} Valid SKUs to Database
                </button>
              )}
            </div>

            {preview && (
              <div>
                <div style={{ display: "flex", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
                  <span className="tag tag-green">Ready: {preview.readyCount}</span>
                  <span className="tag tag-amber">Duplicates: {preview.duplicateCount}</span>
                  <span className="tag tag-red">Errors Blocked: {preview.errorCount}</span>
                </div>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Row</th>
                        <th>Product</th>
                        <th>Barcode</th>
                        <th className="text-right">Price</th>
                        <th className="text-right">Margin</th>
                        <th>Validation Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((r) => (
                        <tr key={r.rowNum}>
                          <td className="mono">{r.rowNum}</td>
                          <td>
                            <strong>{r.name}</strong> ({r.brand})
                          </td>
                          <td className="mono">{r.barcode}</td>
                          <td className="text-right mono">{formatMoney(r.sellPriceCents)}</td>
                          <td className="text-right mono">{formatBp(r.marginBp)}</td>
                          <td>
                            {r.status === "ready" ? (
                              <span className="tag tag-green">Valid ({r.barcodeFormat})</span>
                            ) : (
                              <span className="tag tag-red">
                                {r.status === "duplicate" ? "Already in catalog" : r.issues.join("; ")}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
