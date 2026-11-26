import { useEffect, useMemo, useState } from "react";
import { buildScaleBarcode } from "@supermarket/shared/barcodes";
import type { UnitMode } from "@supermarket/shared/dtos";
import {
  computeLegalUnitPrice,
  computeWeightedPriceCents,
  formatMeasure,
  formatMoney,
} from "@supermarket/shared/money";
import { AlertTriangle, Barcode, Scale, Search, X } from "lucide-react";
import { ModalDialog } from "./AccessibleDialog";

export interface FreshPluItem {
  productId: string;
  sku: string;
  name: string;
  brand: string;
  pluCode: string | null;
  unitMode: UnitMode;
  defaultTareGrams: number;
  netContentAmount: number | null;
  netContentUnit: "g" | "ml" | "ea" | null;
  allergens: string[];
  recalled: boolean;
  recallReason: string | null;
  barcode: string;
  packLabel: string;
  sellPriceCents: number;
}

type FreshDeptFilter = "ALL" | "PROD" | "MEAT" | "DELI" | "BAKE";

const DEPT_FILTERS: { id: FreshDeptFilter; label: string }[] = [
  { id: "ALL", label: "All Fresh" },
  { id: "PROD", label: "Produce" },
  { id: "MEAT", label: "Butcher & Fish" },
  { id: "DELI", label: "Deli & Cheese" },
  { id: "BAKE", label: "Bakery" },
];

const WEIGHT_PRESETS_G = [250, 500, 750, 1000];

