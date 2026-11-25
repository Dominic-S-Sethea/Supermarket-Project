import { useEffect, useState } from "react";
import { formatBp, formatMoney } from "@supermarket/shared";
import {
  CheckCircle2,
  ClipboardCheck,
  Copy,
  Download,
  Ghost,
  Percent,
  Printer,
  RefreshCw,
} from "lucide-react";
import { apiGet, apiPost } from "../api";

interface PhantomItem {
  productId: string;
  sku: string;
  name: string;
  brand: string;
  aisleLocation: string;
  departmentName: string;
  avgCostCents: number;
  bookStockUnits: number;
  avgDailyUnits: number;
  daysSinceLastSale: number;
  voidRefundScore: number;
  phantomProb: number;
  estimatedValueAtRiskCents: number;
  status: string;
}

interface PhantomSummary {
  totalFlagged: number;
  openCount: number;
  verifiedCount: number;
  openAtRiskCents: number;
  avgPhantomProb: number;
}

interface MarkdownItem {
  batchId: string;
  productId: string;
  sku: string;
  name: string;
  brand: string;
  aisleLocation: string;
  departmentName: string;
  lotCode: string;
  bestBeforeDate: string;
  daysLeft: number;
  qtyRemaining: number;
  currentSellPriceCents: number;
  unitCostCents: number;
  recommendedDiscountBp: number;
  recommendedPromoPriceCents: number;
  predictedClearanceUnits: number;
  expectedRecoveryCents: number;
  baselineNoPromoRecoveryCents: number;
  incrementalRecoveryCents: number;
  status: string;
}

interface MarkdownSummary {
  recommendedCount: number;
  appliedCount: number;
  incrementalRecoveryCents: number;
  totalRecommendedRecoveryCents: number;
}

interface ShelfTag {
  id: string;
  productId: string;
  sku: string;
  name: string;
  aisleLocation: string;
  barcode: string;
  oldPriceCents: number;
  newPriceCents: number;
  reason: string;
  status: string;
  printedBy: string | null;
  printedAt: string | null;
  createdAt: string;
}

interface ShelfTagSummary {
  pendingCount: number;
  printedCount: number;
}

