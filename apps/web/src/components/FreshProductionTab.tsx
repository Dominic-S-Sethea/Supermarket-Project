import { useCallback, useEffect, useMemo, useState } from "react";
import type { UnitMode } from "@supermarket/shared/dtos";
import { formatBp, formatMeasure, formatMoney } from "@supermarket/shared/money";
import { ChefHat, Flame, RefreshCw } from "lucide-react";
import { apiGet, apiPost } from "../api";

interface RecipeIngredientRow {
  id: string;
  recipeId: string;
  ingredientProductId: string;
  sku: string;
  name: string;
  unitMode: UnitMode;
  baseUnitLabel: string;
  avgCostCents: number;
  qtyBaseUnits: number;
  onHandUnits: number;
  estimatedLineCostCents: number;
}

interface RecipeRow {
  id: string;
  code: string;
  name: string;
  outputProductId: string;
  outputSku: string;
  outputName: string;
  outputUnitMode: UnitMode;
  outputBaseUnitLabel: string;
  expectedYieldBaseUnits: number;
  shelfLifeDays: number;
  notes: string | null;
  active: boolean;
  ingredients: RecipeIngredientRow[];
  estimatedBatchCostCents: number;
}

interface ProductionBatchRow {
  id: string;
  recipeId: string;
  recipeCode: string;
  recipeName: string;
  outputProductId: string;
  outputSku: string;
  outputName: string;
  outputUnitMode: UnitMode;
  lotCode: string;
  batchMultiplier: number;
  expectedOutputUnits: number;
  actualOutputUnits: number;
  trimWasteUnits: number;
  yieldBp: number;
  totalIngredientCostCents: number;
  effectiveUnitCostCents: number;
  producedBy: string;
  notes: string | null;
  producedAt: string;
}

function fmtUnits(amount: number, unitMode: UnitMode, baseLabel = "unit"): string {
  if (unitMode === "weight_g" || unitMode === "volume_ml") {
    return formatMeasure(amount, unitMode);
  }
  return `${amount.toLocaleString()} ${baseLabel}${amount === 1 ? "" : "s"}`;
}

