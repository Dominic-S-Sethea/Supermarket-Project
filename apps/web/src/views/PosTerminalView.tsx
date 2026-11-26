import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UserRole } from "@supermarket/shared/dtos";
import { formatBp, formatMoney, generateUuidV7 } from "@supermarket/shared/money";
import { evaluateCart, type CartInputLine, type PromotionRule } from "@supermarket/shared/pricing";
import {
  CheckCircle2,
  CloudOff,
  CreditCard,
  DollarSign,
  History,
  Play,
  Receipt,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wifi,
} from "lucide-react";
import { ApiError, apiGet, apiPost } from "../api";
import { PosLoyaltyCard, type AppliedCoupon, type PosCustomer } from "../components/PosLoyaltyCard";
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
import {
  appendDeadLetterSale,
  classifySaleSyncError,
  enqueueOfflineSale,
  loadDeadLetterQueue,
  loadOfflineQueue,
  loadPosCache,
  mapBootstrapPromotions,
  removeDeadLetterSale,
  saveOfflineQueue,
  savePosCache,
  type DeadLetterPosSale,
  type PosBootstrapSnapshot,
  type QueuedPosSale,
} from "../lib/posCache";

type BootstrapProduct = PosBootstrapSnapshot["products"][number];
type BootstrapBarcode = PosBootstrapSnapshot["barcodes"][number];
type BootstrapTax = PosBootstrapSnapshot["taxRates"][number];
type BasketRule = NonNullable<PosBootstrapSnapshot["basketRules"]>[number];

