# SupermarketOS — 3,000+ SKU Packaged-Goods Retail Platform

End-to-end management, offline-first POS checkout, FEFO inventory & receiving, and predictive retail analytics built specifically for a **3,000+ SKU packaged-goods supermarket** (beer, beverages, snacks, instant noodles, FMCG).

## Monorepo Architecture

- [`packages/shared`](packages/shared) — Integer minor-unit currency/tax math, GS1 EAN-13/UPC-A/ITF-14 barcode validator, RFC 9562 UUIDv7 generator, and deterministic **Promotion & Multi-UOM Cart Pricing Engine** (Mix-and-Match, BOGO, Volume Tiers, Floor-Price Margin Guards).
- [`apps/api`](apps/api) — Fastify 5 + Drizzle ORM + PostgreSQL 16 REST API with immutable stock ledger (`stock_movements` + `stock_baselines` folding), idempotent offline POS uploads, bonus-case GRN effective cost math, margin-erosion alerts, and accounting CSV export.
- [`apps/web`](apps/web) — React 19 + Vite + Vanilla CSS Back-Office, Owner BI Portal, and Live Offline-First POS Checkout Terminal Simulator.
- [`apps/pos/src-tauri`](apps/pos/src-tauri) — Rust Tauri 2 hardware bridge for 80mm LAN/USB ESC/POS thermal receipt printing and RJ-11 cash drawer kick pulses.
- [`apps/mobile`](apps/mobile) — Phase 3 Expo Mobile Aisle Companion App blueprint (Zebra DataWedge / Sunmi PDA + camera scanning).
- [`services/analytics`](services/analytics) — Python 3.12 (`uv`, NumPy, Polars, psycopg) analytics & forecasting worker computing ABC-XYZ 3×3 segmentation, `WeekendETS` + `CrostonSBA` demand forecasts, case-rounded Auto-PO drafts, Market Basket Association Rules, and Cashier Loss-Prevention Z-scores.
- [`infra`](infra) — PostgreSQL 16 Docker Compose (logical replication enabled) + PowerSync sync rules.

## Quick Start

```bash
# 1. Start PostgreSQL 16
pnpm db:up

# 2. Push schema & seed 3,120 packaged SKUs + 7,950 multi-UOM barcodes + 60 days of receipts
pnpm db:push
pnpm db:seed

# 3. Run Python Analytics & ML Worker (ABC-XYZ, Forecasts, Market Basket, Loss Prevention)
pnpm analytics:run

# 4. Run full verification (typecheck + shared unit tests + live Postgres API integration tests)
pnpm typecheck
pnpm test

# 5. Start API (port 4000) & Web Portal / POS Terminal (port 5173)
pnpm dev:api
pnpm dev:web
```
