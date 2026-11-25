import { useEffect, useState } from "react";
import { formatMoney, type UserRole } from "@supermarket/shared";
import {
  Activity,
  Download,
  ExternalLink,
  KeyRound,
  Lock,
  Receipt,
  RefreshCw,
  Search,
  ShieldCheck,
  UserPlus,
  Users,
} from "lucide-react";
import { apiGet, apiPatch, apiPost } from "../api";

interface StaffUserRow {
  id: string;
  username: string;
  fullName: string;
  role: UserRole;
  active: boolean;
  createdAt: string;
  activeSessions: number;
  lastLoginAt: string | null;
}

interface AuditLogRow {
  id: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string | null;
  detailsJson: Record<string, unknown> | null;
  createdAt: string;
}

interface AuditResponse {
  page: number;
  pageSize: number;
  total: number;
  facets: { actions: string[]; entityTypes: string[] };
  logs: AuditLogRow[];
}

interface ShiftSummaryPayload {
  summary: {
    totalShifts: number;
    openShifts: number;
    closedShifts: number;
    flaggedShifts: number;
    netVarianceCents: number;
  };
  byCashier: {
    cashierName: string;
    closedShifts: number;
    netVarianceCents: number;
    maxAbsVarianceCents: number;
  }[];
  shifts: {
    id: string;
    registerCode: string;
    cashierName: string;
    zReportNo: string | null;
    openedAt: string;
    closedAt: string | null;
    openingFloatCents: number;
    expectedCashCents: number | null;
    blindCountedCashCents: number | null;
    varianceCents: number | null;
  }[];
}

interface PipelineStageTiming {
  stage: string;
  elapsed_s: number;
}

interface PipelineDqCheck {
  name: string;
  passed: boolean;
  observed: number;
  expected: string;
}

interface PipelineRunRow {
  id: string;
  startedAt: string;
  finishedAt: string;
  elapsedSec: number;
  status: string;
  stagesJson: PipelineStageTiming[];
  dqPassed: boolean;
  dqChecksJson: PipelineDqCheck[];
}

type AdminSubTab = "audit" | "reconciliation" | "pipeline" | "users" | "security";

const EXPORT_CARDS: {
  title: string;
  desc: string;
  href: string;
  id: string;
}[] = [
  {
    id: "export-accounting-csv",
    title: "Accounting Journal CSV",
    desc: "Daily revenue, tax, COGS & margin ledger (last 60 days)",
    href: "/api/exports/accounting.csv?days=60",
  },
  {
    id: "export-valuation-csv",
    title: "Live Inventory Valuation CSV",
    desc: "3,120+ SKUs with live stock, MWAC cost & ABC-XYZ segment",
    href: "/api/exports/inventory-valuation.csv",
  },
  {
    id: "export-variances-csv",
    title: "3-Way Supplier Variance Register CSV",
    desc: "Short deliveries, cost overcharges & dispute resolutions",
    href: "/api/exports/supplier-variances.csv",
  },
  {
    id: "export-shifts-csv",
    title: "Z-Report Shift Closeouts CSV",
    desc: "Blind till counts, expected cash & cashier variance audit",
    href: "/api/exports/shifts.csv",
  },
  {
    id: "export-audit-csv",
    title: "Immutable Audit Trail CSV",
    desc: "Latest 1,000 governance, pricing, void & auth events",
    href: "/api/exports/audit-logs.csv",
  },
];

