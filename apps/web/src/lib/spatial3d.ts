import { useEffect } from "react";

const INNER_3D_SELECTOR =
  ".kpi-tile, .briefing-bullet, .quick-sku-btn:not(:disabled), .abc-cell, .did-card, .foundation-bar, .ai-starter-btn:not(:disabled)";
const OUTER_3D_SELECTOR = ".panel, .pos-receipt-panel, .login-card";

function clearElement3D(el: HTMLElement | null): void {
  if (!el) return;
  el.classList.remove("is-3d-active");
  el.style.removeProperty("--rx");
  el.style.removeProperty("--ry");
  el.style.removeProperty("--gx");
  el.style.removeProperty("--gy");
}

function find3DTarget(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  const inner = node.closest(INNER_3D_SELECTOR) as HTMLElement | null;
  if (inner) return inner;
  return node.closest(OUTER_3D_SELECTOR) as HTMLElement | null;
}

/**
 * Delegated cursor-reactive 3D elevation & tilt controller.
 * Throttled cleanly in a single requestAnimationFrame with zero React re-renders.
 */
export function useSpatial3DPanels(): void {
  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;

    const finePointerMq =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(hover: hover) and (pointer: fine)")
        : null;
    const reducedMotionMq =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;

    if ((finePointerMq && !finePointerMq.matches) || reducedMotionMq?.matches) {
      return;
    }

    let activeEl: HTMLElement | null = null;
    let rafId = 0;
    let pendingTarget: HTMLElement | null = null;
    let pendingX = 0;
    let pendingY = 0;
    let disabled = false;

    const applyFrame = () => {
      rafId = 0;
      if (disabled) return;
      const target = pendingTarget;
      if (!target || !target.isConnected) {
        clearElement3D(activeEl);
        activeEl = null;
        return;
      }

      if (activeEl !== target) {
        clearElement3D(activeEl);
        activeEl = target;
        activeEl.classList.add("is-3d-active");
      }

      const rect = target.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      const nx = Math.min(1, Math.max(0, (pendingX - rect.left) / rect.width));
      const ny = Math.min(1, Math.max(0, (pendingY - rect.top) / rect.height));
      const isOuter = target.matches(OUTER_3D_SELECTOR);
      const maxTilt = isOuter ? (rect.width > 560 || rect.height > 420 ? 2.2 : 3.8) : 5.8;

      // Tilt the edge closest to the pointer forward (+Z toward the viewer)
      const rx = ((ny - 0.5) * 2 * maxTilt).toFixed(2);
      const ry = ((0.5 - nx) * 2 * maxTilt).toFixed(2);
      const gx = (nx * 100).toFixed(1);
      const gy = (ny * 100).toFixed(1);

      target.style.setProperty("--rx", `${rx}deg`);
      target.style.setProperty("--ry", `${ry}deg`);
      target.style.setProperty("--gx", `${gx}%`);
      target.style.setProperty("--gy", `${gy}%`);
    };

    const scheduleTilt = (target: HTMLElement | null, clientX: number, clientY: number) => {
      if (disabled) return;
      pendingTarget = target;
      pendingX = clientX;
      pendingY = clientY;
      if (!rafId) {
        rafId = window.requestAnimationFrame(applyFrame);
      }
    };

    const resetAll = () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
        rafId = 0;
      }
      pendingTarget = null;
      clearElement3D(activeEl);
      activeEl = null;
    };

    const onPointerOver = (e: PointerEvent) => {
      if (e.pointerType && e.pointerType !== "mouse" && e.pointerType !== "pen") return;
      const target = find3DTarget(e.target);
      if (target !== activeEl) {
        scheduleTilt(target, e.clientX, e.clientY);
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType && e.pointerType !== "mouse" && e.pointerType !== "pen") return;
      if (e.buttons !== 0) return;
      const target = find3DTarget(e.target);
      scheduleTilt(target, e.clientX, e.clientY);
    };

    const onMotionChange = () => {
      disabled = Boolean(
        (finePointerMq && !finePointerMq.matches) || reducedMotionMq?.matches
      );
      if (disabled) resetAll();
    };

    const root = document.documentElement;
    root.addEventListener("pointerover", onPointerOver, { passive: true });
    root.addEventListener("pointermove", onPointerMove, { passive: true });
    root.addEventListener("pointerleave", resetAll, { passive: true });
    window.addEventListener("blur", resetAll);
    finePointerMq?.addEventListener?.("change", onMotionChange);
    reducedMotionMq?.addEventListener?.("change", onMotionChange);

    return () => {
      resetAll();
      root.removeEventListener("pointerover", onPointerOver);
      root.removeEventListener("pointermove", onPointerMove);
      root.removeEventListener("pointerleave", resetAll);
      window.removeEventListener("blur", resetAll);
      finePointerMq?.removeEventListener?.("change", onMotionChange);
      reducedMotionMq?.removeEventListener?.("change", onMotionChange);
    };
  }, []);
}
