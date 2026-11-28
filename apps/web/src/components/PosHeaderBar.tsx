import { memo, useEffect, useRef, useState } from "react";
import { formatMoney } from "@supermarket/shared/money";
import {
  ChevronDown,
  CloudOff,
  History,
  KeyRound,
  Monitor,
  PauseCircle,
  Play,
  Receipt,
  RefreshCw,
  Scale,
  SlidersHorizontal,
  Wifi,
} from "lucide-react";
import type { ActiveShiftInfo } from "./PosModals";
import { PageHeading } from "./PageHeading";

/**
 * Compact POS terminal top action bar with overflow "Lane Tools" popover
 * so primary cashier actions stay on 1-2 clean rows even at 1024x768.
 */
export const PosHeaderBar = memo(function PosHeaderBar({
  activeShift,
  cacheSource,
  bootstrapLoading,
  productsCount,
  barcodesCount,
  freshPluCount,
  parkedCount,
  simulatedOffline,
  offlineQueueCount,
  syncingQueue,
  daypartPreview,
  liveHour,
  onOpenPluGrid,
  onOpenParkedBaskets,
  onOpenSupervisorOverride,
  onToggleOfflineSim,
  onFlushOfflineQueue,
  onOpenShift,
  onOpenRecentReceipts,
  onOpenShiftClose,
  onDaypartChange,
}: {
  activeShift: ActiveShiftInfo | null;
  cacheSource: "live" | "indexeddb" | null;
  bootstrapLoading: boolean;
  productsCount: number;
  barcodesCount: number;
  freshPluCount: number;
  parkedCount: number;
  simulatedOffline: boolean;
  offlineQueueCount: number;
  syncingQueue: boolean;
  daypartPreview: "live" | "morning" | "evening";
  liveHour: number;
  onOpenPluGrid: () => void;
  onOpenParkedBaskets: () => void;
  onOpenSupervisorOverride: () => void;
  onToggleOfflineSim: () => void;
  onFlushOfflineQueue: () => void;
  onOpenShift: () => void;
  onOpenRecentReceipts: () => void;
  onOpenShiftClose: () => void;
  onDaypartChange: (next: "live" | "morning" | "evening") => void;
}) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolsWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!toolsOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (toolsWrapRef.current && !toolsWrapRef.current.contains(e.target as Node)) {
        setToolsOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setToolsOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [toolsOpen]);

  return (
    <header className="page-header">
      <PageHeading
        lead="Offline-First"
        accent="POS Checkout"
        compact
        badge={
          activeShift ? (
            <span className="tag tag-green mono">
              Shift Active · Float {formatMoney(activeShift.openingFloatCents)}
            </span>
          ) : (
            <span className="tag tag-neutral mono">No Open Shift</span>
          )
        }
        subtitle={
          <>
            Local cache (
            {cacheSource === "indexeddb"
              ? "IndexedDB offline snapshot"
              : cacheSource === "live"
                ? "live"
                : bootstrapLoading
                  ? "syncing..."
                  : "unavailable"}
            ): <strong className="mono">{productsCount.toLocaleString()}</strong> SKUs /{" "}
            <strong className="mono">{barcodesCount.toLocaleString()}</strong> barcodes · Deterministic multi-UOM &amp; promo engine runs 100% locally.
          </>
        }
      />
      <div className="header-actions">
        <button
          id="open-plu-grid-btn"
          type="button"
          className="btn btn-primary"
          disabled={freshPluCount === 0}
          onClick={onOpenPluGrid}
        >
          <Scale size={14} aria-hidden="true" /> Fresh PLU / Scale ({freshPluCount})
        </button>
        <button
          id="open-parked-baskets-btn"
          type="button"
          className="btn"
          onClick={onOpenParkedBaskets}
        >
          <PauseCircle size={14} aria-hidden="true" /> Hold / Recall (F6)
          {parkedCount > 0 ? ` (${parkedCount})` : ""}
        </button>
        <button
          id="open-supervisor-override-btn"
          type="button"
          className="btn"
          onClick={onOpenSupervisorOverride}
        >
          <KeyRound size={14} aria-hidden="true" /> Supervisor PIN
        </button>
        <button
          id="toggle-offline-sim-btn"
          type="button"
          className={`btn ${simulatedOffline ? "btn-amber" : ""}`}
          onClick={onToggleOfflineSim}
        >
          {simulatedOffline ? <CloudOff size={14} aria-hidden="true" /> : <Wifi size={14} aria-hidden="true" />}
          {simulatedOffline ? "Offline Mode Active (Click to Reconnect)" : "Simulate Outage"}
        </button>
        {offlineQueueCount > 0 && !simulatedOffline && (
          <button
            id="flush-offline-queue-btn"
            type="button"
            className="btn btn-primary"
            disabled={syncingQueue}
            onClick={onFlushOfflineQueue}
          >
            <RefreshCw size={14} aria-hidden="true" />{" "}
            {syncingQueue ? "Syncing..." : `Sync ${offlineQueueCount} Queued Sale(s)`}
          </button>
        )}
        <button
          id="recent-receipts-btn"
          type="button"
          className="btn"
          onClick={onOpenRecentReceipts}
        >
          <History size={14} aria-hidden="true" /> Receipts
        </button>

        <div ref={toolsWrapRef} className="lane-tools-wrap">
          <button
            id="pos-lane-tools-btn"
            type="button"
            className="btn"
            aria-expanded={toolsOpen}
            aria-controls="pos-lane-tools-popover"
            onClick={() => setToolsOpen((o) => !o)}
          >
            <SlidersHorizontal size={14} aria-hidden="true" />
            <span>Lane Tools</span>
            <ChevronDown size={13} aria-hidden="true" />
          </button>
          {toolsOpen && (
            <div id="pos-lane-tools-popover" className="lane-tools-popover" role="region" aria-label="Secondary POS lane tools">
              <a
                id="open-customer-display-btn"
                href="/customer-display"
                target="_blank"
                rel="noopener noreferrer"
                className="btn"
                onClick={() => setToolsOpen(false)}
              >
                <Monitor size={14} aria-hidden="true" /> Customer Display
              </a>
              <select
                id="pos-daypart-select"
                aria-label="POS promotion clock daypart preview"
                className="select"
                value={daypartPreview}
                onChange={(e) => {
                  onDaypartChange(e.target.value as "live" | "morning" | "evening");
                  setToolsOpen(false);
                }}
                title="Switch clock to preview Morning 08-12 Daypart promos and morning basket upsells"
              >
                <option value="live">Clock: Live ({String(liveHour).padStart(2, "0")}:00)</option>
                <option value="morning">Daypart: Morning (09:00)</option>
                <option value="evening">Daypart: Evening (18:00)</option>
              </select>
              <button
                id="open-shift-btn"
                type="button"
                className="btn"
                onClick={() => {
                  setToolsOpen(false);
                  onOpenShift();
                }}
              >
                <Play size={14} aria-hidden="true" /> Open Shift
              </button>
              <button
                id="open-shift-close-btn"
                type="button"
                className="btn"
                onClick={() => {
                  setToolsOpen(false);
                  onOpenShiftClose();
                }}
              >
                <Receipt size={14} aria-hidden="true" /> Blind Close (Z-Report)
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
});
