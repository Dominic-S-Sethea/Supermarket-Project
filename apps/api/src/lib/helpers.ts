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
  return text.replace(/[\^~\r\n\x00-\x1f]/g, " ").trim();
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
  if (/^[=+\-@\t\r]/.test(str)) {
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
