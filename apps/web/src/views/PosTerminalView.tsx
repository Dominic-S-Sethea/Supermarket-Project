import { useEffect, useMemo, useRef, useState } from "react";
import {
  evaluateCart,
  formatBp,
  formatMoney,
  generateUuidV7,
  type CartInputLine,
  type PromotionRule,
} from "@supermarket/shared";
import {
  AlertTriangle,
  CheckCircle2,
  CloudOff,
  CreditCard,
  DollarSign,
  Receipt,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wifi,
} from "lucide-react";
import { apiGet, apiPost } from "../api";
import { loadPosCache, savePosCache, type PosBootstrapSnapshot } from "../lib/posCache";

type BootstrapProduct = PosBootstrapSnapshot["products"][number];
type BootstrapBarcode = PosBootstrapSnapshot["barcodes"][number];
type BootstrapTax = PosBootstrapSnapshot["taxRates"][number];
type BasketRule = NonNullable<PosBootstrapSnapshot["basketRules"]>[number];

interface QueuedSale {
  id: string;
  registerCode: string;
  receiptNo: string;
  kind: "sale";
  soldAt: string;
  cashierName: string;
  ageVerified: boolean;
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

const OFFLINE_QUEUE_KEY = "supermarket_os_offline_pos_queue_v1";

export function PosTerminalView({ cashierName = "Elena Morales" }: { cashierName?: string }) {
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
  const [simulatedOffline, setSimulatedOffline] = useState(false);

  const [scanInput, setScanInput] = useState("");
  const [scanError, setScanError] = useState<string | null>(null);
  const [cart, setCart] = useState<CartInputLine[]>([]);
  const [ageVerified, setAgeVerified] = useState(false);
  const [pendingAgeItem, setPendingAgeItem] = useState<BootstrapBarcode | null>(null);
  const [receiptPreview, setReceiptPreview] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [daypartPreview, setDaypartPreview] = useState<"live" | "morning" | "evening">("live");

  // Blind Shift Close Modal
  const [showShiftClose, setShowShiftClose] = useState(false);
  const [blindCashInput, setBlindCashInput] = useState("420.00");
  const [shiftError, setShiftError] = useState<string | null>(null);
  const [zReportResult, setZReportResult] = useState<{
    zReportNo: string;
    expectedCashCents: number;
    blindCountedCashCents: number;
    varianceCents: number;
  } | null>(null);

  const [offlineQueue, setOfflineQueue] = useState<QueuedSale[]>(() => {
    try {
      const raw = localStorage.getItem(OFFLINE_QUEUE_KEY);
      return raw ? (JSON.parse(raw) as QueuedSale[]) : [];
    } catch {
      return [];
    }
  });

  const scanRef = useRef<HTMLInputElement>(null);
  const flushLockRef = useRef(false);

  useEffect(() => {
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(offlineQueue));
  }, [offlineQueue]);

