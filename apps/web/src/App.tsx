import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import type { UserRole } from "@supermarket/shared/dtos";
import {
  BarChart3,
  Boxes,
  Gift,
  Grid3X3,
  LogOut,
  Menu,
  PackageCheck,
  ScanBarcode,
  ShieldCheck,
  Sparkles,
  Sun,
  TrendingUp,
  X,
} from "lucide-react";
import { apiGet, apiPost, setUnauthorizedHandler } from "./api";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { LoginScreen, type SessionUser } from "./components/LoginScreen";
import { ThemeSwitcher } from "./components/ThemeSwitcher";
import { useTheme } from "./lib/theme";
import { readQueryParam, syncQueryParam } from "./lib/urlSync";

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

const TAB_LABELS: Record<TabId, string> = {
  overview: "Executive Overview",
  pos: "Offline-First POS",
  catalog: "Catalog & Multi-UOM",
  operations: "Receiving & FEFO",
  loyalty: "Loyalty & Promos",
  "shift-diagnostics": "Shift Diagnostics",
  "abc-lp": "ABC-XYZ & Loss Prev.",
  forecasting: "Forecasts & Basket AI",
  admin: "Governance & Audit",
};

function resolveInitialTab(allowed: TabId[]): TabId {
  const fromUrl = readQueryParam("tab") as TabId | null;
  if (fromUrl && allowed.includes(fromUrl)) {
    return fromUrl;
  }
  return allowed[0];
}

