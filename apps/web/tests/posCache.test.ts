import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ApiError,
  apiGet,
  formatApiErrorPayload,
  setUnauthorizedHandler,
} from "../src/api.ts";
import {
  appendDeadLetterSale,
  classifySaleSyncError,
  clearPosCache,
  DEAD_LETTER_QUEUE_KEY,
  enqueueOfflineSale,
  isValidPosSnapshot,
  loadDeadLetterQueue,
  loadOfflineQueue,
  loadPosCache,
  mapBootstrapPromotions,
  OFFLINE_QUEUE_KEY,
  removeDeadLetterSale,
  saveOfflineQueue,
  savePosCache,
  type PosBootstrapSnapshot,
  type QueuedPosSale,
} from "../src/lib/posCache.ts";

describe("web API error handling and session expiry", () => {
  it("formats string errors, Zod flattened field errors, and plain text fallbacks", () => {
    assert.equal(
      formatApiErrorPayload(JSON.stringify({ error: "Insufficient permissions" }), 403, "POST", "/api/pos/sales"),
      "Insufficient permissions"
    );

    const zodBody = JSON.stringify({
      error: {
        formErrors: ["At least one case required"],
        fieldErrors: {
          invoiceNumber: ["String must contain at least 1 character(s)"],
          supplierId: ["Invalid uuid"],
        },
      },
    });
    const formatted = formatApiErrorPayload(zodBody, 400, "POST", "/api/purchasing/grn");
    assert.match(formatted, /At least one case required/);
    assert.match(formatted, /invoiceNumber:/);
    assert.match(formatted, /supplierId:/);

    assert.equal(
      formatApiErrorPayload("Bad Gateway", 502, "GET", "/api/meta"),
      "GET /api/meta failed (502): Bad Gateway"
    );
  });

  it("triggers unauthorized callback on 401 for protected routes but ignores /api/auth/me", async () => {
    const origFetch = globalThis.fetch;
    let unauthorizedCount = 0;
    setUnauthorizedHandler(() => {
      unauthorizedCount += 1;
    });

    try {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ error: "Authentication required" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });

      await assert.rejects(
        () => apiGet("/api/auth/me"),
        (err: unknown) => err instanceof ApiError && err.status === 401
      );
      assert.equal(unauthorizedCount, 0);

      await assert.rejects(
        () => apiGet("/api/analytics/overview"),
        (err: unknown) => err instanceof ApiError && err.status === 401
      );
      assert.equal(unauthorizedCount, 1);
    } finally {
      setUnauthorizedHandler(null);
      globalThis.fetch = origFetch;
    }
  });
});

describe("POS offline queue and sync classification", () => {
  const sampleSale: QueuedPosSale = {
    id: "01950000-0000-7000-8000-000000000010",
    registerCode: "REG-01",
    receiptNo: "REG-01-00000010",
    kind: "sale",
    soldAt: "2026-11-25T10:00:00.000Z",
    cashierName: "Elena Morales",
    ageVerified: false,
    lines: [
      {
        id: "01950000-0000-7000-8000-000000000011",
        productId: "01950000-0000-7000-8000-000000000012",
        scannedBarcode: "8850000000012",
        packLabel: "Single",
        packQty: 1,
        qtyPacks: 1,
        unitPriceCents: 250,
        unitCostCents: 120,
        discountCents: 0,
        taxRateBp: 1000,
        taxCents: 23,
        lineTotalCents: 250,
      },
    ],
    payments: [
      {
        id: "01950000-0000-7000-8000-000000000013",
        method: "cash",
        amountCents: 250,
        tenderedCents: 250,
        changeCents: 0,
      },
    ],
  };

  it("classifies 4xx validation/RBAC errors as permanent, 401 as auth, and 5xx/network as retryable", () => {
    assert.equal(
      classifySaleSyncError(new ApiError("Age verification required", 400, "POST", "/api/pos/sales")),
      "permanent"
    );
    assert.equal(
      classifySaleSyncError(new ApiError("Forbidden", 403, "POST", "/api/pos/sales")),
      "permanent"
    );
    assert.equal(
      classifySaleSyncError(new ApiError("Duplicate receipt", 409, "POST", "/api/pos/sales")),
      "permanent"
    );
    assert.equal(
      classifySaleSyncError(new ApiError("Session expired", 401, "POST", "/api/pos/sales")),
      "auth"
    );
    assert.equal(
      classifySaleSyncError(new ApiError("Service Unavailable", 503, "POST", "/api/pos/sales")),
      "retryable"
    );
    assert.equal(classifySaleSyncError(new TypeError("Failed to fetch")), "retryable");
  });

  it("loads and saves offline sales resiliently across corruption and quota errors", () => {
    const store = new Map<string, string>();
    const mockStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    };

    assert.equal(saveOfflineQueue([sampleSale], mockStorage), true);
    const loaded = loadOfflineQueue(mockStorage);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].receiptNo, sampleSale.receiptNo);

    // Mix valid entry with corrupt entry -> corrupt entry dropped, valid preserved
    store.set(OFFLINE_QUEUE_KEY, JSON.stringify([sampleSale, { id: "bad", lines: [] }, null]));
    assert.equal(loadOfflineQueue(mockStorage).length, 1);

    // Broken JSON -> safe empty array
    store.set(OFFLINE_QUEUE_KEY, "{not-json");
    assert.deepEqual(loadOfflineQueue(mockStorage), []);

    // QuotaExceededError on write -> returns false without throwing
    const throwingStorage = {
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    assert.equal(saveOfflineQueue([sampleSale], throwingStorage), false);
  });

  it("preserves optional loyalty customerId and couponCode across offline queue round-trips", () => {
    const store = new Map<string, string>();
    const mockStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    };
    const loyaltySale: QueuedPosSale = {
      ...sampleSale,
      customerId: "11111111-1111-4111-8111-111111111111",
      couponCode: "SAVE5-ABC123",
    };
    assert.equal(saveOfflineQueue([loyaltySale], mockStorage), true);
    const [loaded] = loadOfflineQueue(mockStorage);
    assert.equal(loaded.customerId, loyaltySale.customerId);
    assert.equal(loaded.couponCode, "SAVE5-ABC123");
  });

  it("synchronously persists enqueued sales without duplicates and manages persistent dead-letter quarantine", () => {
    const store = new Map<string, string>();
    const mockStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    };

    const q1 = enqueueOfflineSale(sampleSale, mockStorage);
    assert.equal(q1.length, 1);
    // Synchronous persistence already written to storage before any async React effect
    assert.equal(loadOfflineQueue(mockStorage).length, 1);
    // Re-enqueuing same UUIDv7 sale ID is idempotent
    const q2 = enqueueOfflineSale(sampleSale, mockStorage);
    assert.equal(q2.length, 1);

    const dlq1 = appendDeadLetterSale(
      {
        sale: sampleSale,
        error: "Coupon already redeemed",
        status: 409,
        failedAt: "2026-11-25T10:05:00.000Z",
      },
      mockStorage
    );
    assert.equal(dlq1.length, 1);
    assert.equal(loadDeadLetterQueue(mockStorage)[0].status, 409);

    // Corrupt dead-letter entries are filtered cleanly
    store.set(DEAD_LETTER_QUEUE_KEY, JSON.stringify([dlq1[0], { bad: true }]));
    assert.equal(loadDeadLetterQueue(mockStorage).length, 1);

    const dlqAfterRemove = removeDeadLetterSale(sampleSale.id, mockStorage);
    assert.equal(dlqAfterRemove.length, 0);
    assert.equal(loadDeadLetterQueue(mockStorage).length, 0);
  });
});

