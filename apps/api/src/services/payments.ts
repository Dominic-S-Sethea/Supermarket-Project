import crypto from "node:crypto";
import {
  buildKhqrPayload,
  buildPayNowPayload,
  buildPromptPayPayload,
  convertToSecondaryCurrency,
  formatCurrency,
  type PaymentProviderKind,
} from "@supermarket/shared";
import { eq } from "drizzle-orm";
import { env } from "../config/env.js";
import { db, storeSettings } from "../db/index.js";

export class PaymentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentConfigError";
  }
}

export const WEBHOOK_TIMESTAMP_TOLERANCE_SEC = 300;

export type StoreSettingsRow = typeof storeSettings.$inferSelect;

export async function getOrCreateStoreSettings(): Promise<StoreSettingsRow> {
  const [existing] = await db
    .select()
    .from(storeSettings)
    .where(eq(storeSettings.code, "FLAGSHIP"))
    .limit(1);
  if (existing) return existing;

  await db
    .insert(storeSettings)
    .values({ code: "FLAGSHIP" })
    .onConflictDoNothing({ target: storeSettings.code });

  const [created] = await db
    .select()
    .from(storeSettings)
    .where(eq(storeSettings.code, "FLAGSHIP"))
    .limit(1);
  return created;
}

export interface AdapterCreateIntentInput {
  rail: "khqr" | "promptpay" | "paynow" | "card_terminal";
  amountCents: number;
  currencyCode?: string;
  billReference: string;
  registerCode: string;
  expiresAtMs: number;
}

export interface AdapterCreateIntentResult {
  provider: PaymentProviderKind;
  currencyCode: string;
  displayAmount: string;
  qrPayload: string | null;
  externalRef: string | null;
  foreignAmount?: number | null;
  fxRateUsed?: number | null;
}

export interface PaymentProviderAdapter {
  readonly provider: PaymentProviderKind;
  createIntent(
    input: AdapterCreateIntentInput,
    settings: StoreSettingsRow
  ): Promise<AdapterCreateIntentResult>;
}

export function resolveRailAmountMinorUnits(
  amountCents: number,
  targetCurrency: "USD" | "KHR" | "THB" | "SGD",
  settings: StoreSettingsRow
): { amountMinor: number; fxRateUsed: number | null; foreignAmount: number | null } {
  const primary = (settings.primaryCurrency || "USD").toUpperCase();
  const secondary = (settings.secondaryCurrency || "").toUpperCase();
  if (primary === targetCurrency) {
    return { amountMinor: amountCents, fxRateUsed: null, foreignAmount: null };
  }
  const isZeroDecimal = targetCurrency === "KHR";
  const step = isZeroDecimal ? settings.secondaryRoundingStep : 1;
  if (secondary === targetCurrency && settings.secondaryFxRate > 0) {
    const amountMinor = convertToSecondaryCurrency(
      amountCents,
      settings.secondaryFxRate,
      step,
      isZeroDecimal
    );
    return { amountMinor, fxRateUsed: settings.secondaryFxRate, foreignAmount: amountMinor };
  }
  const railRates = settings.railFxRatesJson as Record<string, unknown> | null | undefined;
  const railRate = railRates && typeof railRates === "object" ? railRates[targetCurrency] : undefined;
  if (typeof railRate === "number" && Number.isFinite(railRate) && railRate > 0) {
    const amountMinor = convertToSecondaryCurrency(amountCents, railRate, step, isZeroDecimal);
    return { amountMinor, fxRateUsed: railRate, foreignAmount: amountMinor };
  }
  throw new PaymentConfigError(
    `${targetCurrency} payment rail requires store primaryCurrency, secondaryCurrency, or railFxRatesJson.${targetCurrency} to be configured with a positive FX rate (current store currencies: ${primary}/${secondary || "none"}).`
  );
}

