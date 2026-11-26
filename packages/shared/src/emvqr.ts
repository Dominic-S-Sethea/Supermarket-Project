/**
 * Standards-compliant SE Asia EMVCo Merchant-Presented QR (EMV QRCPS) engine
 * + zero-dependency ISO/IEC 18004 QR Code Model 2 matrix encoder (Versions 1-12, ECC M).
 *
 * Supported rails:
 * - KHQR (National Bank of Cambodia / Bakong): Tag 29/30, ISO 4217 840 (USD) / 116 (KHR), Tag 99 expiry
 * - PromptPay (Bank of Thailand): Tag 29 AID A000000677010111, ISO 4217 764 (THB)
 * - PayNow (ABS Singapore): Tag 26 SG.PAYNOW, UEN/mobile proxy, editable=0, ISO 4217 702 (SGD)
 */

export type QrPaymentRail = "khqr" | "promptpay" | "paynow";

export interface EmvQrBuildResult {
  rail: QrPaymentRail;
  payload: string;
  crc16: string;
  currencyCode: string;
  currencyNumeric: string;
  amountFormatted: string;
  billReference: string;
}

export interface ParsedEmvQr {
  valid: boolean;
  crcValid: boolean;
  crcExpected: string | null;
  crcActual: string | null;
  rail: QrPaymentRail | null;
  tags: Record<string, string>;
  amount: string | null;
  currencyNumeric: string | null;
  merchantName: string | null;
  billReference: string | null;
}

export const ISO_CURRENCY_NUMERIC: Record<string, string> = {
  USD: "840",
  KHR: "116",
  THB: "764",
  SGD: "702",
  EUR: "978",
};

/**
 * CRC-16/CCITT-FALSE (polynomial 0x1021, initial value 0xFFFF, no reflection, no final XOR)
 * per EMVCo QR Code Specification for Payment Systems (EMV QRCPS) Section 4.7.14.
 */