export function AdminAuditView({
  userRole,
  currentUsername,
}: {
  userRole: UserRole;
  currentUsername: string;
}) {
  const isOwner = userRole === "owner";
  const [subTab, setSubTab] = useState<AdminSubTab>(isOwner ? "users" : "audit");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Staff Users state (owner only)
  const [staffUsers, setStaffUsers] = useState<StaffUserRow[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newFullName, setNewFullName] = useState("");
  const [newRole, setNewRole] = useState<UserRole>("cashier");
  const [newPin, setNewPin] = useState("");
  const [resetPinTarget, setResetPinTarget] = useState<string | null>(null);
  const [resetPinValue, setResetPinValue] = useState("");

  // Audit Log state
  const [auditData, setAuditData] = useState<AuditResponse | null>(null);
  const [loadingAudit, setLoadingAudit] = useState(false);
  const [auditSearch, setAuditSearch] = useState("");
  const [auditAction, setAuditAction] = useState("all");
  const [auditEntity, setAuditEntity] = useState("all");
  const [auditPage, setAuditPage] = useState(1);

  // Z-Report Shift Reconciliation state
  const [shiftSummary, setShiftSummary] = useState<ShiftSummaryPayload | null>(null);
  const [loadingShifts, setLoadingShifts] = useState(false);

  // ML Pipeline Health & Data-Quality state
  const [pipelineRuns, setPipelineRuns] = useState<PipelineRunRow[]>([]);
  const [loadingPipeline, setLoadingPipeline] = useState(false);

  // Self-Service Change My PIN state
  const [currentPin, setCurrentPin] = useState("");
  const [nextPin, setNextPin] = useState("");
  const [confirmNextPin, setConfirmNextPin] = useState("");

  const loadUsers = async (signal?: AbortSignal) => {
    if (!isOwner) return;
    setLoadingUsers(true);
    try {
      const res = await apiGet<{ users: StaffUserRow[] }>("/api/admin/users", signal);
      if (!signal?.aborted) setStaffUsers(res.users);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setErrorMsg(err instanceof Error ? err.message : "Failed loading staff users.");
      }
    } finally {
      if (!signal?.aborted) setLoadingUsers(false);
    }
  };

  const loadAuditLogs = async (page = auditPage, signal?: AbortSignal) => {
    setLoadingAudit(true);
    try {
      const qs = new URLSearchParams({
        page: String(page),
        pageSize: "25",
      });
      if (auditAction !== "all") qs.set("action", auditAction);
      if (auditEntity !== "all") qs.set("entityType", auditEntity);
      if (auditSearch.trim()) qs.set("search", auditSearch.trim());
      const res = await apiGet<AuditResponse>(`/api/admin/audit-logs?${qs.toString()}`, signal);
      if (!signal?.aborted) setAuditData(res);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setErrorMsg(err instanceof Error ? err.message : "Failed loading audit trail.");
      }
    } finally {
      if (!signal?.aborted) setLoadingAudit(false);
    }
  };

  const loadShiftSummary = async (signal?: AbortSignal) => {
    setLoadingShifts(true);
    try {
      const res = await apiGet<ShiftSummaryPayload>("/api/pos/shifts/summary", signal);
      if (!signal?.aborted) setShiftSummary(res);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setErrorMsg(err instanceof Error ? err.message : "Failed loading Z-report summary.");
      }
    } finally {
      if (!signal?.aborted) setLoadingShifts(false);
    }
  };

  const loadPipelineRuns = async (signal?: AbortSignal) => {
    setLoadingPipeline(true);
    try {
      const res = await apiGet<{ runs: PipelineRunRow[] }>("/api/admin/pipeline-runs", signal);
      if (!signal?.aborted) setPipelineRuns(res.runs);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setErrorMsg(err instanceof Error ? err.message : "Failed loading ML pipeline runs.");
      }
    } finally {
      if (!signal?.aborted) setLoadingPipeline(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    if (subTab === "users" && isOwner) void loadUsers(controller.signal);
    if (subTab === "reconciliation") void loadShiftSummary(controller.signal);
    if (subTab === "pipeline") void loadPipelineRuns(controller.signal);
    return () => controller.abort();
  }, [subTab, isOwner]);

  useEffect(() => {
    if (subTab !== "audit") return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void loadAuditLogs(auditPage, controller.signal);
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [subTab, auditAction, auditEntity, auditSearch, auditPage]);

  const handleCreateUser = async () => {
    if (busy) return;
    setErrorMsg(null);
    setFeedback(null);
    if (!newUsername.trim() || !newFullName.trim() || newPin.trim().length < 4) {
      setErrorMsg("Enter username, full name, and a 4–12 digit/character PIN.");
      return;
    }
    setBusy("create-user");
    try {
      const res = await apiPost<{ user: StaffUserRow }>("/api/admin/users", {
        username: newUsername.trim().toLowerCase(),
        fullName: newFullName.trim(),
        role: newRole,
        pin: newPin.trim(),
      });
      setFeedback(`Created staff account "${res.user.username}" (${res.user.role}).`);
      setNewUsername("");
      setNewFullName("");
      setNewPin("");
      await loadUsers();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed creating user.");
    } finally {
      setBusy(null);
    }
  };

  const handleToggleActive = async (u: StaffUserRow) => {
    if (busy) return;
    setErrorMsg(null);
    setBusy(`toggle-${u.id}`);
    try {
      const res = await apiPatch<{ user: StaffUserRow; sessionsRevoked: number }>(
        `/api/admin/users/${u.id}`,
        { active: !u.active }
      );
      setFeedback(
        `${res.user.username} is now ${res.user.active ? "Active" : "Deactivated"}${res.sessionsRevoked > 0 ? ` (${res.sessionsRevoked} session(s) revoked)` : ""}.`
      );
      await loadUsers();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed updating staff account.");
    } finally {
      setBusy(null);
    }
  };

  const handleResetPin = async (userId: string, username: string) => {
    if (busy || resetPinValue.trim().length < 4) {
      setErrorMsg("Reset PIN must be 4–12 characters.");
      return;
    }
    setErrorMsg(null);
    setBusy(`pin-${userId}`);
    try {
      const res = await apiPatch<{ sessionsRevoked: number }>(`/api/admin/users/${userId}`, {
        pin: resetPinValue.trim(),
      });
      setFeedback(
        `Reset PIN for "${username}" and revoked ${res.sessionsRevoked} active session(s).`
      );
      setResetPinTarget(null);
      setResetPinValue("");
      await loadUsers();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed resetting PIN.");
    } finally {
      setBusy(null);
    }
  };

  const handleRevokeSessions = async (u: StaffUserRow) => {
    if (busy) return;
    setErrorMsg(null);
    setBusy(`revoke-${u.id}`);
    try {
      const res = await apiPost<{ sessionsRevoked: number }>(
        `/api/admin/users/${u.id}/revoke-sessions`,
        {}
      );
      setFeedback(`Revoked ${res.sessionsRevoked} active session(s) for "${u.username}".`);
      await loadUsers();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed revoking sessions.");
    } finally {
      setBusy(null);
    }
  };

  const handleChangeOwnPin = async () => {
    if (busy) return;
    setErrorMsg(null);
    setFeedback(null);
    if (nextPin.trim().length < 4) {
      setErrorMsg("New PIN must be 4–12 characters.");
      return;
    }
    if (nextPin !== confirmNextPin) {
      setErrorMsg("New PIN and confirmation do not match.");
      return;
    }
    setBusy("change-own-pin");
    try {
      const res = await apiPost<{ otherSessionsRevoked: number }>("/api/auth/change-pin", {
        currentPin,
        newPin: nextPin,
      });
      setFeedback(
        `Your PIN has been rotated cleanly (${res.otherSessionsRevoked} other device session(s) revoked).`
      );
      setCurrentPin("");
      setNextPin("");
      setConfirmNextPin("");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed rotating PIN.");
    } finally {
      setBusy(null);
    }
  };

  const totalAuditPages = auditData
    ? Math.max(1, Math.ceil(auditData.total / auditData.pageSize))
    : 1;

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>Governance, Audit Trail &amp; Financial Exports</h1>
          <p className="page-subtitle">
            {isOwner
              ? "Manage staff RBAC accounts, revoke compromised sessions, explore the immutable compliance ledger, and export formula-safe ERP registers."
              : "Inspect the immutable store audit trail, reconcile cashier Z-Reports, rotate your PIN, and export formula-safe ERP registers."}
          </p>
        </div>
        <div className="subtab-bar" role="tablist">
          {isOwner && (
            <button
              id="admin-subtab-users"
              role="tab"
              aria-selected={subTab === "users"}
              className={`subtab-btn ${subTab === "users" ? "active" : ""}`}
              onClick={() => setSubTab("users")}
            >
              <Users size={14} /> Staff &amp; Sessions
            </button>
          )}
          <button
            id="admin-subtab-audit"
            role="tab"
            aria-selected={subTab === "audit"}
            className={`subtab-btn ${subTab === "audit" ? "active" : ""}`}
            onClick={() => setSubTab("audit")}
          >
            <ShieldCheck size={14} /> Immutable Audit Log
          </button>
          <button
            id="admin-subtab-reconciliation"
            role="tab"
            aria-selected={subTab === "reconciliation"}
            className={`subtab-btn ${subTab === "reconciliation" ? "active" : ""}`}
            onClick={() => setSubTab("reconciliation")}
          >
            <Receipt size={14} /> Z-Reports &amp; Exports
          </button>
          <button
            id="admin-subtab-pipeline"
            role="tab"
            aria-selected={subTab === "pipeline"}
            className={`subtab-btn ${subTab === "pipeline" ? "active" : ""}`}
            onClick={() => setSubTab("pipeline")}
          >
            <Activity size={14} /> ML Pipeline Health
          </button>
          <button
            id="admin-subtab-security"
            role="tab"
            aria-selected={subTab === "security"}
            className={`subtab-btn ${subTab === "security" ? "active" : ""}`}
            onClick={() => setSubTab("security")}
          >
            <KeyRound size={14} /> My PIN Security
          </button>
        </div>
      </header>

      {errorMsg && (
        <div className="banner banner-red" style={{ marginBottom: 14 }}>
          <span>{errorMsg}</span>
          <button className="btn btn-sm" onClick={() => setErrorMsg(null)}>
            Dismiss
          </button>
        </div>
      )}

      {feedback && (
        <div className="banner banner-green" style={{ marginBottom: 14 }}>
          <span>{feedback}</span>
          <button className="btn btn-sm" onClick={() => setFeedback(null)}>
            Dismiss
          </button>
        </div>
      )}

      {subTab === "users" && isOwner && (
        <div className="grid-asymmetric">
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2 className="panel-title">
                  <Users size={15} style={{ verticalAlign: "middle", marginRight: 6 }} />
                  Staff Accounts &amp; Active Sessions ({staffUsers.length})
                </h2>
                <p className="panel-desc">
                  Deactivating an account or resetting a PIN atomically revokes all active JWT sessions in PostgreSQL.
                </p>
              </div>
              <button className="btn btn-sm" disabled={loadingUsers} onClick={() => void loadUsers()}>
                <RefreshCw size={13} /> Refresh
              </button>
            </div>

            {loadingUsers && staffUsers.length === 0 ? (
              <div style={{ padding: "14px 0", color: "var(--ink-muted)" }}>Loading staff accounts...</div>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Staff Member</th>
                      <th>Role</th>
                      <th className="text-right">Sessions</th>
                      <th>Status</th>
                      <th className="text-right">Governance Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {staffUsers.map((u) => (
                      <tr key={u.id}>
                        <td>
                          <div style={{ fontWeight: 600 }}>{u.fullName}</div>
                          <div className="mono" style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                            @{u.username}
                          </div>
                        </td>
                        <td>
                          <span className="tag tag-neutral mono">{u.role}</span>
                        </td>
                        <td className="text-right mono">{u.activeSessions}</td>
                        <td>
                          <span className={`tag ${u.active ? "tag-green" : "tag-red"}`}>
                            {u.active ? "Active" : "Disabled"}
                          </span>
                        </td>
                        <td className="text-right">
                          {resetPinTarget === u.id ? (
                            <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                              <input
                                className="input mono"
                                type="password"
                                placeholder="New PIN"
                                style={{ width: 96, padding: "4px 8px" }}
                                value={resetPinValue}
                                onChange={(e) => setResetPinValue(e.target.value)}
                              />
                              <button
                                className="btn btn-primary btn-sm"
                                disabled={busy !== null}
                                onClick={() => void handleResetPin(u.id, u.username)}
                              >
                                Save
                              </button>
                              <button
                                className="btn btn-sm"
                                onClick={() => {
                                  setResetPinTarget(null);
                                  setResetPinValue("");
                                }}
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <div style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                              <button
                                className="btn btn-sm"
                                disabled={busy !== null}
                                onClick={() => {
                                  setResetPinTarget(u.id);
                                  setResetPinValue("");
                                }}
                              >
                                <KeyRound size={12} /> Reset PIN
                              </button>
                              {u.activeSessions > 0 && (
                                <button
                                  className="btn btn-sm"
                                  disabled={busy !== null}
                                  onClick={() => void handleRevokeSessions(u)}
                                >
                                  <Lock size={12} /> Revoke ({u.activeSessions})
                                </button>
                              )}
                              <button
                                className="btn btn-sm"
                                style={{ color: u.active ? "var(--accent-crimson)" : "var(--accent-primary)" }}
                                disabled={busy !== null}
                                onClick={() => void handleToggleActive(u)}
                              >
                                {u.active ? "Deactivate" : "Reactivate"}
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-header">
              <div>
                <h2 className="panel-title">
                  <UserPlus size={15} style={{ verticalAlign: "middle", marginRight: 6 }} />
                  Provision New Staff Account
                </h2>
                <p className="panel-desc">
                  PINs are salted with scrypt (N=16384). Role determines visible tabs and API RBAC guards.
                </p>
              </div>
            </div>

            <form
              className="stack-md"
              style={{ gap: 11 }}
              onSubmit={(e) => {
                e.preventDefault();
                void handleCreateUser();
              }}
            >
              <div className="field">
                <label htmlFor="new-staff-username">Username</label>
                <input
                  id="new-staff-username"
                  className="input mono"
                  placeholder="e.g. cashier2"
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="new-staff-fullname">Full Name</label>
                <input
                  id="new-staff-fullname"
                  className="input"
                  placeholder="e.g. Priya Patel (Lane 02)"
                  value={newFullName}
                  onChange={(e) => setNewFullName(e.target.value)}
                  required
                />
              </div>
              <div className="form-grid">
                <div className="field">
                  <label htmlFor="new-staff-role">RBAC Role</label>
                  <select
                    id="new-staff-role"
                    className="select"
                    value={newRole}
                    onChange={(e) => setNewRole(e.target.value as UserRole)}
                  >
                    <option value="cashier">cashier</option>
                    <option value="stock_clerk">stock_clerk</option>
                    <option value="accountant">accountant</option>
                    <option value="manager">manager</option>
                    <option value="owner">owner</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="new-staff-pin">Initial PIN (4–12 chars)</label>
                  <input
                    id="new-staff-pin"
                    className="input mono"
                    type="password"
                    minLength={4}
                    maxLength={12}
                    value={newPin}
                    onChange={(e) => setNewPin(e.target.value)}
                    required
                  />
                </div>
              </div>
              <button
                id="create-staff-btn"
                type="submit"
                className="btn btn-primary"
                disabled={busy !== null}
              >
                <UserPlus size={14} /> {busy === "create-user" ? "Creating..." : "Create Staff User"}
              </button>
            </form>
          </section>
        </div>
      )}

      {subTab === "audit" && (
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2 className="panel-title">
                <Activity size={15} style={{ verticalAlign: "middle", marginRight: 6 }} />
                Immutable Compliance Audit Trail ({auditData?.total ?? 0} events)
              </h2>
              <p className="panel-desc">
                Append-only operational record covering price changes, voids/refunds, PO approvals, PIN resets, and lockouts.
              </p>
            </div>
            <a className="btn btn-sm" href="/api/exports/audit-logs.csv" download>
              <Download size={13} /> Export Audit CSV
            </a>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
            <div className="search-box" style={{ flex: 1, minWidth: 220 }}>
              <Search size={14} className="search-icon" />
              <input
                id="audit-search-input"
                className="input"
                placeholder="Search actor, action, SKU, PO, or JSON payload..."
                value={auditSearch}
                onChange={(e) => {
                  setAuditPage(1);
                  setAuditSearch(e.target.value);
                }}
              />
            </div>
            <select
              id="audit-action-filter"
              className="select"
              style={{ width: 190 }}
              value={auditAction}
              onChange={(e) => {
                setAuditPage(1);
                setAuditAction(e.target.value);
              }}
            >
              <option value="all">All Actions</option>
              {(auditData?.facets.actions ?? []).map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <select
              id="audit-entity-filter"
              className="select"
              style={{ width: 170 }}
              value={auditEntity}
              onChange={(e) => {
                setAuditPage(1);
                setAuditEntity(e.target.value);
              }}
            >
              <option value="all">All Entities</option>
              {(auditData?.facets.entityTypes ?? []).map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>

          {loadingAudit && !auditData ? (
            <div style={{ padding: "14px 0", color: "var(--ink-muted)" }}>Loading audit trail...</div>
          ) : !auditData || auditData.logs.length === 0 ? (
            <div className="banner banner-amber">No audit events match your current filters.</div>
          ) : (
            <>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Timestamp</th>
                      <th>Actor</th>
                      <th>Action</th>
                      <th>Entity</th>
                      <th>Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditData.logs.map((row) => (
                      <tr key={row.id}>
                        <td className="mono" style={{ fontSize: 11.5, whiteSpace: "nowrap" }}>
                          {new Date(row.createdAt).toLocaleString()}
                        </td>
                        <td style={{ fontWeight: 600 }}>{row.actor}</td>
                        <td>
                          <span className="tag tag-neutral mono">{row.action}</span>
                        </td>
                        <td className="mono" style={{ fontSize: 11.5 }}>
                          {row.entityType}
                        </td>
                        <td
                          className="mono"
                          style={{
                            fontSize: 11,
                            color: "var(--ink-secondary)",
                            maxWidth: 360,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          title={row.detailsJson ? JSON.stringify(row.detailsJson) : ""}
                        >
                          {row.detailsJson ? JSON.stringify(row.detailsJson) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginTop: 12,
                }}
              >
                <span style={{ fontSize: 12.5, color: "var(--ink-muted)" }}>
                  Page {auditData.page} of {totalAuditPages} ({auditData.total} matching rows)
                </span>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    className="btn btn-sm"
                    disabled={auditPage <= 1}
                    onClick={() => setAuditPage((p) => Math.max(1, p - 1))}
                  >
                    Previous
                  </button>
                  <button
                    className="btn btn-sm"
                    disabled={auditPage >= totalAuditPages}
                    onClick={() => setAuditPage((p) => Math.min(totalAuditPages, p + 1))}
                  >
                    Next
                  </button>
                </div>
              </div>
            </>
          )}
        </section>
      )}

      {subTab === "reconciliation" && (
        <div className="stack-md">
          {shiftSummary && (
            <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(175px, 1fr))" }}>
              <div className="kpi-card">
                <div className="kpi-label">Tracked Shifts</div>
                <div className="kpi-value mono">{shiftSummary.summary.totalShifts}</div>
                <div className="kpi-meta">
                  {shiftSummary.summary.openShifts} open · {shiftSummary.summary.closedShifts} closed
                </div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">Net Cash Variance</div>
                <div
                  className="kpi-value mono"
                  style={{
                    color:
                      shiftSummary.summary.netVarianceCents < 0
                        ? "var(--accent-crimson)"
                        : "var(--accent-primary)",
                  }}
                >
                  {formatMoney(shiftSummary.summary.netVarianceCents)}
                </div>
                <div className="kpi-meta">Across closed blind Z-Reports</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">Flagged Shifts (≥ $5)</div>
                <div className="kpi-value mono">{shiftSummary.summary.flaggedShifts}</div>
                <div className="kpi-meta">Over/short requiring review</div>
              </div>
            </div>
          )}

          <section className="panel">
            <div className="panel-header">
              <div>
                <h2 className="panel-title">
                  <Download size={15} style={{ verticalAlign: "middle", marginRight: 6 }} />
                  Formula-Safe ERP CSV Exports &amp; OpenAPI 3.1 Contract
                </h2>
                <p className="panel-desc">
                  All exports neutralize Excel/Sheets formula injection (=, +, -, @) while preserving numeric ledger columns.
                </p>
              </div>
              <a
                id="openapi-spec-link"
                className="btn btn-sm"
                href="/api/openapi.json"
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink size={13} /> OpenAPI 3.1 JSON
              </a>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
                gap: 10,
              }}
            >
              {EXPORT_CARDS.map((card) => (
                <a
                  key={card.id}
                  id={card.id}
                  href={card.href}
                  download
                  className="quick-sku-btn"
                  style={{ textDecoration: "none", color: "inherit", alignItems: "flex-start" }}
                >
                  <strong style={{ fontSize: 13 }}>
                    <Download size={13} style={{ verticalAlign: "middle", marginRight: 5 }} />
                    {card.title}
                  </strong>
                  <span style={{ fontSize: 11.5, color: "var(--ink-secondary)" }}>{card.desc}</span>
                </a>
              ))}
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <div>
                <h2 className="panel-title">
                  <Receipt size={15} style={{ verticalAlign: "middle", marginRight: 6 }} />
                  Cashier Z-Report Variance Scorecard
                </h2>
                <p className="panel-desc">
                  Aggregated blind-count cash accuracy per cashier across closed register shifts.
                </p>
              </div>
              <button
                className="btn btn-sm"
                disabled={loadingShifts}
                onClick={() => void loadShiftSummary()}
              >
                <RefreshCw size={13} /> Refresh
              </button>
            </div>
            {loadingShifts && !shiftSummary ? (
              <div style={{ padding: "12px 0", color: "var(--ink-muted)" }}>Loading Z-Report data...</div>
            ) : !shiftSummary || shiftSummary.byCashier.length === 0 ? (
              <div className="banner banner-amber">No closed Z-Report shifts recorded yet.</div>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Cashier</th>
                      <th className="text-right">Closed Shifts</th>
                      <th className="text-right">Net Variance</th>
                      <th className="text-right">Worst Single-Shift Diff</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shiftSummary.byCashier.map((c) => (
                      <tr key={c.cashierName}>
                        <td style={{ fontWeight: 600 }}>{c.cashierName}</td>
                        <td className="text-right mono">{c.closedShifts}</td>
                        <td className="text-right mono">
                          <span
                            className={`tag mono ${
                              Math.abs(c.netVarianceCents) >= 500 ? "tag-red" : "tag-green"
                            }`}
                          >
                            {formatMoney(c.netVarianceCents)}
                          </span>
                        </td>
                        <td className="text-right mono">{formatMoney(c.maxAbsVarianceCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}

      {subTab === "pipeline" && (
        <div className="stack-md">
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2 className="panel-title">
                  <Activity size={15} style={{ verticalAlign: "middle", marginRight: 6 }} />
                  Python ML Pipeline Health &amp; 12-Check Data-Quality Contracts
                </h2>
                <p className="panel-desc">
                  Audits every nightly/on-demand Python analytics run across ABC-XYZ, Demand Forecasts, Market Basket, LP, Supplier OTIF, Phantom Stock, Dynamic Markdowns, and Promo ROI.
                </p>
              </div>
              <button
                className="btn btn-sm"
                disabled={loadingPipeline}
                onClick={() => void loadPipelineRuns()}
              >
                <RefreshCw size={13} /> Refresh
              </button>
            </div>

            {loadingPipeline && pipelineRuns.length === 0 ? (
              <div style={{ padding: "14px 0", color: "var(--ink-muted)" }}>
                Loading ML pipeline runs...
              </div>
            ) : pipelineRuns.length === 0 ? (
              <div className="banner banner-amber">
                No ML pipeline runs recorded yet. Execute the Python analytics worker to populate.
              </div>
            ) : (
              (() => {
                const latest = pipelineRuns[0];
                const passedCount = latest.dqChecksJson.filter((c) => c.passed).length;
                return (
                  <div className="stack-md">
                    <div
                      className="kpi-grid"
                      style={{ gridTemplateColumns: "repeat(auto-fit, minmax(175px, 1fr))" }}
                    >
                      <div className="kpi-card">
                        <div className="kpi-label">Latest Run Status</div>
                        <div className="kpi-value">
                          <span className={`tag mono ${latest.dqPassed ? "tag-green" : "tag-red"}`}>
                            {latest.status.toUpperCase()}
                          </span>
                        </div>
                        <div className="kpi-meta">
                          {new Date(latest.finishedAt).toLocaleString()}
                        </div>
                      </div>
                      <div className="kpi-card">
                        <div className="kpi-label">Data-Quality Contracts</div>
                        <div className="kpi-value mono">
                          {passedCount} / {latest.dqChecksJson.length}
                        </div>
                        <div className="kpi-meta">Post-run PostgreSQL invariant assertions</div>
                      </div>
                      <div className="kpi-card">
                        <div className="kpi-label">Total Pipeline Duration</div>
                        <div className="kpi-value mono">{latest.elapsedSec.toFixed(2)}s</div>
                        <div className="kpi-meta">{latest.stagesJson.length} stages executed</div>
                      </div>
                      <div className="kpi-card">
                        <div className="kpi-label">Tracked History</div>
                        <div className="kpi-value mono">{pipelineRuns.length} runs</div>
                        <div className="kpi-meta">Bounded latest 50 executions</div>
                      </div>
                    </div>

                    <div className="grid-asymmetric">
                      <div>
                        <h3 style={{ fontSize: 13.5, margin: "0 0 8px" }}>
                          12-Check Data-Quality Contract Matrix
                        </h3>
                        <div className="table-wrap">
                          <table className="data-table">
                            <thead>
                              <tr>
                                <th>Contract Check</th>
                                <th className="text-right">Observed</th>
                                <th>Expectation</th>
                                <th>Status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {latest.dqChecksJson.map((chk) => (
                                <tr key={chk.name}>
                                  <td className="mono" style={{ fontSize: 12 }}>
                                    {chk.name}
                                  </td>
                                  <td className="text-right mono">{chk.observed}</td>
                                  <td style={{ fontSize: 12, color: "var(--ink-secondary)" }}>
                                    {chk.expected}
                                  </td>
                                  <td>
                                    <span className={`tag mono ${chk.passed ? "tag-green" : "tag-red"}`}>
                                      {chk.passed ? "PASS" : "FAIL"}
                                    </span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>

                      <div>
                        <h3 style={{ fontSize: 13.5, margin: "0 0 8px" }}>
                          Stage Execution Timings
                        </h3>
                        <div className="table-wrap">
                          <table className="data-table">
                            <thead>
                              <tr>
                                <th>ML Stage</th>
                                <th className="text-right">Elapsed (s)</th>
                              </tr>
                            </thead>
                            <tbody>
                              {latest.stagesJson.map((st) => (
                                <tr key={st.stage}>
                                  <td className="mono" style={{ fontSize: 12 }}>
                                    {st.stage}
                                  </td>
                                  <td className="text-right mono">{st.elapsed_s.toFixed(3)}s</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()
            )}
          </section>
        </div>
      )}

      {subTab === "security" && (
        <section className="panel" style={{ maxWidth: 480 }}>
          <div className="panel-header">
            <div>
              <h2 className="panel-title">
                <KeyRound size={15} style={{ verticalAlign: "middle", marginRight: 6 }} />
                Rotate My Staff PIN (@{currentUsername})
              </h2>
              <p className="panel-desc">
                Changing your PIN immediately revokes all other active sessions on other terminals while keeping your current session active.
              </p>
            </div>
          </div>
          <form
            className="stack-md"
            style={{ gap: 12 }}
            onSubmit={(e) => {
              e.preventDefault();
              void handleChangeOwnPin();
            }}
          >
            <div className="field">
              <label htmlFor="self-current-pin">Current PIN</label>
              <input
                id="self-current-pin"
                className="input mono"
                type="password"
                minLength={4}
                maxLength={12}
                value={currentPin}
                onChange={(e) => setCurrentPin(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="self-new-pin">New PIN (4–12 characters)</label>
              <input
                id="self-new-pin"
                className="input mono"
                type="password"
                minLength={4}
                maxLength={12}
                value={nextPin}
                onChange={(e) => setNextPin(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="self-confirm-pin">Confirm New PIN</label>
              <input
                id="self-confirm-pin"
                className="input mono"
                type="password"
                minLength={4}
                maxLength={12}
                value={confirmNextPin}
                onChange={(e) => setConfirmNextPin(e.target.value)}
                required
              />
            </div>
            <button
              id="rotate-pin-btn"
              type="submit"
              className="btn btn-primary"
              disabled={busy !== null}
            >
              <KeyRound size={14} /> {busy === "change-own-pin" ? "Rotating PIN..." : "Update My PIN"}
            </button>
          </form>
        </section>
      )}
    </div>
  );
}