function buildRailQr(
  input: AdapterCreateIntentInput,
  settings: StoreSettingsRow
): {
  currencyCode: string;
  displayAmount: string;
  qrPayload: string | null;
  foreignAmount: number | null;
  fxRateUsed: number | null;
} {
  const nowMs = Date.now();
  if (input.rail === "card_terminal") {
    const currencyCode = (input.currencyCode ?? settings.primaryCurrency ?? "USD").toUpperCase();
    return {
      currencyCode,
      displayAmount: formatCurrency(input.amountCents, currencyCode),
      qrPayload: null,
      foreignAmount: null,
      fxRateUsed: null,
    };
  }

  if (input.rail === "khqr") {
    const targetCurrency: "USD" | "KHR" =
      (input.currencyCode ?? settings.primaryCurrency).toUpperCase() === "KHR" ? "KHR" : "USD";
    const resolved = resolveRailAmountMinorUnits(input.amountCents, targetCurrency, settings);
    const built = buildKhqrPayload({
      accountId: settings.khqrAccountId,
      merchantId: settings.khqrMerchantId ?? undefined,
      acquiringBank: settings.khqrAcquiringBank,
      merchantName: settings.storeName,
      merchantCity: settings.khqrCity,
      currencyCode: targetCurrency,
      amountMinorUnits: resolved.amountMinor,
      billReference: input.billReference,
      terminalLabel: input.registerCode,
      createdAtMs: nowMs,
      expiresAtMs: input.expiresAtMs,
    });
    return {
      currencyCode: built.currencyCode,
      displayAmount: formatCurrency(resolved.amountMinor, built.currencyCode),
      qrPayload: built.payload,
      foreignAmount: resolved.foreignAmount,
      fxRateUsed: resolved.fxRateUsed,
    };
  }

  if (input.rail === "promptpay") {
    const resolved = resolveRailAmountMinorUnits(input.amountCents, "THB", settings);
    const built = buildPromptPayPayload({
      proxy: settings.promptpayProxy,
      merchantName: settings.storeName,
      merchantCity: "Bangkok",
      amountMinorUnits: resolved.amountMinor,
      billReference: input.billReference,
    });
    return {
      currencyCode: built.currencyCode,
      displayAmount: formatCurrency(resolved.amountMinor, built.currencyCode),
      qrPayload: built.payload,
      foreignAmount: resolved.foreignAmount,
      fxRateUsed: resolved.fxRateUsed,
    };
  }

  // PayNow (Singapore ABS)
  const resolved = resolveRailAmountMinorUnits(input.amountCents, "SGD", settings);
  const expiryDateYyyymmdd = new Date(input.expiresAtMs)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "");
  const built = buildPayNowPayload({
    proxy: settings.paynowUen,
    proxyType: "uen",
    merchantName: settings.storeName,
    merchantCity: "Singapore",
    amountMinorUnits: resolved.amountMinor,
    billReference: input.billReference,
    expiryDateYyyymmdd,
  });
  return {
    currencyCode: built.currencyCode,
    displayAmount: formatCurrency(resolved.amountMinor, built.currencyCode),
    qrPayload: built.payload,
    foreignAmount: resolved.foreignAmount,
    fxRateUsed: resolved.fxRateUsed,
  };
}

class EmvQrPaymentAdapter implements PaymentProviderAdapter {
  readonly provider: PaymentProviderKind;

  constructor(provider: PaymentProviderKind) {
    this.provider = provider;
  }

  async createIntent(
    input: AdapterCreateIntentInput,
    settings: StoreSettingsRow
  ): Promise<AdapterCreateIntentResult> {
    const built = buildRailQr(input, settings);
    return {
      provider: this.provider,
      currencyCode: built.currencyCode,
      displayAmount: built.displayAmount,
      qrPayload: built.qrPayload,
      externalRef: null,
      foreignAmount: built.foreignAmount,
      fxRateUsed: built.fxRateUsed,
    };
  }
}

export function resolvePaymentAdapter(
  rail: AdapterCreateIntentInput["rail"],
  configuredProvider: string
): PaymentProviderAdapter {
  const validProviders: PaymentProviderKind[] = [
    "mock_sandbox",
    "bakong_khqr",
    "promptpay_gateway",
    "paynow_gateway",
    "stripe_terminal",
  ];
  const provider: PaymentProviderKind = validProviders.includes(
    configuredProvider as PaymentProviderKind
  )
    ? (configuredProvider as PaymentProviderKind)
    : rail === "card_terminal"
      ? "stripe_terminal"
      : "mock_sandbox";

  return new EmvQrPaymentAdapter(provider);
}

export function generateExternalSettlementRef(
  rail: "khqr" | "promptpay" | "paynow" | "card_terminal"
): string {
  const prefix =
    rail === "khqr"
      ? "BAKONG"
      : rail === "promptpay"
        ? "PROMPTPAY"
        : rail === "paynow"
          ? "PAYNOW"
          : "TERM";
  const rand = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${rand}`;
}

/**
 * Compute an HMAC-SHA256 webhook signature over "${timestampSec}.${rawBody}".
 */
export function computeWebhookSignature(
  rawBody: string,
  timestampSec: string,
  secret: string
): string {
  return crypto.createHmac("sha256", secret).update(`${timestampSec}.${rawBody}`).digest("hex");
}

/**
 * Fail-closed HMAC-SHA256 webhook verifier with replay window protection.
 */
export function verifyWebhookSignature(
  rawBody: string,
  headerSig: string | undefined,
  headerTimestamp: string | undefined,
  nowMs = Date.now()
): boolean {
  const secret = (
    process.env.PAYMENT_WEBHOOK_SECRET !== undefined
      ? process.env.PAYMENT_WEBHOOK_SECRET
      : (env.paymentWebhookSecret ?? "")
  ).trim();
  if (!secret || !headerSig || !headerTimestamp) {
    return false;
  }
  const ts = headerTimestamp.trim();
  if (!/^\d{9,12}$/.test(ts)) {
    return false;
  }
  const tsSec = Number(ts);
  const nowSec = Math.floor(nowMs / 1000);
  if (!Number.isFinite(tsSec) || Math.abs(nowSec - tsSec) > WEBHOOK_TIMESTAMP_TOLERANCE_SEC) {
    return false;
  }
  const expected = computeWebhookSignature(rawBody, ts, secret);
  const cleanHeader = headerSig.replace(/^sha256=/i, "").trim();
  if (cleanHeader.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(cleanHeader, "utf8"), Buffer.from(expected, "utf8"));
}
