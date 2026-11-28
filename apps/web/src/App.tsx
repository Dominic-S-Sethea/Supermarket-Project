import { lazy, Suspense, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { UserRole } from "@supermarket/shared/dtos";
import {
  BarChart3,
  Boxes,
  Gift,
  Grid3X3,
  LogOut,
  type LucideIcon,
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
import { clearCfdState } from "./lib/cfdChannel";
import { clearPosCache, loadOfflineQueue } from "./lib/posCache";
import { useSpatial3DPanels } from "./lib/spatial3d";
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
  useSpatial3DPanels();
  const { theme, setTheme } = useTheme();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [meta, setMeta] = useState<MetaPayload>({ departments: [], suppliers: [] });
  const [alertCounts, setAlertCounts] = useState({ margin: 0, expiry: 0 });
  const [apiStatus, setApiStatus] = useState<"live" | "degraded" | "offline">("live");
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [copilotInitialPrompt, setCopilotInitialPrompt] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [posCatalogTick, setPosCatalogTick] = useState(0);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [logoutQueueWarning, setLogoutQueueWarning] = useState(false);
  const metaAbortRef = useRef<AbortController | null>(null);

  const resetSessionClientState = useCallback(() => {
    metaAbortRef.current?.abort();
    metaAbortRef.current = null;
    void clearPosCache();
    clearCfdState();
    setMeta({ departments: [], suppliers: [] });
    setAlertCounts({ margin: 0, expiry: 0 });
    setCopilotInitialPrompt(null);
    setPosCatalogTick(0);
    setCopilotOpen(false);
    setMobileNavOpen(false);
    setLogoutQueueWarning(false);
  }, []);

  const loadMetaAndAlerts = useCallback(async (currentUser: SessionUser) => {
    metaAbortRef.current?.abort();
    const controller = new AbortController();
    metaAbortRef.current = controller;

    const canSeeMargin = ["owner", "manager"].includes(currentUser.role);
    const canSeeExpiry = ["owner", "manager", "stock_clerk"].includes(currentUser.role);
    const [metaRes, marginRes, expiryRes] = await Promise.allSettled([
      apiGet<MetaPayload>("/api/meta", controller.signal),
      canSeeMargin
        ? apiGet<{ alerts: unknown[] }>("/api/inventory/margin-alerts", controller.signal)
        : Promise.resolve(null),
      canSeeExpiry
        ? apiGet<{ items: unknown[] }>("/api/inventory/expiry-alerts?days=30", controller.signal)
        : Promise.resolve(null),
    ]);
    if (controller.signal.aborted) return;

    if (metaRes.status === "fulfilled") {
      setMeta(metaRes.value);
    }
    setAlertCounts((prev) => ({
      margin:
        marginRes.status === "fulfilled" && marginRes.value
          ? marginRes.value.alerts.length
          : canSeeMargin
            ? prev.margin
            : 0,
      expiry:
        expiryRes.status === "fulfilled" && expiryRes.value
          ? expiryRes.value.items.length
          : canSeeExpiry
            ? prev.expiry
            : 0,
    }));

    const activeResults = [
      metaRes,
      ...(canSeeMargin ? [marginRes] : []),
      ...(canSeeExpiry ? [expiryRes] : []),
    ];
    const fulfilledCount = activeResults.filter((r) => r.status === "fulfilled").length;
    if (fulfilledCount === activeResults.length) {
      setApiStatus("live");
    } else if (fulfilledCount > 0) {
      setApiStatus("degraded");
    } else {
      setApiStatus("offline");
    }
  }, []);

  const checkSession = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await apiGet<{ user: SessionUser | null }>("/api/auth/me", signal);
      if (signal?.aborted) return;
      setApiStatus("live");
      setUser(res.user);
      if (res.user) {
        const allowed = ROLE_TABS[res.user.role] ?? ["catalog"];
        const initial = resolveInitialTab(allowed);
        setActiveTab(initial);
        syncQueryParam("tab", initial, { push: false });
        void loadMetaAndAlerts(res.user);
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setApiStatus("offline");
      }
    } finally {
      if (!signal?.aborted) {
        setAuthChecked(true);
      }
    }
  }, [loadMetaAndAlerts]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      resetSessionClientState();
      setUser(null);
      setSessionNotice(
        "Your session expired or was revoked. Please sign in again (any queued offline POS receipts remain saved locally)."
      );
    });
    return () => setUnauthorizedHandler(null);
  }, [resetSessionClientState]);

  useEffect(() => {
    const controller = new AbortController();
    void checkSession(controller.signal);
    return () => controller.abort();
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

  const [isMobileViewport, setIsMobileViewport] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(max-width: 820px)").matches
      : false
  );
  const sidebarRef = useRef<HTMLElement>(null);
  const mobileToggleRef = useRef<HTMLButtonElement>(null);
  const prevMobileNavOpenRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(max-width: 820px)");
    const sync = () => {
      setIsMobileViewport(mq.matches);
      if (!mq.matches) setMobileNavOpen(false);
    };
    sync();
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", sync);
      return () => mq.removeEventListener("change", sync);
    }
    return undefined;
  }, []);

  // Keep collapsed mobile drawer non-focusable & hidden from assistive technology
  useEffect(() => {
    const el = sidebarRef.current as (HTMLElement & { inert?: boolean }) | null;
    if (!el) return;
    el.inert = isMobileViewport && !mobileNavOpen;
  }, [isMobileViewport, mobileNavOpen, user]);

  // Close mobile navigation drawer on Escape, trap Tab focus while open, and restore trigger focus on close
  useEffect(() => {
    if (!isMobileViewport) {
      prevMobileNavOpenRef.current = mobileNavOpen;
      return;
    }

    if (mobileNavOpen) {
      const container = sidebarRef.current as (HTMLElement & { inert?: boolean }) | null;
      let focusRaf = 0;
      if (container) {
        container.inert = false;
        focusRaf = window.requestAnimationFrame(() => {
          const firstFocusable = container.querySelector<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
          );
          firstFocusable?.focus();
        });
      }

      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.preventDefault();
          setMobileNavOpen(false);
          return;
        }
        if (e.key !== "Tab" || !container) return;
        const focusables = Array.from(
          container.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
        ).filter((node) => node.offsetParent !== null || getComputedStyle(node).visibility !== "hidden");
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first || !container.contains(document.activeElement)) {
            e.preventDefault();
            last.focus();
          }
        } else if (document.activeElement === last || !container.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        }
      };

      window.addEventListener("keydown", onKeyDown);
      prevMobileNavOpenRef.current = true;
      return () => {
        window.cancelAnimationFrame(focusRaf);
        window.removeEventListener("keydown", onKeyDown);
      };
    }

    if (prevMobileNavOpenRef.current) {
      prevMobileNavOpenRef.current = false;
      mobileToggleRef.current?.focus();
    }
  }, [mobileNavOpen, isMobileViewport]);

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
    resetSessionClientState();
    setSessionNotice(null);
    setApiStatus("live");
    setUser(loggedUser);
    const allowed = ROLE_TABS[loggedUser.role] ?? ["catalog"];
    const nextTab = resolveInitialTab(allowed);
    setActiveTab(nextTab);
    syncQueryParam("tab", nextTab, { push: false });
    void loadMetaAndAlerts(loggedUser);
  };

  const handleLogout = async (force = false) => {
    const pendingOffline = loadOfflineQueue().length;
    if (!force && pendingOffline > 0 && !logoutQueueWarning) {
      setLogoutQueueWarning(true);
      return;
    }
    try {
      await apiPost("/api/auth/logout", {});
    } catch {
      // ignore logout error
    }
    resetSessionClientState();
    setSessionNotice(null);
    setUser(null);
    // Shared lane workstation: the next staff member lands on their own role's default view
    syncQueryParam("tab", null, { push: false, clearParams: ["sub"] });
  };

  if (!authChecked) {
    return (
      <div className="login-shell">
        <div className="panel" role="status" aria-live="polite">
          Checking SupermarketOS session...
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <LoginScreen
        onLoggedIn={handleLoggedIn}
        sessionNotice={sessionNotice}
        apiHealthy={apiStatus !== "offline"}
        onRetryConnection={() => void checkSession()}
        theme={theme}
        onThemeChange={setTheme}
      />
    );
  }

  const allowedTabs = ROLE_TABS[user.role] ?? ["catalog"];
  const canUseAi = user.role === "owner" || user.role === "manager";
  const totalOpsAlerts = alertCounts.margin + alertCounts.expiry;

  const renderNavBtn = (tab: TabId, Icon: LucideIcon, tone: string, badge?: ReactNode) => {
    if (!allowedTabs.includes(tab)) return null;
    const isActive = activeTab === tab;
    return (
      <button
        id={`nav-${tab}`}
        type="button"
        className={`nav-btn ${isActive ? "active" : ""}`}
        aria-current={isActive ? "page" : undefined}
        onClick={() => navigateToTab(tab)}
      >
        <span className={`nav-icon-tile tone-${tone}${isActive ? "" : "-soft"}`} aria-hidden="true">
          <Icon size={15} />
        </span>
        <span>{TAB_LABELS[tab]}</span>
        {badge}
      </button>
    );
  };

  return (
    <div className={`app-shell ${canUseAi && copilotOpen ? "copilot-docked" : ""}`}>
      {/* Compact mobile top navigation bar (<= 820px) */}
      <header className="mobile-topbar">
        <button
          ref={mobileToggleRef}
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
        <div className="mobile-topbar-actions">
          {totalOpsAlerts > 0 && allowedTabs.includes("operations") && (
            <button
              id="mobile-ops-alerts-btn"
              type="button"
              className="btn btn-danger btn-sm mobile-icon-btn"
              aria-label={`${totalOpsAlerts} open margin and expiry alerts — open Receiving & FEFO`}
              onClick={() => navigateToTab("operations")}
            >
              <span>{totalOpsAlerts}</span>
              <span className="sr-only"> alerts</span>
            </button>
          )}
          {canUseAi ? (
            <button
              id="mobile-ai-copilot-btn"
              type="button"
              className="btn btn-primary btn-sm mobile-icon-btn"
              aria-label="Open AI Store Copilot"
              onClick={() => setCopilotOpen(true)}
            >
              <Sparkles size={16} aria-hidden="true" />
            </button>
          ) : (
            <span
              role="status"
              className={`status-dot ${apiStatus === "live" ? "" : "offline"}`}
              aria-label={
                apiStatus === "live"
                  ? "API live"
                  : apiStatus === "degraded"
                    ? "API degraded"
                    : "API unreachable"
              }
            />
          )}
        </div>
      </header>

      {mobileNavOpen && (
        <div
          className="sidebar-backdrop"
          aria-hidden="true"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      <aside
        ref={sidebarRef}
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
          {renderNavBtn("overview", BarChart3, "violet")}
          {renderNavBtn("pos", ScanBarcode, "teal", <span className="nav-badge">Lane 01</span>)}
          {renderNavBtn("catalog", Boxes, "indigo")}
          {renderNavBtn(
            "operations",
            PackageCheck,
            "amber",
            totalOpsAlerts > 0 ? <span className="nav-badge alert">{totalOpsAlerts}</span> : undefined
          )}
          {renderNavBtn("loyalty", Gift, "rose")}
        </nav>

        {(allowedTabs.includes("abc-lp") ||
          allowedTabs.includes("forecasting") ||
          allowedTabs.includes("shift-diagnostics") ||
          allowedTabs.includes("admin")) && (
          <>
            <div className="nav-section-label">Retail Intelligence</div>
            <nav className="nav-list" aria-label="Retail intelligence">
              {renderNavBtn("shift-diagnostics", Sun, "orange")}
              {renderNavBtn("abc-lp", Grid3X3, "rose")}
              {renderNavBtn("forecasting", TrendingUp, "emerald")}
              {renderNavBtn("admin", ShieldCheck, "indigo")}
            </nav>
          </>
        )}

        <div className="sidebar-footer">
          <ThemeSwitcher theme={theme} onChange={setTheme} variant="sidebar" />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
            <div>
              <div className="sidebar-user-name">
                {user.fullName}
              </div>
              <div className="mono" style={{ fontSize: 11.5, textTransform: "uppercase" }}>
                {user.role}
              </div>
            </div>
            <button
              id="logout-btn"
              type="button"
              className="btn btn-sm sidebar-logout-btn"
              title="Sign Out"
              aria-label="Sign Out"
              onClick={() => void handleLogout()}
            >
              <LogOut size={14} aria-hidden="true" />
            </button>
          </div>
          <div className="status-row">
            <span className={`status-dot ${apiStatus === "live" ? "" : "offline"}`} />
            <span>
              {apiStatus === "live"
                ? "PostgreSQL + API Live"
                : apiStatus === "degraded"
                  ? "API Degraded"
                  : "API Unreachable"}
            </span>
            {apiStatus !== "live" && (
              <button
                id="sidebar-api-retry-btn"
                type="button"
                className="btn btn-sm"
                style={{ marginLeft: "auto" }}
                onClick={() => void loadMetaAndAlerts(user)}
              >
                Retry
              </button>
            )}
          </div>
          <div>Immutable Ledger · Integer Cents</div>
          {logoutQueueWarning && (
            <div
              className="banner banner-amber"
              role="alert"
              style={{ marginTop: 8, padding: "8px 10px", fontSize: 11.5, flexDirection: "column", alignItems: "stretch", gap: 6 }}
            >
              <span>
                Queued offline POS receipts exist locally. Sync before signing out, or confirm sign-out anyway.
              </span>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  id="confirm-logout-with-queue-btn"
                  type="button"
                  className="btn btn-danger btn-sm"
                  onClick={() => void handleLogout(true)}
                >
                  Sign Out Anyway
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setLogoutQueueWarning(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </aside>

      <main className="main-content">
        <ErrorBoundary key={activeTab} scope={TAB_LABELS[activeTab]}>
          <Suspense fallback={<div className="panel">Loading SupermarketOS module...</div>}>
            {activeTab !== "pos" && (
              <div key={activeTab} className="view-stage">
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
                    onCatalogChanged={() => setPosCatalogTick((t) => t + 1)}
                  />
                )}
                {activeTab === "operations" && (
                  <OperationsView
                    key={`ops-${refreshTick}`}
                    suppliers={meta.suppliers}
                    userRole={user.role}
                    onCountsChanged={() => void loadMetaAndAlerts(user)}
                    onCatalogChanged={() => setPosCatalogTick((t) => t + 1)}
                  />
                )}
                {activeTab === "loyalty" && (
                  <LoyaltyPromosView
                    key={`loy-${refreshTick}`}
                    userRole={user.role}
                    onCatalogChanged={() => setPosCatalogTick((t) => t + 1)}
                  />
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
                    onSettingsSaved={() => setPosCatalogTick((t) => t + 1)}
                  />
                )}
              </div>
            )}
            {/* Keep PosTerminalView mounted across tab switches so active basket & offline state persist;
                refreshTick reloads catalog/promos in place without losing the active cart (H-17) */}
            {allowedTabs.includes("pos") && (
              <div style={{ display: activeTab === "pos" ? "block" : "none" }}>
                <PosTerminalView
                  cashierUserId={user.id}
                  cashierName={user.fullName}
                  userRole={user.role}
                  isActive={activeTab === "pos"}
                  catalogRefreshTick={refreshTick + posCatalogTick}
                />
              </div>
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
