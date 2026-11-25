import { lazy, Suspense, useEffect, useState } from "react";
import type { UserRole } from "@supermarket/shared";
import {
  BarChart3,
  Boxes,
  Gift,
  Grid3X3,
  LogOut,
  PackageCheck,
  ScanBarcode,
  ShieldCheck,
  Sparkles,
  Sun,
  TrendingUp,
} from "lucide-react";
import { apiGet, apiPost, setUnauthorizedHandler } from "./api";
import { LoginScreen, type SessionUser } from "./components/LoginScreen";

const AiCopilotDrawer = lazy(() =>
  import("./components/AiCopilotDrawer").then((m) => ({ default: m.AiCopilotDrawer }))
);
const AbcLossView = lazy(() =>
  import("./views/AbcLossView").then((m) => ({ default: m.AbcLossView }))
);
const AdminAuditView = lazy(() =>
  import("./views/AdminAuditView").then((m) => ({ default: m.AdminAuditView }))
);
const CatalogView = lazy(() =>
  import("./views/CatalogView").then((m) => ({ default: m.CatalogView }))
);
const ForecastingBasketView = lazy(() =>
  import("./views/ForecastingBasketView").then((m) => ({ default: m.ForecastingBasketView }))
);
const LoyaltyPromosView = lazy(() =>
  import("./views/LoyaltyPromosView").then((m) => ({ default: m.LoyaltyPromosView }))
);
const OperationsView = lazy(() =>
  import("./views/OperationsView").then((m) => ({ default: m.OperationsView }))
);
const OverviewView = lazy(() =>
  import("./views/OverviewView").then((m) => ({ default: m.OverviewView }))
);
const PosTerminalView = lazy(() =>
  import("./views/PosTerminalView").then((m) => ({ default: m.PosTerminalView }))
);
const ShiftDiagnosticsView = lazy(() =>
  import("./views/ShiftDiagnosticsView").then((m) => ({ default: m.ShiftDiagnosticsView }))
);

type TabId =
  | "overview"
  | "catalog"
  | "pos"
  | "operations"
  | "loyalty"
  | "abc-lp"
  | "forecasting"
  | "shift-diagnostics"
  | "admin";

interface MetaPayload {
  departments: { id: string; code: string; name: string }[];
  suppliers: { id: string; code: string; name: string }[];
}

const ROLE_TABS: Record<UserRole, TabId[]> = {
  owner: ["overview", "pos", "catalog", "operations", "loyalty", "abc-lp", "forecasting", "shift-diagnostics", "admin"],
  manager: ["overview", "pos", "catalog", "operations", "loyalty", "abc-lp", "forecasting", "shift-diagnostics", "admin"],
  cashier: ["pos", "catalog"],
  stock_clerk: ["catalog", "operations"],
  accountant: ["overview", "loyalty", "abc-lp", "forecasting", "shift-diagnostics", "admin"],
};

