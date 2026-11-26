/**
 * Helpers for synchronizing top-level navigation tabs and view sub-tabs with
 * browser URL query parameters (`?tab=...&sub=...`) and `popstate` (M-21).
 */

export function readQueryParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

export function syncQueryParam(
  name: string,
  value: string | null,
  options: { push?: boolean; clearParams?: string[] } = {}
): void {
  if (typeof window === "undefined" || !window.history) return;
  try {
    const url = new URL(window.location.href);
    const current = url.searchParams.get(name);
    let changed = false;

    if (value) {
      if (current !== value) {
        url.searchParams.set(name, value);
        changed = true;
      }
    } else if (current !== null) {
      url.searchParams.delete(name);
      changed = true;
    }

    if (options.clearParams) {
      for (const param of options.clearParams) {
        if (url.searchParams.has(param)) {
          url.searchParams.delete(param);
          changed = true;
        }
      }
    }

    if (!changed) return;

    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    if (options.push) {
      window.history.pushState(null, "", nextUrl);
    } else {
      window.history.replaceState(null, "", nextUrl);
    }
  } catch {
    // ignore history errors in restricted environments
  }
}
