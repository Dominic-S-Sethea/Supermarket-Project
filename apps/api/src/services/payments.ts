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
import { db, storeSettings } from "../db/index.js";

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
}

export interface PaymentProviderAdapter {
  readonly provider: PaymentProviderKind;
  createIntent(
    input: AdapterCreateIntentInput,
    settings: StoreSettingsRow
  ): Promise<AdapterCreateIntentResult>;
}

function buildRailQr(
  input: AdapterCreateIntentInput,
  settings: StoreSettingsRow
): { currencyCode: string; displayAmount: string; qrPayload: string | null } {
  const nowMs = Date.now();
  if (input.rail === "card_terminal") {
    const currencyCode = (input.currencyCode ?? settings.primaryCurrency ?? "USD").toUpperCase();
    return {
      currencyCode,
      displayAmount: formatCurrency(input.amountCents, currencyCode),
      qrPayload: null,
    };
  }

  if (input.rail === "khqr") {
    const targetCurrency: "USD" | "KHR" =
      (input.currencyCode ?? settings.primaryCurrency).toUpperCase() === "KHR" ? "KHR" : "USD";
    const amountMinor =
      targetCurrency === "KHR"
        ? convertToSecondaryCurrency(
            input.amountCents,
            settings.secondaryFxRate,
            settings.secondaryRoundingStep
          )
        : input.amountCents;
    const built = buildKhqrPayload({
      accountId: settings.khqrAccountId,
      merchantId: settings.khqrMerchantId ?? undefined,
      acquiringBank: settings.khqrAcquiringBank,
      merchantName: settings.storeName,
      merchantCity: settings.khqrCity,
      currencyCode: targetCurrency,
      amountMinorUnits: amountMinor,
      billReference: input.billReference,
      terminalLabel: input.registerCode,
      createdAtMs: nowMs,
      expiresAtMs: input.expiresAtMs,
    });
    return {
      currencyCode: built.currencyCode,
      displayAmount: formatCurrency(amountMinor, built.currencyCode),
      qrPayload: built.payload,
    };
  }

  if (input.rail === "promptpay") {
    const built = buildPromptPayPayload({
      proxy: settings.promptpayProxy,
      merchantName: settings.storeName,
      merchantCity: "Bangkok",
      amountMinorUnits: input.amountCents,
      billReference: input.billReference,
    });
    return {
      currencyCode: built.currencyCode,
      displayAmount: formatCurrency(input.amountCents, built.currencyCode),
      qrPayload: built.payload,
    };
  }

  // PayNow (Singapore ABS)
  const expiryDateYyyymmdd = new Date(input.expiresAtMs)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "");
  const built = buildPayNowPayload({
    proxy: settings.paynowUen,
    proxyType: "uen",
    merchantName: settings.storeName,
    merchantCity: "Singapore",
    amountMinorUnits: input.amountCents,
    billReference: input.billReference,
    expiryDateYyyymmdd,
  });
  return {
    currencyCode: built.currencyCode,
    displayAmount: formatCurrency(input.amountCents, built.currencyCode),
    qrPayload: built.payload,
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

export function verifyWebhookSignature(rawBody: string, headerSig: string | undefined): boolean {
  const secret = process.env.PAYMENT_WEBHOOK_SECRET?.trim();
  if (!secret) {
    // Allow local dev / test sandbox webhook verification when no live HMAC secret is configured
    return true;
  }
  if (!headerSig) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const cleanHeader = headerSig.replace(/^sha256=/i, "").trim();
  if (cleanHeader.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(cleanHeader, "utf8"), Buffer.from(expected, "utf8"));
}
