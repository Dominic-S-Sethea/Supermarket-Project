import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { applyTheme, readStoredTheme } from "./lib/theme";

applyTheme(readStoredTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary scope="SupermarketOS">
      <App />
    </ErrorBoundary>
  </StrictMode>
);
