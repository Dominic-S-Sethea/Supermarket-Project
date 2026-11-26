import { useEffect, useState } from "react";
import { Calendar, CheckCircle2, RefreshCw, Sparkles, Users } from "lucide-react";
import { apiGet, apiPatch, apiPost } from "../api";

interface StaffOption {
  id: string;
  fullName: string;
  role: string;
}

interface RosterSlot {
  id: string;
  planDate: string;
  hour: number;
  shiftBucket: string;
  predictedEntries: number;
  predictedTransactions: number;
  recommendedLanes: number;
  assignedStaffId: string | null;
  assignedCashierName: string | null;
  status: "planned" | "confirmed" | "completed";
}

interface RosterSummary {
  totalHours: number;
  peakLanes: number;
  totalPredictedEntries: number;
  assignedSlots: number;
  confirmedSlots: number;
}

function shiftBadgeClass(bucket: string): string {
  if (bucket === "morning") return "tag-amber";
  if (bucket === "evening") return "tag-blue";
  return "tag-neutral";
}

export function StaffingRosterTab({
  canOperate,
  onBanner,
}: {
  canOperate: boolean;
  onBanner: (banner: { kind: "green" | "amber" | "red"; text: string }) => void;
}) {
  const [planDate, setPlanDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [slots, setSlots] = useState<RosterSlot[]>([]);
  const [staffOptions, setStaffOptions] = useState<StaffOption[]>([]);
  const [summary, setSummary] = useState<RosterSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadRoster = async (date = planDate, signal?: AbortSignal) => {
    setLoading(true);
    try {
      const res = await apiGet<{
        planDate: string;
        summary: RosterSummary;
        staffOptions: StaffOption[];
        slots: RosterSlot[];
      }>(`/api/operations/staffing-plan?date=${encodeURIComponent(date)}`, signal);
      if (signal?.aborted) return;
      setSlots(res.slots);
      setStaffOptions(res.staffOptions);
      setSummary(res.summary);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        onBanner({
          kind: "red",
          text: err instanceof Error ? err.message : "Failed loading hourly lane staffing roster",
        });
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void loadRoster(planDate, controller.signal);
    return () => controller.abort();
  }, [planDate]);

  const handleGenerate = async () => {
    if (busyId) return;
    setBusyId("generate");
    try {
      const res = await apiPost<{ generatedCount: number }>(
        "/api/operations/staffing-plan/generate",
        { planDate }
      );
      onBanner({
        kind: "green",
        text: `Generated ${res.generatedCount} forecast-driven hourly lane slots for ${planDate} from trailing 28-day door footfall & receipts.`,
      });
      await loadRoster(planDate);
    } catch (err) {
      onBanner({
        kind: "red",
        text: err instanceof Error ? err.message : "Failed generating staffing plan",
      });
    } finally {
      setBusyId(null);
    }
  };

  const handlePatchSlot = async (
    slotId: string,
    patch: {
      assignedStaffId?: string | null;
      status?: "planned" | "confirmed" | "completed";
      recommendedLanes?: number;
    }
  ) => {
    if (busyId) return;
    setBusyId(slotId);
    try {
      await apiPatch(`/api/operations/staffing-plan/${slotId}`, patch);
      onBanner({ kind: "green", text: "Updated hourly lane staffing assignment." });
      await loadRoster(planDate);
    } catch (err) {
      onBanner({
        kind: "red",
        text: err instanceof Error ? err.message : "Failed updating staffing slot",
      });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="panel" style={{ marginBottom: 20 }}>
      <div className="panel-header">
        <div>
          <h2 className="panel-title">
            <Users size={15} style={{ verticalAlign: "middle", marginRight: 6, color: "var(--accent-primary)" }} />
            Hourly Checkout Lane Staffing Roster ({planDate})
          </h2>
          <p className="panel-desc">
            Matches open checkout lanes to trailing 28-day hourly door footfall to eliminate morning &amp; evening queue walkouts.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            <Calendar size={14} />
            <input
              id="roster-date-input"
              type="date"
              className="input mono"
              style={{ padding: "5px 8px" }}
              value={planDate}
              onChange={(e) => setPlanDate(e.target.value)}
            />
          </label>
          {canOperate && (
            <button
              id="generate-roster-btn"
              className="btn btn-primary btn-sm"
              disabled={busyId !== null}
              onClick={() => void handleGenerate()}
            >
              <Sparkles size={13} /> {busyId === "generate" ? "Generating..." : "Generate Forecast Roster"}
            </button>
          )}
          <button
            className="btn btn-sm"
            disabled={loading}
            onClick={() => void loadRoster(planDate)}
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      <div className="kpi-strip" style={{ marginBottom: 14 }}>
        <div className="kpi-tile">
          <div className="kpi-label">Predicted Walk-Ins</div>
          <div className="kpi-value">{(summary?.totalPredictedEntries ?? 0).toLocaleString()}</div>
          <div className="kpi-meta">Across {summary?.totalHours ?? 0} trading hours</div>
        </div>
        <div className="kpi-tile">
          <div className="kpi-label">Peak Recommended Lanes</div>
          <div className="kpi-value">{summary?.peakLanes ?? 0} lanes</div>
          <div className="kpi-meta">1 lane per ~30 hourly door entries</div>
        </div>
        <div className="kpi-tile">
          <div className="kpi-label">Cashiers Assigned</div>
          <div className="kpi-value">
            {summary?.assignedSlots ?? 0} / {summary?.totalHours ?? 0}
          </div>
          <div className="kpi-meta">Lead cashier coverage per hour</div>
        </div>
        <div className="kpi-tile">
          <div className="kpi-label">Confirmed Slots</div>
          <div className="kpi-value" style={{ color: "var(--accent-primary)" }}>
            {summary?.confirmedSlots ?? 0} / {summary?.totalHours ?? 0}
          </div>
          <div className="kpi-meta">Locked &amp; communicated to floor team</div>
        </div>
      </div>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Hour</th>
              <th>Shift</th>
              <th className="text-right">Pred. Entries</th>
              <th className="text-right">Pred. Receipts</th>
              <th className="text-right">Target Lanes</th>
              <th>Assigned Lead Cashier</th>
              <th>Status</th>
              {canOperate && <th className="text-right">Action</th>}
            </tr>
          </thead>
          <tbody>
            {loading && slots.length === 0 ? (
              <tr>
                <td colSpan={canOperate ? 8 : 7}>Loading hourly lane staffing roster...</td>
              </tr>
            ) : slots.length === 0 ? (
              <tr>
                <td colSpan={canOperate ? 8 : 7} style={{ textAlign: "center", color: "var(--ink-muted)", padding: 20 }}>
                  No staffing roster generated for {planDate} yet.{" "}
                  {canOperate ? "Click Generate Forecast Roster above." : ""}
                </td>
              </tr>
            ) : (
              slots.map((slot) => (
                <tr key={slot.id}>
                  <td className="mono" style={{ fontWeight: 700 }}>
                    {String(slot.hour).padStart(2, "0")}:00–{String(slot.hour + 1).padStart(2, "0")}:00
                  </td>
                  <td>
                    <span className={`tag ${shiftBadgeClass(slot.shiftBucket)}`}>
                      {slot.shiftBucket}
                    </span>
                  </td>
                  <td className="text-right mono">{Math.round(slot.predictedEntries)}</td>
                  <td className="text-right mono">{Math.round(slot.predictedTransactions)}</td>
                  <td className="text-right mono" style={{ fontWeight: 700 }}>
                    {slot.recommendedLanes} {slot.recommendedLanes === 1 ? "lane" : "lanes"}
                  </td>
                  <td>
                    {canOperate ? (
                      <select
                        aria-label={`Assign cashier for ${String(slot.hour).padStart(2, "0")}:00 slot`}
                        className="select"
                        style={{ fontSize: 12, padding: "4px 8px" }}
                        disabled={busyId !== null}
                        value={slot.assignedStaffId ?? ""}
                        onChange={(e) =>
                          void handlePatchSlot(slot.id, {
                            assignedStaffId: e.target.value || null,
                          })
                        }
                      >
                        <option value="">
                          {slot.assignedCashierName ? `${slot.assignedCashierName} (Unlinked)` : "Unassigned"}
                        </option>
                        {staffOptions.map((st) => (
                          <option key={st.id} value={st.id}>
                            {st.fullName} ({st.role})
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span>{slot.assignedCashierName ?? "Unassigned"}</span>
                    )}
                  </td>
                  <td>
                    <span
                      className={`tag ${
                        slot.status === "completed"
                          ? "tag-green"
                          : slot.status === "confirmed"
                            ? "tag-blue"
                            : "tag-amber"
                      }`}
                    >
                      {slot.status}
                    </span>
                  </td>
                  {canOperate && (
                    <td className="text-right">
                      {slot.status === "planned" ? (
                        <button
                          className="btn btn-primary btn-sm"
                          disabled={busyId !== null}
                          onClick={() => void handlePatchSlot(slot.id, { status: "confirmed" })}
                        >
                          <CheckCircle2 size={12} /> Confirm
                        </button>
                      ) : slot.status === "confirmed" ? (
                        <button
                          className="btn btn-sm"
                          disabled={busyId !== null}
                          onClick={() => void handlePatchSlot(slot.id, { status: "completed" })}
                        >
                          Mark Done
                        </button>
                      ) : (
                        <span style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>Done</span>
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
  );
}
