/**
 * GS1 Barcode validation (EAN-13, EAN-8, UPC-A, ITF-14) and generator helpers
 * for packaged FMCG units, multi-packs, and supplier cases.
 */

export type BarcodeFormat = "EAN-13" | "UPC-A" | "EAN-8" | "ITF-14" | "INTERNAL";

export function computeGs1CheckDigit(digitsWithoutCheck: string): number {
  if (!/^\d+$/.test(digitsWithoutCheck)) {
    throw new Error(`Invalid barcode digits: ${digitsWithoutCheck}`);
  }
  let sum = 0;
  // Weight 3, 1, 3, 1... moving right-to-left from rightmost payload digit
  const len = digitsWithoutCheck.length;
  for (let i = 0; i < len; i++) {
    const digit = Number(digitsWithoutCheck[len - 1 - i]);
    sum += i % 2 === 0 ? digit * 3 : digit;
  }
  return (10 - (sum % 10)) % 10;
}

export function validateBarcode(raw: string): {
  valid: boolean;
  normalized: string;
  format: BarcodeFormat;
  error?: string;
} {
  const normalized = raw.trim().replace(/\s+/g, "");
  if (!normalized) {
    return { valid: false, normalized, format: "INTERNAL", error: "Empty barcode" };
  }

  if (/^\d{13}$/.test(normalized)) {
    const expected = computeGs1CheckDigit(normalized.slice(0, 12));
    const actual = Number(normalized[12]);
    return expected === actual
      ? { valid: true, normalized, format: "EAN-13" }
      : {
          valid: false,
          normalized,
          format: "EAN-13",
          error: `Invalid EAN-13 check digit (expected ${expected}, got ${actual})`,
        };
  }

  if (/^\d{12}$/.test(normalized)) {
    const expected = computeGs1CheckDigit(normalized.slice(0, 11));
    const actual = Number(normalized[11]);
    return expected === actual
      ? { valid: true, normalized, format: "UPC-A" }
      : {
          valid: false,
          normalized,
          format: "UPC-A",
          error: `Invalid UPC-A check digit (expected ${expected}, got ${actual})`,
        };
  }

  if (/^\d{8}$/.test(normalized)) {
    const expected = computeGs1CheckDigit(normalized.slice(0, 7));
    const actual = Number(normalized[7]);
    return expected === actual
      ? { valid: true, normalized, format: "EAN-8" }
      : {
          valid: false,
          normalized,
          format: "EAN-8",
          error: `Invalid EAN-8 check digit (expected ${expected}, got ${actual})`,
        };
  }

  if (/^\d{14}$/.test(normalized)) {
    const expected = computeGs1CheckDigit(normalized.slice(0, 13));
    const actual = Number(normalized[13]);
    return expected === actual
      ? { valid: true, normalized, format: "ITF-14" }
      : {
          valid: false,
          normalized,
          format: "ITF-14",
          error: `Invalid ITF-14 check digit (expected ${expected}, got ${actual})`,
        };
  }

  // Allow store-internal alphanumeric SKUs starting with INT-
  if (/^INT-[A-Z0-9-]{4,16}$/i.test(normalized)) {
    return { valid: true, normalized: normalized.toUpperCase(), format: "INTERNAL" };
  }

  return {
    valid: false,
    normalized,
    format: "INTERNAL",
    error: `Unsupported barcode length/format (${normalized.length} chars)`,
  };
}

/**
 * Deterministically generate a valid EAN-13 barcode from a numeric prefix + sequence number.
 */
export function buildValidEan13(prefix3: string, seq9: number): string {
  const payload = `${prefix3.slice(0, 3).padStart(3, "8")}${String(seq9).padStart(9, "0")}`;
  const check = computeGs1CheckDigit(payload);
  return `${payload}${check}`;
}

/**
 * GS1 Prefix 20-29 in-store variable-measure barcode layout (EAN-13):
 *   2X PPPPP VVVVV C
 *   - Prefix 20..24: embedded net weight in grams (e.g., 00425 = 425 g = 0.425 kg)
 *   - Prefix 25..29: embedded line price in integer minor currency units (e.g., 00450 = $4.50)
 *   - PPPPP: 5-digit zero-padded PLU code (e.g., "04011" matches PLU "4011" or "04011")
 *   - C: GS1 EAN-13 check digit
 */
export interface ParsedScaleBarcode {
  barcode: string;
  prefix: string;
  kind: "weight" | "price";
  rawPlu5: string;
  pluCandidates: string[];
  weightGrams: number | null;
  embeddedPriceCents: number | null;
}

export function normalizePluCode(raw: string): string {
  const digits = raw.trim().replace(/\D/g, "");
  return digits.replace(/^0+/, "") || digits;
}

export function parseScaleBarcode(raw: string): ParsedScaleBarcode | null {
  const clean = raw.trim().replace(/\s+/g, "");
  if (!/^2[0-9]\d{11}$/.test(clean)) return null;
  const expected = computeGs1CheckDigit(clean.slice(0, 12));
  if (Number(clean[12]) !== expected) return null;

  const prefix = clean.slice(0, 2);
  const prefixNum = Number(prefix);
  const rawPlu5 = clean.slice(2, 7);
  const valueInt = Number(clean.slice(7, 12));
  if (!Number.isFinite(valueInt) || valueInt <= 0) return null;

  const stripped = normalizePluCode(rawPlu5);
  const pluCandidates = stripped === rawPlu5 ? [rawPlu5] : [stripped, rawPlu5];
  const kind: "weight" | "price" = prefixNum <= 24 ? "weight" : "price";

  return {
    barcode: clean,
    prefix,
    kind,
    rawPlu5,
    pluCandidates,
    weightGrams: kind === "weight" ? valueInt : null,
    embeddedPriceCents: kind === "price" ? valueInt : null,
  };
}

export function buildScaleBarcode(
  kind: "weight" | "price",
  pluCode: string,
  valueInt: number,
  prefix?: string
): string {
  const pfx = prefix ?? (kind === "weight" ? "20" : "25");
  if (!/^2[0-9]$/.test(pfx)) {
    throw new Error(`Scale barcode prefix must be 20..29, got ${pfx}`);
  }
  const pluDigits = pluCode.replace(/\D/g, "");
  if (!pluDigits || pluDigits.length > 5) {
    throw new Error(`PLU code must be 1..5 digits, got "${pluCode}"`);
  }
  const clamped = Math.max(1, Math.min(99999, Math.round(valueInt)));
  const payload = `${pfx}${pluDigits.padStart(5, "0")}${String(clamped).padStart(5, "0")}`;
  return `${payload}${computeGs1CheckDigit(payload)}`;
}
