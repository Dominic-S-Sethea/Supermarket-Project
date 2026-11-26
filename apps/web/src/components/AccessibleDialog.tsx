import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE_SELECTOR = [
  'a[href]:not([tabindex="-1"])',
  'button:not(:disabled):not([tabindex="-1"])',
  'input:not(:disabled):not([type="hidden"]):not([tabindex="-1"])',
  'select:not(:disabled):not([tabindex="-1"])',
  'textarea:not(:disabled):not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

let openDialogCount = 0;
let initialBodyOverflow = "";
const dialogStack: symbol[] = [];

interface BackgroundRestoreEntry {
  el: HTMLElement & { inert?: boolean };
  prevInert: boolean;
  prevAriaHidden: string | null;
}

const lockedBackgrounds = new Map<HTMLElement, BackgroundRestoreEntry>();

function lockBackgroundForDialog(overlayNode: HTMLElement | null) {
  if (typeof document === "undefined") return;
  for (const child of Array.from(document.body.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (child === overlayNode) continue;
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
}

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

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => {
    if (el.getAttribute("aria-hidden") === "true") return false;
    return true;
  });
}

interface DialogBaseProps {
  open: boolean;
  onClose: () => void;
  labelledBy?: string;
  ariaLabel?: string;
  describedBy?: string;
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
  overlayClassName,
  surfaceClassName,
  style,
  children,
}: DialogBaseProps & { overlayClassName: string; surfaceClassName: string }) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    const dialogId = Symbol("accessible-dialog");
    dialogStack.push(dialogId);

    const previouslyFocused =
      typeof document !== "undefined" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    openDialogCount += 1;
    if (openDialogCount === 1) {
      initialBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      lockBackgroundForDialog(overlayRef.current);
    }

    const focusTimer = window.setTimeout(() => {
      const container = surfaceRef.current;
      if (!container) return;
      if (container.contains(document.activeElement)) return;
      const focusables = getFocusableElements(container);
      if (focusables.length > 0) {
        focusables[0].focus();
      } else {
        container.focus();
      }
    }, 0);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (dialogStack[dialogStack.length - 1] !== dialogId) return;

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

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
      const stackIdx = dialogStack.lastIndexOf(dialogId);
      if (stackIdx >= 0) dialogStack.splice(stackIdx, 1);

      openDialogCount = Math.max(0, openDialogCount - 1);
      if (openDialogCount === 0) {
        document.body.style.overflow = initialBodyOverflow;
        unlockAllBackgrounds();
      }
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
        className="overlay-backdrop"
        aria-hidden="true"
        onMouseDown={onClose}
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
