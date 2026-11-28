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
  const qrResult = useMemo<
    { ok: true; pathD: string; viewBoxSize: number } | { ok: false; error: string }
  >(() => {
    try {
      if (!payload || payload.trim().length === 0) {
        return { ok: false, error: "Empty QR payload" };
      }
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
        ok: true,
        pathD: parts.join(""),
        viewBoxSize: matrix.size + quiet * 2,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Failed encoding QR matrix",
      };
    }
  }, [payload]);

  if (!qrResult.ok) {
    return (
      <div
        role="alert"
        className="banner banner-red"
        style={{
          width: sizePx,
          minHeight: Math.min(sizePx, 120),
          boxSizing: "border-box",
          fontSize: 12,
          margin: 0,
        }}
      >
        <span>Unable to render QR matrix: {qrResult.error}</span>
      </div>
    );
  }

  return (
    <svg
      role="img"
      aria-label={label}
      width={sizePx}
      height={sizePx}
      viewBox={`0 0 ${qrResult.viewBoxSize} ${qrResult.viewBoxSize}`}
      shapeRendering="crispEdges"
      style={{
        display: "block",
        borderRadius: 10,
        border: "1px solid var(--border-hairline)",
        background: "#ffffff",
      }}
    >
      <rect width={qrResult.viewBoxSize} height={qrResult.viewBoxSize} fill="#ffffff" />
      <path d={qrResult.pathD} fill="#000000" />
    </svg>
  );
}
