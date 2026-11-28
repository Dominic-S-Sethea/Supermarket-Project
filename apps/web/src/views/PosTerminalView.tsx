import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { normalizePluCode, parseScaleBarcode } from "@supermarket/shared/barcodes";
import type { ParkedBasketDto, StoreSettingsDto, UnitMode, UserRole } from "@supermarket/shared/dtos";
import {
  computeWeightedPriceCents,
  convertToSecondaryCurrency,
  deriveWeightFromPriceGrams,
  formatCurrency,
  formatMeasure,
  formatMoney,
  generateUuidV7,
} from "@supermarket/shared/money";
import { evaluateCart, type CartInputLine, type PromotionRule } from "@supermarket/shared/pricing";
import { CheckCircle2, RefreshCw } from "lucide-react";
import { ApiError, apiDelete, apiGet, apiPost } from "../api";
import { PosCartPanel } from "../components/PosCartPanel";
import { PosCheckoutModal, type CheckoutTab } from "../components/PosCheckoutModal";
import { PosFreshPluModal, type FreshPluItem } from "../components/PosFreshPluModal";
import { PosHeaderBar } from "../components/PosHeaderBar";
import {
  mapServerParkedBasket,
  PosParkedBasketsModal,
  PosSupervisorOverrideModal,
  type LocalOrServerParkedBasket,
  type SupervisorOverrideResult,
} from "../components/PosHoldAndOverrideModals";
import { type AppliedCoupon, type PosCustomer } from "../components/PosLoyaltyCard";
import {
  AgeVerificationModal,
  DeadLetterModal,
  OpenShiftModal,
  RecentReceiptsModal,
  ShiftCloseModal,
  type ActiveShiftInfo,
  type RecentSaleRow,
  type ZReportSummary,
} from "../components/PosModals";
import { PosScanBar } from "../components/PosScanBar";
import { clearCfdState, publishCfdState, type CfdActiveQr } from "../lib/cfdChannel";
import {
  appendDeadLetterSaleResult,
  classifySaleSyncError,
  DEAD_LETTER_QUEUE_KEY,
  enqueueOfflineSaleResult,
  loadDeadLetterQueue,
  loadLocalParkedBaskets,
  loadOfflineQueue,
  loadPosCache,
  mapBootstrapPromotions,
  OFFLINE_QUEUE_KEY,
  rebuildSaleWithoutCoupon,
  removeDeadLetterSale,
  removeOfflineSalesByIds,
  saveLocalParkedBaskets,
  savePosCache,
  withOfflineQueueLock,
  type DeadLetterPosSale,
  type PosBootstrapSnapshot,
  type QueuedPosPayment,
  type QueuedPosSale,
} from "../lib/posCache";

type BootstrapProduct = PosBootstrapSnapshot["products"][number];
type BootstrapBarcode = PosBootstrapSnapshot["barcodes"][number];
type BootstrapTax = PosBootstrapSnapshot["taxRates"][number];
type BasketRule = NonNullable<PosBootstrapSnapshot["basketRules"]>[number];