export function crc16CcittFalse(input: string): string {
  let crc = 0xffff;
  for (let i = 0; i < input.length; i++) {
    crc ^= (input.charCodeAt(i) & 0xff) << 8;
    for (let bit = 0; bit < 8; bit++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function sanitizeAscii(input: string, maxLen: number): string {
  return input
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .trim()
    .slice(0, maxLen);
}

/** Encode a single EMVCo TLV object: 2-digit ID + 2-digit byte length + value. */
export function encodeTlv(tag: string, value: string): string {
  if (!/^\d{2}$/.test(tag)) {
    throw new Error(`Invalid EMVCo tag "${tag}" (expected 2 digits).`);
  }
  if (value.length > 99) {
    throw new Error(`EMVCo tag ${tag} value exceeds 99 characters (${value.length}).`);
  }
  return `${tag}${String(value.length).padStart(2, "0")}${value}`;
}

export function decodeTlvMap(raw: string): Record<string, string> | null {
  const map: Record<string, string> = {};
  let pos = 0;
  while (pos < raw.length) {
    if (pos + 4 > raw.length) return null;
    const tag = raw.slice(pos, pos + 2);
    const lenStr = raw.slice(pos + 2, pos + 4);
    if (!/^\d{2}$/.test(tag) || !/^\d{2}$/.test(lenStr)) return null;
    const len = Number(lenStr);
    pos += 4;
    if (pos + len > raw.length) return null;
    map[tag] = raw.slice(pos, pos + len);
    pos += len;
  }
  return map;
}

function finalizeEmvPayload(bodyWithoutCrc: string): { payload: string; crc16: string } {
  const withTag63Header = `${bodyWithoutCrc}6304`;
  const crc16 = crc16CcittFalse(withTag63Header);
  return { payload: `${withTag63Header}${crc16}`, crc16 };
}

function formatEmvAmount(amountMinorUnits: number, currencyCode: string): string {
  const safe = Math.max(0, Math.round(amountMinorUnits));
  if (currencyCode.toUpperCase() === "KHR") {
    return String(safe);
  }
  return (safe / 100).toFixed(2);
}

export interface KhqrInput {
  accountId: string; // e.g. "flagship_market@aba"
  merchantId?: string; // if provided -> Tag 30 (Merchant), else Tag 29 (Individual)
  acquiringBank?: string;
  merchantName: string;
  merchantCity?: string;
  currencyCode: "USD" | "KHR";
  /** For USD: cents (e.g. 1445 -> "14.45"). For KHR: whole riel (e.g. 59200 -> "59200"). */
  amountMinorUnits: number;
  billReference: string;
  terminalLabel?: string;
  mcc?: string;
  createdAtMs?: number;
  expiresAtMs?: number;
}

export function buildKhqrPayload(input: KhqrInput): EmvQrBuildResult {
  const currencyCode = input.currencyCode.toUpperCase() === "KHR" ? "KHR" : "USD";
  const currencyNumeric = ISO_CURRENCY_NUMERIC[currencyCode];
  const amountFormatted = formatEmvAmount(input.amountMinorUnits, currencyCode);
  const merchantName = sanitizeAscii(input.merchantName || "SUPERMARKET OS", 25) || "SUPERMARKET OS";
  const merchantCity = sanitizeAscii(input.merchantCity || "Phnom Penh", 15) || "Phnom Penh";
  const billReference = sanitizeAscii(input.billReference, 25);
  const terminalLabel = sanitizeAscii(input.terminalLabel || "LANE-01", 25);
  const accountId = sanitizeAscii(input.accountId, 32);

  const isMerchant = Boolean(input.merchantId && input.merchantId.trim().length > 0);
  const merchantAccountSub =
    encodeTlv("00", accountId) +
    (isMerchant ? encodeTlv("01", sanitizeAscii(input.merchantId!, 32)) : "") +
    (input.acquiringBank ? encodeTlv("02", sanitizeAscii(input.acquiringBank, 32)) : "");

  const additionalData =
    encodeTlv("01", billReference) + (terminalLabel ? encodeTlv("07", terminalLabel) : "");

  const nowMs = input.createdAtMs ?? Date.now();
  const expMs = input.expiresAtMs ?? nowMs + 5 * 60_000;
  const timestampSub = encodeTlv("00", String(nowMs)) + encodeTlv("01", String(expMs));

  const body =
    encodeTlv("00", "01") +
    encodeTlv("01", input.amountMinorUnits > 0 ? "12" : "11") +
    encodeTlv(isMerchant ? "30" : "29", merchantAccountSub) +
    encodeTlv("52", input.mcc ?? "5411") +
    encodeTlv("53", currencyNumeric) +
    (input.amountMinorUnits > 0 ? encodeTlv("54", amountFormatted) : "") +
    encodeTlv("58", "KH") +
    encodeTlv("59", merchantName) +
    encodeTlv("60", merchantCity) +
    encodeTlv("62", additionalData) +
    encodeTlv("99", timestampSub);

  const { payload, crc16 } = finalizeEmvPayload(body);
  return {
    rail: "khqr",
    payload,
    crc16,
    currencyCode,
    currencyNumeric,
    amountFormatted,
    billReference,
  };
}

export interface PromptPayInput {
  /** Thai mobile (08x/09x/+66...), 13-digit Tax/National ID, or 15-digit e-Wallet ID */
  proxy: string;
  merchantName: string;
  merchantCity?: string;
  /** THB satang (minor units, e.g. 49900 -> "499.00") */
  amountMinorUnits: number;
  billReference: string;
  mcc?: string;
}

export function normalizePromptPayProxy(raw: string): { subTag: "01" | "02" | "03"; value: string } {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 15) {
    return { subTag: "03", value: digits };
  }
  if (digits.length === 13) {
    return { subTag: "02", value: digits };
  }
  // Thai mobile number -> "0066" + 9 subscriber digits (13 digits total)
  const local9 = digits.startsWith("0066")
    ? digits.slice(4)
    : digits.startsWith("66")
      ? digits.slice(2)
      : digits.startsWith("0")
        ? digits.slice(1)
        : digits;
  return { subTag: "01", value: `0066${local9.slice(0, 9).padStart(9, "0")}` };
}

export function buildPromptPayPayload(input: PromptPayInput): EmvQrBuildResult {
  const currencyCode = "THB";
  const currencyNumeric = ISO_CURRENCY_NUMERIC.THB;
  const amountFormatted = formatEmvAmount(input.amountMinorUnits, currencyCode);
  const merchantName = sanitizeAscii(input.merchantName || "SUPERMARKET OS", 25) || "SUPERMARKET OS";
  const merchantCity = sanitizeAscii(input.merchantCity || "Bangkok", 15) || "Bangkok";
  const billReference = sanitizeAscii(input.billReference, 25);
  const { subTag, value } = normalizePromptPayProxy(input.proxy);

  const tag29 = encodeTlv("00", "A000000677010111") + encodeTlv(subTag, value);
  const tag62 = encodeTlv("01", billReference);

  const body =
    encodeTlv("00", "01") +
    encodeTlv("01", input.amountMinorUnits > 0 ? "12" : "11") +
    encodeTlv("29", tag29) +
    encodeTlv("52", input.mcc ?? "5411") +
    encodeTlv("53", currencyNumeric) +
    (input.amountMinorUnits > 0 ? encodeTlv("54", amountFormatted) : "") +
    encodeTlv("58", "TH") +
    encodeTlv("59", merchantName) +
    encodeTlv("60", merchantCity) +
    encodeTlv("62", tag62);

  const { payload, crc16 } = finalizeEmvPayload(body);
  return {
    rail: "promptpay",
    payload,
    crc16,
    currencyCode,
    currencyNumeric,
    amountFormatted,
    billReference,
  };
}

export interface PayNowInput {
  /** Singapore UEN (e.g. "202612345K") or mobile ("+6591234567") */
  proxy: string;
  proxyType?: "uen" | "mobile";
  merchantName: string;
  merchantCity?: string;
  /** SGD cents (e.g. 1950 -> "19.50") */
  amountMinorUnits: number;
  billReference: string;
  /** Optional YYYYMMDD expiry date */
  expiryDateYyyymmdd?: string;
  mcc?: string;
}

export function buildPayNowPayload(input: PayNowInput): EmvQrBuildResult {
  const currencyCode = "SGD";
  const currencyNumeric = ISO_CURRENCY_NUMERIC.SGD;
  const amountFormatted = formatEmvAmount(input.amountMinorUnits, currencyCode);
  const merchantName = sanitizeAscii(input.merchantName || "SUPERMARKET OS", 25) || "SUPERMARKET OS";
  const merchantCity = sanitizeAscii(input.merchantCity || "Singapore", 15) || "Singapore";
  const billReference = sanitizeAscii(input.billReference, 25);

  const isMobile =
    input.proxyType === "mobile" ||
    (!input.proxyType && /^\+?\d{8,12}$/.test(input.proxy.replace(/\s+/g, "")));
  const proxyCode = isMobile ? "0" : "2";
  const cleanProxy = isMobile
    ? input.proxy.trim().startsWith("+")
      ? input.proxy.trim().replace(/\s+/g, "")
      : `+65${input.proxy.replace(/\D/g, "").slice(-8)}`
    : sanitizeAscii(input.proxy, 25).toUpperCase();

  const expiry =
    input.expiryDateYyyymmdd ??
    new Date(Date.now() + 86_400_000).toISOString().slice(0, 10).replace(/-/g, "");

  const tag26 =
    encodeTlv("00", "SG.PAYNOW") +
    encodeTlv("01", proxyCode) +
    encodeTlv("02", cleanProxy) +
    encodeTlv("03", "0") + // 0 = non-editable locked amount
    encodeTlv("04", expiry);

  const tag62 = encodeTlv("01", billReference);

  const body =
    encodeTlv("00", "01") +
    encodeTlv("01", input.amountMinorUnits > 0 ? "12" : "11") +
    encodeTlv("26", tag26) +
    encodeTlv("52", input.mcc ?? "5411") +
    encodeTlv("53", currencyNumeric) +
    (input.amountMinorUnits > 0 ? encodeTlv("54", amountFormatted) : "") +
    encodeTlv("58", "SG") +
    encodeTlv("59", merchantName) +
    encodeTlv("60", merchantCity) +
    encodeTlv("62", tag62);

  const { payload, crc16 } = finalizeEmvPayload(body);
  return {
    rail: "paynow",
    payload,
    crc16,
    currencyCode,
    currencyNumeric,
    amountFormatted,
    billReference,
  };
}

/**
 * Parse and validate an EMVCo QR string (TLV structure + CRC-16/CCITT-FALSE verification).
 */
export function parseEmvQrTlv(payload: string): ParsedEmvQr {
  const trimmed = payload.trim();
  const tags = decodeTlvMap(trimmed);
  if (!tags || !tags["00"] || !tags["63"] || tags["63"].length !== 4) {
    return {
      valid: false,
      crcValid: false,
      crcExpected: null,
      crcActual: null,
      rail: null,
      tags: tags ?? {},
      amount: null,
      currencyNumeric: null,
      merchantName: null,
      billReference: null,
    };
  }
  const bodyPlusHeader = trimmed.slice(0, trimmed.length - 4);
  const crcExpected = crc16CcittFalse(bodyPlusHeader);
  const crcActual = tags["63"].toUpperCase();
  const crcValid = crcExpected === crcActual;

  let rail: QrPaymentRail | null = null;
  if (tags["26"]?.includes("SG.PAYNOW") || tags["58"] === "SG") {
    rail = "paynow";
  } else if (tags["29"]?.includes("A000000677010111") || tags["58"] === "TH") {
    rail = "promptpay";
  } else if (tags["58"] === "KH" || tags["29"] || tags["30"]) {
    rail = "khqr";
  }

  const tag62 = tags["62"] ? decodeTlvMap(tags["62"]) : null;

  return {
    valid: crcValid && tags["00"] === "01",
    crcValid,
    crcExpected,
    crcActual,
    rail,
    tags,
    amount: tags["54"] ?? null,
    currencyNumeric: tags["53"] ?? null,
    merchantName: tags["59"] ?? null,
    billReference: tag62?.["01"] ?? null,
  };
}

// ============================================================================
// ISO/IEC 18004 QR Code Model 2 Matrix Encoder (Versions 1..14, ECC Level M)
// Zero runtime dependencies; produces genuine smartphone-scannable QR matrices.
// ============================================================================

interface QrVersionSpec {
  version: number;
  totalDataCodewords: number;
  ecPerBlock: number;
  g1Blocks: number;
  g1Data: number;
  g2Blocks: number;
  g2Data: number;
  alignCenters: number[];
}

// ISO/IEC 18004 Table 9 (ECC Level M, Versions 1..14 — up to 411 bytes)
const QR_M_SPECS: QrVersionSpec[] = [
  { version: 1, totalDataCodewords: 16, ecPerBlock: 10, g1Blocks: 1, g1Data: 16, g2Blocks: 0, g2Data: 0, alignCenters: [] },
  { version: 2, totalDataCodewords: 28, ecPerBlock: 16, g1Blocks: 1, g1Data: 28, g2Blocks: 0, g2Data: 0, alignCenters: [6, 18] },
  { version: 3, totalDataCodewords: 44, ecPerBlock: 26, g1Blocks: 1, g1Data: 44, g2Blocks: 0, g2Data: 0, alignCenters: [6, 22] },
  { version: 4, totalDataCodewords: 64, ecPerBlock: 18, g1Blocks: 2, g1Data: 32, g2Blocks: 0, g2Data: 0, alignCenters: [6, 26] },
  { version: 5, totalDataCodewords: 86, ecPerBlock: 24, g1Blocks: 2, g1Data: 43, g2Blocks: 0, g2Data: 0, alignCenters: [6, 30] },
  { version: 6, totalDataCodewords: 108, ecPerBlock: 16, g1Blocks: 4, g1Data: 27, g2Blocks: 0, g2Data: 0, alignCenters: [6, 34] },
  { version: 7, totalDataCodewords: 124, ecPerBlock: 18, g1Blocks: 4, g1Data: 31, g2Blocks: 0, g2Data: 0, alignCenters: [6, 22, 38] },
  { version: 8, totalDataCodewords: 154, ecPerBlock: 22, g1Blocks: 2, g1Data: 38, g2Blocks: 2, g2Data: 39, alignCenters: [6, 24, 42] },
  { version: 9, totalDataCodewords: 182, ecPerBlock: 22, g1Blocks: 3, g1Data: 36, g2Blocks: 2, g2Data: 37, alignCenters: [6, 26, 46] },
  { version: 10, totalDataCodewords: 216, ecPerBlock: 26, g1Blocks: 4, g1Data: 43, g2Blocks: 1, g2Data: 44, alignCenters: [6, 28, 50] },
  { version: 11, totalDataCodewords: 254, ecPerBlock: 30, g1Blocks: 1, g1Data: 50, g2Blocks: 4, g2Data: 51, alignCenters: [6, 30, 54] },
  { version: 12, totalDataCodewords: 290, ecPerBlock: 22, g1Blocks: 6, g1Data: 36, g2Blocks: 2, g2Data: 37, alignCenters: [6, 32, 58] },
  { version: 13, totalDataCodewords: 334, ecPerBlock: 22, g1Blocks: 8, g1Data: 37, g2Blocks: 1, g2Data: 38, alignCenters: [6, 34, 62] },
  { version: 14, totalDataCodewords: 365, ecPerBlock: 24, g1Blocks: 4, g1Data: 40, g2Blocks: 5, g2Data: 41, alignCenters: [6, 26, 46, 66] },
];

// Precomputed BCH(15,5) + mask 0x5412 format strings for ECC Level M (00) and masks 0..7
const FORMAT_INFO_M: number[] = [
  0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0,
];

// Precomputed BCH(18,6) version info bits for Versions 7..14
const VERSION_INFO: Record<number, number> = {
  7: 0x07c94,
  8: 0x085bc,
  9: 0x09a99,
  10: 0x0a4d3,
  11: 0x0bbf6,
  12: 0x0c762,
  13: 0x0d847,
  14: 0x0e60d,
};

// GF(256) with primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11d)
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    const root = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data: number[], ecLen: number): number[] {
  const gen = rsGeneratorPoly(ecLen);
  const rem = new Array<number>(ecLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift()!;
    rem.push(0);
    if (factor !== 0) {
      for (let i = 0; i < ecLen; i++) {
        rem[i] ^= gfMul(gen[i + 1], factor);
      }
    }
  }
  return rem;
}

function toUtf8Bytes(text: string): number[] {
  if (typeof TextEncoder !== "undefined") {
    return Array.from(new TextEncoder().encode(text));
  }
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    out.push(text.charCodeAt(i) & 0xff);
  }
  return out;
}

