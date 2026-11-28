import { useState } from "react";
import type { UserRole } from "@supermarket/shared/dtos";
import { KeyRound, ShieldCheck, Database } from "lucide-react";
import { apiPost } from "../api";
import type { ThemeId } from "../lib/theme";
import { ThemeSwitcher } from "./ThemeSwitcher";

export interface SessionUser {
  id: string;
  username: string;
  fullName: string;
  role: UserRole;
}

const SHOW_DEMO_PERSONAS =
  import.meta.env.DEV && import.meta.env.VITE_ENABLE_DEMO_LOGIN === "true";

const DEMO_PERSONAS: { label: string; role: string; username: string; pin: string }[] =
  SHOW_DEMO_PERSONAS
    ? [
        { label: "Owner", role: "Full Access + AI", username: "owner", pin: "1111" },
        { label: "Store Manager", role: "GRN, POs & AI", username: "manager", pin: "9999" },
        { label: "Accountant", role: "Audit, Z-Reports & Exports", username: "accountant", pin: "4444" },
        { label: "Cashier (Lane 01)", role: "POS & Shifts", username: "cashier1", pin: "1234" },
        { label: "Stock Clerk", role: "FEFO & Counts", username: "clerk1", pin: "2222" },
      ]
    : [];

export function LoginScreen({
  onLoggedIn,
  sessionNotice,
  apiHealthy = true,
  onRetryConnection,
  theme = "light",
  onThemeChange,
}: {
  onLoggedIn: (user: SessionUser) => void;
  sessionNotice?: string | null;
  apiHealthy?: boolean;
  onRetryConnection?: () => void;
  theme?: ThemeId;
  onThemeChange?: (next: ThemeId) => void;
}) {
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submitLogin = async (u = username, p = pin) => {
    const cleanUser = u.trim();
    const cleanPin = p.trim();
    if (!cleanUser) {
      setError("Enter your staff username.");
      return;
    }
    if (cleanPin.length < 4 || cleanPin.length > 64) {
      setError("Staff PIN or password must be 4 to 64 characters.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await apiPost<{ user: SessionUser }>("/api/auth/login", {
        username: cleanUser,
        pin: cleanPin,
      });
      onLoggedIn(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-shell">
      <main className="login-card">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">S</div>
          <div>
            <div className="brand-title">SupermarketOS</div>
            <div className="brand-sub">
              3,120+ SKU Retail Operations, Offline POS &amp; Gemini AI Copilot
            </div>
          </div>
        </div>

        {onThemeChange && (
          <div style={{ marginBottom: 16 }}>
            <ThemeSwitcher theme={theme} onChange={onThemeChange} variant="surface" />
          </div>
        )}

        <div className="editorial-heading-block compact">
          <h1 className="editorial-heading">
            Staff <span className="heading-accent">Sign-In</span>
          </h1>
          <div className="heading-rule" aria-hidden="true" />
        </div>
        <p className="panel-desc" style={{ marginBottom: 16 }}>
          {SHOW_DEMO_PERSONAS
            ? "Enter your staff username and PIN, or pick a local dev role below."
            : "Enter your staff username and PIN / password to start your shift."}
        </p>

        {!apiHealthy && (
          <div className="banner banner-amber" role="alert" style={{ marginBottom: 14 }}>
            <span>Store API is currently unreachable. Check LAN / server health before signing in.</span>
            {onRetryConnection && (
              <button type="button" className="btn btn-sm" onClick={onRetryConnection}>
                Retry
              </button>
            )}
          </div>
        )}

        {sessionNotice && !error && (
          <div className="banner banner-amber" role="status" style={{ marginBottom: 14 }}>
            {sessionNotice}
          </div>
        )}

        {error && (
          <div className="banner banner-red" role="alert" style={{ marginBottom: 14 }}>
            {error}
          </div>
        )}

        <form
          className="stack-md"
          style={{ gap: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            void submitLogin();
          }}
        >
          <div className="field">
            <label htmlFor="login-username">Username</label>
            <input
              id="login-username"
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              disabled={submitting}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="login-pin">Staff PIN / Password</label>
            <input
              id="login-pin"
              className="input mono"
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              autoComplete="current-password"
              disabled={submitting}
              minLength={4}
              maxLength={64}
              required
            />
          </div>
          <button
            id="login-submit-btn"
            type="submit"
            className="btn btn-primary"
            disabled={submitting}
          >
            <KeyRound size={14} aria-hidden="true" /> {submitting ? "Signing in..." : "Sign In"}
          </button>
        </form>

        {SHOW_DEMO_PERSONAS && DEMO_PERSONAS.length > 0 && (
          <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--border-hairline)" }}>
            <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--ink-muted)", marginBottom: 8 }}>
              <ShieldCheck size={12} aria-hidden="true" style={{ verticalAlign: "middle", marginRight: 4 }} />
              LOCAL DEV DEMO ROLES
            </div>
            <div className="persona-grid">
              {DEMO_PERSONAS.map((p) => (
                <button
                  key={p.username}
                  type="button"
                  className="quick-sku-btn"
                  disabled={submitting}
                  onClick={() => {
                    setUsername(p.username);
                    setPin(p.pin);
                    void submitLogin(p.username, p.pin);
                  }}
                >
                  <strong style={{ fontSize: 12.5 }}>{p.label}</strong>
                  <span className="mono" style={{ fontSize: 11, color: "var(--ink-secondary)" }}>
                    {p.username} · {p.role}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="login-foundation">
          <div className="foundation-bar foundation-sky">
            <span className="foundation-bar-icon" aria-hidden="true">
              <Database size={14} />
            </span>
            <span className="foundation-bar-label">POSTGRESQL LEDGER · OFFLINE POS CACHE · RBAC</span>
          </div>
        </div>
      </main>
    </div>
  );
}
