import type { PromotionRule } from "@supermarket/shared/pricing";
import { ApiError } from "../api.ts";

const DB_NAME = "supermarket_os_pos_cache";
const STORE_NAME = "bootstrap";
const KEY = "latest_v1";

export const OFFLINE_QUEUE_KEY = "supermarket_os_offline_pos_queue_v1";
export const DEAD_LETTER_QUEUE_KEY = "supermarket_os_pos_dead_letter_v1";

export interface PosBootstrapSnapshot {
  syncedAt: string;
  products: {
    id: string;
    sku: string;
    name: string;
    brand: string;
    categoryId: string;
    taxRateId: string;
    baseUnitLabel: string;
    avgCostCents?: number;
    requiresAgeCheck: boolean;
  }[];
  barcodes: {
    id: string;
    productId: string;
    barcode: string;
    packQty: number;
    packLabel: string;
    sellPriceCents: number;
    isPrimary: boolean;
  }[];
  taxRates: {
    id: string;
    rateBp: number;
    isInclusive: boolean;
  }[];
  promotions: {
    id: string;
    name: string;
    promoType: "mix_and_match" | "bogo" | "tier_price" | "clearance" | "basket_threshold";
    priority: number;
    combinable: boolean;
    minMarginGuardBp: number | null;
    startsAt?: string | null;
    endsAt?: string | null;
    daypartStartHour?: number | null;
    daypartEndHour?: number | null;
    rulesJson: Record<string, unknown>;
  }[];
  basketRules?: {
    shiftBucket?: string;
    antecedentProductId: string;
    consequentProductId: string;
    consequentName: string;
    confidence: number;
    lift: number;
  }[];
}

export interface QueuedPosSale {
  id: string;
  registerCode: string;
  shiftId?: string | null;
  receiptNo: string;
  kind: "sale";
  soldAt: string;
  cashierName: string;
  ageVerified: boolean;
  customerId?: string | null;
  couponCode?: string | null;
  lines: {
    id: string;
    productId: string;
    scannedBarcode: string;
    packLabel: string;
    packQty: number;
    qtyPacks: number;
    unitPriceCents: number;
    unitCostCents: number;
    discountCents: number;
    taxRateBp: number;
    taxCents: number;
    lineTotalCents: number;
  }[];
  payments: {
    id: string;
    method: "cash" | "card" | "mobile_pay";
    amountCents: number;
    tenderedCents?: number;
    changeCents?: number;
  }[];
}

export interface DeadLetterPosSale {
  sale: QueuedPosSale;
  error: string;
  status: number | null;
  failedAt: string;
}

export function isValidPosSnapshot(value: unknown): value is PosBootstrapSnapshot {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.syncedAt === "string" &&
    Array.isArray(v.products) &&
    Array.isArray(v.barcodes) &&
    Array.isArray(v.taxRates) &&
    Array.isArray(v.promotions)
  );
}

export function mapBootstrapPromotions(
  promotions: PosBootstrapSnapshot["promotions"]
): PromotionRule[] {
  return promotions.map((pr) => ({
    ...(pr.rulesJson as Record<string, unknown>),
    id: pr.id,
    name: pr.name,
    promoType: pr.promoType,
    priority: pr.priority,
    combinable: pr.combinable,
    minMarginGuardBp: pr.minMarginGuardBp,
    startsAt: pr.startsAt ?? null,
    endsAt: pr.endsAt ?? null,
    daypartStartHour: pr.daypartStartHour ?? null,
    daypartEndHour: pr.daypartEndHour ?? null,
  }));
}

export type SaleSyncErrorKind = "permanent" | "auth" | "retryable";

/**
 * Classify a POS sale upload error so the offline queue never silently drops
 * sales on session expiry (401) or transient outages (5xx/network), while
 * quarantining permanent client rejections (400/403/404/409/422) into the dead-letter queue.
 */
export function classifySaleSyncError(err: unknown): SaleSyncErrorKind {
  if (err instanceof ApiError) {
    if (err.status === 401) return "auth";
    if (
      err.status === 400 ||
      err.status === 403 ||
      err.status === 404 ||
      err.status === 409 ||
      err.status === 422
    ) {
      return "permanent";
    }
    return "retryable";
  }
  return "retryable";
}

function isValidQueuedSale(item: unknown): item is QueuedPosSale {
  if (!item || typeof item !== "object") return false;
  const s = item as Record<string, unknown>;
  return (
    typeof s.id === "string" &&
    s.id.length > 0 &&
    typeof s.receiptNo === "string" &&
    s.receiptNo.length > 0 &&
    typeof s.soldAt === "string" &&
    Array.isArray(s.lines) &&
    s.lines.length > 0 &&
    Array.isArray(s.payments) &&
    s.payments.length > 0
  );
}

