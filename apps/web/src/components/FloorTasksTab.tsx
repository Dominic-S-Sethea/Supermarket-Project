import { useEffect, useState } from "react";
import { CheckCircle2, ClipboardList, RefreshCw } from "lucide-react";
import { apiGet, apiPost } from "../api";

interface FloorTask {
  id: string;
  taskDate: string;
  shiftBucket: string;
  taskType: "restock" | "cycle_count" | "shelf_tag" | "expiry_markdown";
  priority: number;
  title: string;
  aisleLocation: string | null;
  productId: string | null;
  sku: string | null;
  productName: string | null;
  targetQty: number | null;
  status: "pending" | "completed" | "skipped";
  completedBy: string | null;
  completedAt: string | null;
  completionNote: string | null;
}

interface TaskSummary {
  total: number;
  pending: number;
  completed: number;
  urgentPending: number;
}

function taskTypeBadge(t: FloorTask["taskType"]): { label: string; cls: string } {
  switch (t) {
    case "restock":
      return { label: "Pre-Open Restock", cls: "tag-blue" };
    case "cycle_count":
      return { label: "Blind Cycle Count", cls: "tag-red" };
    case "shelf_tag":
      return { label: "07:30 Shelf Tags", cls: "tag-amber" };
    case "expiry_markdown":
      return { label: "FEFO Markdown", cls: "tag-amber" };
  }
}