export function PosFreshPluModal({
  open,
  items,
  initialProductId = null,
  onAddWeighted,
  onAddEach,
  onSimulateScaleBarcode,
  onClose,
}: {
  open: boolean;
  items: FreshPluItem[];
  initialProductId?: string | null;
  onAddWeighted: (item: FreshPluItem, netGrams: number, tareGrams: number) => void;
  onAddEach: (item: FreshPluItem) => void;
  onSimulateScaleBarcode: (barcode: string) => void;
  onClose: () => void;
}) {
  const [deptFilter, setDeptFilter] = useState<FreshDeptFilter>("ALL");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(initialProductId);
  const [grossInput, setGrossInput] = useState("500");
  const [tareInput, setTareInput] = useState("0");

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setDeptFilter("ALL");
    const target =
      (initialProductId ? items.find((i) => i.productId === initialProductId) : null) ??
      items[0] ??
      null;
    setSelectedId(target?.productId ?? null);
    if (target) {
      const tare = target.defaultTareGrams ?? 0;
      setTareInput(String(tare));
      setGrossInput(String(500 + tare));
    }
  }, [open, initialProductId, items]);

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((item) => {
      if (deptFilter !== "ALL" && !item.sku.startsWith(`${deptFilter}-`)) {
        return false;
      }
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q) ||
        item.sku.toLowerCase().includes(q) ||
        (item.pluCode ?? "").toLowerCase().includes(q)
      );
    });
  }, [items, deptFilter, query]);

  const selected = useMemo(
    () => items.find((i) => i.productId === selectedId) ?? filteredItems[0] ?? null,
    [items, selectedId, filteredItems]
  );

  const handleSelectItem = (item: FreshPluItem) => {
    setSelectedId(item.productId);
    const tare = item.defaultTareGrams ?? 0;
    setTareInput(String(tare));
    setGrossInput(String(500 + tare));
  };

  const grossGrams = Math.max(0, Math.round(Number(grossInput) || 0));
  const tareGrams = Math.max(0, Math.round(Number(tareInput) || 0));
  const netGrams = Math.max(0, grossGrams - tareGrams);
  const isMeasured =
    selected?.unitMode === "weight_g" || selected?.unitMode === "volume_ml";
  const computedLineCents =
    selected && isMeasured && netGrams > 0
      ? computeWeightedPriceCents(netGrams, selected.sellPriceCents)
      : selected?.sellPriceCents ?? 0;

  const legalUnitPrice = selected
    ? computeLegalUnitPrice(
        selected.sellPriceCents,
        selected.netContentAmount,
        selected.netContentUnit,
        selected.unitMode
      )
    : null;

  const handleSimulateScale = () => {
    if (!selected || !selected.pluCode || !isMeasured || netGrams < 1 || selected.recalled) return;
    const gs1ScaleCode = buildScaleBarcode("weight", selected.pluCode, netGrams);
    onSimulateScaleBarcode(gs1ScaleCode);
    onClose();
  };

  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      labelledBy="fresh-plu-modal-title"
      style={{ maxWidth: 820 }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div>
          <h2 id="fresh-plu-modal-title" style={{ margin: 0, fontSize: 18, display: "flex", alignItems: "center", gap: 8 }}>
            <Scale size={18} aria-hidden="true" style={{ color: "var(--accent-primary-ink)" }} />
            Fresh Produce, Butcher, Deli &amp; Bakery PLU Scale
          </h2>
          <p className="page-subtitle" style={{ marginTop: 2 }}>
            Select a 4-/5-digit PLU, apply container tare, and ring up exact gram weight or test a GS1 prefix-20 scale barcode.
          </p>
        </div>
        <button type="button" className="btn btn-sm" aria-label="Close fresh PLU scale" onClick={onClose}>
          <X size={15} aria-hidden="true" />
        </button>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <div className="search-box" style={{ flex: "1 1 220px" }}>
          <Search size={14} className="search-icon" aria-hidden="true" />
          <input
            id="fresh-plu-search-input"
            aria-label="Search fresh PLU code or item name"
            className="input"
            placeholder="Filter by PLU (e.g. 4011, 20010, 40010) or item name..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }} role="group" aria-label="Fresh department filter">
          {DEPT_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`btn btn-sm ${deptFilter === f.id ? "btn-primary" : ""}`}
              aria-pressed={deptFilter === f.id}
              onClick={() => setDeptFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(175px, 1fr))",
          gap: 8,
          maxHeight: 240,
          overflowY: "auto",
          padding: 2,
        }}
      >
        {filteredItems.length === 0 ? (
          <div style={{ gridColumn: "1 / -1", color: "var(--ink-muted)", padding: "14px 4px" }}>
            No fresh PLU items matched your filter.
          </div>
        ) : (
          filteredItems.map((item) => {
            const isSelected = selected?.productId === item.productId;
            const measured = item.unitMode === "weight_g" || item.unitMode === "volume_ml";
            return (
              <button
                key={item.productId}
                type="button"
                className="quick-sku-btn"
                aria-pressed={isSelected}
                style={{
                  borderColor: isSelected ? "var(--accent-primary)" : undefined,
                  background: isSelected ? "var(--accent-primary-soft)" : undefined,
                  textAlign: "left",
                }}
                onClick={() => handleSelectItem(item)}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 4 }}>
                  <span className="tag tag-blue mono" style={{ fontSize: 10.5 }}>
                    PLU {item.pluCode ?? item.sku}
                  </span>
                  {item.recalled && (
                    <span className="tag tag-red" style={{ fontSize: 10 }}>
                      RECALLED
                    </span>
                  )}
                </div>
                <div className="quick-sku-name">{item.name}</div>
                <div className="quick-sku-foot">
                  <span style={{ color: "var(--ink-muted)", fontSize: 11 }}>
                    {measured ? (item.unitMode === "volume_ml" ? "per L" : "per kg") : "each"}
                  </span>
                  <strong className="mono">{formatMoney(item.sellPriceCents)}</strong>
                </div>
              </button>
            );
          })
        )}
      </div>

      {selected && (
        <div className="panel" style={{ background: "var(--bg-canvas)", margin: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
            <div>
              <div className="mono" style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                {selected.sku} {selected.pluCode ? `· PLU ${selected.pluCode}` : ""} ·{" "}
                {legalUnitPrice ?? `${formatMoney(selected.sellPriceCents)} each`}
              </div>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{selected.name}</div>
            </div>
            {selected.allergens.length > 0 && (
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {selected.allergens.map((a) => (
                  <span key={a} className="tag tag-amber mono" style={{ fontSize: 10.5 }}>
                    ALLERGEN: {a.toUpperCase()}
                  </span>
                ))}
              </div>
            )}
          </div>

          {selected.recalled ? (
            <div className="banner banner-red" role="alert">
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <AlertTriangle size={15} aria-hidden="true" />
                <strong>FOOD-SAFETY RECALL BLOCK:</strong> {selected.recallReason ?? "Item is locked from sale across all POS lanes."}
              </span>
            </div>
          ) : isMeasured ? (
            <>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                {WEIGHT_PRESETS_G.map((netPreset) => (
                  <button
                    key={netPreset}
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setGrossInput(String(netPreset + tareGrams))}
                  >
                    {formatMeasure(netPreset, selected.unitMode)} net
                  </button>
                ))}
              </div>

              <div className="form-grid" style={{ marginBottom: 12 }}>
                <div className="field">
                  <label htmlFor="fresh-gross-weight-input">
                    Gross Scale Weight ({selected.unitMode === "volume_ml" ? "ml" : "g"})
                  </label>
                  <input
                    id="fresh-gross-weight-input"
                    type="number"
                    min={1}
                    max={500000}
                    className="input mono"
                    value={grossInput}
                    onChange={(e) => setGrossInput(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="fresh-tare-weight-input">
                    Container / Tray Tare ({selected.unitMode === "volume_ml" ? "ml" : "g"})
                  </label>
                  <input
                    id="fresh-tare-weight-input"
                    type="number"
                    min={0}
                    max={50000}
                    className="input mono"
                    value={tareInput}
                    onChange={(e) => setTareInput(e.target.value)}
                  />
                </div>
              </div>

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 10,
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid var(--border-hairline)",
                  background: "var(--bg-surface)",
                  marginBottom: 12,
                }}
              >
                <div className="mono" style={{ fontSize: 12.5 }}>
                  Net: <strong>{formatMeasure(netGrams, selected.unitMode)}</strong>
                  {tareGrams > 0 ? ` (Tare -${tareGrams}g)` : ""} × {formatMoney(selected.sellPriceCents)}/
                  {selected.unitMode === "volume_ml" ? "L" : "kg"}
                </div>
                <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: "var(--accent-primary-ink)" }}>
                  {formatMoney(computedLineCents)}
                </div>
              </div>

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  id="fresh-add-weighted-btn"
                  type="button"
                  className="btn btn-primary"
                  disabled={netGrams < 1}
                  onClick={() => {
                    onAddWeighted(selected, netGrams, tareGrams);
                    onClose();
                  }}
                >
                  <Scale size={14} aria-hidden="true" /> Add {formatMeasure(netGrams, selected.unitMode)} to Basket (
                  {formatMoney(computedLineCents)})
                </button>
                {selected.pluCode && (
                  <button
                    id="fresh-simulate-scale-btn"
                    type="button"
                    className="btn"
                    disabled={netGrams < 1}
                    onClick={handleSimulateScale}
                  >
                    <Barcode size={14} aria-hidden="true" /> Simulate GS1 Scale Barcode
                  </button>
                )}
              </div>
            </>
          ) : (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
              <div className="mono" style={{ fontSize: 13 }}>
                Unit Price: <strong>{formatMoney(selected.sellPriceCents)}</strong>{" "}
                {legalUnitPrice ? `(${legalUnitPrice})` : ""}
              </div>
              <button
                id="fresh-add-each-btn"
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  onAddEach(selected);
                  onClose();
                }}
              >
                Add 1× to Basket ({formatMoney(selected.sellPriceCents)})
              </button>
            </div>
          )}
        </div>
      )}
    </ModalDialog>
  );
}
