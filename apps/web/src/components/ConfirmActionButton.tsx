import { type CSSProperties, type ReactNode, useEffect, useState } from "react";

/**
 * Accessible inline two-step confirmation button to prevent accidental single-click
 * execution of irreversible operations (PO cancel, FEFO write-off, user deactivation, etc.).
 */
export function ConfirmActionButton({
  id,
  label,
  confirmLabel = "Confirm",
  ariaLabel,
  confirmAriaLabel,
  className = "btn btn-sm",
  confirmClassName = "btn btn-danger btn-sm",
  style,
  disabled = false,
  onConfirm,
}: {
  id?: string;
  label: ReactNode;
  confirmLabel?: string;
  ariaLabel?: string;
  confirmAriaLabel?: string;
  className?: string;
  confirmClassName?: string;
  style?: CSSProperties;
  disabled?: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), 6_000);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  if (confirming) {
    return (
      <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
        <button
          id={id ? `${id}-confirm` : undefined}
          type="button"
          className={confirmClassName}
          aria-label={confirmAriaLabel ?? (ariaLabel ? `Confirm ${ariaLabel}` : confirmLabel)}
          disabled={disabled}
          onClick={() => {
            setConfirming(false);
            void onConfirm();
          }}
        >
          {confirmLabel}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={disabled}
          onClick={() => setConfirming(false)}
        >
          Cancel
        </button>
      </span>
    );
  }

  return (
    <button
      id={id}
      type="button"
      className={className}
      aria-label={ariaLabel}
      style={style}
      disabled={disabled}
      onClick={() => setConfirming(true)}
    >
      {label}
    </button>
  );
}
