import { validateBarcode } from "@supermarket/shared";

/**
 * RFC-4180 compliant CSV parser supporting quoted fields, embedded commas, and escaped double quotes ("").
 */
export function parseCsvRows(csvText: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i];
    const next = csvText[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field.trim());
      field = "";
    } else if (ch === "\r" && next === "\n") {
      row.push(field.trim());
      if (row.some((c) => c.length > 0)) rows.push(row);
      row = [];
      field = "";
      i++;
    } else if (ch === "\n" || ch === "\r") {
      row.push(field.trim());
      if (row.some((c) => c.length > 0)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }

  row.push(field.trim());
  if (row.some((c) => c.length > 0)) rows.push(row);
  return rows;
}

/**
 * Strip ZPL command prefixes (^, ~) and control characters to prevent ZPL label command injection.
 */
export function sanitizeZpl(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const ch = text[i];
    if (code < 0x20 || ch === "^" || ch === "~") {
      out += " ";
    } else {
      out += ch;
    }
  }
  return out.trim();
}

/**
 * Select the proper ZPL barcode symbology instruction by validated GS1/internal format.
 */
export function buildZplBarcodeCommand(barcode: string): string {
  const clean = sanitizeZpl(barcode).replace(/\s+/g, "");
  const check = validateBarcode(clean);
  switch (check.format) {
    case "EAN-13":
      return `^FO20,152^BEN,52,Y,N^FD${clean.slice(0, 12)}^FS`;
    case "UPC-A":
      return `^FO20,152^BUN,52,Y,N,Y^FD${clean.slice(0, 11)}^FS`;
    case "EAN-8":
      return `^FO20,152^B8N,52,Y,N^FD${clean.slice(0, 7)}^FS`;
    case "ITF-14":
      return `^FO20,152^B2N,52,Y,N,N^FD${clean}^FS`;
    default:
      return `^FO20,152^BCN,52,Y,N,N^FD${clean}^FS`;
  }
}

/**
 * RFC-4180 formula-injection-safe CSV cell serializer.
 * Guards against Excel/Calc formula execution (=, +, -, @, tab, CR) and quotes fields cleanly.
 */
export function escapeCsvCell(value: unknown): string {
  let str = value === null || value === undefined ? "" : String(value);
  const isPlainSignedNumber = /^-?\d+(?:\.\d+)?$/.test(str);
  if (!isPlainSignedNumber && (/^[\t\r]/.test(str) || /^\s*[=+\-@]/.test(str))) {
    str = `'${str}`;
  }
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function buildCsvDocument(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(escapeCsvCell).join(",")];
  for (const r of rows) {
    lines.push(r.map(escapeCsvCell).join(","));
  }
  return lines.join("\r\n");
}

/**
 * Escapes PostgreSQL LIKE/ILIKE metacharacters (%, _, \) in user search queries.
 */
export function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, "\\$&");
}

/**
 * Resolves the 0..23 hour of day for a timestamp in an explicit IANA store timezone.
 */
export function getHourInTimezone(date: Date, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      hour: "2-digit",
    }).formatToParts(date);
    const rawHour = Number(parts.find((p) => p.type === "hour")?.value);
    if (Number.isInteger(rawHour)) {
      return rawHour === 24 ? 0 : Math.max(0, Math.min(23, rawHour));
    }
  } catch {
    // Fallback cleanly if a custom timezone string is unparseable
  }
  return date.getUTCHours();
}

/**
 * Enforces bounded POS sale timestamps against future clock-skew and arbitrary historical backdating.
 */
export function validateSoldAtBounds(
  soldAtIso: string,
  nowMs = Date.now(),
  maxBackdateHours = 72,
  maxFutureSkewSec = 300
): { ok: true; soldDate: Date } | { ok: false; error: string } {
  const soldMs = Date.parse(soldAtIso);
  if (!Number.isFinite(soldMs)) {
    return { ok: false, error: "Invalid soldAt timestamp." };
  }
  if (soldMs - nowMs > maxFutureSkewSec * 1000) {
    return {
      ok: false,
      error: `Sale timestamp soldAt cannot be more than ${maxFutureSkewSec}s in the future.`,
    };
  }
  if (nowMs - soldMs > maxBackdateHours * 3600_000) {
    return {
      ok: false,
      error: `Sale timestamp soldAt exceeds the maximum offline backdating window (${maxBackdateHours}h).`,
    };
  }
  return { ok: true, soldDate: new Date(soldMs) };
}