export function PosTerminalView({
  cashierUserId,
  cashierName = "Elena Morales",
  userRole = "owner",
  isActive = true,
  catalogRefreshTick = 0,
}: {
  cashierUserId?: string;
  cashierName?: string;
  userRole?: UserRole;
  isActive?: boolean;
  catalogRefreshTick?: number;
}) {
  const canVoidOrRefund = userRole === "owner" || userRole === "manager";
  const [productsMap, setProductsMap] = useState<Map<string, BootstrapProduct>>(new Map());
  const [barcodesMap, setBarcodesMap] = useState<Map<string, BootstrapBarcode>>(new Map());
  const [pluMap, setPluMap] = useState<Map<string, BootstrapProduct>>(new Map());
  const [freshPluItems, setFreshPluItems] = useState<FreshPluItem[]>([]);
  const [primaryByProductMap, setPrimaryByProductMap] = useState<Map<string, BootstrapBarcode>>(
    new Map()
  );
  const [taxMap, setTaxMap] = useState<Map<string, BootstrapTax>>(new Map());
  const [promos, setPromos] = useState<PromotionRule[]>([]);
  const [basketRules, setBasketRules] = useState<BasketRule[]>([]);
  const [quickItems, setQuickItems] = useState<
    { barcode: string; name: string; packLabel: string; packQty: number; priceCents: number; badge: string }[]
  >([]);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [cacheSource, setCacheSource] = useState<"live" | "indexeddb" | null>(null);
  const [bootstrapLoading, setBootstrapLoading] = useState(true);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [simulatedOffline, setSimulatedOffline] = useState(false);

  const [scanError, setScanError] = useState<string | null>(null);
  const [cart, setCart] = useState<CartInputLine[]>([]);
  const [ageVerified, setAgeVerified] = useState(false);
  const [pendingAgeItem, setPendingAgeItem] = useState<
    | { kind: "barcode"; bc: BootstrapBarcode }
    | {
        kind: "weighted";
        prod: BootstrapProduct;
        primBc: BootstrapBarcode;
        scannedBarcode: string;
        netGrams: number;
        tareGrams: number;
        embeddedPriceCents: number | null;
      }
    | {
        kind: "recalled";
        lines: CartInputLine[];
        holdCode: string;
      }
    | null
  >(null);
  const [showFreshPluModal, setShowFreshPluModal] = useState(false);
  const [freshPluInitialProductId, setFreshPluInitialProductId] = useState<string | null>(null);
  const [receiptPreview, setReceiptPreview] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [submittingSale, setSubmittingSale] = useState(false);
  const [submittingMethod, setSubmittingMethod] = useState<"cash" | "card" | "modal" | null>(null);
  const [syncingQueue, setSyncingQueue] = useState(false);
  const [daypartPreview, setDaypartPreview] = useState<"live" | "morning" | "evening">("live");
  const [clockNow, setClockNow] = useState<Date>(() => new Date());
  const [removedUndoLine, setRemovedUndoLine] = useState<CartInputLine | null>(null);

  // Active Register Shift (hydrated from GET /api/pos/shifts/active — H-17)
  const [activeShift, setActiveShift] = useState<ActiveShiftInfo | null>(null);

  // Loyalty Customer & Single-Use Coupon
  const [customerLookupInput, setCustomerLookupInput] = useState("");
  const [customerResults, setCustomerResults] = useState<PosCustomer[]>([]);
  const [attachedCustomer, setAttachedCustomer] = useState<PosCustomer | null>(null);
  const [couponInput, setCouponInput] = useState("");
  const [appliedCoupon, setAppliedCoupon] = useState<AppliedCoupon | null>(null);
  const [couponFeedback, setCouponFeedback] = useState<string | null>(null);
  const [validatingCoupon, setValidatingCoupon] = useState(false);

  // Open Shift Modal
  const [showShiftOpen, setShowShiftOpen] = useState(false);
  const [openFloatInput, setOpenFloatInput] = useState("300.00");
  const [openingShift, setOpeningShift] = useState(false);
  const [openShiftBanner, setOpenShiftBanner] = useState<string | null>(null);

  // Recent Receipts & Manager Void/Refund Modal
  const [showRecentReceipts, setShowRecentReceipts] = useState(false);
  const [recentSales, setRecentSales] = useState<RecentSaleRow[]>([]);
  const [loadingRecent, setLoadingRecent] = useState(false);
  const [busyReceiptId, setBusyReceiptId] = useState<string | null>(null);
  const [recentError, setRecentError] = useState<string | null>(null);

  // Blind Shift Close Modal
  const [showShiftClose, setShowShiftClose] = useState(false);
  const [blindCashInput, setBlindCashInput] = useState("");
  const [fallbackFloatInput, setFallbackFloatInput] = useState("300.00");
  const [closingShift, setClosingShift] = useState(false);
  const [shiftError, setShiftError] = useState<string | null>(null);
  const [zReportResult, setZReportResult] = useState<ZReportSummary | null>(null);

  const [offlineQueue, setOfflineQueue] = useState<QueuedPosSale[]>(() => loadOfflineQueue());
  const [deadLetterQueue, setDeadLetterQueue] = useState<DeadLetterPosSale[]>(() =>
    loadDeadLetterQueue()
  );
  const [showDeadLetterModal, setShowDeadLetterModal] = useState(false);

  // Milestone 2: Store Settings, Split Tender / EMVCo QR Checkout, Hold/Recall & Supervisor PIN
  const [storeSettings, setStoreSettings] = useState<StoreSettingsDto | null>(null);
  const [showCheckoutModal, setShowCheckoutModal] = useState(false);
  const [checkoutInitialTab, setCheckoutInitialTab] = useState<CheckoutTab>("qr");
  const [activeCfdQr, setActiveCfdQr] = useState<CfdActiveQr | null>(null);
  const [lastCompletedReceiptNo, setLastCompletedReceiptNo] = useState<string | null>(null);

  const [showParkedModal, setShowParkedModal] = useState(false);
  const [parkedBaskets, setParkedBaskets] = useState<LocalOrServerParkedBasket[]>([]);
  const [loadingParked, setLoadingParked] = useState(false);
  const [busyParkedId, setBusyParkedId] = useState<string | null>(null);
  const [parkedError, setParkedError] = useState<string | null>(null);

  const [showSupervisorModal, setShowSupervisorModal] = useState(false);
  const [supervisorOverrideId, setSupervisorOverrideId] = useState<string | null>(null);
  const [supervisorOverrideBy, setSupervisorOverrideBy] = useState<string | null>(null);
  const [supervisorBanner, setSupervisorBanner] = useState<string | null>(null);

  const scanRef = useRef<HTMLInputElement>(null);
  const flushLockRef = useRef(false);
  const saleLockRef = useRef(false);
  const undoTimerRef = useRef<number | null>(null);
  const completeQuickSaleRef = useRef<(method: "cash" | "card") => Promise<void>>(async () => {});
  const hasEvaluatedLinesRef = useRef(false);
  const offlineQueueRef = useRef(offlineQueue);
  const simulatedOfflineRef = useRef(simulatedOffline);
  const showCheckoutModalRef = useRef(showCheckoutModal);
  const daypartPreviewRef = useRef(daypartPreview);

  offlineQueueRef.current = offlineQueue;
  simulatedOfflineRef.current = simulatedOffline;
  showCheckoutModalRef.current = showCheckoutModal;
  daypartPreviewRef.current = daypartPreview;

  // Periodic clock tick so live daypart promo boundary transitions evaluate without manual clicks
  // Freeze live clock while checkout modal is open so tender entry stays stable
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!showCheckoutModalRef.current) {
        setClockNow(new Date());
      }
    }, 60_000);
    return () => window.clearInterval(id);
  }, []);

  // Cross-tab offline/dead-letter storage sync & clean CFD reset on unmount
  useEffect(() => {
    const onStorage = (ev: StorageEvent) => {
      if (ev.key === OFFLINE_QUEUE_KEY) {
        setOfflineQueue(loadOfflineQueue());
      } else if (ev.key === DEAD_LETTER_QUEUE_KEY) {
        setDeadLetterQueue(loadDeadLetterQueue());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
      clearCfdState();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (undoTimerRef.current !== null) {
        window.clearTimeout(undoTimerRef.current);
      }
    };
  }, []);

  const handleActiveQrChange = useCallback((qr: CfdActiveQr | null) => {
    setActiveCfdQr(qr);
  }, []);

  // Reset age verification automatically whenever basket becomes empty; clear paid receipt banner when ringing starts
  useEffect(() => {
    if (cart.length === 0 && ageVerified) {
      setAgeVerified(false);
    }
    if (cart.length > 0 && lastCompletedReceiptNo) {
      setLastCompletedReceiptNo(null);
    }
  }, [cart.length, ageVerified, lastCompletedReceiptNo]);

  const anyModalOpen = Boolean(
    pendingAgeItem ||
      showFreshPluModal ||
      showShiftClose ||
      showShiftOpen ||
      showRecentReceipts ||
      showDeadLetterModal ||
      showCheckoutModal ||
      showParkedModal ||
      showSupervisorModal
  );

  // Re-focus barcode scanner input when POS tab becomes active and no modal is open
  useEffect(() => {
    if (isActive && !anyModalOpen) {
      scanRef.current?.focus();
    }
  }, [isActive, anyModalOpen]);

  const loadParkedBaskets = useCallback(async (signal?: AbortSignal) => {
    const localRows: LocalOrServerParkedBasket[] = loadLocalParkedBaskets().map((b) => ({
      ...b,
      source: "local" as const,
    }));
    if (simulatedOfflineRef.current) {
      if (!signal?.aborted) setParkedBaskets(localRows);
      return;
    }
    setLoadingParked(true);
    try {
      const res = await apiGet<{ baskets: ParkedBasketDto[] }>("/api/pos/parked-baskets", signal);
      if (!signal?.aborted) {
        setParkedBaskets([...res.baskets.map(mapServerParkedBasket), ...localRows]);
      }
    } catch {
      if (!signal?.aborted) {
        setParkedBaskets(localRows);
      }
    } finally {
      if (!signal?.aborted) setLoadingParked(false);
    }
  }, []);

  // Global POS function shortcuts: F6 Hold/Recall, F7 Split, F8 Cash, F9 Card, F10 KHQR/QR
  useEffect(() => {
    if (!isActive || anyModalOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
      const target =
        (e.target instanceof HTMLElement ? e.target : document.activeElement) as HTMLElement | null;
      if (
        target &&
        (target.matches("input, textarea, select") || target.isContentEditable) &&
        target.id !== "pos-barcode-input"
      ) {
        return;
      }
      if (e.key === "F6") {
        e.preventDefault();
        setParkedError(null);
        setShowParkedModal(true);
        void loadParkedBaskets();
        return;
      }
      if (!hasEvaluatedLinesRef.current || saleLockRef.current) return;
      if (
        (e.key === "F7" || e.key === "F8" || e.key === "F9" || e.key === "F10") &&
        daypartPreviewRef.current !== "live"
      ) {
        e.preventDefault();
        setSyncError("Daypart preview is active — switch back to Live Clock before checking out.");
        return;
      }
      if (e.key === "F7") {
        e.preventDefault();
        setCheckoutInitialTab("cash");
        setShowCheckoutModal(true);
      } else if (e.key === "F8") {
        e.preventDefault();
        void completeQuickSaleRef.current("cash");
      } else if (e.key === "F9") {
        e.preventDefault();
        void completeQuickSaleRef.current("card");
      } else if (e.key === "F10") {
        e.preventDefault();
        setCheckoutInitialTab("qr");
        setShowCheckoutModal(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isActive, anyModalOpen, loadParkedBaskets]);

  const loadActiveShift = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await apiGet<{ shift: ActiveShiftInfo | null }>(
        "/api/pos/shifts/active?registerCode=REG-01",
        signal
      );
      if (!signal?.aborted) {
        setActiveShift(res.shift);
        if (res.shift) {
          setFallbackFloatInput((res.shift.openingFloatCents / 100).toFixed(2));
        }
      }
    } catch {
      // ignore shift hydrate errors while offline
    }
  }, []);

  const hydrateFromSnapshot = useCallback(
    (data: PosBootstrapSnapshot, source: "live" | "indexeddb") => {
      const pMap = new Map(data.products.map((p) => [p.id, p]));
      const bMap = new Map<string, BootstrapBarcode>();
      const primMap = new Map<string, BootstrapBarcode>();

      type QuickPick = {
        barcode: string;
        name: string;
        packLabel: string;
        packQty: number;
        priceCents: number;
        badge: string;
      };
      const quickRules: { prefix: string; packQty: number; badge: string; limit: number; items: QuickPick[] }[] = [
        { prefix: "BEER", packQty: 6, badge: "Beer 6-Pack · 18+", limit: 2, items: [] },
        { prefix: "BEER", packQty: 1, badge: "Beer Single · 18+", limit: 1, items: [] },
        { prefix: "NDLS", packQty: 1, badge: "5 for $3.95 Promo", limit: 3, items: [] },
        { prefix: "NDLS", packQty: 5, badge: "5-Pack Bundle", limit: 1, items: [] },
        { prefix: "SNCK", packQty: 1, badge: "Buy 2 Get 1 Free", limit: 3, items: [] },
        { prefix: "SODA", packQty: 6, badge: "Soda 6-Pack", limit: 1, items: [] },
        { prefix: "ENRG", packQty: 1, badge: "Energy Can", limit: 1, items: [] },
      ];
      let quickRemaining = quickRules.reduce((acc, r) => acc + r.limit, 0);

      for (const bc of data.barcodes) {
        bMap.set(bc.barcode, bc);
        if (bc.isPrimary || !primMap.has(bc.productId)) {
          primMap.set(bc.productId, bc);
        }
        if (quickRemaining > 0) {
          const p = pMap.get(bc.productId);
          if (p) {
            for (const rule of quickRules) {
              if (
                rule.items.length < rule.limit &&
                bc.packQty === rule.packQty &&
                p.sku.startsWith(rule.prefix)
              ) {
                rule.items.push({
                  barcode: bc.barcode,
                  name: p.name,
                  packLabel: bc.packLabel,
                  packQty: bc.packQty,
                  priceCents: bc.sellPriceCents,
                  badge: rule.badge,
                });
                quickRemaining -= 1;
                break;
              }
            }
          }
        }
      }

      const tMap = new Map(data.taxRates.map((t) => [t.id, t]));
      const parsedPromos = mapBootstrapPromotions(data.promotions);
      const nextPluMap = new Map<string, BootstrapProduct>();
      const nextFreshItems: FreshPluItem[] = [];

      for (const p of data.products) {
        if (p.pluCode) {
          nextPluMap.set(normalizePluCode(p.pluCode), p);
          nextPluMap.set(p.pluCode.trim(), p);
        }
        const unitMode: UnitMode = p.unitMode ?? "each";
        if (p.pluCode || unitMode !== "each") {
          const primBc = primMap.get(p.id);
          if (primBc) {
            nextFreshItems.push({
              productId: p.id,
              sku: p.sku,
              name: p.name,
              brand: p.brand,
              pluCode: p.pluCode ?? null,
              unitMode,
              defaultTareGrams: p.defaultTareGrams ?? 0,
              netContentAmount: p.netContentAmount ?? null,
              netContentUnit: p.netContentUnit ?? null,
              allergens: Array.isArray(p.allergens) ? p.allergens : [],
              recalled: Boolean(p.recalled),
              recallReason: p.recallReason ?? null,
              barcode: primBc.barcode,
              packLabel: primBc.packLabel,
              sellPriceCents: primBc.sellPriceCents,
            });
          }
        }
      }
      nextFreshItems.sort((a, b) => a.sku.localeCompare(b.sku));

      setProductsMap(pMap);
      setBarcodesMap(bMap);
      setPluMap(nextPluMap);
      setFreshPluItems(nextFreshItems);
      setPrimaryByProductMap(primMap);
      setTaxMap(tMap);
      setPromos(parsedPromos);
      setBasketRules(data.basketRules ?? []);
      if (data.storeSettings) {
        setStoreSettings(data.storeSettings);
      }
      setSyncedAt(data.syncedAt);
      setCacheSource(source);
      setBootstrapError(null);
      setQuickItems(quickRules.flatMap((r) => r.items));
    },
    []
  );

  const loadBootstrap = useCallback(
    async (signal?: AbortSignal, options?: { preferLive?: boolean }) => {
      setBootstrapLoading(true);
      setBootstrapError(null);
      let hasCached = Boolean(options?.preferLive);
      try {
        if (!options?.preferLive) {
          const cached = await loadPosCache();
          if (cached && !signal?.aborted) {
            hasCached = true;
            hydrateFromSnapshot(cached, "indexeddb");
          }
        }
        try {
          const live = await apiGet<PosBootstrapSnapshot>("/api/pos/bootstrap", signal);
          if (!signal?.aborted) {
            hydrateFromSnapshot(live, "live");
            await savePosCache(live);
          }
        } catch (err) {
          if ((err as Error).name === "AbortError") return;
          if (!hasCached) {
            setBootstrapError(
              err instanceof Error
                ? err.message
                : "Could not load POS catalog from API or local IndexedDB cache."
            );
          }
        }
      } finally {
        if (!signal?.aborted) {
          setBootstrapLoading(false);
        }
      }
    },
    [hydrateFromSnapshot]
  );

  // Initial load + active shift & parked baskets hydration
  useEffect(() => {
    const controller = new AbortController();
    void loadBootstrap(controller.signal);
    void loadActiveShift(controller.signal);
    void loadParkedBaskets(controller.signal);
    return () => controller.abort();
  }, [loadBootstrap, loadActiveShift, loadParkedBaskets]);

  // Refresh POS catalog/promos in place whenever Catalog or AI Copilot executes a mutation (H-17)
  useEffect(() => {
    if (catalogRefreshTick <= 0) return;
    const controller = new AbortController();
    void loadBootstrap(controller.signal, { preferLive: true });
    return () => controller.abort();
  }, [catalogRefreshTick, loadBootstrap]);

  const flushOfflineQueueRef = useRef<() => Promise<void>>(
    async () => {}
  );

  // Automatically flush offline queue when browser network connectivity returns
  useEffect(() => {
    const handleOnline = () => {
      if (!simulatedOfflineRef.current && offlineQueueRef.current.length > 0) {
        void flushOfflineQueueRef.current();
      }
    };
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, []);

  const evalHour =
    daypartPreview === "morning" ? 9 : daypartPreview === "evening" ? 18 : clockNow.getHours();

  const rawBasketSubtotalCents = useMemo(
    () =>
      cart.reduce((s, l) => {
        if (typeof l.embeddedPriceCents === "number" && l.embeddedPriceCents > 0) {
          return s + l.embeddedPriceCents;
        }
        if (
          (l.unitMode === "weight_g" || l.unitMode === "volume_ml") &&
          typeof l.weightGrams === "number" &&
          l.weightGrams > 0
        ) {
          return s + computeWeightedPriceCents(l.weightGrams, l.unitPriceCents);
        }
        return s + l.unitPriceCents * l.qtyPacks;
      }, 0),
    [cart]
  );

  const couponEligibleNow = Boolean(
    appliedCoupon &&
      rawBasketSubtotalCents >= appliedCoupon.minBasketCents &&
      (!appliedCoupon.customerId || appliedCoupon.customerId === attachedCustomer?.id)
  );

  const evaluated = useMemo(
    () =>
      evaluateCart(cart, promos, {
        evalHour,
        evalNow: clockNow,
        couponDiscountCents: couponEligibleNow ? appliedCoupon!.discountCents : 0,
      }),
    [cart, promos, evalHour, clockNow, couponEligibleNow, appliedCoupon]
  );

  hasEvaluatedLinesRef.current = evaluated.lines.length > 0;

  // Live Customer-Facing Display (/customer-display) BroadcastChannel + localStorage mirror
  useEffect(() => {
    const status =
      activeCfdQr && activeCfdQr.status === "pending"
        ? "awaiting_qr"
        : evaluated.lines.length > 0
          ? "ringing"
          : lastCompletedReceiptNo
            ? "paid"
            : "idle";

    publishCfdState({
      storeName: storeSettings?.storeName ?? "SupermarketOS Flagship Market",
      receiptHeader:
        storeSettings?.receiptHeader ?? "Fresh Produce · Meat · Deli · Bakery · Packaged FMCG",
      receiptFooter:
        storeSettings?.receiptFooter ?? "Thank you for shopping at SupermarketOS Flagship!",
      registerCode: "REG-01",
      cashierName,
      primaryCurrency: storeSettings?.primaryCurrency ?? "USD",
      secondaryCurrency: storeSettings?.secondaryCurrency ?? "KHR",
      secondaryFxRate: storeSettings?.secondaryFxRate ?? 4100,
      secondaryRoundingStep: storeSettings?.secondaryRoundingStep ?? 100,
      status,
      lines: evaluated.lines.map((l) => ({
        lineKey: l.lineKey,
        name: l.name,
        packLabel: l.packLabel,
        qtyPacks: l.qtyPacks,
        weightGrams: l.weightGrams ?? null,
        unitMode: l.unitMode,
        lineTotalCents: l.lineTotalCents,
        discountCents: l.discountCents,
      })),
      subtotalCents: evaluated.subtotalBeforeDiscountCents,
      discountCents: evaluated.totalDiscountCents,
      taxCents: evaluated.totalTaxCents,
      grandTotalCents: evaluated.grandTotalCents,
      activeQr: activeCfdQr,
      lastReceiptNo: lastCompletedReceiptNo,
      updatedAt: new Date().toISOString(),
    });
  }, [evaluated, storeSettings, cashierName, activeCfdQr, lastCompletedReceiptNo]);

  // Offline-safe Basket Upsell Nudges derived from cached analytics_basket_rules
  const upsellSuggestions = useMemo(() => {
    if (cart.length === 0 || basketRules.length === 0) return [];
    const inCartProductIds = new Set(cart.map((c) => c.productId));
    const seenConsequents = new Set<string>();
    const isMorning = evalHour < 12;
    const orderedRules = isMorning
      ? [
          ...basketRules.filter((r) => r.shiftBucket === "morning"),
          ...basketRules.filter((r) => r.shiftBucket !== "morning"),
        ]
      : basketRules.filter((r) => r.shiftBucket !== "morning");

    const results: {
      productId: string;
      name: string;
      barcode: string;
      priceCents: number;
      lift: number;
      confidence: number;
      isMorningPair: boolean;
    }[] = [];

    for (const rule of orderedRules) {
      if (!inCartProductIds.has(rule.antecedentProductId)) continue;
      if (inCartProductIds.has(rule.consequentProductId)) continue;
      if (seenConsequents.has(rule.consequentProductId)) continue;
      const bc = primaryByProductMap.get(rule.consequentProductId);
      if (!bc) continue;
      seenConsequents.add(rule.consequentProductId);
      results.push({
        productId: rule.consequentProductId,
        name: rule.consequentName,
        barcode: bc.barcode,
        priceCents: bc.sellPriceCents,
        lift: rule.lift,
        confidence: rule.confidence,
        isMorningPair: rule.shiftBucket === "morning",
      });
      if (results.length >= 3) break;
    }
    return results;
  }, [cart, basketRules, primaryByProductMap, evalHour]);

  const checkRecallBlock = (prod: BootstrapProduct): boolean => {
    if (!prod.recalled) return false;
    setScanError(
      `FOOD-SAFETY RECALL BLOCK: ${prod.sku} (${prod.name}) is locked from sale — ${
        prod.recallReason ?? "Remove from shelf immediately."
      }`
    );
    return true;
  };

  const addWeightedLineToCart = (
    prod: BootstrapProduct,
    primBc: BootstrapBarcode,
    scannedBarcode: string,
    netGrams: number,
    tareGrams: number,
    embeddedPriceCents: number | null = null,
    bypassAge = false
  ): boolean => {
    if (checkRecallBlock(prod)) return false;
    if (prod.requiresAgeCheck && !ageVerified && !bypassAge) {
      setPendingAgeItem({
        kind: "weighted",
        prod,
        primBc,
        scannedBarcode,
        netGrams,
        tareGrams,
        embeddedPriceCents,
      });
      return false;
    }
    const tax = taxMap.get(prod.taxRateId) ?? { rateBp: 0, isInclusive: true };
    const unitMode: UnitMode = prod.unitMode ?? "weight_g";
    const measureLabel = formatMeasure(netGrams, unitMode);
    setCart((prev) => [
      ...prev,
      {
        lineKey: generateUuidV7(),
        productId: prod.id,
        categoryId: prod.categoryId,
        sku: prod.sku,
        name: prod.name,
        scannedBarcode,
        packLabel: embeddedPriceCents
          ? `Scale Pack · ${measureLabel}`
          : `${measureLabel}${tareGrams > 0 ? ` (Tare -${tareGrams}g)` : ""}`,
        packQty: 1,
        qtyPacks: 1,
        unitMode,
        weightGrams: netGrams,
        tareGrams,
        embeddedPriceCents,
        unitPriceCents: primBc.sellPriceCents,
        unitCostCents: prod.avgCostCents ?? 0,
        taxRateBp: tax.rateBp,
        taxInclusive: tax.isInclusive,
        requiresAgeCheck: prod.requiresAgeCheck,
      },
    ]);
    setScanError(null);
    return true;
  };

  const addBarcodeToCart = (bc: BootstrapBarcode, bypassAge = false) => {
    const prod = productsMap.get(bc.productId);
    if (!prod) return;
    if (checkRecallBlock(prod)) return;
    if (prod.requiresAgeCheck && !ageVerified && !bypassAge) {
      setPendingAgeItem({ kind: "barcode", bc });
      return;
    }
    const tax = taxMap.get(prod.taxRateId) ?? { rateBp: 0, isInclusive: true };

    setCart((prev) => {
      const existingIdx = prev.findIndex(
        (l) => l.scannedBarcode === bc.barcode && !l.weightGrams
      );
      if (existingIdx >= 0) {
        return prev.map((l, idx) =>
          idx === existingIdx ? { ...l, qtyPacks: l.qtyPacks + 1 } : l
        );
      }
      return [
        ...prev,
        {
          lineKey: generateUuidV7(),
          productId: prod.id,
          categoryId: prod.categoryId,
          sku: prod.sku,
          name: prod.name,
          scannedBarcode: bc.barcode,
          packLabel: bc.packLabel,
          packQty: bc.packQty,
          qtyPacks: 1,
          unitMode: prod.unitMode ?? "each",
          unitPriceCents: bc.sellPriceCents,
          unitCostCents: prod.avgCostCents ?? 0,
          taxRateBp: tax.rateBp,
          taxInclusive: tax.isInclusive,
          requiresAgeCheck: prod.requiresAgeCheck,
        },
      ];
    });
    setScanError(null);
  };

  const handleScanSubmit = (raw: string): boolean => {
    if (saleLockRef.current) return false;
    const clean = raw.trim();
    if (!clean) return false;

    // 1. Exact barcode match in local IndexedDB/live map
    const bc = barcodesMap.get(clean);
    if (bc) {
      const prod = productsMap.get(bc.productId);
      if (prod) {
        if (checkRecallBlock(prod)) {
          scanRef.current?.focus();
          scanRef.current?.select();
          return false;
        }
        if (prod.unitMode === "weight_g" || prod.unitMode === "volume_ml") {
          setFreshPluInitialProductId(prod.id);
          setShowFreshPluModal(true);
          setScanError(null);
          return true;
        }
      }
      addBarcodeToCart(bc);
      scanRef.current?.focus();
      return true;
    }

    // 2. GS1 Prefix 20-29 in-store variable-measure / scale barcode (weight or embedded price)
    const scaleParsed = parseScaleBarcode(clean);
    if (scaleParsed) {
      const matchedProd = scaleParsed.pluCandidates
        .map((c) => pluMap.get(c))
        .find((p): p is BootstrapProduct => Boolean(p));
      if (!matchedProd) {
        setScanError(
          `Scale barcode "${clean}" decoded PLU ${scaleParsed.rawPlu5}, but no matching fresh PLU exists in catalog.`
        );
        scanRef.current?.focus();
        scanRef.current?.select();
        return false;
      }
      const primBc = primaryByProductMap.get(matchedProd.id);
      if (!primBc) {
        setScanError(`Fresh product ${matchedProd.sku} has no primary price tier configured.`);
        return false;
      }
      const netGrams =
        scaleParsed.kind === "weight" && scaleParsed.weightGrams
          ? scaleParsed.weightGrams
          : scaleParsed.embeddedPriceCents
            ? deriveWeightFromPriceGrams(scaleParsed.embeddedPriceCents, primBc.sellPriceCents)
            : 0;
      if (netGrams < 1) {
        setScanError(`Scale barcode "${clean}" resolved invalid weight (${netGrams}g).`);
        return false;
      }
      const ok = addWeightedLineToCart(
        matchedProd,
        primBc,
        scaleParsed.barcode,
        netGrams,
        0,
        scaleParsed.kind === "price" ? scaleParsed.embeddedPriceCents : null
      );
      scanRef.current?.focus();
      return ok;
    }

    // 3. Direct 4- or 5-digit PLU entry (e.g. 4011 Cavendish Bananas, 40010 Sourdough Loaf)
    if (/^\d{4,5}$/.test(clean)) {
      const matchedProd = pluMap.get(normalizePluCode(clean)) ?? pluMap.get(clean);
      if (matchedProd) {
        if (checkRecallBlock(matchedProd)) {
          scanRef.current?.focus();
          scanRef.current?.select();
          return false;
        }
        if (matchedProd.unitMode === "weight_g" || matchedProd.unitMode === "volume_ml") {
          setFreshPluInitialProductId(matchedProd.id);
          setShowFreshPluModal(true);
          setScanError(null);
          return true;
        }
        const primBc = primaryByProductMap.get(matchedProd.id);
        if (primBc) {
          addBarcodeToCart(primBc);
          scanRef.current?.focus();
          return true;
        }
      }
    }

    setScanError(`Barcode or PLU "${clean}" not found in local POS catalog (${barcodesMap.size} cached).`);
    scanRef.current?.focus();
    scanRef.current?.select();
    return false;
  };

  const flushOfflineQueue = async () => {
    if (flushLockRef.current) return;
    flushLockRef.current = true;
    setSyncingQueue(true);
    setSyncError(null);
    let synced = 0;
    let authRequired = false;
    let retryableRemainingCount = 0;
    let skippedOtherCashierCount = 0;
    const permanentErrors: string[] = [];

    try {
      await withOfflineQueueLock(async () => {
        const snapshotQueue = loadOfflineQueue();
        if (snapshotQueue.length === 0) {
          setOfflineQueue([]);
          return;
        }
        for (let i = 0; i < snapshotQueue.length; i++) {
          const sale = snapshotQueue[i];
          if (
            sale.originCashierId &&
            cashierUserId &&
            sale.originCashierId !== cashierUserId &&
            !canVoidOrRefund
          ) {
            skippedOtherCashierCount += 1;
            continue;
          }
          try {
            await apiPost("/api/pos/sales", sale);
            synced++;
            const rm = removeOfflineSalesByIds([sale.id]);
            setOfflineQueue(rm.queue);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const kind = classifySaleSyncError(err);
            if (kind === "permanent") {
              const dlqRes = appendDeadLetterSaleResult({
                sale,
                error: msg,
                status: err instanceof ApiError ? err.status : null,
                failedAt: new Date().toISOString(),
              });
              if (dlqRes.saved) {
                permanentErrors.push(`${sale.receiptNo}: ${msg}`);
                setDeadLetterQueue(dlqRes.queue);
                const rm = removeOfflineSalesByIds([sale.id]);
                setOfflineQueue(rm.queue);
              } else {
                permanentErrors.push(`${sale.receiptNo}: storage full — kept in queue`);
                retryableRemainingCount += 1;
              }
            } else if (kind === "auth") {
              authRequired = true;
              retryableRemainingCount += snapshotQueue.length - i;
              break;
            } else {
              retryableRemainingCount += 1;
            }
          }
        }
        const latestQueue = loadOfflineQueue();
        setOfflineQueue(latestQueue);
      });

      if (synced > 0) {
        setSyncMessage(
          `Idempotently synced ${synced} queued receipt(s) to PostgreSQL & updated FEFO batches.`
        );
      } else {
        setSyncMessage(null);
      }
      if (authRequired) {
        setSyncError(
          `Session expired — ${retryableRemainingCount} receipt(s) remain safely queued locally until you sign back in.`
        );
      } else if (permanentErrors.length > 0) {
        setSyncError(
          `Quarantined ${permanentErrors.length} rejected receipt(s) in Dead-Letter Queue for manager review: ${permanentErrors.join("; ")}`
        );
      } else if (skippedOtherCashierCount > 0 && synced === 0) {
        setSyncError(
          `${skippedOtherCashierCount} offline receipt(s) belong to another cashier — have that cashier sign in or have a manager/owner sync.`
        );
      } else if (retryableRemainingCount > 0 && synced === 0) {
        setSyncError(`Still offline — ${retryableRemainingCount} receipt(s) remain queued locally.`);
      }
    } finally {
      flushLockRef.current = false;
      setSyncingQueue(false);
    }
  };
  flushOfflineQueueRef.current = flushOfflineQueue;

  const handleRetryDeadLetter = async (entry: DeadLetterPosSale, stripCoupon = false) => {
    if (syncingQueue) return;
    setSyncingQueue(true);
    setSyncError(null);
    try {
      const retrySale: QueuedPosSale = stripCoupon
        ? rebuildSaleWithoutCoupon(entry.sale, productsMap, taxMap, promos)
        : entry.sale;
      await apiPost("/api/pos/sales", retrySale);
      const nextDlq = removeDeadLetterSale(entry.sale.id);
      setDeadLetterQueue(nextDlq);
      setSyncMessage(`Recovered quarantined receipt ${entry.sale.receiptNo} to PostgreSQL.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSyncError(`Retry failed for ${entry.sale.receiptNo}: ${msg}`);
    } finally {
      setSyncingQueue(false);
    }
  };

  const handleDismissDeadLetter = (saleId: string) => {
    const nextDlq = removeDeadLetterSale(saleId);
    setDeadLetterQueue(nextDlq);
  };

  const primaryCurrency = storeSettings?.primaryCurrency ?? "USD";
  const secondaryCurrency = storeSettings?.secondaryCurrency ?? "KHR";
  const secondaryFxRate = storeSettings?.secondaryFxRate ?? 4100;
  const secondaryRoundingStep = storeSettings?.secondaryRoundingStep ?? 100;

  const buildPaperReceipt = (
    receiptNo: string,
    saleId: string,
    payments: QueuedPosPayment[],
    statusTag: "[OFFLINE QUEUED]" | "[SYNCED]",
    overrideActor: string | null
  ): string => {
    const hasExclusiveTax = cart.some((c) => !c.taxInclusive && c.taxRateBp > 0);
    const taxLabel = hasExclusiveTax ? "Tax (Incl./Excl.):  " : "Included Tax:       ";
    const storeTitle = (storeSettings?.storeName ?? "SUPERMARKET OS — LANE 01").toUpperCase();
    const secondaryTotalLine =
      secondaryCurrency && evaluated.grandTotalCents > 0
        ? `Equiv (${secondaryCurrency} @ ${secondaryFxRate.toLocaleString()}): ${formatCurrency(
            convertToSecondaryCurrency(
              evaluated.grandTotalCents,
              secondaryFxRate,
              secondaryRoundingStep
            ),
            secondaryCurrency
          )}`
        : "";
    const paymentLines = payments.map((p) => {
      const label = p.method.toUpperCase();
      const fxSuffix =
        p.foreignAmount && secondaryCurrency
          ? ` (${formatCurrency(p.foreignAmount, secondaryCurrency)} @ ${p.fxRateUsed ?? secondaryFxRate})`
          : "";
      const refSuffix = p.externalRef ? ` [${p.externalRef}]` : "";
      const chgSuffix =
        p.changeCents && p.changeCents > 0
          ? ` | Chg ${formatCurrency(p.changeCents, primaryCurrency)}`
          : "";
      return `  ${label.padEnd(14)} ${formatCurrency(p.amountCents, primaryCurrency).padStart(10)}${fxSuffix}${refSuffix}${chgSuffix}`;
    });
    return [
      storeTitle,
      storeSettings?.address ?? "",
      storeSettings?.taxId ? `Tax ID: ${storeSettings.taxId}` : "",
      `Receipt: ${receiptNo}   ${statusTag}`,
      `Cashier: ${cashierName}   ${new Date().toLocaleTimeString()}`,
      attachedCustomer
        ? `Loyalty: ${attachedCustomer.fullName} (${attachedCustomer.phone})`
        : "",
      overrideActor ? `Supervisor Auth: ${overrideActor}` : "",
      "----------------------------------------",
      ...evaluated.lines.map((l) => {
        const isWeighted =
          (l.unitMode === "weight_g" || l.unitMode === "volume_ml") &&
          typeof l.weightGrams === "number" &&
          l.weightGrams > 0;
        const prefix = isWeighted ? formatMeasure(l.weightGrams!, l.unitMode) : `${l.qtyPacks}x`;
        const stockLabel = isWeighted
          ? `-${formatMeasure(l.baseUnitsSold, l.unitMode)} stock`
          : `-${l.baseUnitsSold} base units`;
        return `${prefix} ${l.name.slice(0, 22).padEnd(22)} ${formatMoney(l.lineTotalCents).padStart(8)}\n   [${l.packLabel} -> ${stockLabel}]`;
      }),
      "----------------------------------------",
      `Subtotal:           ${formatMoney(evaluated.subtotalBeforeDiscountCents).padStart(20)}`,
      `Promo & Coupon:    -${formatMoney(evaluated.totalDiscountCents).padStart(19)}`,
      couponEligibleNow && appliedCoupon
        ? `Coupon Applied:     ${appliedCoupon.code.padStart(20)}`
        : "",
      `${taxLabel}${formatMoney(evaluated.totalTaxCents).padStart(20)}`,
      `TOTAL PAID:         ${formatCurrency(evaluated.grandTotalCents, primaryCurrency).padStart(20)}`,
      secondaryTotalLine,
      "Tenders:",
      ...paymentLines,
      evaluated.requiresAgeCheck ? "** ALCOHOL AGE VERIFIED (ID CHECKED) **" : "",
      "----------------------------------------",
      storeSettings?.receiptFooter ?? "",
      `Client UUIDv7: ${saleId.slice(0, 18)}...`,
    ]
      .filter(Boolean)
      .join("\n");
  };

  const handleLookupCustomer = async () => {
    const q = customerLookupInput.trim();
    if (!q || simulatedOffline) return;
    try {
      const res = await apiGet<{ customers: PosCustomer[] }>(
        `/api/loyalty/customers?search=${encodeURIComponent(q)}`
      );
      setCustomerResults(res.customers.slice(0, 5));
      if (res.customers.length === 1) {
        setAttachedCustomer(res.customers[0]);
        setCustomerResults([]);
        setCustomerLookupInput("");
      } else if (res.customers.length === 0) {
        setCouponFeedback(`No loyalty member matching "${q}".`);
      }
    } catch (err) {
      setCouponFeedback(err instanceof Error ? err.message : "Failed looking up customer");
    }
  };

  const handleApplyCoupon = async () => {
    const code = couponInput.trim().toUpperCase();
    if (!code || validatingCoupon) return;
    if (simulatedOffline) {
      setCouponFeedback("Coupon validation requires live API connectivity.");
      return;
    }
    setValidatingCoupon(true);
    setCouponFeedback(null);
    try {
      const qs = new URLSearchParams({ basketCents: String(rawBasketSubtotalCents) });
      if (attachedCustomer) qs.set("customerId", attachedCustomer.id);
      const res = await apiGet<{ valid: boolean; reason?: string; coupon?: AppliedCoupon }>(
        `/api/loyalty/coupons/validate/${encodeURIComponent(code)}?${qs.toString()}`
      );
      if (!res.valid || !res.coupon) {
        setCouponFeedback(res.reason ?? "Invalid coupon code.");
        return;
      }
      setAppliedCoupon(res.coupon);
      setCouponInput("");
      setCouponFeedback(
        `Applied coupon ${res.coupon.code} (-${formatMoney(res.coupon.discountCents)}).`
      );
    } catch (err) {
      setCouponFeedback(err instanceof Error ? err.message : "Failed validating coupon");
    } finally {
      setValidatingCoupon(false);
    }
  };

  const completeSaleWithPayments = async (
    payments: QueuedPosPayment[],
    method: "cash" | "card" | "modal" = "modal"
  ) => {
    if (daypartPreview !== "live") {
      setSyncError("Daypart preview is active — switch back to Live Clock before checking out.");
      return;
    }
    if (evaluated.lines.length === 0 || payments.length === 0 || saleLockRef.current) return;
    saleLockRef.current = true;
    setSubmittingSale(true);
    setSubmittingMethod(method);
    setSyncError(null);

    try {
      const saleId = generateUuidV7();
      const receiptNo = `REG-01-${saleId.slice(-8).toUpperCase()}`;
      const nowIso = new Date().toISOString();

      const payload: QueuedPosSale = {
        id: saleId,
        registerCode: "REG-01",
        shiftId: activeShift?.id ?? null,
        receiptNo,
        kind: "sale",
        soldAt: nowIso,
        cashierName,
        originCashierId: cashierUserId ?? null,
        ageVerified: evaluated.requiresAgeCheck && ageVerified,
        customerId: attachedCustomer?.id ?? null,
        couponCode: couponEligibleNow && appliedCoupon ? appliedCoupon.code : null,
        supervisorOverrideId,
        lines: evaluated.lines.map((l) => ({
          id: generateUuidV7(),
          productId: l.productId,
          scannedBarcode: l.scannedBarcode,
          packLabel: l.packLabel,
          packQty: l.packQty,
          qtyPacks: l.qtyPacks,
          weightGrams: l.weightGrams ?? null,
          tareGrams: l.tareGrams ?? null,
          unitPriceCents: l.unitPriceCents,
          unitCostCents: l.unitCostCents,
          discountCents: l.discountCents,
          taxRateBp: l.taxRateBp,
          taxCents: l.taxCents,
          lineTotalCents: l.lineTotalCents,
        })),
        payments,
      };

      if (simulatedOffline) {
        const persistRes = enqueueOfflineSaleResult(payload);
        if (!persistRes.saved) {
          setSyncError(
            "Browser storage quota exceeded — receipt could NOT be saved offline. Free storage or keep this basket open."
          );
          return;
        }
        setOfflineQueue(persistRes.queue);
        setReceiptPreview(
          buildPaperReceipt(receiptNo, saleId, payments, "[OFFLINE QUEUED]", supervisorOverrideBy)
        );
        setSyncMessage(`Saved offline locally (${receiptNo}). Checkout uninterrupted!`);
      } else {
        try {
          const res = await apiPost<{ pointsEarned?: number }>("/api/pos/sales", payload);
          setReceiptPreview(
            buildPaperReceipt(receiptNo, saleId, payments, "[SYNCED]", supervisorOverrideBy)
          );
          const ptsNote =
            res.pointsEarned && res.pointsEarned > 0
              ? ` (+${res.pointsEarned} loyalty pts earned)`
              : "";
          setSyncMessage(`Completed & synced ${receiptNo} directly to PostgreSQL ledger.${ptsNote}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const kind = classifySaleSyncError(err);
          if (kind === "permanent") {
            setSyncError(msg);
            return;
          }
          const persistRes = enqueueOfflineSaleResult(payload);
          if (!persistRes.saved) {
            setSyncError(
              `Network sync failed (${msg}) and browser storage quota is full — receipt could NOT be saved offline. Keep this basket open and retry.`
            );
            return;
          }
          setOfflineQueue(persistRes.queue);
          setReceiptPreview(
            buildPaperReceipt(receiptNo, saleId, payments, "[OFFLINE QUEUED]", supervisorOverrideBy)
          );
          if (kind === "auth") {
            setSyncError(`Session expired — ${receiptNo} queued safely offline until you sign back in.`);
          } else {
            setSyncMessage(`Network hiccup — queued ${receiptNo} locally for auto-retry.`);
          }
        }
      }

      setCart([]);
      setRemovedUndoLine(null);
      setAgeVerified(false);
      setAttachedCustomer(null);
      setAppliedCoupon(null);
      setCouponFeedback(null);
      setSupervisorOverrideId(null);
      setSupervisorOverrideBy(null);
      setActiveCfdQr(null);
      setShowCheckoutModal(false);
      setLastCompletedReceiptNo(receiptNo);
      scanRef.current?.focus();
    } finally {
      saleLockRef.current = false;
      setSubmittingSale(false);
      setSubmittingMethod(null);
    }
  };

  const completeQuickSale = async (method: "cash" | "card") => {
    await completeSaleWithPayments(
      [
        {
          id: generateUuidV7(),
          method,
          amountCents: evaluated.grandTotalCents,
          tenderedCents: evaluated.grandTotalCents,
          changeCents: 0,
          currencyCode: primaryCurrency,
        },
      ],
      method
    );
  };
  completeQuickSaleRef.current = completeQuickSale;

  const scheduleUndoLine = (removed: CartInputLine) => {
    if (undoTimerRef.current !== null) {
      window.clearTimeout(undoTimerRef.current);
    }
    setRemovedUndoLine(removed);
    undoTimerRef.current = window.setTimeout(() => {
      setRemovedUndoLine(null);
      undoTimerRef.current = null;
    }, 8_000);
  };

  const handleClearCart = () => {
    if (cart.length === 1) {
      scheduleUndoLine(cart[0]);
    }
    setCart([]);
    setAgeVerified(false);
    setSupervisorOverrideId(null);
    setSupervisorOverrideBy(null);
  };

  const handleRemoveLine = (lineKey: string) => {
    const target = cart.find((c) => c.lineKey === lineKey);
    if (target) scheduleUndoLine(target);
    setCart((prev) => prev.filter((c) => c.lineKey !== lineKey));
  };

  const handleDecrementLine = (lineKey: string) => {
    const target = cart.find((c) => c.lineKey === lineKey);
    if (target && target.qtyPacks <= 1) {
      scheduleUndoLine(target);
    }
    setCart((prev) =>
      prev
        .map((c) => (c.lineKey === lineKey ? { ...c, qtyPacks: c.qtyPacks - 1 } : c))
        .filter((c) => c.qtyPacks > 0)
    );
  };

  const handleIncrementLine = (lineKey: string) => {
    setCart((prev) =>
      prev.map((c) => (c.lineKey === lineKey ? { ...c, qtyPacks: c.qtyPacks + 1 } : c))
    );
  };

  const handleUndoRemovedLine = () => {
    if (!removedUndoLine) return;
    const restored = removedUndoLine;
    if (undoTimerRef.current !== null) {
      window.clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    setRemovedUndoLine(null);
    setCart((prev) => {
      const idx = prev.findIndex((c) => c.lineKey === restored.lineKey);
      if (idx >= 0) {
        return prev.map((c, i) =>
          i === idx ? { ...c, qtyPacks: c.qtyPacks + restored.qtyPacks } : c
        );
      }
      return [...prev, restored];
    });
  };

  const handleDismissUndo = () => {
    if (undoTimerRef.current !== null) {
      window.clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    setRemovedUndoLine(null);
  };

  const handleParkCurrentBasket = async (customerLabel: string, note: string) => {
    if (cart.length === 0 || busyParkedId) return;
    setBusyParkedId("park");
    setParkedError(null);
    const persistLocal = () => {
      const id = generateUuidV7();
      const holdCode = `LOC-${id.slice(-4).toUpperCase()}`;
      const existing = loadLocalParkedBaskets();
      saveLocalParkedBaskets([
        {
          id,
          holdCode,
          registerCode: "REG-01",
          cashierName,
          customerLabel: customerLabel || null,
          customerId: attachedCustomer?.id ?? null,
          couponCode: appliedCoupon?.code ?? null,
          linesJson: cart,
          subtotalCents: evaluated.grandTotalCents,
          itemCount: cart.length,
          note: note || null,
          parkedAt: new Date().toISOString(),
        },
        ...existing,
      ]);
      return holdCode;
    };

    try {
      let holdCode: string;
      if (simulatedOffline) {
        holdCode = persistLocal();
      } else {
        try {
          const res = await apiPost<{ basket: ParkedBasketDto }>("/api/pos/parked-baskets", {
            registerCode: "REG-01",
            customerLabel: customerLabel || null,
            customerId: attachedCustomer?.id ?? null,
            couponCode: appliedCoupon?.code ?? null,
            note: note || null,
            lines: cart,
            subtotalCents: evaluated.grandTotalCents,
          });
          holdCode = res.basket.holdCode;
        } catch {
          holdCode = persistLocal();
        }
      }
      setCart([]);
      setAgeVerified(false);
      setAttachedCustomer(null);
      setAppliedCoupon(null);
      setCouponFeedback(null);
      setSupervisorOverrideId(null);
      setSupervisorOverrideBy(null);
      setSyncMessage(`Parked active basket as ${holdCode}. Ready for next shopper!`);
      await loadParkedBaskets();
      setShowParkedModal(false);
      scanRef.current?.focus();
    } catch (err) {
      setParkedError(err instanceof Error ? err.message : "Failed parking active basket.");
    } finally {
      setBusyParkedId(null);
    }
  };

  const handleRecallBasket = async (basket: LocalOrServerParkedBasket) => {
    if (busyParkedId) return;
    setBusyParkedId(basket.id);
    setParkedError(null);
    try {
      let recalledLinesRaw = basket.linesJson;
      let targetCustomerId = basket.customerId;
      let targetCouponCode = basket.couponCode;
      if (basket.source === "server") {
        const res = await apiPost<{ basket: ParkedBasketDto }>(
          `/api/pos/parked-baskets/${basket.id}/recall`,
          {}
        );
        recalledLinesRaw = res.basket.linesJson;
        targetCustomerId = res.basket.customerId;
        targetCouponCode = res.basket.couponCode;
      } else {
        const remaining = loadLocalParkedBaskets().filter((b) => b.id !== basket.id);
        saveLocalParkedBaskets(remaining);
      }

      const rawLines = recalledLinesRaw as CartInputLine[];
      const validatedLines: CartInputLine[] = [];
      const blockedSkus: string[] = [];
      for (const raw of rawLines) {
        const prod = productsMap.get(raw.productId);
        if (prod?.recalled) {
          blockedSkus.push(prod.sku);
          continue;
        }
        const bc =
          barcodesMap.get(raw.scannedBarcode) ??
          (prod ? primaryByProductMap.get(prod.id) : undefined);
        const tax = prod ? taxMap.get(prod.taxRateId) : undefined;
        validatedLines.push({
          ...raw,
          unitMode: prod?.unitMode ?? raw.unitMode ?? "each",
          unitPriceCents: bc ? bc.sellPriceCents : raw.unitPriceCents,
          packLabel: !raw.weightGrams && bc ? bc.packLabel : raw.packLabel,
          packQty: bc ? bc.packQty : raw.packQty,
          taxRateBp: tax ? tax.rateBp : raw.taxRateBp,
          taxInclusive: tax ? tax.isInclusive : raw.taxInclusive,
          requiresAgeCheck: prod ? prod.requiresAgeCheck : raw.requiresAgeCheck,
        });
      }

      if (blockedSkus.length > 0) {
        setScanError(
          `FOOD-SAFETY RECALL BLOCK on recalled basket ${basket.holdCode}: skipped ${blockedSkus.join(", ")}.`
        );
      } else {
        setScanError(null);
      }

      let restoredCustomer: PosCustomer | null = null;
      if (targetCustomerId && !simulatedOfflineRef.current) {
        try {
          const custRes = await apiGet<{ customers: PosCustomer[] }>(
            "/api/loyalty/customers?limit=200"
          );
          restoredCustomer = custRes.customers.find((c) => c.id === targetCustomerId) ?? null;
        } catch {
          restoredCustomer = null;
        }
      }
      setAttachedCustomer(restoredCustomer);

      let restoredCoupon: AppliedCoupon | null = null;
      if (targetCouponCode) {
        if (simulatedOfflineRef.current) {
          setCouponFeedback(
            `Coupon ${targetCouponCode} cannot be verified while offline — re-apply when online.`
          );
        } else {
          try {
            const rawSubtotal = validatedLines.reduce((s, l) => {
              if (typeof l.embeddedPriceCents === "number" && l.embeddedPriceCents > 0) {
                return s + l.embeddedPriceCents;
              }
              if (
                (l.unitMode === "weight_g" || l.unitMode === "volume_ml") &&
                typeof l.weightGrams === "number" &&
                l.weightGrams > 0
              ) {
                return s + computeWeightedPriceCents(l.weightGrams, l.unitPriceCents);
              }
              return s + l.unitPriceCents * l.qtyPacks;
            }, 0);
            const qs = new URLSearchParams({ basketCents: String(rawSubtotal) });
            if (restoredCustomer) qs.set("customerId", restoredCustomer.id);
            const valRes = await apiGet<{
              valid: boolean;
              reason?: string;
              coupon?: AppliedCoupon;
            }>(
              `/api/loyalty/coupons/validate/${encodeURIComponent(targetCouponCode)}?${qs.toString()}`
            );
            if (valRes.valid && valRes.coupon) {
              restoredCoupon = valRes.coupon;
              setCouponFeedback(
                `Restored coupon ${valRes.coupon.code} (-${formatMoney(valRes.coupon.discountCents)}).`
              );
            } else {
              setCouponFeedback(valRes.reason ?? `Coupon ${targetCouponCode} is no longer valid.`);
            }
          } catch {
            setCouponFeedback(`Could not re-validate coupon ${targetCouponCode}.`);
          }
        }
      } else {
        setCouponFeedback(null);
      }
      setAppliedCoupon(restoredCoupon);
      setLastCompletedReceiptNo(null);

      await loadParkedBaskets();
      setShowParkedModal(false);

      if (!ageVerified && validatedLines.some((l) => l.requiresAgeCheck)) {
        setCart(validatedLines.filter((l) => !l.requiresAgeCheck));
        setPendingAgeItem({
          kind: "recalled",
          lines: validatedLines,
          holdCode: basket.holdCode,
        });
        setSyncMessage(
          `Recalled ${basket.holdCode} — confirm shopper age to restore restricted item(s).`
        );
        return;
      }

      setCart(validatedLines);
      setSyncMessage(`Recalled parked basket ${basket.holdCode} (${validatedLines.length} line(s)).`);
      scanRef.current?.focus();
    } catch (err) {
      setParkedError(err instanceof Error ? err.message : "Failed recalling parked basket.");
      await loadParkedBaskets();
    } finally {
      setBusyParkedId(null);
    }
  };

  const handleDiscardBasket = async (basket: LocalOrServerParkedBasket) => {
    if (busyParkedId) return;
    setBusyParkedId(basket.id);
    setParkedError(null);
    try {
      if (basket.source === "server") {
        await apiDelete(`/api/pos/parked-baskets/${basket.id}`);
      } else {
        const remaining = loadLocalParkedBaskets().filter((b) => b.id !== basket.id);
        saveLocalParkedBaskets(remaining);
      }
      await loadParkedBaskets();
    } catch (err) {
      setParkedError(err instanceof Error ? err.message : "Failed discarding parked basket.");
    } finally {
      setBusyParkedId(null);
    }
  };

  const handleSupervisorApproved = (res: SupervisorOverrideResult, reason: string) => {
    const label = res.actionType.replace(/_/g, " ").toUpperCase();
    if (res.actionType === "basket_void") {
      setCart([]);
      setAgeVerified(false);
      setSupervisorOverrideId(null);
      setSupervisorOverrideBy(null);
    } else if (res.actionType === "line_void") {
      setCart((prev) => prev.slice(0, -1));
      setSupervisorOverrideId(res.overrideId);
      setSupervisorOverrideBy(res.supervisorName);
    } else if (res.actionType === "price_override" || res.actionType === "manual_discount") {
      setSupervisorOverrideId(res.overrideId);
      setSupervisorOverrideBy(res.supervisorName);
    }
    setSupervisorBanner(
      `Supervisor Override Approved (${label}) by ${res.supervisorName} [${res.supervisorRole}] — "${reason}" · Audit #${res.overrideId.slice(0, 8)}`
    );
  };

  const handleOpenShift = async () => {
    if (openingShift) return;
    setShiftError(null);
    setOpenShiftBanner(null);
    const parsedFloat = Number(openFloatInput);
    if (!Number.isFinite(parsedFloat) || parsedFloat < 0) {
      setShiftError("Enter a valid non-negative opening float amount.");
      return;
    }
    setOpeningShift(true);
    try {
      const res = await apiPost<{
        id: string;
        registerCode: string;
        openingFloatCents: number;
        openedAt?: string;
      }>("/api/pos/shifts/open", {
        registerCode: "REG-01",
        openingFloatCents: Math.round(parsedFloat * 100),
      });
      setActiveShift({
        id: res.id,
        registerCode: res.registerCode,
        openingFloatCents: res.openingFloatCents,
        openedAt: res.openedAt ?? new Date().toISOString(),
      });
      setFallbackFloatInput((res.openingFloatCents / 100).toFixed(2));
      setOpenShiftBanner(
        `Shift active on ${res.registerCode} with opening float ${formatMoney(res.openingFloatCents)}.`
      );
    } catch (err) {
      setShiftError(err instanceof Error ? err.message : "Failed opening shift");
    } finally {
      setOpeningShift(false);
    }
  };

  const loadRecentSales = async () => {
    setLoadingRecent(true);
    setRecentError(null);
    try {
      const res = await apiGet<{ sales: RecentSaleRow[] }>("/api/pos/recent-sales");
      setRecentSales(res.sales);
    } catch (err) {
      setRecentError(err instanceof Error ? err.message : "Failed loading recent receipts");
    } finally {
      setLoadingRecent(false);
    }
  };

  const handleVoidOrRefund = async (sale: RecentSaleRow, kind: "void" | "refund") => {
    if (busyReceiptId || sale.lines.length === 0) return;
    setBusyReceiptId(`${sale.id}-${kind}`);
    setRecentError(null);
    try {
      const reversalId = generateUuidV7();
      const suffix = kind === "void" ? "VOID" : "RFND";
      const receiptNo = `${suffix}-${reversalId.slice(-8).toUpperCase()}`;
      const reversalPayments =
        sale.payments.length > 0
          ? sale.payments.map((p) => ({
              id: generateUuidV7(),
              method: p.method,
              amountCents: p.amountCents,
              tenderedCents: p.amountCents,
              changeCents: 0,
              currencyCode: p.currencyCode,
              foreignAmount: p.foreignAmount ?? undefined,
              fxRateUsed: p.fxRateUsed ?? undefined,
            }))
          : [
              {
                id: generateUuidV7(),
                method: "cash" as const,
                amountCents: sale.totalCents,
                tenderedCents: sale.totalCents,
                changeCents: 0,
              },
            ];

      await apiPost("/api/pos/sales", {
        id: reversalId,
        registerCode: sale.registerCode,
        shiftId: activeShift?.registerCode === sale.registerCode ? activeShift.id : null,
        receiptNo,
        kind,
        originalSaleId: sale.id,
        soldAt: new Date().toISOString(),
        cashierName,
        ageVerified: true,
        customerId: sale.customerId ?? null,
        lines: sale.lines.map((l) => ({
          id: generateUuidV7(),
          productId: l.productId,
          scannedBarcode: l.scannedBarcode,
          packLabel: l.packLabel,
          packQty: l.packQty,
          qtyPacks: l.qtyPacks,
          weightGrams: l.weightGrams ?? null,
          tareGrams: l.tareGrams ?? null,
          unitPriceCents: l.unitPriceCents,
          unitCostCents: l.unitCostCents,
          discountCents: l.discountCents,
          taxRateBp: l.taxRateBp,
          taxCents: l.taxCents,
          lineTotalCents: l.lineTotalCents,
        })),
        payments: reversalPayments,
      });
      setSyncMessage(
        `${kind === "void" ? "Voided" : "Refunded"} receipt ${sale.receiptNo} → posted ${receiptNo} (${formatMoney(sale.totalCents)} restocked to ledger).`
      );
      await loadRecentSales();
    } catch (err) {
      setRecentError(err instanceof Error ? err.message : `Failed posting ${kind}`);
    } finally {
      setBusyReceiptId(null);
    }
  };

  const handleCloseShift = async () => {
    if (closingShift) return;
    setShiftError(null);
    const parsedCash = Number(blindCashInput);
    if (!Number.isFinite(parsedCash) || parsedCash < 0) {
      setShiftError("Enter a valid non-negative cash count amount.");
      return;
    }
    let openingFloatCents = activeShift?.openingFloatCents;
    if (openingFloatCents === undefined) {
      const parsedFallback = Number(fallbackFloatInput);
      if (!Number.isFinite(parsedFallback) || parsedFallback < 0) {
        setShiftError("Enter a valid non-negative opening float amount.");
        return;
      }
      openingFloatCents = Math.round(parsedFallback * 100);
    }

    setClosingShift(true);
    try {
      const res = await apiPost<ZReportSummary>("/api/pos/shifts/close", {
        registerCode: "REG-01",
        openingFloatCents,
        cashDropsCents: 0,
        blindCountedCashCents: Math.round(parsedCash * 100),
      });
      setZReportResult(res);
      setActiveShift(null);
    } catch (err) {
      setShiftError(err instanceof Error ? err.message : "Failed closing shift");
    } finally {
      setClosingShift(false);
    }
  };

  return (
    <div>
      <PosHeaderBar
        activeShift={activeShift}
        cacheSource={cacheSource}
        bootstrapLoading={bootstrapLoading}
        productsCount={productsMap.size}
        barcodesCount={barcodesMap.size}
        freshPluCount={freshPluItems.length}
        parkedCount={parkedBaskets.length}
        simulatedOffline={simulatedOffline}
        offlineQueueCount={offlineQueue.length}
        syncingQueue={syncingQueue}
        daypartPreview={daypartPreview}
        liveHour={clockNow.getHours()}
        onOpenPluGrid={() => {
          setFreshPluInitialProductId(null);
          setShowFreshPluModal(true);
        }}
        onOpenParkedBaskets={() => {
          setParkedError(null);
          setShowParkedModal(true);
          void loadParkedBaskets();
        }}
        onOpenSupervisorOverride={() => setShowSupervisorModal(true)}
        onToggleOfflineSim={() => {
          const nextOffline = !simulatedOffline;
          setSimulatedOffline(nextOffline);
          if (!nextOffline) {
            void flushOfflineQueue();
          }
        }}
        onFlushOfflineQueue={() => void flushOfflineQueue()}
        onOpenShift={() => {
          setShowShiftOpen(true);
          setShiftError(null);
          setOpenShiftBanner(null);
          void loadActiveShift();
        }}
        onOpenRecentReceipts={() => {
          setShowRecentReceipts(true);
          void loadRecentSales();
        }}
        onOpenShiftClose={() => {
          setShowShiftClose(true);
          setBlindCashInput("");
          setZReportResult(null);
          setShiftError(null);
          void loadActiveShift();
        }}
        onDaypartChange={setDaypartPreview}
      />

      {daypartPreview !== "live" && (
        <div id="pos-daypart-preview-banner" className="banner banner-amber" role="status" style={{ marginBottom: 12 }}>
          <span>
            <strong>Daypart Clock Preview ({daypartPreview === "morning" ? "09:00" : "18:00"}):</strong>{" "}
            Showing simulated promotional prices &amp; basket nudges. Switch back to Live Clock before checking out.
          </span>
          <button
            id="pos-exit-daypart-preview-btn"
            type="button"
            className="btn btn-sm"
            onClick={() => setDaypartPreview("live")}
          >
            Return to Live Clock
          </button>
        </div>
      )}

      {bootstrapError && barcodesMap.size > 0 && (
        <div className="banner banner-red" role="alert" style={{ marginBottom: 12 }}>
          <span>{bootstrapError}</span>
          <button type="button" className="btn btn-sm" onClick={() => void loadBootstrap(undefined, { preferLive: true })}>
            <RefreshCw size={12} aria-hidden="true" /> Retry Sync
          </button>
        </div>
      )}

      {syncError && (
        <div className="banner banner-red" role="alert" style={{ marginBottom: 12 }}>
          <span>{syncError}</span>
          <button type="button" className="btn btn-sm" onClick={() => setSyncError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {supervisorBanner && (
        <div id="supervisor-override-banner" className="banner banner-green" role="status" style={{ marginBottom: 12 }}>
          <span>{supervisorBanner}</span>
          <button type="button" className="btn btn-sm" onClick={() => setSupervisorBanner(null)}>
            Dismiss
          </button>
        </div>
      )}

      {deadLetterQueue.length > 0 && (
        <div className="banner banner-red" role="alert" style={{ marginBottom: 12 }}>
          <span>
            <strong>{deadLetterQueue.length} quarantined offline receipt(s)</strong> require reconciliation — saved locally so no paid sale is lost.
          </span>
          <button
            id="open-dead-letter-modal-btn"
            type="button"
            className="btn btn-sm"
            onClick={() => setShowDeadLetterModal(true)}
          >
            Review Quarantined ({deadLetterQueue.length})
          </button>
        </div>
      )}

      {(simulatedOffline || offlineQueue.length > 0 || syncMessage) && (
        <div
          className={`banner ${simulatedOffline ? "banner-amber" : "banner-green"}`}
          role="status"
          style={{ marginBottom: 16 }}
        >
          <span>
            {simulatedOffline
              ? `OFFLINE MODE — Checkout continues uninterrupted against IndexedDB catalog. ${offlineQueue.length} receipt(s) queued with UUIDv7 idempotency keys.`
              : syncMessage ?? `${offlineQueue.length} queued receipt(s) ready to sync.`}
          </span>
          {syncedAt && (
            <span className="mono" style={{ fontSize: 11.5 }}>
              Catalog synced {new Date(syncedAt).toLocaleTimeString()}
            </span>
          )}
        </div>
      )}

      <div className="pos-layout">
        <div className="stack-md">
          <section className="panel">
            {!bootstrapLoading && barcodesMap.size === 0 && (
              <div id="pos-empty-catalog-alert" className="banner banner-red" role="alert" style={{ marginBottom: 14 }}>
                <span>
                  <strong>POS Scanning Paused (0 SKUs Cached):</strong>{" "}
                  {bootstrapError ?? "Local barcode catalog is empty. Sync with the Store API before ringing items."}
                </span>
                <button
                  id="pos-empty-catalog-retry-btn"
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void loadBootstrap(undefined, { preferLive: true })}
                >
                  <RefreshCw size={14} aria-hidden="true" /> Retry Catalog Sync
                </button>
              </div>
            )}
            <PosScanBar
              inputRef={scanRef}
              isActive={isActive}
              disabled={barcodesMap.size === 0}
              inputDisabled={submittingSale}
              modalOpen={anyModalOpen}
              invalid={Boolean(scanError)}
              errorId="pos-scan-error-alert"
              onScan={handleScanSubmit}
            />
            {scanError && (
              <div id="pos-scan-error-alert" className="banner banner-red" role="alert" style={{ marginBottom: 12 }}>
                <span>{scanError}</span>
                <button type="button" className="btn btn-sm" onClick={() => setScanError(null)}>
                  Dismiss
                </button>
              </div>
            )}

            <div className="panel-header" style={{ marginBottom: 10 }}>
              <div>
                <h2 className="panel-title">Quick-Test Packaged Goods &amp; Live Promo Triggers</h2>
                <p className="panel-desc">
                  Tap 5× noodles to trigger <strong>Any 5 for $3.95</strong>, tap 3× chips for <strong>Buy 2 Get 1 Free</strong>, or scan Beer to test <strong>6-Pack Deduction + Age Check</strong>.
                </p>
              </div>
            </div>

            {bootstrapLoading && quickItems.length === 0 ? (
              <div style={{ color: "var(--ink-muted)", padding: "18px 0" }}>
                Syncing offline-first barcode catalog...
              </div>
            ) : quickItems.length === 0 ? (
              <div style={{ color: "var(--ink-muted)", padding: "18px 0" }}>
                No quick-scan catalog items available. Use Retry Catalog Sync above once API connectivity is restored.
              </div>
            ) : (
              <div className="quick-scan-grid">
                {quickItems.map((q) => (
                  <button
                    key={q.barcode}
                    type="button"
                    className="quick-sku-btn"
                    disabled={submittingSale}
                    onClick={() => handleScanSubmit(q.barcode)}
                  >
                    <span className="tag tag-blue" style={{ width: "fit-content", fontSize: 11.5 }}>
                      {q.badge}
                    </span>
                    <div className="quick-sku-name">{q.name}</div>
                    <div className="quick-sku-foot">
                      <span style={{ color: "var(--ink-muted)" }}>{q.packLabel}</span>
                      <strong>{formatMoney(q.priceCents)}</strong>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>

          {receiptPreview && (
            <section className="panel">
              <div className="panel-header" style={{ marginBottom: 8 }}>
                <h2 className="panel-title">Last 80mm ESC/POS Thermal Receipt</h2>
                <span className="tag tag-green">
                  <CheckCircle2 size={12} aria-hidden="true" /> Ready for TCP:9100 / RJ-11 Drawer Kick
                </span>
              </div>
              <div className="thermal-paper">{receiptPreview}</div>
            </section>
          )}
        </div>

        <PosCartPanel
          cartLength={cart.length}
          evaluated={evaluated}
          ageVerified={ageVerified}
          productsMap={productsMap}
          upsellSuggestions={upsellSuggestions}
          attachedCustomer={attachedCustomer}
          customerLookupInput={customerLookupInput}
          customerResults={customerResults}
          appliedCoupon={appliedCoupon}
          couponEligibleNow={couponEligibleNow}
          couponInput={couponInput}
          couponFeedback={couponFeedback}
          validatingCoupon={validatingCoupon}
          simulatedOffline={simulatedOffline}
          submittingSale={submittingSale}
          submittingMethod={submittingMethod}
          canVoidOrRefund={canVoidOrRefund}
          primaryCurrency={primaryCurrency}
          secondaryCurrency={secondaryCurrency}
          secondaryFxRate={secondaryFxRate}
          secondaryRoundingStep={secondaryRoundingStep}
          removedUndoLine={removedUndoLine}
          onClearCart={handleClearCart}
          onRemoveLine={handleRemoveLine}
          onDecrementLine={handleDecrementLine}
          onIncrementLine={handleIncrementLine}
          onUndoRemovedLine={handleUndoRemovedLine}
          onDismissUndo={handleDismissUndo}
          onQuickAddBarcode={(barcode) => handleScanSubmit(barcode)}
          onCustomerLookupInputChange={setCustomerLookupInput}
          onLookupCustomer={() => void handleLookupCustomer()}
          onSelectCustomer={(c) => {
            setAttachedCustomer(c);
            setCustomerResults([]);
            setCustomerLookupInput("");
          }}
          onDetachCustomer={() => setAttachedCustomer(null)}
          onCouponInputChange={setCouponInput}
          onApplyCoupon={() => void handleApplyCoupon()}
          onRemoveCoupon={() => {
            setAppliedCoupon(null);
            setCouponFeedback(null);
          }}
          onQuickPay={(method) => void completeQuickSale(method)}
          onOpenCheckoutTab={(tab) => {
            if (daypartPreview !== "live") {
              setSyncError("Daypart preview is active — switch back to Live Clock before checking out.");
              return;
            }
            setCheckoutInitialTab(tab);
            setShowCheckoutModal(true);
          }}
        />
      </div>

      <AgeVerificationModal
        open={Boolean(pendingAgeItem)}
        onCancel={() => setPendingAgeItem(null)}
        onConfirm={() => {
          if (!pendingAgeItem) return;
          const item = pendingAgeItem;
          setAgeVerified(true);
          setPendingAgeItem(null);
          if (item.kind === "barcode") {
            addBarcodeToCart(item.bc, true);
          } else if (item.kind === "weighted") {
            addWeightedLineToCart(
              item.prod,
              item.primBc,
              item.scannedBarcode,
              item.netGrams,
              item.tareGrams,
              item.embeddedPriceCents,
              true
            );
          } else {
            setCart(item.lines);
            setSyncMessage(`Recalled parked basket ${item.holdCode} (age verified).`);
          }
          scanRef.current?.focus();
        }}
      />

      <OpenShiftModal
        open={showShiftOpen}
        activeShift={activeShift}
        openFloatInput={openFloatInput}
        openingShift={openingShift}
        shiftError={shiftError}
        openShiftBanner={openShiftBanner}
        onFloatChange={setOpenFloatInput}
        onSubmit={() => void handleOpenShift()}
        onClose={() => setShowShiftOpen(false)}
      />

      <RecentReceiptsModal
        open={showRecentReceipts}
        canVoidOrRefund={canVoidOrRefund}
        loadingRecent={loadingRecent}
        recentSales={recentSales}
        recentError={recentError}
        busyReceiptId={busyReceiptId}
        onVoidOrRefund={(sale, kind) => void handleVoidOrRefund(sale, kind)}
        onClose={() => setShowRecentReceipts(false)}
      />

      <ShiftCloseModal
        open={showShiftClose}
        activeShift={activeShift}
        blindCashInput={blindCashInput}
        fallbackFloatInput={fallbackFloatInput}
        closingShift={closingShift}
        shiftError={shiftError}
        zReportResult={zReportResult}
        onBlindCashChange={setBlindCashInput}
        onFallbackFloatChange={setFallbackFloatInput}
        onSubmit={() => void handleCloseShift()}
        onClose={() => {
          setShowShiftClose(false);
          setBlindCashInput("");
        }}
      />

      <DeadLetterModal
        open={showDeadLetterModal}
        entries={deadLetterQueue}
        syncingQueue={syncingQueue}
        canVoidOrRefund={canVoidOrRefund}
        onRetry={(entry, stripCoupon) => void handleRetryDeadLetter(entry, stripCoupon)}
        onDismiss={handleDismissDeadLetter}
        onClose={() => setShowDeadLetterModal(false)}
      />

      <PosFreshPluModal
        open={showFreshPluModal}
        items={freshPluItems}
        initialProductId={freshPluInitialProductId}
        onAddWeighted={(item, netGrams, tareGrams) => {
          const prod = productsMap.get(item.productId);
          const primBc = primaryByProductMap.get(item.productId);
          if (prod && primBc) {
            addWeightedLineToCart(prod, primBc, primBc.barcode, netGrams, tareGrams, null);
          }
          scanRef.current?.focus();
        }}
        onAddEach={(item) => {
          const primBc = primaryByProductMap.get(item.productId);
          if (primBc) {
            addBarcodeToCart(primBc);
          }
          scanRef.current?.focus();
        }}
        onSimulateScaleBarcode={(code) => {
          handleScanSubmit(code);
        }}
        onClose={() => setShowFreshPluModal(false)}
      />

      <PosCheckoutModal
        open={showCheckoutModal}
        initialTab={checkoutInitialTab}
        grandTotalCents={evaluated.grandTotalCents}
        storeSettings={storeSettings}
        attachedCustomer={attachedCustomer}
        simulatedOffline={simulatedOffline}
        submittingSale={submittingSale}
        onActiveQrChange={handleActiveQrChange}
        onFinalizeSale={completeSaleWithPayments}
        onClose={() => setShowCheckoutModal(false)}
      />

      <PosParkedBasketsModal
        open={showParkedModal}
        canParkCurrent={cart.length > 0}
        currentItemCount={cart.length}
        currentSubtotalCents={evaluated.grandTotalCents}
        baskets={parkedBaskets}
        loading={loadingParked}
        busyId={busyParkedId}
        error={parkedError}
        onParkCurrent={handleParkCurrentBasket}
        onRecall={handleRecallBasket}
        onDiscard={handleDiscardBasket}
        onClose={() => setShowParkedModal(false)}
      />

      <PosSupervisorOverrideModal
        open={showSupervisorModal}
        onApproved={handleSupervisorApproved}
        onClose={() => setShowSupervisorModal(false)}
      />
    </div>
  );
}