export function PosTerminalView({
  cashierName = "Elena Morales",
  userRole = "owner",
  isActive = true,
  catalogRefreshTick = 0,
}: {
  cashierName?: string;
  userRole?: UserRole;
  isActive?: boolean;
  catalogRefreshTick?: number;
}) {
  const canVoidOrRefund = userRole === "owner" || userRole === "manager";
  const [productsMap, setProductsMap] = useState<Map<string, BootstrapProduct>>(new Map());
  const [barcodesMap, setBarcodesMap] = useState<Map<string, BootstrapBarcode>>(new Map());
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
  const [pendingAgeItem, setPendingAgeItem] = useState<BootstrapBarcode | null>(null);
  const [receiptPreview, setReceiptPreview] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [submittingSale, setSubmittingSale] = useState(false);
  const [syncingQueue, setSyncingQueue] = useState(false);
  const [daypartPreview, setDaypartPreview] = useState<"live" | "morning" | "evening">("live");

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
  const [blindCashInput, setBlindCashInput] = useState("420.00");
  const [fallbackFloatInput, setFallbackFloatInput] = useState("300.00");
  const [closingShift, setClosingShift] = useState(false);
  const [shiftError, setShiftError] = useState<string | null>(null);
  const [zReportResult, setZReportResult] = useState<ZReportSummary | null>(null);

  const [offlineQueue, setOfflineQueue] = useState<QueuedPosSale[]>(() => loadOfflineQueue());
  const [deadLetterQueue, setDeadLetterQueue] = useState<DeadLetterPosSale[]>(() =>
    loadDeadLetterQueue()
  );
  const [showDeadLetterModal, setShowDeadLetterModal] = useState(false);

  const scanRef = useRef<HTMLInputElement>(null);
  const flushLockRef = useRef(false);
  const saleLockRef = useRef(false);
  const offlineQueueRef = useRef(offlineQueue);
  const simulatedOfflineRef = useRef(simulatedOffline);

  offlineQueueRef.current = offlineQueue;
  simulatedOfflineRef.current = simulatedOffline;

  // Reset age verification automatically whenever basket becomes empty
  useEffect(() => {
    if (cart.length === 0 && ageVerified) {
      setAgeVerified(false);
    }
  }, [cart.length, ageVerified]);

  const anyModalOpen = Boolean(
    pendingAgeItem || showShiftClose || showShiftOpen || showRecentReceipts || showDeadLetterModal
  );

  // Re-focus barcode scanner input when POS tab becomes active and no modal is open
  useEffect(() => {
    if (isActive && !anyModalOpen) {
      scanRef.current?.focus();
    }
  }, [isActive, anyModalOpen]);

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

      setProductsMap(pMap);
      setBarcodesMap(bMap);
      setPrimaryByProductMap(primMap);
      setTaxMap(tMap);
      setPromos(parsedPromos);
      setBasketRules(data.basketRules ?? []);
      setSyncedAt(data.syncedAt);
      setCacheSource(source);
      setBootstrapError(null);
      setQuickItems(quickRules.flatMap((r) => r.items));
    },
    []
  );

  const loadBootstrap = useCallback(
    async (signal?: AbortSignal) => {
      setBootstrapLoading(true);
      setBootstrapError(null);
      let hasCached = false;
      try {
        const cached = await loadPosCache();
        if (cached && !signal?.aborted) {
          hasCached = true;
          hydrateFromSnapshot(cached, "indexeddb");
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

  // Initial load + active shift hydration
  useEffect(() => {
    const controller = new AbortController();
    void loadBootstrap(controller.signal);
    void loadActiveShift(controller.signal);
    return () => controller.abort();
  }, [loadBootstrap, loadActiveShift]);

  // Refresh POS catalog/promos in place whenever AI Copilot executes a price/promo mutation (H-17)
  useEffect(() => {
    if (catalogRefreshTick <= 0) return;
    const controller = new AbortController();
    void loadBootstrap(controller.signal);
    return () => controller.abort();
  }, [catalogRefreshTick, loadBootstrap]);

  const flushOfflineQueueRef = useRef<(queueToFlush?: QueuedPosSale[]) => Promise<void>>(
    async () => {}
  );

  // Automatically flush offline queue when browser network connectivity returns
  useEffect(() => {
    const handleOnline = () => {
      if (!simulatedOfflineRef.current && offlineQueueRef.current.length > 0) {
        void flushOfflineQueueRef.current(offlineQueueRef.current);
      }
    };
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, []);

  const evalHour =
    daypartPreview === "morning" ? 9 : daypartPreview === "evening" ? 18 : new Date().getHours();

  const rawBasketSubtotalCents = useMemo(
    () => cart.reduce((s, l) => s + l.unitPriceCents * l.qtyPacks, 0),
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
        evalNow: new Date(),
        couponDiscountCents: couponEligibleNow ? appliedCoupon!.discountCents : 0,
      }),
    [cart, promos, evalHour, couponEligibleNow, appliedCoupon]
  );

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

  const addBarcodeToCart = (bc: BootstrapBarcode, bypassAge = false) => {
    const prod = productsMap.get(bc.productId);
    if (!prod) return;
    if (prod.requiresAgeCheck && !ageVerified && !bypassAge) {
      setPendingAgeItem(bc);
      return;
    }
    const tax = taxMap.get(prod.taxRateId) ?? { rateBp: 0, isInclusive: true };

    setCart((prev) => {
      const existingIdx = prev.findIndex((l) => l.scannedBarcode === bc.barcode);
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
    const clean = raw.trim();
    if (!clean) return false;
    const bc = barcodesMap.get(clean);
    if (!bc) {
      setScanError(`Barcode "${clean}" not found in local POS catalog (${barcodesMap.size} cached).`);
      scanRef.current?.focus();
      scanRef.current?.select();
      return false;
    }
    addBarcodeToCart(bc);
    scanRef.current?.focus();
    return true;
  };

  const flushOfflineQueue = async (queueToFlush = offlineQueueRef.current) => {
    if (queueToFlush.length === 0 || flushLockRef.current) return;
    flushLockRef.current = true;
    setSyncingQueue(true);
    setSyncError(null);
    let synced = 0;
    let authRequired = false;
    const remaining: QueuedPosSale[] = [];
    const permanentErrors: string[] = [];
    let latestDeadLetters = deadLetterQueue;

    try {
      for (let i = 0; i < queueToFlush.length; i++) {
        const sale = queueToFlush[i];
        try {
          await apiPost("/api/pos/sales", sale);
          synced++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const kind = classifySaleSyncError(err);
          if (kind === "permanent") {
            permanentErrors.push(`${sale.receiptNo}: ${msg}`);
            latestDeadLetters = appendDeadLetterSale({
              sale,
              error: msg,
              status: err instanceof ApiError ? err.status : null,
              failedAt: new Date().toISOString(),
            });
          } else if (kind === "auth") {
            authRequired = true;
            remaining.push(...queueToFlush.slice(i));
            break;
          } else {
            remaining.push(sale);
          }
        }
      }
      saveOfflineQueue(remaining);
      setOfflineQueue(remaining);
      setDeadLetterQueue(latestDeadLetters);
      if (synced > 0) {
        setSyncMessage(
          `Idempotently synced ${synced} queued receipt(s) to PostgreSQL & updated FEFO batches.`
        );
      } else {
        setSyncMessage(null);
      }
      if (authRequired) {
        setSyncError(
          `Session expired — ${remaining.length} receipt(s) remain safely queued locally until you sign back in.`
        );
      } else if (permanentErrors.length > 0) {
        setSyncError(
          `Quarantined ${permanentErrors.length} rejected receipt(s) in Dead-Letter Queue for manager review: ${permanentErrors.join("; ")}`
        );
      } else if (remaining.length > 0 && synced === 0) {
        setSyncError(`Still offline — ${remaining.length} receipt(s) remain queued locally.`);
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
        ? { ...entry.sale, couponCode: null }
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

  const buildPaperReceipt = (
    receiptNo: string,
    saleId: string,
    method: "cash" | "card" | "mobile_pay",
    statusTag: "[OFFLINE QUEUED]" | "[SYNCED]"
  ): string => {
    const hasExclusiveTax = cart.some((c) => !c.taxInclusive && c.taxRateBp > 0);
    const taxLabel = hasExclusiveTax ? "Tax (Incl./Excl.):  " : "Included Tax:       ";
    return [
      "        SUPERMARKET OS — LANE 01        ",
      `Receipt: ${receiptNo}   ${statusTag}`,
      `Cashier: ${cashierName}   ${new Date().toLocaleTimeString()}`,
      attachedCustomer
        ? `Loyalty: ${attachedCustomer.fullName} (${attachedCustomer.phone})`
        : "",
      "----------------------------------------",
      ...evaluated.lines.map(
        (l) =>
          `${l.qtyPacks}x ${l.name.slice(0, 22).padEnd(22)} ${formatMoney(l.lineTotalCents).padStart(8)}\n   [${l.packLabel} -> -${l.baseUnitsSold} base units]`
      ),
      "----------------------------------------",
      `Subtotal:           ${formatMoney(evaluated.subtotalBeforeDiscountCents).padStart(20)}`,
      `Promo & Coupon:    -${formatMoney(evaluated.totalDiscountCents).padStart(19)}`,
      couponEligibleNow && appliedCoupon
        ? `Coupon Applied:     ${appliedCoupon.code.padStart(20)}`
        : "",
      `${taxLabel}${formatMoney(evaluated.totalTaxCents).padStart(20)}`,
      `TOTAL PAID (${method.toUpperCase()}): ${formatMoney(evaluated.grandTotalCents).padStart(16)}`,
      evaluated.requiresAgeCheck ? "** ALCOHOL AGE VERIFIED (ID CHECKED) **" : "",
      "----------------------------------------",
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

  const completeSale = async (method: "cash" | "card" | "mobile_pay") => {
    if (evaluated.lines.length === 0 || saleLockRef.current) return;
    saleLockRef.current = true;
    setSubmittingSale(true);
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
        ageVerified: evaluated.requiresAgeCheck && ageVerified,
        customerId: attachedCustomer?.id ?? null,
        couponCode: couponEligibleNow && appliedCoupon ? appliedCoupon.code : null,
        lines: evaluated.lines.map((l) => ({
          id: generateUuidV7(),
          productId: l.productId,
          scannedBarcode: l.scannedBarcode,
          packLabel: l.packLabel,
          packQty: l.packQty,
          qtyPacks: l.qtyPacks,
          unitPriceCents: l.unitPriceCents,
          unitCostCents: l.unitCostCents,
          discountCents: l.discountCents,
          taxRateBp: l.taxRateBp,
          taxCents: l.taxCents,
          lineTotalCents: l.lineTotalCents,
        })),
        payments: [
          {
            id: generateUuidV7(),
            method,
            amountCents: evaluated.grandTotalCents,
            tenderedCents: evaluated.grandTotalCents,
            changeCents: 0,
          },
        ],
      };

      if (simulatedOffline) {
        const nextQueue = enqueueOfflineSale(payload);
        setOfflineQueue(nextQueue);
        setReceiptPreview(buildPaperReceipt(receiptNo, saleId, method, "[OFFLINE QUEUED]"));
        setSyncMessage(`Saved offline locally (${receiptNo}). Checkout uninterrupted!`);
      } else {
        try {
          const res = await apiPost<{ pointsEarned?: number }>("/api/pos/sales", payload);
          setReceiptPreview(buildPaperReceipt(receiptNo, saleId, method, "[SYNCED]"));
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
          const nextQueue = enqueueOfflineSale(payload);
          setOfflineQueue(nextQueue);
          setReceiptPreview(buildPaperReceipt(receiptNo, saleId, method, "[OFFLINE QUEUED]"));
          if (kind === "auth") {
            setSyncError(`Session expired — ${receiptNo} queued safely offline until you sign back in.`);
          } else {
            setSyncMessage(`Network hiccup — queued ${receiptNo} locally for auto-retry.`);
          }
        }
      }

      setCart([]);
      setAgeVerified(false);
      setAttachedCustomer(null);
      setAppliedCoupon(null);
      setCouponFeedback(null);
      scanRef.current?.focus();
    } finally {
      saleLockRef.current = false;
      setSubmittingSale(false);
    }
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
      const payMethod = sale.payments[0]?.method ?? "cash";

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
          unitPriceCents: l.unitPriceCents,
          unitCostCents: l.unitCostCents,
          discountCents: l.discountCents,
          taxRateBp: l.taxRateBp,
          taxCents: l.taxCents,
          lineTotalCents: l.lineTotalCents,
        })),
        payments: [
          {
            id: generateUuidV7(),
            method: payMethod,
            amountCents: sale.totalCents,
            tenderedCents: sale.totalCents,
            changeCents: 0,
          },
        ],
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
      <header className="page-header">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h1>Offline-First POS Checkout Terminal</h1>
            {activeShift ? (
              <span className="tag tag-green mono">
                Shift Active · Float {formatMoney(activeShift.openingFloatCents)}
              </span>
            ) : (
              <span className="tag tag-neutral mono">No Open Shift</span>
            )}
          </div>
          <p className="page-subtitle">
            Local cache (
            {cacheSource === "indexeddb"
              ? "IndexedDB offline snapshot"
              : cacheSource === "live"
                ? "live"
                : bootstrapLoading
                  ? "syncing..."
                  : "unavailable"}
            ): <strong className="mono">{productsMap.size.toLocaleString()}</strong> SKUs /{" "}
            <strong className="mono">{barcodesMap.size.toLocaleString()}</strong> barcodes · Deterministic multi-UOM &amp; promo engine runs 100% locally.
          </p>
        </div>
        <div className="header-actions">
          <select
            id="pos-daypart-select"
            aria-label="POS promotion clock daypart preview"
            className="select"
            value={daypartPreview}
            onChange={(e) => setDaypartPreview(e.target.value as "live" | "morning" | "evening")}
            title="Switch clock to preview Morning 08-12 Daypart promos and morning basket upsells"
          >
            <option value="live">Clock: Live ({String(new Date().getHours()).padStart(2, "0")}:00)</option>
            <option value="morning">Daypart: Morning (09:00)</option>
            <option value="evening">Daypart: Evening (18:00)</option>
          </select>
          <button
            id="toggle-offline-sim-btn"
            type="button"
            className={`btn ${simulatedOffline ? "btn-amber" : ""}`}
            onClick={() => {
              const nextOffline = !simulatedOffline;
              setSimulatedOffline(nextOffline);
              if (!nextOffline && offlineQueue.length > 0) {
                void flushOfflineQueue(offlineQueue);
              }
            }}
          >
            {simulatedOffline ? <CloudOff size={14} aria-hidden="true" /> : <Wifi size={14} aria-hidden="true" />}
            {simulatedOffline ? "Offline Mode Active (Click to Reconnect)" : "Simulate Internet Outage"}
          </button>
          {offlineQueue.length > 0 && !simulatedOffline && (
            <button
              id="flush-offline-queue-btn"
              type="button"
              className="btn btn-primary"
              disabled={syncingQueue}
              onClick={() => void flushOfflineQueue()}
            >
              <RefreshCw size={14} aria-hidden="true" />{" "}
              {syncingQueue ? "Syncing..." : `Sync ${offlineQueue.length} Queued Sale(s)`}
            </button>
          )}
          <button
            id="open-shift-btn"
            type="button"
            className="btn"
            onClick={() => {
              setShowShiftOpen(true);
              setShiftError(null);
              setOpenShiftBanner(null);
              void loadActiveShift();
            }}
          >
            <Play size={14} aria-hidden="true" /> Open Shift
          </button>
          <button
            id="recent-receipts-btn"
            type="button"
            className="btn"
            onClick={() => {
              setShowRecentReceipts(true);
              void loadRecentSales();
            }}
          >
            <History size={14} aria-hidden="true" /> Receipts
          </button>
          <button
            id="open-shift-close-btn"
            type="button"
            className="btn"
            onClick={() => {
              setShowShiftClose(true);
              setZReportResult(null);
              setShiftError(null);
              void loadActiveShift();
            }}
          >
            <Receipt size={14} aria-hidden="true" /> Blind Close (Z-Report)
          </button>
        </div>
      </header>

      {bootstrapError && (
        <div className="banner banner-red" role="alert" style={{ marginBottom: 12 }}>
          <span>{bootstrapError}</span>
          <button type="button" className="btn btn-sm" onClick={() => void loadBootstrap()}>
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
            <PosScanBar
              inputRef={scanRef}
              isActive={isActive}
              disabled={barcodesMap.size === 0}
              onScan={handleScanSubmit}
            />
            {scanError && (
              <div className="banner banner-red" role="alert" style={{ marginBottom: 12 }}>
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
                No quick-scan catalog items available. Use Retry Sync above once API connectivity is restored.
              </div>
            ) : (
              <div className="quick-scan-grid">
                {quickItems.map((q) => (
                  <button
                    key={q.barcode}
                    type="button"
                    className="quick-sku-btn"
                    onClick={() => handleScanSubmit(q.barcode)}
                  >
                    <span className="tag tag-blue" style={{ width: "fit-content", fontSize: 10.5 }}>
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

        {/* Live Cart & Tender Panel */}
        <aside className="pos-receipt-panel">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2 className="panel-title">Current Basket (Lane 01)</h2>
            {cart.length > 0 && (
              <button
                type="button"
                className="btn btn-sm"
                disabled={submittingSale}
                onClick={() => {
                  setCart([]);
                  setAgeVerified(false);
                }}
              >
                <Trash2 size={13} aria-hidden="true" /> Clear
              </button>
            )}
          </div>

          {evaluated.requiresAgeCheck && ageVerified && (
            <div className="banner banner-green" style={{ padding: "7px 10px", fontSize: 12 }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <ShieldCheck size={14} aria-hidden="true" /> Alcohol Age Check Verified
              </span>
            </div>
          )}

          <div className="cart-lines">
            {evaluated.lines.length === 0 ? (
              <div style={{ color: "var(--ink-muted)", padding: "28px 0", textAlign: "center" }}>
                Scan a barcode or tap a quick-test SKU to start ringing up a basket.
              </div>
            ) : (
              evaluated.lines.map((line) => (
                <div key={line.lineKey} className="cart-line">
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{line.name}</div>
                    <div style={{ fontSize: 11.5, color: "var(--ink-secondary)" }} className="mono">
                      {line.packLabel} ({line.packQty}× base) · -{line.baseUnitsSold} stock
                    </div>
                    {line.appliedPromotions.length > 0 && (
                      <div style={{ marginTop: 3, display: "flex", flexWrap: "wrap", gap: 4 }}>
                        {line.appliedPromotions.map((pName, idx) => (
                          <span key={`${pName}-${idx}`} className="tag tag-green" style={{ fontSize: 10.5 }}>
                            {pName}
                            {idx === 0 ? ` (-${formatMoney(line.discountCents)})` : ""}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div className="mono" style={{ fontWeight: 600 }}>
                      {formatMoney(line.lineTotalCents)}
                    </div>
                    <div className="qty-stepper" style={{ marginTop: 4 }}>
                      <button
                        type="button"
                        className="qty-btn"
                        aria-label={`Decrease quantity for ${line.name}`}
                        disabled={submittingSale}
                        onClick={() =>
                          setCart((prev) =>
                            prev
                              .map((c) =>
                                c.lineKey === line.lineKey
                                  ? { ...c, qtyPacks: c.qtyPacks - 1 }
                                  : c
                              )
                              .filter((c) => c.qtyPacks > 0)
                          )
                        }
                      >
                        -
                      </button>
                      <span className="mono" style={{ minWidth: 18, textAlign: "center" }}>
                        {line.qtyPacks}
                      </span>
                      <button
                        type="button"
                        className="qty-btn"
                        aria-label={`Increase quantity for ${line.name}`}
                        disabled={submittingSale}
                        onClick={() =>
                          setCart((prev) =>
                            prev.map((c) =>
                              c.lineKey === line.lineKey
                                ? { ...c, qtyPacks: c.qtyPacks + 1 }
                                : c
                            )
                          )
                        }
                      >
                        +
                      </button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          {upsellSuggestions.length > 0 && (
            <div className="upsell-box">
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--accent-primary-ink)", display: "flex", alignItems: "center", gap: 5 }}>
                <Sparkles size={12} aria-hidden="true" /> OFFLINE-SAFE BASKET UPSELLS
              </div>
              {upsellSuggestions.map((u) => (
                <div key={u.productId} className="upsell-row">
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {u.name}
                    </div>
                    <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-muted)" }}>
                      {u.lift.toFixed(1)}× lift · {formatMoney(u.priceCents)}{" "}
                      {u.isMorningPair && <span className="tag tag-amber">Morning Pair</span>}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={submittingSale}
                    onClick={() => handleScanSubmit(u.barcode)}
                  >
                    + Add
                  </button>
                </div>
              ))}
            </div>
          )}

          <PosLoyaltyCard
            attachedCustomer={attachedCustomer}
            customerLookupInput={customerLookupInput}
            customerResults={customerResults}
            appliedCoupon={appliedCoupon}
            couponEligibleNow={couponEligibleNow}
            couponInput={couponInput}
            couponFeedback={couponFeedback}
            validatingCoupon={validatingCoupon}
            simulatedOffline={simulatedOffline}
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
          />

          <div className="totals-box">
            <div className="total-row">
              <span>Subtotal</span>
              <span className="mono">{formatMoney(evaluated.subtotalBeforeDiscountCents)}</span>
            </div>
            <div className="total-row" style={{ color: "var(--accent-primary-ink)", fontWeight: 600 }}>
              <span>Auto Promotions &amp; Coupons</span>
              <span className="mono">-{formatMoney(evaluated.totalDiscountCents)}</span>
            </div>
            {evaluated.couponDiscountCents > 0 && (
              <div className="total-row" style={{ fontSize: 11.5, color: "var(--accent-primary-ink)" }}>
                <span>↳ Loyalty Coupon ({appliedCoupon?.code})</span>
                <span className="mono">-{formatMoney(evaluated.couponDiscountCents)}</span>
              </div>
            )}
            <div className="total-row">
              <span>VAT / Excise Tax</span>
              <span className="mono">{formatMoney(evaluated.totalTaxCents)}</span>
            </div>
            {canVoidOrRefund && (
              <div className="total-row" style={{ fontSize: 11.5 }}>
                <span>Live Basket Margin (Cost Snapshot)</span>
                <span className="mono">{formatBp(evaluated.estimatedMarginBp)}</span>
              </div>
            )}
            <div className="total-row grand">
              <span>Total Due</span>
              <span className="mono">{formatMoney(evaluated.grandTotalCents)}</span>
            </div>
          </div>

          <div className="tender-grid">
            <button
              id="pos-pay-cash-btn"
              type="button"
              className="btn btn-primary"
              disabled={evaluated.lines.length === 0 || submittingSale}
              onClick={() => void completeSale("cash")}
            >
              <DollarSign size={14} aria-hidden="true" /> {submittingSale ? "Saving..." : "Cash"}
            </button>
            <button
              id="pos-pay-card-btn"
              type="button"
              className="btn btn-primary"
              disabled={evaluated.lines.length === 0 || submittingSale}
              onClick={() => void completeSale("card")}
            >
              <CreditCard size={14} aria-hidden="true" /> Card
            </button>
            <button
              id="pos-pay-mobile-btn"
              type="button"
              className="btn"
              disabled={evaluated.lines.length === 0 || submittingSale}
              onClick={() => void completeSale("mobile_pay")}
            >
              Mobile Pay
            </button>
          </div>
        </aside>
      </div>

      <AgeVerificationModal
        open={Boolean(pendingAgeItem)}
        onCancel={() => setPendingAgeItem(null)}
        onConfirm={() => {
          if (!pendingAgeItem) return;
          const item = pendingAgeItem;
          setAgeVerified(true);
          setPendingAgeItem(null);
          addBarcodeToCart(item, true);
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
        onClose={() => setShowShiftClose(false)}
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
    </div>
  );
}
