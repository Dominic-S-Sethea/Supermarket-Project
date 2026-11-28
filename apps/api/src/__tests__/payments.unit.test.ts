import {
  generateUuidV7,
  parseEmvQrTlv,
  PaymentWebhookSchema,
  PosSaleUploadSchema,
} from "@supermarket/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeWebhookSignature,
  PaymentConfigError,
  resolvePaymentAdapter,
  type StoreSettingsRow,
  verifyWebhookSignature,
} from "../services/payments.js";

function makeStoreSettings(overrides: Partial<StoreSettingsRow> = {}): StoreSettingsRow {
  return {
    id: generateUuidV7(),
    code: "FLAGSHIP",
    legalName: "SupermarketOS Flagship Co., Ltd.",
    storeName: "SupermarketOS Flagship Market",
    address: "123 Norodom Blvd",
    taxId: "K001-990011223",
    primaryCurrency: "USD",
    secondaryCurrency: "KHR",
    secondaryFxRate: 4100,
    secondaryRoundingStep: 100,
    cashSkimLimitCents: 50_000,
    receiptHeader: "Fresh Daily",
    receiptFooter: "Thank you!",
    defaultQrRail: "khqr",
    paymentProvider: "mock_sandbox",
    khqrAccountId: "flagship@aclb",
    khqrMerchantId: null,
    khqrAcquiringBank: "ABA Bank",
    khqrCity: "Phnom Penh",
    promptpayProxy: "0812345678",
    paynowUen: "202412345A",
    fiscalProvider: "local_hash_chain",
    storeTimezone: "Asia/Phnom_Penh",
    railFxRatesJson: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("Shared schemas & payment security unit checks", () => {
  const originalWebhookSecret = process.env.PAYMENT_WEBHOOK_SECRET;

  afterEach(() => {
    if (originalWebhookSecret === undefined) {
      delete process.env.PAYMENT_WEBHOOK_SECRET;
    } else {
      process.env.PAYMENT_WEBHOOK_SECRET = originalWebhookSecret;
    }
  });

  it("accepts nullable shiftId on POS sales and voids", () => {
    const baseSale = {
      id: generateUuidV7(),
      registerCode: "REG-02",
      shiftId: null,
      receiptNo: "REG-02-0001",
      kind: "sale" as const,
      soldAt: new Date().toISOString(),
      lines: [
        {
          id: generateUuidV7(),
          productId: generateUuidV7(),
          scannedBarcode: "8850000000012",
          packLabel: "Single",
          packQty: 1,
          qtyPacks: 1,
          unitPriceCents: 250,
          discountCents: 0,
          taxRateBp: 0,
          taxCents: 0,
          lineTotalCents: 250,
        },
      ],
      payments: [{ id: generateUuidV7(), method: "cash" as const, amountCents: 250 }],
    };

    expect(PosSaleUploadSchema.safeParse(baseSale).success).toBe(true);
    expect(
      PosSaleUploadSchema.safeParse({
        ...baseSale,
        id: generateUuidV7(),
        receiptNo: "REG-02-VOID-0001",
        kind: "void",
        originalSaleId: baseSale.id,
      }).success
    ).toBe(true);
  });

  it("requires positive amountCents on PaymentWebhookSchema", () => {
    expect(
      PaymentWebhookSchema.safeParse({
        billReference: "REG01-12345678",
        externalRef: "EXT-001",
        status: "paid",
      }).success
    ).toBe(false);

    expect(
      PaymentWebhookSchema.safeParse({
        billReference: "REG01-12345678",
        externalRef: "EXT-001",
        status: "paid",
        amountCents: 250,
      }).success
    ).toBe(true);
  });

  it("fails closed when PAYMENT_WEBHOOK_SECRET is unset and enforces raw-body HMAC + timestamp window", () => {
    const nowMs = 1_700_000_000_000;
    const nowSec = String(Math.floor(nowMs / 1000));
    const rawBody = '{"billReference":"REF-1","externalRef":"EXT-1","status":"paid","amountCents":250}';

    process.env.PAYMENT_WEBHOOK_SECRET = "";
    expect(verifyWebhookSignature(rawBody, "sha256=deadbeef", nowSec, nowMs)).toBe(false);

    const secret = "unit-test-webhook-secret-32chars!!";
    process.env.PAYMENT_WEBHOOK_SECRET = secret;
    const sig = computeWebhookSignature(rawBody, nowSec, secret);

    expect(verifyWebhookSignature(rawBody, `sha256=${sig}`, nowSec, nowMs)).toBe(true);
    expect(verifyWebhookSignature(rawBody, sig, nowSec, nowMs)).toBe(true);

    // Tampering whitespace must fail raw-byte HMAC
    expect(verifyWebhookSignature(` ${rawBody}`, `sha256=${sig}`, nowSec, nowMs)).toBe(false);
    // Missing or malformed timestamp must fail
    expect(verifyWebhookSignature(rawBody, `sha256=${sig}`, undefined, nowMs)).toBe(false);
    expect(verifyWebhookSignature(rawBody, `sha256=${sig}`, "not-a-ts", nowMs)).toBe(false);
    // Replay beyond +/- 300s must fail
    const staleSec = String(Math.floor(nowMs / 1000) - 301);
    const staleSig = computeWebhookSignature(rawBody, staleSec, secret);
    expect(verifyWebhookSignature(rawBody, `sha256=${staleSig}`, staleSec, nowMs)).toBe(false);
  });

  it("guards PromptPay/PayNow against missing currency/FX config and converts secondary FX accurately", async () => {
    const defaultSettings = makeStoreSettings();
    const ppAdapter = resolvePaymentAdapter("promptpay", "mock_sandbox");
    const pnAdapter = resolvePaymentAdapter("paynow", "mock_sandbox");
    const khqrAdapter = resolvePaymentAdapter("khqr", "mock_sandbox");
    const baseInput = {
      amountCents: 1000, // $10.00 primary
      billReference: "REG01-FX01",
      registerCode: "REG-01",
      expiresAtMs: Date.now() + 300_000,
    };

    await expect(
      ppAdapter.createIntent({ rail: "promptpay", ...baseInput }, defaultSettings)
    ).rejects.toThrow(PaymentConfigError);

    await expect(
      pnAdapter.createIntent({ rail: "paynow", ...baseInput }, defaultSettings)
    ).rejects.toThrow(PaymentConfigError);

    // Secondary THB at 35 -> $10.00 = 350.00 THB
    const ppIntent = await ppAdapter.createIntent(
      { rail: "promptpay", ...baseInput },
      makeStoreSettings({ secondaryCurrency: "THB", secondaryFxRate: 35, secondaryRoundingStep: 1 })
    );
    expect(ppIntent.currencyCode).toBe("THB");
    const parsedPp = parseEmvQrTlv(ppIntent.qrPayload!);
    expect(parsedPp.valid).toBe(true);
    expect(parsedPp.rail).toBe("promptpay");
    expect(parsedPp.amount).toBe("350.00");

    // Primary SGD uses amountCents directly
    const pnIntent = await pnAdapter.createIntent(
      { rail: "paynow", ...baseInput, amountCents: 1850 },
      makeStoreSettings({ primaryCurrency: "SGD", secondaryCurrency: "USD", secondaryFxRate: 0.74 })
    );
    expect(pnIntent.currencyCode).toBe("SGD");
    const parsedPn = parseEmvQrTlv(pnIntent.qrPayload!);
    expect(parsedPn.valid).toBe(true);
    expect(parsedPn.rail).toBe("paynow");
    expect(parsedPn.amount).toBe("18.50");

    // KHQR KHR converts USD cents via secondaryFxRate & rounding step
    const khqrKhr = await khqrAdapter.createIntent(
      { rail: "khqr", currencyCode: "KHR", ...baseInput },
      defaultSettings
    );
    expect(khqrKhr.currencyCode).toBe("KHR");
    const parsedKhqr = parseEmvQrTlv(khqrKhr.qrPayload!);
    expect(parsedKhqr.valid).toBe(true);
    expect(parsedKhqr.amount).toBe("41000");

    // Multi-rail FX map allows PromptPay (THB) & PayNow (SGD) on default USD/KHR flagship store
    const multiFxSettings = makeStoreSettings({
      railFxRatesJson: { THB: 35, SGD: 1.35 },
    });
    const multiPp = await ppAdapter.createIntent({ rail: "promptpay", ...baseInput }, multiFxSettings);
    const parsedMultiPp = parseEmvQrTlv(multiPp.qrPayload!);
    expect(parsedMultiPp.valid).toBe(true);
    expect(parsedMultiPp.currencyNumeric).toBe("764");
    expect(parsedMultiPp.amount).toBe("350.00");
    expect(multiPp.displayAmount).toBe("฿350.00");
    expect(multiPp.fxRateUsed).toBe(35);
    expect(multiPp.foreignAmount).toBe(35000);

    const multiPn = await pnAdapter.createIntent({ rail: "paynow", ...baseInput }, multiFxSettings);
    const parsedMultiPn = parseEmvQrTlv(multiPn.qrPayload!);
    expect(parsedMultiPn.valid).toBe(true);
    expect(parsedMultiPn.currencyNumeric).toBe("702");
    expect(parsedMultiPn.amount).toBe("13.50");
    expect(multiPn.displayAmount).toBe("S$13.50");
    expect(multiPn.fxRateUsed).toBe(1.35);
    expect(multiPn.foreignAmount).toBe(1350);
  });
});
