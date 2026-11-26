import { memo, type RefObject, useEffect, useState } from "react";

/**
 * Isolated POS barcode scan bar so per-keystroke / USB HID scanner input
 * stays local instead of re-rendering the entire PosTerminalView tree.
 */
export const PosScanBar = memo(function PosScanBar({
  inputRef,
  isActive,
  disabled,
  onScan,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  isActive: boolean;
  disabled: boolean;
  onScan: (rawCode: string) => boolean;
}) {
  const [scanInput, setScanInput] = useState("");

  useEffect(() => {
    if (!isActive) return;
    inputRef.current?.focus();
  }, [isActive, inputRef]);

  return (
    <form
      className="pos-scan-bar"
      onSubmit={(e) => {
        e.preventDefault();
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
        className="input"
        placeholder="Scan EAN-13 / GS1 scale barcode (20-29) or type 4-5 digit PLU (e.g. 4011) + Enter..."
        value={scanInput}
        onChange={(e) => setScanInput(e.target.value)}
      />
      <button type="submit" className="btn btn-primary" disabled={disabled}>
        Scan Item
      </button>
    </form>
  );
});
