import { useMemo } from "react";
import { generateQrMatrix } from "@supermarket/shared/emvqr";

/**
 * Pure, accessible SVG renderer for ISO/IEC 18004 QR Code Model 2 matrices
 * with mandatory 4-module white quiet zone for reliable banking-app scanning
 * across Navy, Carbon Dark, and Light themes.
 */
export function QrCodeSvg({
  payload,
  sizePx = 220,
  label = "EMVCo Payment QR Code",
}: {
  payload: string;
  sizePx?: number;
  label?: string;
}) {
  const { pathD, viewBoxSize } = useMemo(() => {
    const matrix = generateQrMatrix(payload);
    const quiet = 4;
    const parts: string[] = [];
    for (let r = 0; r < matrix.size; r++) {
      for (let c = 0; c < matrix.size; c++) {
        if (matrix.modules[r][c]) {
          parts.push(`M${c + quiet},${r + quiet}h1v1h-1z`);
        }
      }
    }
    return {
      pathD: parts.join(""),
      viewBoxSize: matrix.size + quiet * 2,
    };
  }, [payload]);

  return (
    <svg
      role="img"
      aria-label={label}
      width={sizePx}
      height={sizePx}
      viewBox={`0 0 ${viewBoxSize} ${viewBoxSize}`}
      shapeRendering="crispEdges"
      style={{
        display: "block",
        borderRadius: 10,
        border: "1px solid var(--border-hairline)",
        background: "#ffffff",
      }}
    >
      <rect width={viewBoxSize} height={viewBoxSize} fill="#ffffff" />
      <path d={pathD} fill="#000000" />
    </svg>
  );
}