export function ShelfIntegrityTab({
  canManage,
  onFeedback,
  onError,
}: {
  canManage: boolean;
  onFeedback: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [phantomItems, setPhantomItems] = useState<PhantomItem[]>([]);
  const [phantomSummary, setPhantomSummary] = useState<PhantomSummary | null>(null);
  const [markdownItems, setMarkdownItems] = useState<MarkdownItem[]>([]);
  const [markdownSummary, setMarkdownSummary] = useState<MarkdownSummary | null>(null);
  const [tags, setTags] = useState<ShelfTag[]>([]);
  const [tagSummary, setTagSummary] = useState<ShelfTagSummary | null>(null);

  const [countInputs, setCountInputs] = useState<Record<string, string>>({});
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
  const [printedZpl, setPrintedZpl] = useState<{ count: number; zpl: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const loadAll = async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const [phRes, mdRes, tagRes] = await Promise.all([
        apiGet<{ summary: PhantomSummary; items: PhantomItem[] }>(
          "/api/inventory/phantom-stock",
          signal
        ),
        apiGet<{ summary: MarkdownSummary; items: MarkdownItem[] }>(
          "/api/inventory/dynamic-markdowns",
          signal
        ),
        apiGet<{ summary: ShelfTagSummary; tags: ShelfTag[] }>("/api/labels/queue", signal),
      ]);
      if (signal?.aborted) return;
      setPhantomItems(phRes.items);
      setPhantomSummary(phRes.summary);
      setMarkdownItems(mdRes.items);
      setMarkdownSummary(mdRes.summary);
      setTags(tagRes.tags);
      setTagSummary(tagRes.summary);
      setSelectedTagIds(
        new Set(tagRes.tags.filter((t) => t.status === "pending").map((t) => t.id))
      );
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        onError(err instanceof Error ? err.message : "Failed loading shelf integrity data");
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void loadAll(controller.signal);
    return () => controller.abort();
  }, []);

  const handleVerifyPhantom = async (item: PhantomItem, markVerifiedOk: boolean) => {
    if (busyAction) return;
    const rawVal = countInputs[item.productId];
    let payload: { countedBaseUnits?: number; markVerifiedOk?: boolean };
    if (markVerifiedOk) {
      payload = { markVerifiedOk: true };
    } else {
      const parsed = Number(rawVal);
      if (rawVal === undefined || rawVal.trim() === "" || !Number.isInteger(parsed) || parsed < 0) {
        onError(`Enter a non-negative whole-unit blind count for ${item.sku}.`);
        return;
      }
      payload = { countedBaseUnits: parsed };
    }
    setBusyAction(`phantom-${item.productId}`);
    try {
      const res = await apiPost<{
        status: string;
        expectedUnits: number;
        countedUnits: number;
        varianceUnits: number;
      }>(`/api/inventory/phantom-stock/${item.productId}/verify`, payload);
      onFeedback(
        res.varianceUnits === 0
          ? `Verified ${item.sku} on shelf (${res.countedUnits} units match ledger).`
          : `Recounted ${item.sku}: adjusted ledger by ${res.varianceUnits > 0 ? `+${res.varianceUnits}` : res.varianceUnits} units (${res.expectedUnits} → ${res.countedUnits}).`
      );
      await loadAll();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed verifying phantom stock SKU");
    } finally {
      setBusyAction(null);
    }
  };

  const handleApplyMarkdown = async (item: MarkdownItem) => {
    if (busyAction) return;
    setBusyAction(`md-${item.batchId}`);
    try {
      const res = await apiPost<{ promoPriceCents: number; discountBp: number }>(
        `/api/inventory/dynamic-markdowns/${item.batchId}/apply`,
        {
          discountBp: item.recommendedDiscountBp,
          minMarginGuardBp: 0,
        }
      );
      onFeedback(
        `Applied ${formatBp(res.discountBp)} dynamic markdown on ${item.sku} (${formatMoney(res.promoPriceCents)}) and queued a 07:30 clearance shelf tag.`
      );
      await loadAll();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed applying dynamic markdown");
    } finally {
      setBusyAction(null);
    }
  };

  const toggleTag = (id: string) => {
    setSelectedTagIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handlePrintSelectedTags = async () => {
    if (busyAction || selectedTagIds.size === 0) return;
    setBusyAction("print-tags");
    try {
      const res = await apiPost<{ printedCount: number; zpl: string }>("/api/labels/queue/print", {
        tagIds: Array.from(selectedTagIds),
      });
      setPrintedZpl({ count: res.printedCount, zpl: res.zpl });
      onFeedback(
        `Generated Zebra ZPL batch for ${res.printedCount} shelf tag(s) and marked queue printed.`
      );
      await loadAll();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed printing shelf tag batch");
    } finally {
      setBusyAction(null);
    }
  };

  const handleDownloadZpl = () => {
    if (!printedZpl) return;
    const blob = new Blob([printedZpl.zpl], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `shelf-tags-${new Date().toISOString().slice(0, 10)}.zpl`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const pendingTags = tags.filter((t) => t.status === "pending");

  return (
    <div className="stack-md" style={{ gap: 20 }}>
      <div className="kpi-strip">
        <div className="kpi-tile">
          <div className="kpi-label">Open Phantom Stock Alerts</div>
          <div
            className="kpi-value"
            style={{
              color: (phantomSummary?.openCount ?? 0) > 0 ? "var(--accent-crimson)" : "var(--accent-primary)",
            }}
          >
            {phantomSummary?.openCount ?? 0}
          </div>
          <div className="kpi-meta">
            {formatMoney(phantomSummary?.openAtRiskCents ?? 0)} book stock at risk ·{" "}
            {phantomSummary?.verifiedCount ?? 0} verified
          </div>
        </div>
        <div className="kpi-tile">
          <div className="kpi-label">Recommended Dynamic Markdowns</div>
          <div className="kpi-value">{markdownSummary?.recommendedCount ?? 0}</div>
          <div className="kpi-meta">
            {markdownSummary?.appliedCount ?? 0} batches already on clearance
          </div>
        </div>
        <div className="kpi-tile">
          <div className="kpi-label">Incremental FEFO Cash Recovery</div>
          <div className="kpi-value" style={{ color: "var(--accent-primary)" }}>
            +{formatMoney(Math.max(0, markdownSummary?.incrementalRecoveryCents ?? 0))}
          </div>
          <div className="kpi-meta">Expected net lift vs. no-markdown spoilage</div>
        </div>
        <div className="kpi-tile">
          <div className="kpi-label">07:30 Shelf Tag Queue</div>
          <div
            className="kpi-value"
            style={{
              color: (tagSummary?.pendingCount ?? 0) > 0 ? "var(--accent-amber)" : "var(--accent-primary)",
            }}
          >
            {tagSummary?.pendingCount ?? 0} pending
          </div>
          <div className="kpi-meta">{tagSummary?.printedCount ?? 0} printed tags logged</div>
        </div>
      </div>

      {/* 1. 07:30 Shelf Tag Print Queue */}
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2 className="panel-title">
              <Printer size={15} style={{ verticalAlign: "middle", marginRight: 6, color: "var(--accent-primary)" }} />
              07:30 Shelf Tag Batch ZPL Print Queue ({tagSummary?.pendingCount ?? 0} Pending)
            </h2>
            <p className="panel-desc">
              Every cost-update price override and dynamic clearance markdown queues a Zebra ZPL shelf talker here so shelf labels stay 100% synced with POS.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              className="btn btn-sm"
              disabled={loading || pendingTags.length === 0}
              onClick={() => setSelectedTagIds(new Set(pendingTags.map((t) => t.id)))}
            >
              Select All Pending ({pendingTags.length})
            </button>
            <button
              id="print-shelf-tags-btn"
              className="btn btn-primary btn-sm"
              disabled={busyAction !== null || selectedTagIds.size === 0}
              onClick={() => void handlePrintSelectedTags()}
            >
              <Printer size={13} />{" "}
              {busyAction === "print-tags"
                ? "Generating ZPL..."
                : `Print Selected Batch (${selectedTagIds.size})`}
            </button>
            <button className="btn btn-sm" disabled={loading} onClick={() => void loadAll()}>
              <RefreshCw size={13} /> Refresh
            </button>
          </div>
        </div>

        {printedZpl && (
          <div className="triage-box" style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
              <strong style={{ fontSize: 12.5 }}>
                Zebra ZPL Batch Ready ({printedZpl.count} labels)
              </strong>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    void navigator.clipboard?.writeText(printedZpl.zpl);
                    onFeedback("Copied Zebra ZPL batch payload to clipboard.");
                  }}
                >
                  <Copy size={12} /> Copy ZPL
                </button>
                <button className="btn btn-primary btn-sm" onClick={handleDownloadZpl}>
                  <Download size={12} /> Download .zpl
                </button>
                <button className="btn btn-sm" onClick={() => setPrintedZpl(null)}>
                  Close
                </button>
              </div>
            </div>
            <pre
              className="mono"
              style={{
                fontSize: 11,
                maxHeight: 160,
                overflow: "auto",
                background: "var(--bg-subtle)",
                padding: 10,
                borderRadius: 6,
                margin: 0,
              }}
            >
              {printedZpl.zpl}
            </pre>
          </div>
        )}

        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: 34 }} />
                <th>SKU / Product</th>
                <th>Aisle &amp; Barcode</th>
                <th>Reason</th>
                <th className="text-right">Old → New Price</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {loading && tags.length === 0 ? (
                <tr>
                  <td colSpan={6}>Loading shelf tag queue...</td>
                </tr>
              ) : tags.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: "center", color: "var(--ink-muted)", padding: "18px 12px" }}>
                    Shelf tag queue is empty.
                  </td>
                </tr>
              ) : (
                tags.slice(0, 40).map((t) => (
                  <tr key={t.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select shelf tag ${t.sku}`}
                        checked={selectedTagIds.has(t.id)}
                        onChange={() => toggleTag(t.id)}
                      />
                    </td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{t.name}</div>
                      <div className="mono" style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                        {t.sku}
                      </div>
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      Aisle {t.aisleLocation} · {t.barcode}
                    </td>
                    <td>
                      <span
                        className={`tag ${
                          t.reason === "clearance"
                            ? "tag-amber"
                            : t.reason === "cost_change"
                              ? "tag-blue"
                              : "tag-neutral"
                        }`}
                      >
                        {t.reason.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="text-right mono">
                      {formatMoney(t.oldPriceCents)} →{" "}
                      <strong style={{ color: "var(--accent-primary)" }}>
                        {formatMoney(t.newPriceCents)}
                      </strong>
                    </td>
                    <td>
                      {t.status === "printed" ? (
                        <span className="tag tag-green">
                          printed{t.printedBy ? ` · ${t.printedBy}` : ""}
                        </span>
                      ) : (
                        <span className="tag tag-amber">pending</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* 2. Dynamic FEFO Markdown Optimizer */}
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2 className="panel-title">
              <Percent size={15} style={{ verticalAlign: "middle", marginRight: 6, color: "var(--accent-amber)" }} />
              Dynamic FEFO Markdown Optimizer ({markdownItems.length} Batches)
            </h2>
            <p className="panel-desc">
              Elasticity-calibrated discount ladder maximizing expected cash recovery before Best-Before expiry. Applying creates the clearance promotion and queues a shelf tag atomically.
            </p>
          </div>
        </div>

        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Days Left</th>
                <th>Product &amp; Batch</th>
                <th className="text-right">Qty</th>
                <th className="text-right">Price → Optimal</th>
                <th className="text-right">Est. Clearance</th>
                <th className="text-right">Recovery Lift</th>
                <th>Status</th>
                {canManage && <th className="text-right">Action</th>}
              </tr>
            </thead>
            <tbody>
              {loading && markdownItems.length === 0 ? (
                <tr>
                  <td colSpan={canManage ? 8 : 7}>Loading dynamic markdown recommendations...</td>
                </tr>
              ) : markdownItems.length === 0 ? (
                <tr>
                  <td colSpan={canManage ? 8 : 7} style={{ textAlign: "center", color: "var(--ink-muted)", padding: "18px 12px" }}>
                    No dynamic markdown batches currently flagged.
                  </td>
                </tr>
              ) : (
                markdownItems.slice(0, 25).map((m) => (
                  <tr key={m.batchId}>
                    <td>
                      <span
                        className={`tag mono ${
                          m.daysLeft <= 10 ? "tag-red" : m.daysLeft <= 21 ? "tag-amber" : "tag-neutral"
                        }`}
                      >
                        {m.daysLeft}d
                      </span>
                    </td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{m.name}</div>
                      <div className="mono" style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                        {m.sku} · Aisle {m.aisleLocation} · Lot {m.lotCode} ({m.bestBeforeDate})
                      </div>
                    </td>
                    <td className="text-right mono">{m.qtyRemaining}</td>
                    <td className="text-right mono">
                      {formatMoney(m.currentSellPriceCents)} →{" "}
                      <strong style={{ color: "var(--accent-primary)" }}>
                        {formatMoney(m.recommendedPromoPriceCents)}
                      </strong>{" "}
                      <span className="tag tag-amber mono">-{formatBp(m.recommendedDiscountBp)}</span>
                    </td>
                    <td className="text-right mono">
                      {m.predictedClearanceUnits} / {m.qtyRemaining} u
                    </td>
                    <td className="text-right mono" style={{ color: "var(--accent-primary)", fontWeight: 700 }}>
                      +{formatMoney(Math.max(0, m.incrementalRecoveryCents))}
                    </td>
                    <td>
                      <span className={`tag ${m.status === "applied" ? "tag-green" : "tag-blue"}`}>
                        {m.status}
                      </span>
                    </td>
                    {canManage && (
                      <td className="text-right">
                        {m.status === "applied" ? (
                          <span style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                            <CheckCircle2 size={13} style={{ verticalAlign: "middle", marginRight: 4 }} />
                            Applied
                          </span>
                        ) : (
                          <button
                            className="btn btn-primary btn-sm"
                            disabled={busyAction !== null}
                            onClick={() => void handleApplyMarkdown(m)}
                          >
                            {busyAction === `md-${m.batchId}` ? "Applying..." : "Apply Markdown"}
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* 3. Phantom Stock Detector & Blind Cycle Count */}
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2 className="panel-title">
              <Ghost size={15} style={{ verticalAlign: "middle", marginRight: 6, color: "var(--accent-crimson)" }} />
              Phantom Stock Detector — Silent Zero-Sales Ghost Inventory ({phantomItems.length})
            </h2>
            <p className="panel-desc">
              Poisson zero-sales probability detector flagging SKUs with positive ledger stock that stopped scanning at POS. Floor clerks can blind-recount or confirm stock on shelf.
            </p>
          </div>
        </div>

        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Prob</th>
                <th>Product &amp; Aisle</th>
                <th className="text-right">Book Stock</th>
                <th className="text-right">Avg / Day</th>
                <th className="text-right">Silent Days</th>
                <th className="text-right">Value at Risk</th>
                <th>Status</th>
                <th className="text-right">Blind Count Verification</th>
              </tr>
            </thead>
            <tbody>
              {loading && phantomItems.length === 0 ? (
                <tr>
                  <td colSpan={8}>Loading phantom stock alerts...</td>
                </tr>
              ) : phantomItems.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: "center", color: "var(--ink-muted)", padding: "18px 12px" }}>
                    No phantom stock alerts detected.
                  </td>
                </tr>
              ) : (
                phantomItems.slice(0, 25).map((p) => (
                  <tr key={p.productId}>
                    <td>
                      <span
                        className={`tag mono ${
                          p.phantomProb >= 0.8 ? "tag-red" : p.phantomProb >= 0.6 ? "tag-amber" : "tag-neutral"
                        }`}
                      >
                        {Math.round(p.phantomProb * 100)}%
                      </span>
                    </td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{p.name}</div>
                      <div style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                        {p.sku} · {p.departmentName} · Aisle {p.aisleLocation}
                      </div>
                    </td>
                    <td className="text-right mono">{p.bookStockUnits}</td>
                    <td className="text-right mono">{p.avgDailyUnits.toFixed(1)}</td>
                    <td className="text-right mono">{p.daysSinceLastSale.toFixed(1)}d</td>
                    <td className="text-right mono" style={{ fontWeight: 600 }}>
                      {formatMoney(p.estimatedValueAtRiskCents)}
                    </td>
                    <td>
                      <span
                        className={`tag ${
                          p.status === "open"
                            ? "tag-red"
                            : p.status === "recounted"
                              ? "tag-blue"
                              : "tag-green"
                        }`}
                      >
                        {p.status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="text-right">
                      {p.status !== "open" ? (
                        <span style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                          <CheckCircle2 size={13} style={{ verticalAlign: "middle", marginRight: 4 }} />
                          Verified
                        </span>
                      ) : (
                        <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                          <input
                            className="input mono"
                            type="number"
                            min={0}
                            placeholder="Count"
                            style={{ width: 72, padding: "4px 6px", fontSize: 12 }}
                            value={countInputs[p.productId] ?? ""}
                            onChange={(e) =>
                              setCountInputs((prev) => ({ ...prev, [p.productId]: e.target.value }))
                            }
                          />
                          <button
                            className="btn btn-primary btn-sm"
                            disabled={busyAction !== null}
                            onClick={() => void handleVerifyPhantom(p, false)}
                          >
                            <ClipboardCheck size={12} /> Post Count
                          </button>
                          <button
                            className="btn btn-sm"
                            disabled={busyAction !== null}
                            onClick={() => void handleVerifyPhantom(p, true)}
                          >
                            Stock OK
                          </button>
                        </div>
                      )}
                    </td>
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