export function App() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [meta, setMeta] = useState<MetaPayload>({ departments: [], suppliers: [] });
  const [alertCounts, setAlertCounts] = useState({ margin: 0, expiry: 0 });
  const [apiHealthy, setApiHealthy] = useState(true);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [copilotInitialPrompt, setCopilotInitialPrompt] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const loadMetaAndAlerts = async (currentUser: SessionUser) => {
    try {
      const canSeeMargin = ["owner", "manager"].includes(currentUser.role);
      const canSeeExpiry = ["owner", "manager", "stock_clerk"].includes(currentUser.role);
      const [m, ma, exp] = await Promise.all([
        apiGet<MetaPayload>("/api/meta"),
        canSeeMargin
          ? apiGet<{ alerts: unknown[] }>("/api/inventory/margin-alerts")
          : Promise.resolve({ alerts: [] }),
        canSeeExpiry
          ? apiGet<{ items: unknown[] }>("/api/inventory/expiry-alerts?days=30")
          : Promise.resolve({ items: [] }),
      ]);
      setMeta(m);
      setAlertCounts({ margin: ma.alerts.length, expiry: exp.items.length });
      setApiHealthy(true);
    } catch {
      setApiHealthy(false);
    }
  };

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      setCopilotOpen(false);
      setSessionNotice(
        "Your session expired or was revoked. Please sign in again (any queued offline POS receipts remain saved locally)."
      );
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const res = await apiGet<{ user: SessionUser | null }>("/api/auth/me");
        setUser(res.user);
        if (res.user) {
          const allowed = ROLE_TABS[res.user.role] ?? ["catalog"];
          setActiveTab(allowed[0]);
          void loadMetaAndAlerts(res.user);
        }
      } catch {
        setApiHealthy(false);
      } finally {
        setAuthChecked(true);
      }
    })();
  }, []);

  const handleLoggedIn = (loggedUser: SessionUser) => {
    setSessionNotice(null);
    setUser(loggedUser);
    const allowed = ROLE_TABS[loggedUser.role] ?? ["catalog"];
    setActiveTab(allowed[0]);
    void loadMetaAndAlerts(loggedUser);
  };

  const handleLogout = async () => {
    try {
      await apiPost("/api/auth/logout", {});
    } catch {
      // ignore logout error
    }
    setSessionNotice(null);
    setUser(null);
    setCopilotOpen(false);
  };

  if (!authChecked) {
    return (
      <div className="login-shell">
        <div className="panel">Checking SupermarketOS session...</div>
      </div>
    );
  }

  if (!user) {
    return <LoginScreen onLoggedIn={handleLoggedIn} sessionNotice={sessionNotice} />;
  }

  const allowedTabs = ROLE_TABS[user.role] ?? ["catalog"];
  const canUseAi = user.role === "owner" || user.role === "manager";
  const totalOpsAlerts = alertCounts.margin + alertCounts.expiry;

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Primary navigation">
        <div className="brand-lockup">
          <div className="brand-mark">S</div>
          <div>
            <div className="brand-title">SupermarketOS</div>
            <div className="brand-sub">3,120+ Packaged FMCG SKUs</div>
          </div>
        </div>

        {canUseAi && (
          <button
            id="open-ai-copilot-btn"
            className="btn btn-primary"
            style={{ width: "100%", marginBottom: 10, justifyContent: "flex-start" }}
            onClick={() => setCopilotOpen(true)}
          >
            <Sparkles size={15} />
            <span>AI Store Copilot</span>
            <span className="nav-badge">Gemini</span>
          </button>
        )}

        <div className="nav-section-label">Store Operations</div>
        <nav className="nav-list">
          {allowedTabs.includes("overview") && (
            <button
              id="nav-overview"
              className={`nav-btn ${activeTab === "overview" ? "active" : ""}`}
              onClick={() => setActiveTab("overview")}
            >
              <BarChart3 size={16} />
              <span>Executive Overview</span>
            </button>
          )}
          {allowedTabs.includes("pos") && (
            <button
              id="nav-pos"
              className={`nav-btn ${activeTab === "pos" ? "active" : ""}`}
              onClick={() => setActiveTab("pos")}
            >
              <ScanBarcode size={16} />
              <span>Offline-First POS</span>
              <span className="nav-badge">Lane 01</span>
            </button>
          )}
          {allowedTabs.includes("catalog") && (
            <button
              id="nav-catalog"
              className={`nav-btn ${activeTab === "catalog" ? "active" : ""}`}
              onClick={() => setActiveTab("catalog")}
            >
              <Boxes size={16} />
              <span>Catalog &amp; Multi-UOM</span>
            </button>
          )}
          {allowedTabs.includes("operations") && (
            <button
              id="nav-operations"
              className={`nav-btn ${activeTab === "operations" ? "active" : ""}`}
              onClick={() => setActiveTab("operations")}
            >
              <PackageCheck size={16} />
              <span>Receiving &amp; FEFO</span>
              {totalOpsAlerts > 0 && (
                <span className="nav-badge alert">{totalOpsAlerts}</span>
              )}
            </button>
          )}
          {allowedTabs.includes("loyalty") && (
            <button
              id="nav-loyalty"
              className={`nav-btn ${activeTab === "loyalty" ? "active" : ""}`}
              onClick={() => setActiveTab("loyalty")}
            >
              <Gift size={16} />
              <span>Loyalty &amp; Promos</span>
            </button>
          )}
        </nav>

        {(allowedTabs.includes("abc-lp") ||
          allowedTabs.includes("forecasting") ||
          allowedTabs.includes("shift-diagnostics")) && (
          <>
            <div className="nav-section-label">Retail Intelligence</div>
            <nav className="nav-list">
              {allowedTabs.includes("shift-diagnostics") && (
                <button
                  id="nav-shift-diagnostics"
                  className={`nav-btn ${activeTab === "shift-diagnostics" ? "active" : ""}`}
                  onClick={() => setActiveTab("shift-diagnostics")}
                >
                  <Sun size={16} />
                  <span>Shift Diagnostics</span>
                </button>
              )}
              {allowedTabs.includes("abc-lp") && (
                <button
                  id="nav-abc-lp"
                  className={`nav-btn ${activeTab === "abc-lp" ? "active" : ""}`}
                  onClick={() => setActiveTab("abc-lp")}
                >
                  <Grid3X3 size={16} />
                  <span>ABC-XYZ &amp; Loss Prev.</span>
                </button>
              )}
              {allowedTabs.includes("forecasting") && (
                <button
                  id="nav-forecasting"
                  className={`nav-btn ${activeTab === "forecasting" ? "active" : ""}`}
                  onClick={() => setActiveTab("forecasting")}
                >
                  <TrendingUp size={16} />
                  <span>Forecasts &amp; Basket AI</span>
                </button>
              )}
              {allowedTabs.includes("admin") && (
                <button
                  id="nav-admin"
                  className={`nav-btn ${activeTab === "admin" ? "active" : ""}`}
                  onClick={() => setActiveTab("admin")}
                >
                  <ShieldCheck size={16} />
                  <span>Governance &amp; Audit</span>
                </button>
              )}
            </nav>
          </>
        )}

        <div className="sidebar-footer">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
            <div>
              <div style={{ color: "#fff", fontWeight: 600, fontSize: 12.5 }}>{user.fullName}</div>
              <div className="mono" style={{ fontSize: 10.5, textTransform: "uppercase" }}>
                {user.role}
              </div>
            </div>
            <button
              id="logout-btn"
              className="btn btn-sm"
              style={{ padding: "4px 8px" }}
              title="Sign Out"
              aria-label="Sign Out"
              onClick={() => void handleLogout()}
            >
              <LogOut size={13} />
            </button>
          </div>
          <div className="status-row">
            <span className={`status-dot ${apiHealthy ? "" : "offline"}`} />
            <span>{apiHealthy ? "PostgreSQL + API Live" : "API Unreachable"}</span>
          </div>
          <div>Immutable Ledger · Integer Cents</div>
        </div>
      </aside>

      <main className="main-content">
        <Suspense fallback={<div className="panel">Loading SupermarketOS module...</div>}>
          {activeTab === "overview" && (
            <OverviewView
              key={`ov-${refreshTick}`}
              userRole={user.role}
              allowedTabs={allowedTabs}
              onNavigate={(tab) => {
                if (allowedTabs.includes(tab)) setActiveTab(tab);
              }}
            />
          )}
          {activeTab === "catalog" && (
            <CatalogView
              key={`cat-${refreshTick}`}
              departments={meta.departments}
              userRole={user.role}
            />
          )}
          {/* Keep PosTerminalView mounted across tab switches so active basket & offline state persist */}
          {allowedTabs.includes("pos") && (
            <div style={{ display: activeTab === "pos" ? "block" : "none" }}>
              <PosTerminalView
                cashierName={user.fullName}
                userRole={user.role}
                isActive={activeTab === "pos"}
              />
            </div>
          )}
          {activeTab === "operations" && (
            <OperationsView
              key={`ops-${refreshTick}`}
              suppliers={meta.suppliers}
              userRole={user.role}
              onCountsChanged={() => void loadMetaAndAlerts(user)}
            />
          )}
          {activeTab === "loyalty" && (
            <LoyaltyPromosView key={`loy-${refreshTick}`} userRole={user.role} />
          )}
          {activeTab === "abc-lp" && (
            <AbcLossView key={`abc-${refreshTick}`} userRole={user.role} />
          )}
          {activeTab === "forecasting" && (
            <ForecastingBasketView key={`fc-${refreshTick}`} userRole={user.role} />
          )}
          {activeTab === "shift-diagnostics" && (
            <ShiftDiagnosticsView
              key={`sd-${refreshTick}`}
              userRole={user.role}
              onAskCopilot={(prompt) => {
                setCopilotInitialPrompt(prompt);
                setCopilotOpen(true);
              }}
            />
          )}
          {activeTab === "admin" && (
            <AdminAuditView
              key={`adm-${refreshTick}`}
              userRole={user.role}
              currentUsername={user.username}
            />
          )}
        </Suspense>
      </main>

      {canUseAi && (
        <Suspense fallback={null}>
          <AiCopilotDrawer
            open={copilotOpen}
            initialPrompt={copilotInitialPrompt}
            onConsumeInitialPrompt={() => setCopilotInitialPrompt(null)}
            onClose={() => setCopilotOpen(false)}
            onActionExecuted={() => {
              setRefreshTick((t) => t + 1);
              void loadMetaAndAlerts(user);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}

export default App;
