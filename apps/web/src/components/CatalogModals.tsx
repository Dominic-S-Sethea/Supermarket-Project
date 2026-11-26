import { computeNetMarginBp, formatBp, formatMoney } from "@supermarket/shared/money";
import { Barcode, Plus, Printer, X } from "lucide-react";
import { ModalDialog, SlideDrawer } from "./AccessibleDialog";

export interface CatalogBarcodeItem {
  id: string;
  barcode: string;
  packQty: number;
  packLabel: string;
  sellPriceCents: number;
  isPrimary: boolean;
  isOrderableCase: boolean;
}

export interface CatalogProductItem {
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
  barcodes: CatalogBarcodeItem[];
  similarityScore?: number;
}

export interface CsvPreviewResponse {
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

export interface StatusNotice {
  kind: "green" | "red";
  text: string;
}

export function CatalogInspectorDrawer({
  selected,
  canEditCatalog,
  canCycleCount,
  drawerNotice,
  drawerBusy,
  zplOutput,
  newBc,
  newPackLabel,
  newPackQty,
  newPackPrice,
  cycleQty,
  onNewBcChange,
  onNewPackLabelChange,
  onNewPackQtyChange,
  onNewPackPriceChange,
  onCycleQtyChange,
  onAddBarcode,
  onDeleteBarcode,
  onGenerateZpl,
  onCycleCount,
  onClose,
}: {
  selected: CatalogProductItem | null;
  canEditCatalog: boolean;
  canCycleCount: boolean;
  drawerNotice: StatusNotice | null;
  drawerBusy: boolean;
  zplOutput: string | null;
  newBc: string;
  newPackLabel: string;
  newPackQty: number;
  newPackPrice: string;
  cycleQty: string;
  onNewBcChange: (val: string) => void;
  onNewPackLabelChange: (val: string) => void;
  onNewPackQtyChange: (val: number) => void;
  onNewPackPriceChange: (val: string) => void;
  onCycleQtyChange: (val: string) => void;
  onAddBarcode: () => void;
  onDeleteBarcode: (barcodeId: string) => void;
  onGenerateZpl: (productId: string) => void;
  onCycleCount: () => void;
  onClose: () => void;
}) {
  return (
    <SlideDrawer
      open={Boolean(selected)}
      onClose={onClose}
      labelledBy="catalog-inspector-title"
    >
      {selected && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div className="mono" style={{ fontSize: 12, color: "var(--ink-muted)" }}>
                {selected.sku} · Aisle {selected.aisleLocation}
              </div>
              <h2 id="catalog-inspector-title" style={{ margin: "4px 0 0", fontSize: 19 }}>
                {selected.name}
              </h2>
              <div style={{ fontSize: 13, color: "var(--ink-secondary)", marginTop: 2 }}>
                {selected.brand} · {selected.departmentName} / {selected.categoryName}
              </div>
            </div>
            <button type="button" className="btn btn-sm" aria-label="Close inspector" onClick={onClose}>
              <X size={15} aria-hidden="true" />
            </button>
          </div>

          {drawerNotice && (
            <div
              className={`banner ${drawerNotice.kind === "red" ? "banner-red" : "banner-green"}`}
              role={drawerNotice.kind === "red" ? "alert" : "status"}
            >
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
                <Barcode size={15} aria-hidden="true" style={{ verticalAlign: "middle", marginRight: 6 }} />
                Linked Multi-UOM Barcodes (Pack-Breaking)
              </h3>
              <button
                type="button"
                className="btn btn-sm"
                disabled={drawerBusy}
                onClick={() => onGenerateZpl(selected.id)}
              >
                <Printer size={13} aria-hidden="true" /> ZPL Shelf Tag
              </button>
            </div>
            <div className="table-wrap" role="region" aria-label="Product pack-tier barcodes" tabIndex={0}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Pack Tier</th>
                    <th>GS1 Barcode</th>
                    <th className="text-right">Price</th>
                    {typeof selected.avgCostCents === "number" && <th className="text-right">Net Margin</th>}
                    {canEditCatalog && (
                      <th>
                        <span className="sr-only">Actions</span>
                      </th>
                    )}
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
                                type="button"
                                className="btn btn-sm"
                                disabled={drawerBusy}
                                onClick={() => onDeleteBarcode(b.id)}
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
                  <label htmlFor="new-barcode-input">GS1 Barcode (EAN-13 / UPC-A)</label>
                  <input
                    id="new-barcode-input"
                    className="input mono"
                    value={newBc}
                    onChange={(e) => onNewBcChange(e.target.value)}
                    disabled={drawerBusy}
                  />
                </div>
                <div className="field">
                  <label htmlFor="new-pack-label-input">Pack Label</label>
                  <input
                    id="new-pack-label-input"
                    className="input"
                    value={newPackLabel}
                    onChange={(e) => onNewPackLabelChange(e.target.value)}
                    disabled={drawerBusy}
                  />
                </div>
                <div className="field">
                  <label htmlFor="new-pack-qty-input">Base Units in Pack</label>
                  <input
                    id="new-pack-qty-input"
                    className="input mono"
                    type="number"
                    min={1}
                    value={newPackQty}
                    onChange={(e) => onNewPackQtyChange(Math.max(1, Math.trunc(Number(e.target.value) || 1)))}
                    disabled={drawerBusy}
                  />
                </div>
                <div className="field">
                  <label htmlFor="new-pack-price-input">Pack Sell Price ($)</label>
                  <input
                    id="new-pack-price-input"
                    className="input mono"
                    value={newPackPrice}
                    onChange={(e) => onNewPackPriceChange(e.target.value)}
                    disabled={drawerBusy}
                  />
                </div>
              </div>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                style={{ marginTop: 12 }}
                disabled={drawerBusy}
                onClick={onAddBarcode}
              >
                <Plus size={13} aria-hidden="true" /> Save Pack Barcode
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
                  id="catalog-cycle-count-input"
                  aria-label={`Physical count in ${selected.baseUnitLabel}s`}
                  className="input mono"
                  type="number"
                  min={0}
                  placeholder={`Physical count (currently ${selected.onHandUnits})`}
                  value={cycleQty}
                  onChange={(e) => onCycleQtyChange(e.target.value)}
                  disabled={drawerBusy}
                  style={{ flex: 1, minWidth: 0 }}
                />
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={drawerBusy || cycleQty === ""}
                  onClick={onCycleCount}
                >
                  Post Adjustment
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </SlideDrawer>
  );
}

export function CatalogCsvImportModal({
  open,
  csvText,
  preview,
  importNotice,
  importBusy,
  onCsvTextChange,
  onPreviewCsv,
  onCommitCsv,
  onClose,
}: {
  open: boolean;
  csvText: string;
  preview: CsvPreviewResponse | null;
  importNotice: StatusNotice | null;
  importBusy: boolean;
  onCsvTextChange: (val: string) => void;
  onPreviewCsv: () => void;
  onCommitCsv: () => void;
  onClose: () => void;
}) {
  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      labelledBy="csv-import-modal-title"
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 id="csv-import-modal-title" style={{ margin: 0, fontSize: 18 }}>
            3,000+ SKU Distributor CSV Import Wizard
          </h2>
          <p className="page-subtitle">
            Validates GS1 EAN-13/UPC-A check digits, flags duplicates &amp; negative margins before writing to PostgreSQL.
          </p>
        </div>
        <button type="button" className="btn btn-sm" aria-label="Close import wizard" onClick={onClose}>
          <X size={15} aria-hidden="true" />
        </button>
      </div>

      {importNotice && (
        <div
          className={`banner ${importNotice.kind === "red" ? "banner-red" : "banner-green"}`}
          role={importNotice.kind === "red" ? "alert" : "status"}
        >
          <span>{importNotice.text}</span>
        </div>
      )}

      <div className="field">
        <label htmlFor="csv-import-textarea">
          Paste Distributor Price-List CSV (sample pre-loaded with 3 valid + 2 invalid test rows)
        </label>
        <textarea
          id="csv-import-textarea"
          className="textarea"
          rows={7}
          value={csvText}
          onChange={(e) => onCsvTextChange(e.target.value)}
          disabled={importBusy}
        />
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button
          id="validate-csv-btn"
          type="button"
          className="btn btn-primary"
          disabled={importBusy || !csvText.trim()}
          onClick={onPreviewCsv}
        >
          {importBusy ? "Working..." : "Validate Check Digits & Preview"}
        </button>
        {preview && preview.readyCount > 0 && (
          <button
            id="commit-csv-btn"
            type="button"
            className="btn btn-amber"
            disabled={importBusy}
            onClick={onCommitCsv}
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
          <div className="table-wrap" role="region" aria-label="CSV import preview table" tabIndex={0}>
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
    </ModalDialog>
  );
}
