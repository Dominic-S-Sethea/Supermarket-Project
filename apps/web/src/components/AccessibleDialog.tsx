import { useEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE_SELECTOR = [
  'a[href]:not([tabindex="-1"])',
  'button:not(:disabled):not([tabindex="-1"])',
  'input:not(:disabled):not([type="hidden"]):not([tabindex="-1"])',
  'select:not(:disabled):not([tabindex="-1"])',
  'textarea:not(:disabled):not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

interface DialogEntry {
  id: symbol;
  overlay: HTMLElement | null;
}

let initialBodyOverflow = "";
const dialogEntries: DialogEntry[] = [];

interface BackgroundRestoreEntry {
  el: HTMLElement & { inert?: boolean };
  prevInert: boolean;
  prevAriaHidden: string | null;
}

const lockedBackgrounds = new Map<HTMLElement, BackgroundRestoreEntry>();

function unlockAllBackgrounds() {
  for (const entry of lockedBackgrounds.values()) {
    entry.el.inert = entry.prevInert;
    if (entry.prevAriaHidden === null) {
      entry.el.removeAttribute("aria-hidden");
    } else {
      entry.el.setAttribute("aria-hidden", entry.prevAriaHidden);
    }
  }
  lockedBackgrounds.clear();
}

function syncStackedDialogInert() {
  if (typeof document === "undefined") return;
  if (dialogEntries.length === 0) {
    unlockAllBackgrounds();
    return;
  }
  for (const child of Array.from(document.body.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (child.dataset.supermarketDialogOverlay === "true") continue;
    if (!lockedBackgrounds.has(child)) {
      const target = child as HTMLElement & { inert?: boolean };
      lockedBackgrounds.set(child, {
        el: target,
        prevInert: Boolean(target.inert),
        prevAriaHidden: target.getAttribute("aria-hidden"),
      });
      target.inert = true;
      target.setAttribute("aria-hidden", "true");
    }
  }
  const topIdx = dialogEntries.length - 1;
  dialogEntries.forEach((entry, idx) => {
    const overlay = entry.overlay as (HTMLElement & { inert?: boolean }) | null;
    if (!overlay) return;
    if (idx === topIdx) {
      overlay.inert = false;
      overlay.removeAttribute("aria-hidden");
    } else {
      overlay.inert = true;
      overlay.setAttribute("aria-hidden", "true");
    }
  });
}

function isElementVisible(el: HTMLElement): boolean {
  if (el.hidden || el.getAttribute("aria-hidden") === "true") return false;
  if (el.closest("[hidden], [aria-hidden='true'], [inert]")) return false;
  if (typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isElementVisible);
}

interface DialogBaseProps {
  open: boolean;
  onClose: () => void;
  labelledBy?: string;
  ariaLabel?: string;
  describedBy?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

function AccessibleDialogSurface({
  open,
  onClose,
  labelledBy,
  ariaLabel,
  describedBy,
  initialFocusRef,
  overlayClassName,
  surfaceClassName,
  style,
  children,
}: DialogBaseProps & { overlayClassName: string; surfaceClassName: string }) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const initialFocusRefLatest = useRef(initialFocusRef);
  const backdropMouseDownRef = useRef(false);
  onCloseRef.current = onClose;
  initialFocusRefLatest.current = initialFocusRef;

  useEffect(() => {
    if (!open) return;

    const dialogId = Symbol("accessible-dialog");
    const overlayEl = overlayRef.current;

    const previouslyFocused =
      typeof document !== "undefined" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    if (dialogEntries.length === 0) {
      initialBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    dialogEntries.push({ id: dialogId, overlay: overlayEl });
    syncStackedDialogInert();

    const focusTimer = window.setTimeout(() => {
      const container = surfaceRef.current;
      if (!container) return;
      if (container.contains(document.activeElement)) return;
      const preferred = initialFocusRefLatest.current?.current;
      if (
        preferred &&
        container.contains(preferred) &&
        !preferred.hasAttribute("disabled") &&
        isElementVisible(preferred)
      ) {
        preferred.focus();
        return;
      }
      const focusables = getFocusableElements(container);
      if (focusables.length > 0) {
        focusables[0].focus();
      } else {
        container.focus();
      }
    }, 0);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (dialogEntries[dialogEntries.length - 1]?.id !== dialogId) return;

      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (e.key === "Tab") {
        const container = surfaceRef.current;
        if (!container) return;
        const focusables = getFocusableElements(container);
        if (focusables.length === 0) {
          e.preventDefault();
          container.focus();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;

        if (e.shiftKey) {
          if (!active || active === first || !container.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else if (!active || active === last || !container.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    const handleOverlayMouseDown = (e: MouseEvent) => {
      backdropMouseDownRef.current = e.target === backdropRef.current;
    };
    const handleOverlayClick = (e: MouseEvent) => {
      if (e.target === backdropRef.current && backdropMouseDownRef.current) {
        backdropMouseDownRef.current = false;
        onCloseRef.current();
      } else {
        backdropMouseDownRef.current = false;
      }
    };

    overlayEl?.addEventListener("mousedown", handleOverlayMouseDown);
    overlayEl?.addEventListener("click", handleOverlayClick);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      window.clearTimeout(focusTimer);
      overlayEl?.removeEventListener("mousedown", handleOverlayMouseDown);
      overlayEl?.removeEventListener("click", handleOverlayClick);
      document.removeEventListener("keydown", handleKeyDown);
      const stackIdx = dialogEntries.findIndex((d) => d.id === dialogId);
      if (stackIdx >= 0) dialogEntries.splice(stackIdx, 1);

      if (dialogEntries.length === 0) {
        document.body.style.overflow = initialBodyOverflow;
      }
      syncStackedDialogInert();
      if (previouslyFocused && typeof previouslyFocused.focus === "function" && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  const dialogNode = (
    <div
      ref={overlayRef}
      data-supermarket-dialog-overlay="true"
      className={overlayClassName}
    >
      <div
        ref={backdropRef}
        className="overlay-backdrop"
        aria-hidden="true"
      />
      <div
        ref={surfaceRef}
        className={surfaceClassName}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={!labelledBy ? ariaLabel : undefined}
        aria-describedby={describedBy}
        tabIndex={-1}
        style={style}
      >
        {children}
      </div>
    </div>
  );

  if (typeof document !== "undefined" && document.body) {
    return createPortal(dialogNode, document.body);
  }
  return dialogNode;
}

export function ModalDialog({ className, ...props }: DialogBaseProps) {
  return (
    <AccessibleDialogSurface
      {...props}
      overlayClassName="overlay centered"
      surfaceClassName={className ? `modal ${className}` : "modal"}
    />
  );
}

export function SlideDrawer({ className, ...props }: DialogBaseProps) {
  return (
    <AccessibleDialogSurface
      {...props}
      overlayClassName="overlay"
      surfaceClassName={className ? `drawer ${className}` : "drawer"}
    />
  );
}