function isValidDeadLetterSale(item: unknown): item is DeadLetterPosSale {
  if (!item || typeof item !== "object") return false;
  const d = item as Record<string, unknown>;
  return (
    isValidQueuedSale(d.sale) &&
    typeof d.error === "string" &&
    typeof d.failedAt === "string"
  );
}

export function loadOfflineQueue(
  storage: Pick<Storage, "getItem"> | undefined = typeof localStorage !== "undefined"
    ? localStorage
    : undefined
): QueuedPosSale[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(OFFLINE_QUEUE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidQueuedSale);
  } catch {
    return [];
  }
}

export function saveOfflineQueue(
  queue: QueuedPosSale[],
  storage: Pick<Storage, "setItem"> | undefined = typeof localStorage !== "undefined"
    ? localStorage
    : undefined
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
    return true;
  } catch {
    return false;
  }
}

/**
 * Synchronously append a sale to persistent offline storage before React state commits
 * so an immediate 401 unmount cannot lose the receipt.
 */
export function enqueueOfflineSale(
  sale: QueuedPosSale,
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = typeof localStorage !== "undefined"
    ? localStorage
    : undefined
): QueuedPosSale[] {
  const existing = loadOfflineQueue(storage);
  if (existing.some((s) => s.id === sale.id)) {
    return existing;
  }
  const next = [...existing, sale];
  saveOfflineQueue(next, storage);
  return next;
}

export function loadDeadLetterQueue(
  storage: Pick<Storage, "getItem"> | undefined = typeof localStorage !== "undefined"
    ? localStorage
    : undefined
): DeadLetterPosSale[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(DEAD_LETTER_QUEUE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidDeadLetterSale);
  } catch {
    return [];
  }
}

export function saveDeadLetterQueue(
  items: DeadLetterPosSale[],
  storage: Pick<Storage, "setItem"> | undefined = typeof localStorage !== "undefined"
    ? localStorage
    : undefined
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(DEAD_LETTER_QUEUE_KEY, JSON.stringify(items));
    return true;
  } catch {
    return false;
  }
}

export function appendDeadLetterSale(
  entry: DeadLetterPosSale,
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = typeof localStorage !== "undefined"
    ? localStorage
    : undefined
): DeadLetterPosSale[] {
  const existing = loadDeadLetterQueue(storage).filter((d) => d.sale.id !== entry.sale.id);
  const next = [entry, ...existing];
  saveDeadLetterQueue(next, storage);
  return next;
}

export function removeDeadLetterSale(
  saleId: string,
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = typeof localStorage !== "undefined"
    ? localStorage
    : undefined
): DeadLetterPosSale[] {
  const next = loadDeadLetterQueue(storage).filter((d) => d.sale.id !== saleId);
  saveDeadLetterQueue(next, storage);
  return next;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Failed opening POS cache DB"));
    req.onblocked = () => reject(new Error("POS cache DB upgrade blocked"));
  });
}

export async function loadPosCache(): Promise<PosBootstrapSnapshot | null> {
  let db: IDBDatabase | null = null;
  try {
    db = await openDb();
    const openedDb = db;
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (val: PosBootstrapSnapshot | null) => {
        if (!settled) {
          settled = true;
          try {
            openedDb.close();
          } catch {
            // ignore close error
          }
          resolve(val);
        }
      };
      const tx = openedDb.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(KEY);
      req.onsuccess = () => {
        finish(isValidPosSnapshot(req.result) ? req.result : null);
      };
      req.onerror = () => finish(null);
      tx.onabort = () => finish(null);
      tx.onerror = () => finish(null);
    });
  } catch {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
    return null;
  }
}

export async function savePosCache(snapshot: PosBootstrapSnapshot): Promise<boolean> {
  if (!isValidPosSnapshot(snapshot)) return false;
  let db: IDBDatabase | null = null;
  try {
    db = await openDb();
    const openedDb = db;
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (!settled) {
          settled = true;
          try {
            openedDb.close();
          } catch {
            // ignore close error
          }
          resolve(ok);
        }
      };
      const tx = openedDb.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.put(snapshot, KEY);
      tx.oncomplete = () => finish(true);
      tx.onerror = () => finish(false);
      tx.onabort = () => finish(false);
    });
  } catch {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
    return false;
  }
}

export async function clearPosCache(): Promise<void> {
  let db: IDBDatabase | null = null;
  try {
    db = await openDb();
    const openedDb = db;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          try {
            openedDb.close();
          } catch {
            // ignore
          }
          resolve();
        }
      };
      const tx = openedDb.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(KEY);
      tx.oncomplete = finish;
      tx.onerror = finish;
      tx.onabort = finish;
    });
  } catch {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  }
}
