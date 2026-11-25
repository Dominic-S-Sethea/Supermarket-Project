import { useState } from "react";
import type { UserRole } from "@supermarket/shared";
import { KeyRound, ShieldCheck } from "lucide-react";
import { apiPost } from "../api";

export interface SessionUser {
  id: string;
  username: string;
  fullName: string;
  role: UserRole;
}

const DEMO_PERSONAS: { label: string; role: string; username: string; pin: string }[] = [
  { label: "Owner", role: "Full Access + AI", username: "owner", pin: "1111" },
  { label: "Store Manager", role: "GRN, POs & AI", username: "manager", pin: "9999" },
  { label: "Accountant", role: "Audit, Z-Reports & Exports", username: "accountant", pin: "4444" },
  { label: "Cashier (Lane 01)", role: "POS & Shifts", username: "cashier1", pin: "1234" },
  { label: "Stock Clerk", role: "FEFO & Counts", username: "clerk1", pin: "2222" },
];

export function LoginScreen({
  onLoggedIn,
  sessionNotice,
}: {
  onLoggedIn: (user: SessionUser) => void;
  sessionNotice?: string | null;
}) {
  const [username, setUsername] = useState("owner");
  const [pin, setPin] = useState("1111");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submitLogin = async (u = username, p = pin) => {
    const cleanUser = u.trim();
    const cleanPin = p.trim();
    if (!cleanUser) {
      setError("Enter your staff username.");
      return;
    }
    if (cleanPin.length < 4 || cleanPin.length > 12) {
      setError("Staff PIN must be 4 to 12 characters.");
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
      <div className="login-card">
        <div className="brand-lockup" style={{ borderBottomColor: "var(--border-hairline)", paddingLeft: 0 }}>
          <div className="brand-mark">S</div>
          <div>
            <div className="brand-title" style={{ color: "var(--ink-primary)", fontSize: 18 }}>
              SupermarketOS
            </div>
            <div className="brand-sub" style={{ color: "var(--ink-secondary)" }}>
              3,120+ SKU Retail Operations, Offline POS &amp; Gemini AI Copilot
            </div>
          </div>
        </div>

        <h1 style={{ fontSize: 20, margin: "0 0 6px" }}>Staff Sign-In</h1>
        <p className="panel-desc" style={{ marginBottom: 16 }}>
          Enter your staff username and PIN, or pick a demo role below.
        </p>

        {sessionNotice && !error && (
          <div className="banner banner-amber" style={{ marginBottom: 14 }}>
            {sessionNotice}
          </div>
        )}

        {error && (
          <div className="banner banner-red" style={{ marginBottom: 14 }}>
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
            <label htmlFor="login-pin">Staff PIN</label>
            <input
              id="login-pin"
              className="input mono"
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              autoComplete="current-password"
              disabled={submitting}
              minLength={4}
              maxLength={12}
              required
            />
          </div>
          <button
            id="login-submit-btn"
            type="submit"
            className="btn btn-primary"
            disabled={submitting}
          >
            <KeyRound size={14} /> {submitting ? "Signing in..." : "Sign In"}
          </button>
        </form>

        <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--border-hairline)" }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--ink-muted)", marginBottom: 8 }}>
            <ShieldCheck size={12} style={{ verticalAlign: "middle", marginRight: 4 }} />
            QUICK DEMO ROLE SIGN-IN
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
      </div>
    </div>
  );
}