  const hydrateFromSnapshot = (
    data: PosBootstrapSnapshot,
    source: "live" | "indexeddb"
  ) => {
    const pMap = new Map(data.products.map((p) => [p.id, p]));
    const bMap = new Map(data.barcodes.map((b) => [b.barcode, b]));
    const primMap = new Map<string, BootstrapBarcode>();
    for (const bc of data.barcodes) {
      if (bc.isPrimary || !primMap.has(bc.productId)) {
        primMap.set(bc.productId, bc);
      }
    }
    const tMap = new Map(data.taxRates.map((t) => [t.id, t]));
    const parsedPromos: PromotionRule[] = data.promotions.map((pr) => ({
      id: pr.id,
      name: pr.name,
      promoType: pr.promoType,
      priority: pr.priority,
      combinable: pr.combinable,
      minMarginGuardBp: pr.minMarginGuardBp,
      daypartStartHour: pr.daypartStartHour ?? null,
      daypartEndHour: pr.daypartEndHour ?? null,
      ...(pr.rulesJson as Record<string, unknown>),
    }));

    setProductsMap(pMap);
    setBarcodesMap(bMap);
    setPrimaryByProductMap(primMap);
    setTaxMap(tMap);
    setPromos(parsedPromos);
    setBasketRules(data.basketRules ?? []);
    setSyncedAt(data.syncedAt);
    setCacheSource(source);

    const picks: typeof quickItems = [];
    const findMatching = (prefix: string, packQty: number, badge: string, limit: number) => {
      let added = 0;
      for (const bc of data.barcodes) {
        const p = pMap.get(bc.productId);
        if (p && p.sku.startsWith(prefix) && bc.packQty === packQty) {
          picks.push({
            barcode: bc.barcode,
            name: p.name,
            packLabel: bc.packLabel,
            packQty: bc.packQty,
            priceCents: bc.sellPriceCents,
            badge,
          });
          added++;
          if (added >= limit) break;
        }
      }
    };

    findMatching("BEER", 6, "Beer 6-Pack · 18+", 2);
    findMatching("BEER", 1, "Beer Single · 18+", 1);
    findMatching("NDLS", 1, "5 for $3.95 Promo", 3);
    findMatching("NDLS", 5, "5-Pack Bundle", 1);
    findMatching("SNCK", 1, "Buy 2 Get 1 Free", 3);
    findMatching("SODA", 6, "Soda 6-Pack", 1);
    findMatching("ENRG", 1, "Energy Can", 1);
    setQuickItems(picks);
  };

