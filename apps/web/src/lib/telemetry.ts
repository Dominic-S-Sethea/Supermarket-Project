export interface ClientErrorEvent {
  scope: string;
  message: string;
  stack?: string;
  componentStack?: string;
  timestamp: string;
}

type ClientErrorReporter = (event: ClientErrorEvent) => void;

const MAX_BUFFER_SIZE = 25;
const recentErrors: ClientErrorEvent[] = [];
let customReporter: ClientErrorReporter | null = null;

export function setClientErrorReporter(reporter: ClientErrorReporter | null): void {
  customReporter = reporter;
}

export function getRecentClientErrors(): readonly ClientErrorEvent[] {
  return recentErrors;
}

export function clearRecentClientErrors(): void {
  recentErrors.length = 0;
}

/**
 * Lightweight frontend error telemetry hook (H-17 / L-08).
 * Buffers recent runtime errors in memory and forwards to any registered reporter
 * without blocking UI recovery or leaking sensitive payloads externally.
 */
export function reportClientError(
  scope: string,
  error: unknown,
  componentStack?: string
): ClientErrorEvent {
  const err = error instanceof Error ? error : new Error(String(error));
  const event: ClientErrorEvent = {
    scope,
    message: err.message || "Unexpected application error",
    stack: err.stack,
    componentStack,
    timestamp: new Date().toISOString(),
  };

  recentErrors.push(event);
  if (recentErrors.length > MAX_BUFFER_SIZE) {
    recentErrors.shift();
  }

  if (customReporter) {
    try {
      customReporter(event);
    } catch {
      // never allow telemetry reporter failure to break error boundary rendering
    }
  } else if (typeof console !== "undefined" && typeof console.error === "function") {
    console.error(`[SupermarketOS:${scope}]`, err, componentStack ?? "");
  }

  return event;
}