export function FloorTasksTab({
  onFeedback,
  onError,
}: {
  onFeedback: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [tasks, setTasks] = useState<FloorTask[]>([]);
  const [summary, setSummary] = useState<TaskSummary | null>(null);
  const [dateFilter, setDateFilter] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [notesById, setNotesById] = useState<Record<string, string>>({});
  const [qtyById, setQtyById] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadTasks = async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (dateFilter) qs.set("date", dateFilter);
      if (typeFilter !== "all") qs.set("taskType", typeFilter);
      if (statusFilter !== "all") qs.set("status", statusFilter);
      const res = await apiGet<{ summary: TaskSummary; tasks: FloorTask[] }>(
        `/api/operations/tasks?${qs.toString()}`,
        signal
      );
      if (signal?.aborted) return;
      setTasks(res.tasks);
      setSummary(res.summary);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        onError(err instanceof Error ? err.message : "Failed loading floor task checklist");
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void loadTasks(controller.signal);
    return () => controller.abort();
  }, [dateFilter, typeFilter, statusFilter]);

  const handleComplete = async (task: FloorTask) => {
    if (busyId) return;
    const payload: { note?: string; actualQty?: number } = {};
    const note = (notesById[task.id] ?? "").trim();
    if (note) payload.note = note;
    if (task.taskType === "cycle_count" && (qtyById[task.id] ?? "").trim() !== "") {
      const parsed = Number(qtyById[task.id]);
      if (!Number.isInteger(parsed) || parsed < 0) {
        onError(`Enter a valid non-negative whole-unit count for "${task.title}".`);
        return;
      }
      payload.actualQty = parsed;
    }

    setBusyId(task.id);
    try {
      const res = await apiPost<{ stockVarianceUnits: number | null }>(
        `/api/operations/tasks/${task.id}/complete`,
        payload
      );
      const varNote =
        res.stockVarianceUnits !== null
          ? ` (ledger variance: ${res.stockVarianceUnits > 0 ? `+${res.stockVarianceUnits}` : res.stockVarianceUnits} u)`
          : "";
      onFeedback(`Completed floor task "${task.title}"${varNote}.`);
      await loadTasks();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed completing floor task");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="stack-md" style={{ gap: 20 }}>
      <div className="kpi-strip">
        <div className="kpi-tile">
          <div className="kpi-label">Pending Floor Tasks</div>
          <div
            className="kpi-value"
            style={{
              color: (summary?.pending ?? 0) > 0 ? "var(--accent-amber)" : "var(--accent-primary)",
            }}
          >
            {summary?.pending ?? 0}
          </div>
          <div className="kpi-meta">{summary?.total ?? 0} scheduled for {dateFilter}</div>
        </div>
        <div className="kpi-tile">
          <div className="kpi-label">Urgent (P1) Pre-Open</div>
          <div
            className="kpi-value"
            style={{
              color: (summary?.urgentPending ?? 0) > 0 ? "var(--accent-crimson)" : "var(--accent-primary)",
            }}
          >
            {summary?.urgentPending ?? 0}
          </div>
          <div className="kpi-meta">Complete before 08:00 AM store open</div>
        </div>
        <div className="kpi-tile">
          <div className="kpi-label">Completed Today</div>
          <div className="kpi-value" style={{ color: "var(--accent-primary)" }}>
            {summary?.completed ?? 0}
          </div>
          <div className="kpi-meta">Audit-logged by operator &amp; timestamp</div>
        </div>
      </div>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2 className="panel-title">
              <ClipboardList size={15} style={{ verticalAlign: "middle", marginRight: 6, color: "var(--accent-primary)" }} />
              Daily Floor Operations Checklist (Restocks, Blind Counts, Tags &amp; Markdowns)
            </h2>
            <p className="panel-desc">
              Auto-generated by analytics from morning OOS stockouts, phantom stock alerts, dynamic FEFO markdowns, and pending 07:30 shelf tags.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              id="tasks-date-input"
              aria-label="Task schedule date"
              type="date"
              className="input mono"
              style={{ padding: "5px 8px" }}
              value={dateFilter}
              onChange={(e) => setDateFilter(e.target.value)}
            />
            <select
              aria-label="Filter tasks by type"
              className="select"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
            >
              <option value="all">All Task Types</option>
              <option value="restock">Pre-Open Restock</option>
              <option value="cycle_count">Blind Cycle Count</option>
              <option value="shelf_tag">Shelf Tags</option>
              <option value="expiry_markdown">Expiry Markdown</option>
            </select>
            <select
              aria-label="Filter tasks by status"
              className="select"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="all">All Statuses</option>
              <option value="pending">Pending Only</option>
              <option value="completed">Completed</option>
            </select>
            <button
              type="button"
              className="btn btn-sm"
              aria-label="Refresh floor tasks"
              disabled={loading}
              onClick={() => void loadTasks()}
            >
              <RefreshCw size={13} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Priority</th>
                <th>Type &amp; Shift</th>
                <th>Task &amp; Product</th>
                <th>Aisle</th>
                <th className="text-right">Target Qty</th>
                <th>Status &amp; Notes</th>
                <th className="text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && tasks.length === 0 ? (
                <tr>
                  <td colSpan={7}>Loading daily floor checklist...</td>
                </tr>
              ) : tasks.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: "center", color: "var(--ink-muted)", padding: 20 }}>
                    No floor tasks match this date and filter.
                  </td>
                </tr>
              ) : (
                tasks.map((t) => {
                  const tb = taskTypeBadge(t.taskType);
                  return (
                    <tr key={t.id}>
                      <td>
                        <span
                          className={`tag mono ${
                            t.priority === 1 ? "tag-red" : t.priority === 2 ? "tag-blue" : "tag-neutral"
                          }`}
                        >
                          P{t.priority}
                        </span>
                      </td>
                      <td>
                        <div>
                          <span className={`tag ${tb.cls}`}>{tb.label}</span>
                        </div>
                        <div className="mono" style={{ fontSize: 11, color: "var(--ink-muted)", marginTop: 2 }}>
                          {t.shiftBucket}
                        </div>
                      </td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{t.title}</div>
                        {t.sku && (
                          <div className="mono" style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                            {t.sku} · {t.productName}
                          </div>
                        )}
                      </td>
                      <td className="mono">{t.aisleLocation ?? "—"}</td>
                      <td className="text-right mono">{t.targetQty ?? "—"}</td>
                      <td>
                        {t.status === "completed" ? (
                          <div>
                            <span className="tag tag-green">
                              Done · {t.completedBy ?? "Staff"}
                            </span>
                            {t.completionNote && (
                              <div style={{ fontSize: 11.5, color: "var(--ink-muted)", marginTop: 3 }}>
                                {t.completionNote}
                              </div>
                            )}
                          </div>
                        ) : (
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            {t.taskType === "cycle_count" && (
                              <input
                                className="input mono"
                                type="number"
                                min={0}
                                placeholder="Count"
                                style={{ width: 70, fontSize: 12, padding: "4px 6px" }}
                                value={qtyById[t.id] ?? ""}
                                onChange={(e) =>
                                  setQtyById((prev) => ({ ...prev, [t.id]: e.target.value }))
                                }
                              />
                            )}
                            <input
                              className="input"
                              placeholder="Optional note..."
                              style={{ fontSize: 12, padding: "4px 8px", minWidth: 140 }}
                              value={notesById[t.id] ?? ""}
                              onChange={(e) =>
                                setNotesById((prev) => ({ ...prev, [t.id]: e.target.value }))
                              }
                            />
                          </div>
                        )}
                      </td>
                      <td className="text-right">
                        {t.status === "completed" ? (
                          <span style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                            <CheckCircle2 size={13} style={{ verticalAlign: "middle", marginRight: 4 }} />
                            Completed
                          </span>
                        ) : (
                          <button
                            className="btn btn-primary btn-sm"
                            disabled={busyId !== null}
                            onClick={() => void handleComplete(t)}
                          >
                            {busyId === t.id ? "Saving..." : "Complete"}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
