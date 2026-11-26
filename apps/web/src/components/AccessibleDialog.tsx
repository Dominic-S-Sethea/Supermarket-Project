import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

const FOCUSABLE_SELECTOR = [
  'a[href]:not([tabindex="-1"])',
  'button:not(:disabled):not([tabindex="-1"])',
  'input:not(:disabled):not([type="hidden"]):not([tabindex="-1"])',
  'select:not(:disabled):not([tabindex="-1"])',
  'textarea:not(:disabled):not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

let openDialogCount = 0;

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
  const surfaceRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    const previouslyFocused =
      typeof document !== "undefined" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    openDialogCount += 1;
    const prevOverflow = document.body.style.overflow;
    if (openDialogCount === 1) {
      document.body.style.overflow = "hidden";
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
      openDialogCount = Math.max(0, openDialogCount - 1);
      if (openDialogCount === 0) {
        document.body.style.overflow = prevOverflow;
      }
      if (previouslyFocused && typeof previouslyFocused.focus === "function" && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className={overlayClassName}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
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
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
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
