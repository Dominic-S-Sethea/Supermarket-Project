export interface CfdLineSummary {
  lineKey: string;
  name: string;
  packLabel: string;
  qtyPacks: number;
  weightGrams?: number | null;
  unitMode?: "each" | "weight_g" | "volume_ml";
  lineTotalCents: number;
  discountCents: number;
}

export interface CfdActiveQr {
  intentId: string;
  rail: "khqr" | "promptpay" | "paynow" | "card_terminal";
  displayAmount: string;
  currencyCode: string;
  billReference: string;
  qrPayload: string | null;
  status: "pending" | "paid" | "expired" | "failed" | "cancelled";
  externalRef: string | null;
  expiresAt: string;
}

export interface CfdStatePayload {
  storeName: string;
  receiptHeader: string;
  receiptFooter: string;
  registerCode: string;
  cashierName: string;
  primaryCurrency: string;
  secondaryCurrency: string | null;
  secondaryFxRate: number;
  secondaryRoundingStep: number;
  status: "idle" | "ringing" | "awaiting_qr" | "paid";
  lines: CfdLineSummary[];
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  grandTotalCents: number;
  activeQr: CfdActiveQr | null;
  lastReceiptNo: string | null;
  updatedAt: string;
}

export const CFD_CHANNEL_NAME = "supermarket_os_cfd_lane_01";
export const CFD_STORAGE_KEY = "supermarket_os_cfd_state_v1";

export function publishCfdState(state: CfdStatePayload): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(CFD_STORAGE_KEY, JSON.stringify(state));
    }
  } catch {
    // ignore storage quota errors
  }
  try {
    if (typeof BroadcastChannel !== "undefined") {
      const ch = new BroadcastChannel(CFD_CHANNEL_NAME);
      ch.postMessage(state);
      ch.close();
    }
  } catch {
    // ignore BroadcastChannel unavailable
  }
}

export function clearCfdState(): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(CFD_STORAGE_KEY);
    }
  } catch {
    // ignore storage errors
  }
  try {
    if (typeof BroadcastChannel !== "undefined") {
      const ch = new BroadcastChannel(CFD_CHANNEL_NAME);
      ch.postMessage({ __cfdCleared: true });
      ch.close();
    }
  } catch {
    // ignore BroadcastChannel unavailable
  }
}

export function readCfdState(): CfdStatePayload | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(CFD_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CfdStatePayload;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.lines)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function subscribeCfdState(onUpdate: (state: CfdStatePayload | null) => void): () => void {
  let channel: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== "undefined") {
    try {
      channel = new BroadcastChannel(CFD_CHANNEL_NAME);
      channel.onmessage = (ev: MessageEvent) => {
        if (ev.data && typeof ev.data === "object") {
          const msg = ev.data as { __cfdCleared?: boolean } & Partial<CfdStatePayload>;
          if (msg.__cfdCleared === true) {
            onUpdate(null);
            return;
          }
          if (Array.isArray(msg.lines)) {
            onUpdate(ev.data as CfdStatePayload);
          }
        }
      };
    } catch {
      channel = null;
    }
  }

  const handleStorage = (ev: StorageEvent) => {
    if (ev.key !== CFD_STORAGE_KEY) return;
    if (!ev.newValue) {
      onUpdate(null);
      return;
    }
    try {
      const parsed = JSON.parse(ev.newValue) as CfdStatePayload;
      if (parsed && Array.isArray(parsed.lines)) {
        onUpdate(parsed);
      }
    } catch {
      // ignore malformed payload
    }
  };

  if (typeof window !== "undefined") {
    window.addEventListener("storage", handleStorage);
  }

  return () => {
    if (channel) {
      try {
        channel.close();
      } catch {
        // ignore
      }
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", handleStorage);
    }
  };
}