describe("POS IndexedDB snapshot validation and promotion mapping", () => {
  const sampleSnapshot: PosBootstrapSnapshot = {
    syncedAt: "2026-11-25T10:00:00.000Z",
    products: [],
    barcodes: [],
    taxRates: [],
    promotions: [
      {
        id: "promo-1",
        name: "Morning Combo",
        promoType: "mix_and_match",
        priority: 10,
        combinable: false,
        minMarginGuardBp: 1200,
        startsAt: "2026-11-01T00:00:00.000Z",
        endsAt: "2026-12-01T00:00:00.000Z",
        daypartStartHour: 8,
        daypartEndHour: 12,
        rulesJson: {
          id: "spoofed-id-must-not-override",
          requiredQty: 2,
          bundlePriceCents: 350,
        },
      },
    ],
  };

  it("validates snapshot shape and maps promotion date/daypart windows without rule override", () => {
    assert.equal(isValidPosSnapshot(sampleSnapshot), true);
    assert.equal(isValidPosSnapshot(null), false);
    assert.equal(isValidPosSnapshot({ syncedAt: "now", products: "bad" }), false);

    const mapped = mapBootstrapPromotions(sampleSnapshot.promotions);
    assert.equal(mapped.length, 1);
    assert.equal(mapped[0].id, "promo-1");
    assert.equal(mapped[0].startsAt, "2026-11-01T00:00:00.000Z");
    assert.equal(mapped[0].endsAt, "2026-12-01T00:00:00.000Z");
    assert.equal(mapped[0].daypartStartHour, 8);
    assert.equal(mapped[0].daypartEndHour, 12);
    assert.equal(mapped[0].requiredQty, 2);
    assert.equal(mapped[0].bundlePriceCents, 350);
  });

  it("falls back safely when IndexedDB is unavailable and closes DB handles when mocked", async () => {
    // In Node without global indexedDB, load/save return null/false cleanly
    assert.equal(await loadPosCache(), null);
    assert.equal(await savePosCache(sampleSnapshot), false);

    // Mock minimal IndexedDB to verify round-trip + db.close() + clearPosCache()
    const kv = new Map<string, unknown>();
    let closeCalls = 0;

    const fakeIndexedDb = {
      open: () => {
        const req: Record<string, unknown> = {};
        const db = {
          objectStoreNames: { contains: () => true },
          close: () => {
            closeCalls += 1;
          },
          transaction: () => {
            const tx: Record<string, unknown> = {};
            tx.objectStore = () => ({
              get: (k: string) => {
                const getReq: Record<string, unknown> = {};
                queueMicrotask(() => {
                  getReq.result = kv.get(k);
                  (getReq.onsuccess as (() => void) | undefined)?.();
                });
                return getReq;
              },
              put: (val: unknown, k: string) => {
                kv.set(k, val);
                queueMicrotask(() => {
                  (tx.oncomplete as (() => void) | undefined)?.();
                });
              },
              delete: (k: string) => {
                kv.delete(k);
                queueMicrotask(() => {
                  (tx.oncomplete as (() => void) | undefined)?.();
                });
              },
            });
            return tx;
          },
        };
        queueMicrotask(() => {
          req.result = db;
          (req.onsuccess as (() => void) | undefined)?.();
        });
        return req;
      },
    };

    const g = globalThis as unknown as { indexedDB?: unknown };
    const prevIdb = g.indexedDB;
    g.indexedDB = fakeIndexedDb;
    try {
      assert.equal(await savePosCache(sampleSnapshot), true);
      const cached = await loadPosCache();
      assert.ok(cached);
      assert.equal(cached.syncedAt, sampleSnapshot.syncedAt);
      await clearPosCache();
      assert.equal(await loadPosCache(), null);
      assert.equal(closeCalls, 4);
    } finally {
      g.indexedDB = prevIdb;
    }
  });
});
