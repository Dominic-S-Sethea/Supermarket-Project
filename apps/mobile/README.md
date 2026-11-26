# SupermarketOS — Mobile Aisle Companion App (Phase 3 Expo Target)

> **Status:** Roadmap specification only — not yet scaffolded as an active workspace package. All endpoints referenced below are live in `@supermarket/api`.

Designed for rugged Android barcode PDAs (Zebra TC2x via DataWedge, Sunmi L2s) and staff smartphones (`expo-camera` / Google ML Kit):

1. **Receive PO & Log Expiry:** Scan outer carton barcodes (`pack_qty = 24 / 30`), enter `paidCases` + `freeBonusCases`, log Best-Before dates → calls `POST /api/purchasing/grn`.
2. **ABC Daily Cycle Count:** Fetches today's prioritized A/B shelf list, captures blind counts → calls `POST /api/inventory/cycle-count`.
3. **FEFO Expiry Sweep:** Walks aisle-by-aisle through `GET /api/inventory/expiry-alerts` with 1-tap Clearance Markdown or Spoilage Write-Off.
4. **Price Check & Shelf Label Queue:** Scans `GET /api/products/scan/:barcode` and queues ZPL tags via `POST /api/labels/zpl`.
5. **Scan-to-Create Unknown SKU:** Queries `GET /api/lookup/barcode/:barcode` (Open Food Facts) and registers new packaged items directly from the floor.
