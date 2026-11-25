export class ApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;

  constructor(message: string, status: number, method: string, path: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.method = method;
    this.path = path;
  }
}

let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

export function formatApiErrorPayload(
  rawText: string,
  status: number,
  method: string,
  path: string
): string {
  try {
    const parsed = JSON.parse(rawText) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim().length > 0) {
      return parsed.error;
    }
    if (parsed.error && typeof parsed.error === "object") {
      const errObj = parsed.error as {
        formErrors?: unknown;
        fieldErrors?: Record<string, unknown>;
      };
      const parts: string[] = [];
      if (Array.isArray(errObj.formErrors)) {
        for (const item of errObj.formErrors) {
          if (typeof item === "string" && item.trim()) parts.push(item.trim());
        }
      }
      if (errObj.fieldErrors && typeof errObj.fieldErrors === "object") {
        for (const [field, msgs] of Object.entries(errObj.fieldErrors)) {
          if (Array.isArray(msgs)) {
            const clean = msgs.filter((m): m is string => typeof m === "string" && m.trim().length > 0);
            if (clean.length > 0) {
              parts.push(`${field}: ${clean.join(", ")}`);
            }
          }
        }
      }
      if (parts.length > 0) {
        return parts.join("; ");
      }
    }
    if (typeof parsed.message === "string" && parsed.message.trim().length > 0) {
      return parsed.message;
    }
  } catch {
    // ignore JSON parse failure
  }
  const snippet = rawText.trim().slice(0, 200);
  return snippet
    ? `${method} ${path} failed (${status}): ${snippet}`
    : `${method} ${path} failed (${status})`;
}

async function handleResponse<T>(res: Response, method: string, path: string): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (
      res.status === 401 &&
      unauthorizedHandler &&
      !path.startsWith("/api/auth/login") &&
      !path.startsWith("/api/auth/me")
    ) {
      unauthorizedHandler();
    }
    throw new ApiError(formatApiErrorPayload(text, res.status, method, path), res.status, method, path);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { credentials: "include", signal });
  return handleResponse<T>(res, "GET", path);
}

export async function apiPost<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  return handleResponse<T>(res, "POST", path);
}

export async function apiPatch<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  return handleResponse<T>(res, "PATCH", path);
}

export async function apiDelete<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { method: "DELETE", credentials: "include", signal });
  return handleResponse<T>(res, "DELETE", path);
}
