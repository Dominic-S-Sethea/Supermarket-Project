const DB_NAME = "supermarket_os_pos_cache";
const STORE_NAME = "bootstrap";
const KEY = "latest_v1";

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
    avgCostCents: number;
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
  });
}

export async function loadPosCache(): Promise<PosBootstrapSnapshot | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(KEY);
      req.onsuccess = () => resolve((req.result as PosBootstrapSnapshot) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function savePosCache(snapshot: PosBootstrapSnapshot): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.put(snapshot, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // ignore storage quota / private mode failures
  }
}