export function FreshProductionTab({
  onFeedback,
  onError,
}: {
  onFeedback: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [recipes, setRecipes] = useState<RecipeRow[]>([]);
  const [batches, setBatches] = useState<ProductionBatchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [selectedRecipeId, setSelectedRecipeId] = useState("");
  const [multiplier, setMultiplier] = useState(1);
  const [actualOutput, setActualOutput] = useState("10");
  const [trimWaste, setTrimWaste] = useState("0");
  const [lotCode, setLotCode] = useState("");
  const [notes, setNotes] = useState("");

  const loadData = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const res = await apiGet<{ recipes: RecipeRow[]; recentBatches: ProductionBatchRow[] }>(
          "/api/operations/recipes",
          signal
        );
        if (signal?.aborted) return;
        setRecipes(res.recipes);
        setBatches(res.recentBatches);
        setSelectedRecipeId((prev) => {
          if (prev && res.recipes.some((r) => r.id === prev)) return prev;
          const first = res.recipes[0];
          if (first) {
            setMultiplier(1);
            setActualOutput(String(first.expectedYieldBaseUnits));
            setTrimWaste("0");
          }
          return first?.id ?? "";
        });
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          onError(err instanceof Error ? err.message : "Failed loading bakery & deli BOM recipes");
        }
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [onError]
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadData(controller.signal);
    return () => controller.abort();
  }, [loadData]);

  const activeRecipe = useMemo(
    () => recipes.find((r) => r.id === selectedRecipeId) ?? recipes[0] ?? null,
    [recipes, selectedRecipeId]
  );

  const handleSelectRecipe = (nextId: string) => {
    setSelectedRecipeId(nextId);
    const rec = recipes.find((r) => r.id === nextId);
    if (rec) {
      setMultiplier(1);
      setActualOutput(String(rec.expectedYieldBaseUnits));
      setTrimWaste("0");
    }
  };

  const handleMultiplierChange = (nextMult: number) => {
    const clamped = Math.max(1, Math.min(100, Math.trunc(nextMult) || 1));
    setMultiplier(clamped);
    if (activeRecipe) {
      setActualOutput(String(activeRecipe.expectedYieldBaseUnits * clamped));
    }
  };

  const expectedOutputUnits = activeRecipe
    ? activeRecipe.expectedYieldBaseUnits * multiplier
    : 0;
  const parsedActual = Math.max(1, Math.trunc(Number(actualOutput) || 0));
  const parsedTrim = Math.max(0, Math.trunc(Number(trimWaste) || 0));
  const previewYieldBp =
    expectedOutputUnits > 0 ? Math.round((parsedActual * 10000) / expectedOutputUnits) : 10000;
  const previewTotalCostCents = activeRecipe
    ? activeRecipe.estimatedBatchCostCents * multiplier
    : 0;
  const outputIsMeasured =
    activeRecipe?.outputUnitMode === "weight_g" || activeRecipe?.outputUnitMode === "volume_ml";
  const previewEffectiveUnitCost =
    parsedActual > 0
      ? outputIsMeasured
        ? Math.round((previewTotalCostCents * 1000) / parsedActual)
        : Math.round(previewTotalCostCents / parsedActual)
      : 0;

  const avgYieldBp = useMemo(() => {
    if (batches.length === 0) return 10000;
    return Math.round(batches.reduce((s, b) => s + b.yieldBp, 0) / batches.length);
  }, [batches]);

  const totalBatchCostCents = useMemo(
    () => batches.reduce((s, b) => s + b.totalIngredientCostCents, 0),
    [batches]
  );

  const handleSubmitBatch = async () => {
    if (!activeRecipe || submitting) return;
    if (!Number.isInteger(parsedActual) || parsedActual < 1) {
      onError("Actual output must be an integer >= 1.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiPost<{
        batch: {
          lotCode: string;
          actualOutputUnits: number;
          yieldBp: number;
          effectiveUnitCostCents: number;
        };
      }>("/api/operations/production-batches", {
        recipeId: activeRecipe.id,
        batchMultiplier: multiplier,
        actualOutputUnits: parsedActual,
        trimWasteUnits: parsedTrim,
        lotCode: lotCode.trim() ? lotCode.trim() : undefined,
        notes: notes.trim() ? notes.trim() : undefined,
      });
      setLotCode("");
      setNotes("");
      setTrimWaste("0");
      onFeedback(
        `Logged production batch ${res.batch.lotCode} (${activeRecipe.code}): produced ${fmtUnits(
          res.batch.actualOutputUnits,
          activeRecipe.outputUnitMode,
          activeRecipe.outputBaseUnitLabel
        )} at ${formatBp(res.batch.yieldBp)} yield (${formatMoney(
          res.batch.effectiveUnitCostCents
        )}/${outputIsMeasured ? (activeRecipe.outputUnitMode === "volume_ml" ? "L" : "kg") : activeRecipe.outputBaseUnitLabel}). Raw ingredients deducted via FEFO.`
      );
      await loadData();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed logging production batch");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="stack-md">
      <div className="kpi-strip">
        <div className="kpi-tile">
          <div className="kpi-label">Active Fresh BOM Recipes</div>
          <div className="kpi-value">{recipes.length}</div>
          <div className="kpi-sub">Bakery, Butcher Trim &amp; Deli Platters</div>
        </div>
        <div className="kpi-tile">
          <div className="kpi-label">Batches Logged</div>
          <div className="kpi-value">{batches.length}</div>
          <div className="kpi-sub">Auto FEFO raw-material deduction</div>
        </div>
        <div className="kpi-tile">
          <div className="kpi-label">Average Batch Yield</div>
          <div className="kpi-value">{formatBp(avgYieldBp)}</div>
          <div className="kpi-sub">Actual vs standard recipe yield</div>
        </div>
        <div className="kpi-tile">
          <div className="kpi-label">Logged Production COGS</div>
          <div className="kpi-value">{formatMoney(totalBatchCostCents)}</div>
          <div className="kpi-sub">Audited raw ingredient consumption</div>
        </div>
      </div>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2 className="panel-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <ChefHat size={17} aria-hidden="true" style={{ color: "var(--accent-primary-ink)" }} />
              Log In-Store Bakery, Butcher &amp; Deli Production Batch
            </h2>
            <p className="panel-desc">
              Deducts raw ingredients (flour, butter, primal beef, bulk deli) via FEFO batches, mints a dated finished-goods FEFO lot, and computes effective unit cost + trim yield.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            disabled={loading}
            onClick={() => void loadData()}
          >
            <RefreshCw size={13} aria-hidden="true" /> Refresh
          </button>
        </div>

        {loading && recipes.length === 0 ? (
          <div style={{ color: "var(--ink-muted)", padding: "14px 0" }}>
            Loading fresh production BOM recipes...
          </div>
        ) : !activeRecipe ? (
          <div style={{ color: "var(--ink-muted)", padding: "14px 0" }}>
            No active BOM recipes configured.
          </div>
        ) : (
          <div className="stack-md">
            <div className="form-grid">
              <div className="field">
                <label htmlFor="bom-recipe-select">Production Recipe (BOM)</label>
                <select
                  id="bom-recipe-select"
                  className="select"
                  value={activeRecipe.id}
                  onChange={(e) => handleSelectRecipe(e.target.value)}
                  disabled={submitting}
                >
                  {recipes.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.code} — {r.name} ({r.outputSku})
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="bom-multiplier-input">Batch Multiplier</label>
                <input
                  id="bom-multiplier-input"
                  type="number"
                  min={1}
                  max={100}
                  className="input mono"
                  value={multiplier}
                  onChange={(e) => handleMultiplierChange(Number(e.target.value))}
                  disabled={submitting}
                />
              </div>
              <div className="field">
                <label htmlFor="bom-actual-output-input">
                  Actual Output ({outputIsMeasured ? (activeRecipe.outputUnitMode === "volume_ml" ? "ml" : "grams") : `${activeRecipe.outputBaseUnitLabel}s`})
                </label>
                <input
                  id="bom-actual-output-input"
                  type="number"
                  min={1}
                  className="input mono"
                  value={actualOutput}
                  onChange={(e) => setActualOutput(e.target.value)}
                  disabled={submitting}
                />
              </div>
              <div className="field">
                <label htmlFor="bom-trim-waste-input">
                  Trim / Spoilage Waste ({outputIsMeasured ? "grams" : "units/g"})
                </label>
                <input
                  id="bom-trim-waste-input"
                  type="number"
                  min={0}
                  className="input mono"
                  value={trimWaste}
                  onChange={(e) => setTrimWaste(e.target.value)}
                  disabled={submitting}
                />
              </div>
              <div className="field">
                <label htmlFor="bom-lot-code-input">Custom Lot Code (Optional)</label>
                <input
                  id="bom-lot-code-input"
                  className="input mono"
                  placeholder={`Auto: PROD-${activeRecipe.code}-YYMMDD`}
                  value={lotCode}
                  onChange={(e) => setLotCode(e.target.value)}
                  disabled={submitting}
                />
              </div>
              <div className="field">
                <label htmlFor="bom-notes-input">Production / Oven / Butcher Notes</label>
                <input
                  id="bom-notes-input"
                  className="input"
                  placeholder="e.g. 05:30 AM first bake, stone deck oven"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  disabled={submitting}
                />
              </div>
            </div>

            {activeRecipe.notes && (
              <div style={{ fontSize: 12.5, color: "var(--ink-secondary)" }}>
                <strong>Standard SOP:</strong> {activeRecipe.notes} · Shelf life{" "}
                <strong className="mono">{activeRecipe.shelfLifeDays} day(s)</strong>
              </div>
            )}

            <div className="table-wrap" role="region" aria-label="Recipe raw ingredients requirement" tabIndex={0}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Raw Ingredient SKU</th>
                    <th>Ingredient Name</th>
                    <th className="text-right">Required ({multiplier}×)</th>
                    <th className="text-right">Live On Hand</th>
                    <th className="text-right">Est. Raw Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {activeRecipe.ingredients.map((ing) => {
                    const reqUnits = ing.qtyBaseUnits * multiplier;
                    const short = ing.onHandUnits < reqUnits;
                    return (
                      <tr key={ing.id}>
                        <td className="mono">{ing.sku}</td>
                        <td>{ing.name}</td>
                        <td className="text-right mono">
                          {fmtUnits(reqUnits, ing.unitMode, ing.baseUnitLabel)}
                        </td>
                        <td className="text-right mono">
                          <span
                            style={{
                              fontWeight: 600,
                              color: short ? "var(--accent-crimson)" : "inherit",
                            }}
                          >
                            {fmtUnits(ing.onHandUnits, ing.unitMode, ing.baseUnitLabel)}
                          </span>
                          {short && (
                            <span className="tag tag-red" style={{ marginLeft: 6, fontSize: 10 }}>
                              LOW
                            </span>
                          )}
                        </td>
                        <td className="text-right mono">
                          {formatMoney(ing.estimatedLineCostCents * multiplier)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 12,
                padding: "10px 14px",
                borderRadius: 8,
                background: "var(--bg-canvas)",
                border: "1px solid var(--border-hairline)",
              }}
            >
              <div className="mono" style={{ fontSize: 12.5, display: "flex", gap: 14, flexWrap: "wrap" }}>
                <span>
                  Expected:{" "}
                  <strong>
                    {fmtUnits(
                      expectedOutputUnits,
                      activeRecipe.outputUnitMode,
                      activeRecipe.outputBaseUnitLabel
                    )}
                  </strong>
                </span>
                <span>
                  Yield:{" "}
                  <strong
                    style={{
                      color:
                        previewYieldBp < 9000
                          ? "var(--accent-crimson)"
                          : "var(--accent-primary-ink)",
                    }}
                  >
                    {formatBp(previewYieldBp)}
                  </strong>
                </span>
                <span>
                  Total Raw COGS: <strong>{formatMoney(previewTotalCostCents)}</strong>
                </span>
                <span>
                  Effective Cost:{" "}
                  <strong>
                    {formatMoney(previewEffectiveUnitCost)}/
                    {outputIsMeasured
                      ? activeRecipe.outputUnitMode === "volume_ml"
                        ? "L"
                        : "kg"
                      : activeRecipe.outputBaseUnitLabel}
                  </strong>
                </span>
              </div>
              <button
                id="bom-log-batch-btn"
                type="button"
                className="btn btn-primary"
                disabled={submitting || parsedActual < 1}
                onClick={() => void handleSubmitBatch()}
              >
                <Flame size={14} aria-hidden="true" />{" "}
                {submitting ? "Posting Batch..." : "Log Production Batch & Deduct Raw Stock"}
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-header" style={{ marginBottom: 10 }}>
          <div>
            <h2 className="panel-title">Recent Bakery, Butcher &amp; Deli Production Ledger</h2>
            <p className="panel-desc">
              Immutable batch yield history linked directly to FEFO finished-goods lots and raw-material stock movements.
            </p>
          </div>
        </div>
        <div className="table-wrap" role="region" aria-label="Recent BOM production batches" tabIndex={0}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Produced At</th>
                <th>Lot Code</th>
                <th>Recipe / Output</th>
                <th className="text-right">Expected</th>
                <th className="text-right">Actual</th>
                <th className="text-right">Trim Waste</th>
                <th className="text-right">Yield</th>
                <th className="text-right">Eff. Unit Cost</th>
                <th>Operator</th>
              </tr>
            </thead>
            <tbody>
              {batches.length === 0 ? (
                <tr>
                  <td colSpan={9} style={{ textAlign: "center", color: "var(--ink-muted)", padding: "20px 12px" }}>
                    No production batches logged yet. Log your first morning bake, butcher trim, or deli tray above.
                  </td>
                </tr>
              ) : (
                batches.map((b) => (
                  <tr key={b.id}>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {new Date(b.producedAt).toLocaleString()}
                    </td>
                    <td className="mono" style={{ fontWeight: 600 }}>
                      {b.lotCode}
                    </td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{b.outputName}</div>
                      <div className="mono" style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                        {b.recipeCode} · {b.batchMultiplier}× batch
                      </div>
                    </td>
                    <td className="text-right mono">
                      {fmtUnits(b.expectedOutputUnits, b.outputUnitMode)}
                    </td>
                    <td className="text-right mono" style={{ fontWeight: 600 }}>
                      {fmtUnits(b.actualOutputUnits, b.outputUnitMode)}
                    </td>
                    <td className="text-right mono">{b.trimWasteUnits}</td>
                    <td className="text-right">
                      <span
                        className={`tag mono ${
                          b.yieldBp < 9000 ? "tag-red" : b.yieldBp >= 9800 ? "tag-green" : "tag-amber"
                        }`}
                      >
                        {formatBp(b.yieldBp)}
                      </span>
                    </td>
                    <td className="text-right mono">{formatMoney(b.effectiveUnitCostCents)}</td>
                    <td>{b.producedBy}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