  // Load persisted IndexedDB cache immediately, then refresh from live API when reachable
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cached = await loadPosCache();
      if (cached && !cancelled) {
        hydrateFromSnapshot(cached, "indexeddb");
      }
      try {
        const live = await apiGet<PosBootstrapSnapshot>("/api/pos/bootstrap");
        if (!cancelled) {
          hydrateFromSnapshot(live, "live");
          await savePosCache(live);
        }
      } catch {
        // Offline at startup — IndexedDB snapshot remains active
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const evalHour =
    daypartPreview === "morning" ? 9 : daypartPreview === "evening" ? 18 : new Date().getHours();

  const evaluated = useMemo(
    () => evaluateCart(cart, promos, { evalHour }),
    [cart, promos, evalHour]
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
          unitCostCents: prod.avgCostCents,
          taxRateBp: tax.rateBp,
          taxInclusive: tax.isInclusive,
          requiresAgeCheck: prod.requiresAgeCheck,
        },
      ];
    });
    setScanError(null);
  };

  const handleScanSubmit = (raw: string) => {
    const clean = raw.trim();
    if (!clean) return;
    const bc = barcodesMap.get(clean);
    if (!bc) {
      setScanError(`Barcode "${clean}" not found in local POS catalog (${barcodesMap.size} cached).`);
      return;
    }
    addBarcodeToCart(bc);
    setScanInput("");
    scanRef.current?.focus();
  };

  const flushOfflineQueue = async (queueToFlush = offlineQueue) => {
    if (queueToFlush.length === 0 || flushLockRef.current) return;
    flushLockRef.current = true;
    setSyncError(null);
    let synced = 0;
    const remaining: QueuedSale[] = [];
    const permanentErrors: string[] = [];

    try {
      for (const sale of queueToFlush) {
        try {
          await apiPost("/api/pos/sales", sale);
          synced++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("(400)") || msg.includes("(403)") || msg.includes("(409)")) {
            permanentErrors.push(`${sale.receiptNo}: ${msg}`);
          } else {
            remaining.push(sale);
          }
        }
      }
      setOfflineQueue(remaining);
      if (synced > 0) {
        setSyncMessage(
          `Idempotently synced ${synced} queued receipt(s) to PostgreSQL & updated FEFO batches.`
        );
      } else {
        setSyncMessage(null);
      }
      if (permanentErrors.length > 0) {
        setSyncError(`Rejected receipt(s): ${permanentErrors.join("; ")}`);
      } else if (remaining.length > 0 && synced === 0) {
        setSyncError(`Still offline — ${remaining.length} receipt(s) remain queued locally.`);
      }
    } finally {
      flushLockRef.current = false;
    }
  };

  const completeSale = async (method: "cash" | "card" | "mobile_pay") => {
    if (evaluated.lines.length === 0) return;
    setSyncError(null);
    const saleId = generateUuidV7();
    const receiptNo = `REG-01-${saleId.slice(-8).toUpperCase()}`;
    const nowIso = new Date().toISOString();

    const payload: QueuedSale = {
      id: saleId,
      registerCode: "REG-01",
      receiptNo,
      kind: "sale",
      soldAt: nowIso,
      cashierName,
      ageVerified: evaluated.requiresAgeCheck && ageVerified,
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

    const paperLines = [
      "        SUPERMARKET OS — LANE 01        ",
      `Receipt: ${receiptNo}   ${simulatedOffline ? "[OFFLINE QUEUED]" : "[SYNCED]"}`,
      `Cashier: ${cashierName}   ${new Date().toLocaleTimeString()}`,
      "----------------------------------------",
      ...evaluated.lines.map(
        (l) =>
          `${l.qtyPacks}x ${l.name.slice(0, 22).padEnd(22)} ${formatMoney(l.lineTotalCents).padStart(8)}\n   [${l.packLabel} -> -${l.baseUnitsSold} base units]`
      ),
      "----------------------------------------",
      `Subtotal:           ${formatMoney(evaluated.subtotalBeforeDiscountCents).padStart(20)}`,
      `Promo Savings:     -${formatMoney(evaluated.totalDiscountCents).padStart(19)}`,
      `Included Tax:       ${formatMoney(evaluated.totalTaxCents).padStart(20)}`,
      `TOTAL PAID (${method.toUpperCase()}): ${formatMoney(evaluated.grandTotalCents).padStart(16)}`,
      evaluated.requiresAgeCheck ? "** ALCOHOL AGE VERIFIED (ID CHECKED) **" : "",
      "----------------------------------------",
      `Client UUIDv7: ${saleId.slice(0, 18)}...`,
    ].filter(Boolean);

    setReceiptPreview(paperLines.join("\n"));

    if (simulatedOffline) {
      setOfflineQueue((q) => [...q, payload]);
      setSyncMessage(`Saved offline locally (${receiptNo}). Checkout uninterrupted!`);
    } else {
      try {
        await apiPost("/api/pos/sales", payload);
        setSyncMessage(`Completed & synced ${receiptNo} directly to PostgreSQL ledger.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("(400)") || msg.includes("(403)")) {
          setSyncError(msg);
          return;
        }
        setOfflineQueue((q) => [...q, payload]);
        setSyncMessage(`Network hiccup — queued ${receiptNo} locally for auto-retry.`);
      }
    }

    setCart([]);
    setAgeVerified(false);
    scanRef.current?.focus();
  };

  const handleCloseShift = async () => {
    setShiftError(null);
    const parsedCash = Number(blindCashInput);
    if (!Number.isFinite(parsedCash) || parsedCash < 0) {
      setShiftError("Enter a valid non-negative cash count amount.");
      return;
    }
    try {
      const res = await apiPost<{
        zReportNo: string;
        expectedCashCents: number;
        blindCountedCashCents: number;
        varianceCents: number;
      }>("/api/pos/shifts/close", {
        registerCode: "REG-01",
        openingFloatCents: 30000,
        cashDropsCents: 0,
        blindCountedCashCents: Math.round(parsedCash * 100),
      });
      setZReportResult(res);
    } catch (err) {
      setShiftError(err instanceof Error ? err.message : "Failed closing shift");
    }
  };

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>Offline-First POS Checkout Terminal</h1>
          <p className="page-subtitle">
            Local cache ({cacheSource === "indexeddb" ? "IndexedDB offline snapshot" : "live"}):{" "}
            <strong className="mono">{productsMap.size.toLocaleString()}</strong> SKUs /{" "}
            <strong className="mono">{barcodesMap.size.toLocaleString()}</strong> barcodes · Deterministic multi-UOM &amp; promo engine runs 100% locally.
          </p>
        </div>
        <div className="header-actions">
          <select
            id="pos-daypart-select"
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
            className={`btn ${simulatedOffline ? "btn-amber" : ""}`}
            onClick={() => {
              const nextOffline = !simulatedOffline;
              setSimulatedOffline(nextOffline);
              if (!nextOffline && offlineQueue.length > 0) {
                void flushOfflineQueue(offlineQueue);
              }
            }}
          >
            {simulatedOffline ? <CloudOff size={14} /> : <Wifi size={14} />}
            {simulatedOffline ? "Offline Mode Active (Click to Reconnect)" : "Simulate Internet Outage"}
          </button>
          {offlineQueue.length > 0 && !simulatedOffline && (
            <button
              id="flush-offline-queue-btn"
              className="btn btn-primary"
              onClick={() => void flushOfflineQueue()}
            >
              <RefreshCw size={14} /> Sync {offlineQueue.length} Queued Sale(s)
            </button>
          )}
          <button
            id="open-shift-close-btn"
            className="btn"
            onClick={() => {
              setShowShiftClose(true);
              setZReportResult(null);
              setShiftError(null);
            }}
          >
            <Receipt size={14} /> Blind Shift Close (Z-Report)
          </button>
        </div>
      </header>

      {syncError && (
        <div className="banner banner-red" style={{ marginBottom: 12 }}>
          <span>{syncError}</span>
        </div>
      )}

      {(simulatedOffline || offlineQueue.length > 0 || syncMessage) && (
        <div
          className={`banner ${simulatedOffline ? "banner-amber" : "banner-green"}`}
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
            <form
              className="pos-scan-bar"
              onSubmit={(e) => {
                e.preventDefault();
                handleScanSubmit(scanInput);
              }}
            >
              <input
                ref={scanRef}
                id="pos-barcode-input"
                className="input"
                placeholder="Scan EAN-13 / UPC-A barcode (USB HID scanner or paste code) + Enter..."
                value={scanInput}
                onChange={(e) => setScanInput(e.target.value)}
                autoFocus
              />
              <button type="submit" className="btn btn-primary">
                Scan Item
              </button>
            </form>
            {scanError && (
              <div className="banner banner-red" style={{ marginBottom: 12 }}>
                {scanError}
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

            <div className="quick-scan-grid">
              {quickItems.map((q) => (
                <button
                  key={q.barcode}
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
          </section>

          {receiptPreview && (
            <section className="panel">
              <div className="panel-header" style={{ marginBottom: 8 }}>
                <h2 className="panel-title">Last 80mm ESC/POS Thermal Receipt</h2>
                <span className="tag tag-green">
                  <CheckCircle2 size={12} /> Ready for TCP:9100 / RJ-11 Drawer Kick
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
                className="btn btn-sm"
                onClick={() => {
                  setCart([]);
                  setAgeVerified(false);
                }}
              >
                <Trash2 size={13} /> Clear
              </button>
            )}
          </div>

          {evaluated.requiresAgeCheck && ageVerified && (
            <div className="banner banner-green" style={{ padding: "7px 10px", fontSize: 12 }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <ShieldCheck size={14} /> Alcohol Age Check Verified
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
                        className="qty-btn"
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
                        className="qty-btn"
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
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--accent-primary)", display: "flex", alignItems: "center", gap: 5 }}>
                <Sparkles size={12} /> OFFLINE-SAFE BASKET UPSELLS
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
                    className="btn btn-sm"
                    onClick={() => handleScanSubmit(u.barcode)}
                  >
                    + Add
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="totals-box">
            <div className="total-row">
              <span>Subtotal</span>
              <span className="mono">{formatMoney(evaluated.subtotalBeforeDiscountCents)}</span>
            </div>
            <div className="total-row" style={{ color: "var(--accent-primary)", fontWeight: 600 }}>
              <span>Auto Promotions</span>
              <span className="mono">-{formatMoney(evaluated.totalDiscountCents)}</span>
            </div>
            <div className="total-row">
              <span>Included VAT / Excise</span>
              <span className="mono">{formatMoney(evaluated.totalTaxCents)}</span>
            </div>
            <div className="total-row" style={{ fontSize: 11.5 }}>
              <span>Live Basket Margin (Cost Snapshot)</span>
              <span className="mono">{formatBp(evaluated.estimatedMarginBp)}</span>
            </div>
            <div className="total-row grand">
              <span>Total Due</span>
              <span className="mono">{formatMoney(evaluated.grandTotalCents)}</span>
            </div>
          </div>

          <div className="tender-grid">
            <button
              id="pos-pay-cash-btn"
              className="btn btn-primary"
              disabled={evaluated.lines.length === 0}
              onClick={() => void completeSale("cash")}
            >
              <DollarSign size={14} /> Cash
            </button>
            <button
              id="pos-pay-card-btn"
              className="btn btn-primary"
              disabled={evaluated.lines.length === 0}
              onClick={() => void completeSale("card")}
            >
              <CreditCard size={14} /> Card
            </button>
            <button
              id="pos-pay-mobile-btn"
              className="btn"
              disabled={evaluated.lines.length === 0}
              onClick={() => void completeSale("mobile_pay")}
            >
              Mobile Pay
            </button>
          </div>
        </aside>
      </div>

      {/* Alcohol Age Verification Modal */}
      {pendingAgeItem && (
        <div className="overlay centered">
          <div className="modal" style={{ maxWidth: 440 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", color: "var(--accent-amber)" }}>
              <AlertTriangle size={22} />
              <h2 style={{ margin: 0, fontSize: 18, color: "var(--ink-primary)" }}>
                Age Verification Required
              </h2>
            </div>
            <p style={{ margin: 0, color: "var(--ink-secondary)" }}>
              This SKU belongs to an age-restricted alcohol category. Please verify customer photo ID before proceeding with checkout.
            </p>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => setPendingAgeItem(null)}>
                Cancel Scan
              </button>
              <button
                id="confirm-age-check-btn"
                className="btn btn-primary"
                onClick={() => {
                  const item = pendingAgeItem;
                  setAgeVerified(true);
                  setPendingAgeItem(null);
                  addBarcodeToCart(item, true);
                }}
              >
                <ShieldCheck size={14} /> ID Verified — Add to Basket
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Blind Shift Close (Z-Report) Modal */}
      {showShiftClose && (
        <div className="overlay centered" onClick={() => setShowShiftClose(false)}>
          <div className="modal" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ margin: 0, fontSize: 18 }}>Blind Shift Cash Closeout (Z-Report)</h2>
            <p className="page-subtitle" style={{ margin: 0 }}>
              Cashier enters counted drawer cash without seeing the expected system total — prevents skimming overages.
            </p>
            {shiftError && <div className="banner banner-red">{shiftError}</div>}
            <div className="field">
              <label>Physical Cash Counted in Drawer ($ USD)</label>
              <input
                className="input mono"
                value={blindCashInput}
                onChange={(e) => setBlindCashInput(e.target.value)}
              />
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn btn-primary" onClick={() => void handleCloseShift()}>
                Submit Blind Count &amp; Generate Z-Report
              </button>
              <button className="btn" onClick={() => setShowShiftClose(false)}>
                Close
              </button>
            </div>
            {zReportResult && (
              <div className="thermal-paper">
                {`Z-REPORT: ${zReportResult.zReportNo}
Expected Cash:  ${formatMoney(zReportResult.expectedCashCents)}
Blind Counted:  ${formatMoney(zReportResult.blindCountedCashCents)}
Variance:       ${formatMoney(zReportResult.varianceCents)}`}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