export function App() {
  const { theme, setTheme } = useTheme();
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
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const loadMetaAndAlerts = useCallback(async (currentUser: SessionUser) => {
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
  }, []);

  const checkSession = useCallback(async () => {
    try {
      const res = await apiGet<{ user: SessionUser | null }>("/api/auth/me");
      setApiHealthy(true);
      setUser(res.user);
      if (res.user) {
        const allowed = ROLE_TABS[res.user.role] ?? ["catalog"];
        const initial = resolveInitialTab(allowed);
        setActiveTab(initial);
        syncQueryParam("tab", initial, { push: false });
        void loadMetaAndAlerts(res.user);
      }
    } catch {
      setApiHealthy(false);
    } finally {
      setAuthChecked(true);
    }
  }, [loadMetaAndAlerts]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      setCopilotOpen(false);
      setMobileNavOpen(false);
      setSessionNotice(
        "Your session expired or was revoked. Please sign in again (any queued offline POS receipts remain saved locally)."
      );
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  // Sync browser Back/Forward history (`popstate`) with activeTab validated against RBAC (M-21)
  useEffect(() => {
    if (!user) return;
    const allowed = ROLE_TABS[user.role] ?? ["catalog"];
    const onPopState = () => {
      const next = resolveInitialTab(allowed);
      setActiveTab(next);
      setMobileNavOpen(false);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [user]);

  // Close mobile navigation drawer on Escape (M-20)
  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileNavOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileNavOpen]);

  const navigateToTab = useCallback(
    (tab: TabId) => {
      if (!user) return;
      const allowed = ROLE_TABS[user.role] ?? ["catalog"];
      if (!allowed.includes(tab)) return;
      setActiveTab(tab);
      setMobileNavOpen(false);
      syncQueryParam("tab", tab, { push: true, clearParams: ["sub"] });
    },
    [user]
  );

  const handleLoggedIn = (loggedUser: SessionUser) => {
    setSessionNotice(null);
    setApiHealthy(true);
    setUser(loggedUser);
    const allowed = ROLE_TABS[loggedUser.role] ?? ["catalog"];
    const nextTab = resolveInitialTab(allowed);
    setActiveTab(nextTab);
    syncQueryParam("tab", nextTab, { push: false });
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
    setMobileNavOpen(false);
  };

  if (!authChecked) {
    return (
      <div className="login-shell">
        <div className="panel">Checking SupermarketOS session...</div>
      </div>
    );
  }

  if (!user) {
    return (
      <LoginScreen
        onLoggedIn={handleLoggedIn}
        sessionNotice={sessionNotice}
        apiHealthy={apiHealthy}
        onRetryConnection={() => void checkSession()}
        theme={theme}
        onThemeChange={setTheme}
      />
    );
  }

  const allowedTabs = ROLE_TABS[user.role] ?? ["catalog"];
  const canUseAi = user.role === "owner" || user.role === "manager";
  const totalOpsAlerts = alertCounts.margin + alertCounts.expiry;

  return (
    <div className="app-shell">
      {/* Compact mobile top navigation bar (<= 820px) */}
      <header className="mobile-topbar">
        <button
          id="mobile-nav-toggle-btn"
          type="button"
          className="btn btn-sm mobile-menu-btn"
          aria-label={mobileNavOpen ? "Close navigation menu" : "Open navigation menu"}
          aria-expanded={mobileNavOpen}
          aria-controls="primary-sidebar"
          onClick={() => setMobileNavOpen((open) => !open)}
        >
          {mobileNavOpen ? <X size={16} aria-hidden="true" /> : <Menu size={16} aria-hidden="true" />}
          <span>Menu</span>
        </button>
        <div className="mobile-topbar-title">
          <span className="brand-mark" aria-hidden="true" style={{ width: 26, height: 26, fontSize: 13 }}>
            S
          </span>
          <span>{TAB_LABELS[activeTab]}</span>
        </div>
        {canUseAi ? (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            aria-label="Open AI Store Copilot"
            onClick={() => setCopilotOpen(true)}
          >
            <Sparkles size={14} aria-hidden="true" />
          </button>
        ) : (
          <span className={`status-dot ${apiHealthy ? "" : "offline"}`} aria-label={apiHealthy ? "API live" : "API unreachable"} />
        )}
      </header>

      {mobileNavOpen && (
        <div
          className="sidebar-backdrop"
          aria-hidden="true"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      <aside
        id="primary-sidebar"
        className={`sidebar ${mobileNavOpen ? "mobile-open" : ""}`}
        aria-label="Primary navigation"
      >
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">S</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="brand-title">SupermarketOS</div>
            <div className="brand-sub">3,120+ Packaged FMCG SKUs</div>
          </div>
          <button
            type="button"
            className="btn btn-sm sidebar-close-mobile"
            aria-label="Close navigation menu"
            onClick={() => setMobileNavOpen(false)}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>

        {canUseAi && (
          <button
            id="open-ai-copilot-btn"
            type="button"
            className="btn btn-primary"
            style={{ width: "100%", marginBottom: 10, justifyContent: "flex-start" }}
            onClick={() => {
              setMobileNavOpen(false);
              setCopilotOpen(true);
            }}
          >
            <Sparkles size={15} aria-hidden="true" />
            <span>AI Store Copilot</span>
            <span className="nav-badge">Gemini</span>
          </button>
        )}

        <div className="nav-section-label">Store Operations</div>
        <nav className="nav-list" aria-label="Store operations">
          {allowedTabs.includes("overview") && (
            <button
              id="nav-overview"
              type="button"
              className={`nav-btn ${activeTab === "overview" ? "active" : ""}`}
              aria-current={activeTab === "overview" ? "page" : undefined}
              onClick={() => navigateToTab("overview")}
            >
              <BarChart3 size={16} aria-hidden="true" />
              <span>Executive Overview</span>
            </button>
          )}
          {allowedTabs.includes("pos") && (
            <button
              id="nav-pos"
              type="button"
              className={`nav-btn ${activeTab === "pos" ? "active" : ""}`}
              aria-current={activeTab === "pos" ? "page" : undefined}
              onClick={() => navigateToTab("pos")}
            >
              <ScanBarcode size={16} aria-hidden="true" />
              <span>Offline-First POS</span>
              <span className="nav-badge">Lane 01</span>
            </button>
          )}
          {allowedTabs.includes("catalog") && (
            <button
              id="nav-catalog"
              type="button"
              className={`nav-btn ${activeTab === "catalog" ? "active" : ""}`}
              aria-current={activeTab === "catalog" ? "page" : undefined}
              onClick={() => navigateToTab("catalog")}
            >
              <Boxes size={16} aria-hidden="true" />
              <span>Catalog &amp; Multi-UOM</span>
            </button>
          )}
          {allowedTabs.includes("operations") && (
            <button
              id="nav-operations"
              type="button"
              className={`nav-btn ${activeTab === "operations" ? "active" : ""}`}
              aria-current={activeTab === "operations" ? "page" : undefined}
              onClick={() => navigateToTab("operations")}
            >
              <PackageCheck size={16} aria-hidden="true" />
              <span>Receiving &amp; FEFO</span>
              {totalOpsAlerts > 0 && (
                <span className="nav-badge alert">{totalOpsAlerts}</span>
              )}
            </button>
          )}
          {allowedTabs.includes("loyalty") && (
            <button
              id="nav-loyalty"
              type="button"
              className={`nav-btn ${activeTab === "loyalty" ? "active" : ""}`}
              aria-current={activeTab === "loyalty" ? "page" : undefined}
              onClick={() => navigateToTab("loyalty")}
            >
              <Gift size={16} aria-hidden="true" />
              <span>Loyalty &amp; Promos</span>
            </button>
          )}
        </nav>

        {(allowedTabs.includes("abc-lp") ||
          allowedTabs.includes("forecasting") ||
          allowedTabs.includes("shift-diagnostics") ||
          allowedTabs.includes("admin")) && (
          <>
            <div className="nav-section-label">Retail Intelligence</div>
            <nav className="nav-list" aria-label="Retail intelligence">
              {allowedTabs.includes("shift-diagnostics") && (
                <button
                  id="nav-shift-diagnostics"
                  type="button"
                  className={`nav-btn ${activeTab === "shift-diagnostics" ? "active" : ""}`}
                  aria-current={activeTab === "shift-diagnostics" ? "page" : undefined}
                  onClick={() => navigateToTab("shift-diagnostics")}
                >
                  <Sun size={16} aria-hidden="true" />
                  <span>Shift Diagnostics</span>
                </button>
              )}
              {allowedTabs.includes("abc-lp") && (
                <button
                  id="nav-abc-lp"
                  type="button"
                  className={`nav-btn ${activeTab === "abc-lp" ? "active" : ""}`}
                  aria-current={activeTab === "abc-lp" ? "page" : undefined}
                  onClick={() => navigateToTab("abc-lp")}
                >
                  <Grid3X3 size={16} aria-hidden="true" />
                  <span>ABC-XYZ &amp; Loss Prev.</span>
                </button>
              )}
              {allowedTabs.includes("forecasting") && (
                <button
                  id="nav-forecasting"
                  type="button"
                  className={`nav-btn ${activeTab === "forecasting" ? "active" : ""}`}
                  aria-current={activeTab === "forecasting" ? "page" : undefined}
                  onClick={() => navigateToTab("forecasting")}
                >
                  <TrendingUp size={16} aria-hidden="true" />
                  <span>Forecasts &amp; Basket AI</span>
                </button>
              )}
              {allowedTabs.includes("admin") && (
                <button
                  id="nav-admin"
                  type="button"
                  className={`nav-btn ${activeTab === "admin" ? "active" : ""}`}
                  aria-current={activeTab === "admin" ? "page" : undefined}
                  onClick={() => navigateToTab("admin")}
                >
                  <ShieldCheck size={16} aria-hidden="true" />
                  <span>Governance &amp; Audit</span>
                </button>
              )}
            </nav>
          </>
        )}

        <div className="sidebar-footer">
          <ThemeSwitcher theme={theme} onChange={setTheme} variant="sidebar" />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
            <div>
              <div style={{ color: "var(--ink-inverse)", fontWeight: 600, fontSize: 12.5 }}>
                {user.fullName}
              </div>
              <div className="mono" style={{ fontSize: 10.5, textTransform: "uppercase" }}>
                {user.role}
              </div>
            </div>
            <button
              id="logout-btn"
              type="button"
              className="btn btn-sm"
              style={{ padding: "4px 8px" }}
              title="Sign Out"
              aria-label="Sign Out"
              onClick={() => void handleLogout()}
            >
              <LogOut size={13} aria-hidden="true" />
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
        <ErrorBoundary key={activeTab} scope={TAB_LABELS[activeTab]}>
          <Suspense fallback={<div className="panel">Loading SupermarketOS module...</div>}>
            {activeTab === "overview" && (
              <OverviewView
                key={`ov-${refreshTick}`}
                userRole={user.role}
                allowedTabs={allowedTabs}
                onNavigate={(tab) => navigateToTab(tab)}
              />
            )}
            {activeTab === "catalog" && (
              <CatalogView
                key={`cat-${refreshTick}`}
                departments={meta.departments}
                userRole={user.role}
              />
            )}
            {/* Keep PosTerminalView mounted across tab switches so active basket & offline state persist;
                refreshTick reloads catalog/promos in place without losing the active cart (H-17) */}
            {allowedTabs.includes("pos") && (
              <div style={{ display: activeTab === "pos" ? "block" : "none" }}>
                <PosTerminalView
                  cashierName={user.fullName}
                  userRole={user.role}
                  isActive={activeTab === "pos"}
                  catalogRefreshTick={refreshTick}
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
        </ErrorBoundary>
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
