import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { applyTheme, readStoredTheme } from "./lib/theme";

const CustomerDisplayView = lazy(() =>
  import("./views/CustomerDisplayView").then((m) => ({ default: m.CustomerDisplayView }))
);

applyTheme(readStoredTheme());

const isCustomerDisplay =
  typeof window !== "undefined" &&
  window.location.pathname.replace(/\/+$/, "") === "/customer-display";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary scope={isCustomerDisplay ? "Customer Display" : "SupermarketOS"}>
      {isCustomerDisplay ? (
        <Suspense fallback={<div className="login-shell"><div className="panel">Loading Customer Display...</div></div>}>
          <CustomerDisplayView />
        </Suspense>
      ) : (
        <App />
      )}
    </ErrorBoundary>
  </StrictMode>
);

