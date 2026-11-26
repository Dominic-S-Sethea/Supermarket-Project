import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { reportClientError } from "../lib/telemetry";

interface ErrorBoundaryProps {
  scope?: string;
  children: ReactNode;
  onReset?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, errorMessage: "" };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error?.message || "An unexpected rendering error occurred.",
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportClientError(this.props.scope ?? "App", error, info.componentStack ?? undefined);
  }

  private handleReset = () => {
    this.setState({ hasError: false, errorMessage: "" });
    this.props.onReset?.();
  };

  render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const scopeLabel = this.props.scope ?? "Application";
    return (
      <div className="panel stack-md" role="alert" style={{ maxWidth: 640, margin: "24px auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--accent-crimson)" }}>
          <AlertTriangle size={22} aria-hidden="true" />
          <div>
            <h2 style={{ margin: 0, fontSize: 18, color: "var(--ink-primary)" }}>
              {scopeLabel} encountered an unexpected error
            </h2>
            <p className="panel-desc" style={{ marginTop: 2 }}>
              Your queued offline POS receipts and saved database records remain intact.
            </p>
          </div>
        </div>
        <div className="banner banner-red">
          <span className="mono" style={{ fontSize: 12 }}>
            {this.state.errorMessage}
          </span>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button type="button" className="btn btn-primary" onClick={this.handleReset}>
            <RefreshCw size={14} aria-hidden="true" /> Try Again
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              if (typeof window !== "undefined") window.location.reload();
            }}
          >
            Reload Application
          </button>
        </div>
      </div>
    );
  }
}