function selectMaskBit(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0:
      return (r + c) % 2 === 0;
    case 1:
      return r % 2 === 0;
    case 2:
      return c % 3 === 0;
    case 3:
      return (r + c) % 3 === 0;
    case 4:
      return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5:
      return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6:
      return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default:
      return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
}

export interface QrMatrixResult {
  version: number;
  size: number;
  modules: boolean[][];
}

/**
 * Encode any UTF-8/ASCII string (up to 362 bytes) into a standard ISO/IEC 18004 QR Code matrix (ECC Level M).
 */
export function generateQrMatrix(text: string): QrMatrixResult {
  const bytes = toUtf8Bytes(text);
  const spec = QR_M_SPECS.find((s) => {
    const countBits = s.version <= 9 ? 8 : 16;
    const totalBits = 4 + countBits + bytes.length * 8;
    return Math.ceil(totalBits / 8) <= s.totalDataCodewords;
  });
  if (!spec) {
    throw new Error(`QR payload length (${bytes.length} bytes) exceeds supported Version 14 capacity.`);
  }

  // 1. Build bit stream: Mode (0100 = Byte) + Count + Data + Terminator + Pad bytes
  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) {
      bits.push((val >>> i) & 1);
    }
  };
  pushBits(0b0100, 4);
  pushBits(bytes.length, spec.version <= 9 ? 8 : 16);
  for (const b of bytes) pushBits(b, 8);

  const maxDataBits = spec.totalDataCodewords * 8;
  const termLen = Math.min(4, maxDataBits - bits.length);
  for (let i = 0; i < termLen; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const dataCodewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    dataCodewords.push(v);
  }
  const padCycle = [0xec, 0x11];
  let padIdx = 0;
  while (dataCodewords.length < spec.totalDataCodewords) {
    dataCodewords.push(padCycle[padIdx++ % 2]);
  }

  // 2. Split into Reed-Solomon blocks and interleave data + EC codewords
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let cursor = 0;
  for (let i = 0; i < spec.g1Blocks; i++) {
    const blk = dataCodewords.slice(cursor, cursor + spec.g1Data);
    cursor += spec.g1Data;
    dataBlocks.push(blk);
    ecBlocks.push(rsRemainder(blk, spec.ecPerBlock));
  }
  for (let i = 0; i < spec.g2Blocks; i++) {
    const blk = dataCodewords.slice(cursor, cursor + spec.g2Data);
    cursor += spec.g2Data;
    dataBlocks.push(blk);
    ecBlocks.push(rsRemainder(blk, spec.ecPerBlock));
  }

  const maxBlockData = Math.max(spec.g1Data, spec.g2Data);
  const finalCodewords: number[] = [];
  for (let i = 0; i < maxBlockData; i++) {
    for (const blk of dataBlocks) {
      if (i < blk.length) finalCodewords.push(blk[i]);
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const blk of ecBlocks) {
      finalCodewords.push(blk[i]);
    }
  }

  // 3. Allocate matrix & place function patterns
  const size = spec.version * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const isFunc: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

  const setFunc = (r: number, c: number, dark: boolean) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    modules[r][c] = dark;
    isFunc[r][c] = true;
  };

  const drawFinder = (top: number, left: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = top + dr;
        const c = left + dc;
        if (r < 0 || c < 0 || r >= size || c >= size) continue;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const dark =
          inOuter &&
          (dr === 0 ||
            dr === 6 ||
            dc === 0 ||
            dc === 6 ||
            (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        setFunc(r, c, dark);
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setFunc(6, i, i % 2 === 0);
    setFunc(i, 6, i % 2 === 0);
  }

  // Alignment patterns
  for (const cr of spec.alignCenters) {
    for (const cc of spec.alignCenters) {
      if (isFunc[cr][cc]) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc));
          setFunc(cr + dr, cc + dc, dist === 0 || dist === 2);
        }
      }
    }
  }

  // Dark module & reserve format info areas
  setFunc(size - 8, 8, true);
  for (let i = 0; i < 9; i++) {
    if (!isFunc[8][i]) setFunc(8, i, false);
    if (!isFunc[i][8]) setFunc(i, 8, false);
  }
  for (let i = size - 8; i < size; i++) {
    if (!isFunc[8][i]) setFunc(8, i, false);
    if (!isFunc[i][8]) setFunc(i, 8, false);
  }

  // Version info areas (Versions >= 7)
  const verBits = VERSION_INFO[spec.version];
  if (verBits !== undefined) {
    for (let i = 0; i < 18; i++) {
      const dark = ((verBits >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = size - 11 + (i % 3);
      setFunc(a, b, dark);
      setFunc(b, a, dark);
    }
  }

  // 4. Zigzag data placement
  const dataBits: number[] = [];
  for (const cw of finalCodewords) {
    for (let bit = 7; bit >= 0; bit--) dataBits.push((cw >>> bit) & 1);
  }
  let bitIdx = 0;
  let goingUp = true;
  for (let col = size - 1; col >= 1; col -= 2) {
    if (col === 6) col--;
    for (let step = 0; step < size; step++) {
      const r = goingUp ? size - 1 - step : step;
      for (let dc = 0; dc < 2; dc++) {
        const c = col - dc;
        if (!isFunc[r][c]) {
          modules[r][c] = bitIdx < dataBits.length ? dataBits[bitIdx++] === 1 : false;
        }
      }
    }
    goingUp = !goingUp;
  }

  // 5. Evaluate masks 0..7 and select lowest penalty (balance + run-length heuristic)
  const applyFormatInfo = (grid: boolean[][], mask: number) => {
    const fmt = FORMAT_INFO_M[mask];
    for (let i = 0; i <= 5; i++) grid[8][i] = ((fmt >>> (14 - i)) & 1) === 1;
    grid[8][7] = ((fmt >>> 8) & 1) === 1;
    grid[8][8] = ((fmt >>> 7) & 1) === 1;
    grid[7][8] = ((fmt >>> 6) & 1) === 1;
    for (let i = 9; i < 15; i++) grid[14 - i][8] = ((fmt >>> (14 - i)) & 1) === 1;

    for (let i = 0; i < 8; i++) grid[8][size - 1 - i] = ((fmt >>> i) & 1) === 1;
    for (let i = 0; i < 7; i++) grid[size - 1 - i][8] = ((fmt >>> (8 + i)) & 1) === 1;
  };

  let bestMask = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  let bestGrid: boolean[][] = modules;

  for (let mask = 0; mask < 8; mask++) {
    const cand = modules.map((row, r) =>
      row.map((val, c) => (!isFunc[r][c] && selectMaskBit(mask, r, c) ? !val : val))
    );
    applyFormatInfo(cand, mask);

    // Penalty scoring (runs + 2x2 blocks + dark ratio)
    let penalty = 0;
    let darkCount = 0;
    for (let r = 0; r < size; r++) {
      let rowRun = 1;
      let colRun = 1;
      for (let c = 0; c < size; c++) {
        if (cand[r][c]) darkCount++;
        if (c > 0) {
          if (cand[r][c] === cand[r][c - 1]) rowRun++;
          else {
            if (rowRun >= 5) penalty += 3 + (rowRun - 5);
            rowRun = 1;
          }
          if (cand[c][r] === cand[c - 1][r]) colRun++;
          else {
            if (colRun >= 5) penalty += 3 + (colRun - 5);
            colRun = 1;
          }
        }
        if (
          r < size - 1 &&
          c < size - 1 &&
          cand[r][c] === cand[r][c + 1] &&
          cand[r][c] === cand[r + 1][c] &&
          cand[r][c] === cand[r + 1][c + 1]
        ) {
          penalty += 3;
        }
      }
      if (rowRun >= 5) penalty += 3 + (rowRun - 5);
      if (colRun >= 5) penalty += 3 + (colRun - 5);
    }
    const ratioPenalty = Math.floor((Math.abs((darkCount * 100) / (size * size) - 50) / 5)) * 10;
    penalty += ratioPenalty;

    if (penalty < bestScore) {
      bestScore = penalty;
      bestMask = mask;
      bestGrid = cand;
    }
  }
  void bestMask;

  return { version: spec.version, size, modules: bestGrid };
}
