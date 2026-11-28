import { memo, type RefObject, useEffect, useState } from "react";

/**
 * Isolated POS barcode scan bar so per-keystroke / USB HID scanner input
 * stays local instead of re-rendering the entire PosTerminalView tree.
 */
export const PosScanBar = memo(function PosScanBar({
  inputRef,
  isActive,
  disabled,
  inputDisabled = false,
  modalOpen = false,
  invalid = false,
  errorId,
  onScan,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  isActive: boolean;
  disabled: boolean;
  inputDisabled?: boolean;
  modalOpen?: boolean;
  invalid?: boolean;
  errorId?: string;
  onScan: (rawCode: string) => boolean;
}) {
  const [scanInput, setScanInput] = useState("");

  useEffect(() => {
    if (!isActive || inputDisabled || modalOpen) return;
    if (
      typeof document !== "undefined" &&
      document.querySelector('[data-supermarket-dialog-overlay="true"]') !== null
    ) {
      return;
    }
    inputRef.current?.focus();
  }, [isActive, inputDisabled, modalOpen, inputRef]);

  return (
    <form
      className="pos-scan-bar"
      onSubmit={(e) => {
        e.preventDefault();
        if (inputDisabled || disabled) return;
        const accepted = onScan(scanInput);
        if (accepted) {
          setScanInput("");
        }
      }}
    >
      <input
        ref={inputRef}
        id="pos-barcode-input"
        aria-label="Scan EAN-13, UPC-A, GS1 scale barcode, or 4-5 digit PLU"
        aria-invalid={invalid || undefined}
        aria-describedby={invalid && errorId ? errorId : undefined}
        className="input"
        placeholder="Scan EAN-13 / GS1 barcode or enter PLU..."
        value={scanInput}
        disabled={inputDisabled}
        onChange={(e) => setScanInput(e.target.value)}
      />
      <button type="submit" className="btn btn-primary" disabled={disabled || inputDisabled}>
        Scan Item
      </button>
    </form>
  );
});
