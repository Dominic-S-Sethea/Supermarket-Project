# Overnight Run #2 Report — Milestones 1–3 End-to-End Workflows, Production Hardening, Playwright E2E & CI

**Branch:** `overnight/m1-m3-and-prod-readiness` (stacked cleanly on `overnight/production-hardening` / Draft PR #1)  
**Target Stack:** TypeScript Monorepo (`packages/shared`, `apps/api`, `apps/web`), Python 3.12 Analytics (`services/analytics`), Rust Tauri ESC/POS (`apps/pos/src-tauri`), PostgreSQL 16, Docker, Playwright E2E, GitHub Actions CI  
**Date:** 2026-11-25

---

## Executive Summary

All 7 phases of the Milestone 1–3 & Production Readiness roadmap completed autonomously with **100% passing verification across TypeScript, Python, Rust, Docker, PostgreSQL query plans, and headless Playwright E2E**:

- **Milestone 1 (Supplier OTIF & 3-Way Match):** Auto-detects short/over deliveries and >1% invoice unit cost variances during PO-linked GRN receiving (`POST /api/purchasing/grn`), exposes 90-day Supplier OTIF Scorecards & Variance resolution routes, and adds a full **Supplier OTIF & 3-Way Match** workbench inside `OperationsView`.
- **Milestone 2 (Shelf Integrity, Dynamic Markdowns & 07:30 Shelf Tags):** Exposes Phantom Stock blind count verification, elasticity-optimized Dynamic FEFO Markdown application (atomically creating clearance promos + queuing shelf tags), and batch Zebra ZPL shelf-tag printing—wired into a **Shelf Integrity & 07:30 Tags** tab accessible to Store Managers, Owners, and Stock Clerks with strict RBAC.
- **Milestone 3 (Loyalty CRM, Atomic Coupons, Promotions, POS Voids/Refunds, Staffing & Floor Tasks):** Adds RFM Loyalty CRM, `FOR UPDATE`-locked single-use coupon validation & redemption (proven race-free under concurrent double-redemption tests), automatic 1-pt/$1 points accrual & void/refund clawback, upgraded POS terminal (loyalty lookup, coupon apply, Open Shift, Recent Receipts + Manager Void/Refund), Promotions Manager, Hourly Lane Staffing Roster, and Daily Floor Task Checklist.
- **Production Hardening, Rust Audit & Containerization:** Upgraded `/api/health` to run live PostgreSQL `SELECT 1` readiness probes + `/api/health/live`, added graceful `SIGTERM`/`SIGINT` HTTP + PG pool shutdown, added 4 M1–M3 read tools to AI Copilot, hardened Rust ESC/POS LAN printer driver against SSRF (RFC1918/loopback allowlist), C0/C1 control-code injection, and oversized payloads (7/7 zero-warning `cargo test`), and added & verified multi-stage production Dockerfiles (`api`, `web` Nginx, `analytics`) + `docker-compose.prod.yml` + `.env.example`.
- **Playwright E2E, DB Indexing & GitHub Actions CI:** Built a 5-journey Playwright E2E suite running against the compiled API + Vite preview build + live PG 16 (5/5 passing with 0 console/page/API errors), fixed a real `/favicon.ico` 404 caught by Playwright, added 3 high-impact PostgreSQL indexes verified with `EXPLAIN ANALYZE`, and added `.github/workflows/ci.yml`.

---

## Commit-by-Commit Log

| Commit | Phase | Summary |
|---|---|---|
| `3007bd4` | Phase 1 | `feat(m1): add Supplier OTIF scorecards, 3-way GRN dock variance detection & resolution UI` |
| `8ee9037` | Phase 2 | `feat(m2): add Phantom Stock verification, Dynamic Markdown apply & 07:30 Shelf Tag ZPL print queue` |
| `b0f2e12` | Phase 3 | `feat(m3): add Loyalty CRM, atomic single-use coupon redemption, Promotions Manager & POS receipts/voids` |
| `89fc192` | Phase 4 | `feat(m3): add Hourly Lane Staffing Planner and Daily Floor Task Checklist` |
| `15b78b4` | Phase 5 | `feat(prod): add DB health probe, graceful shutdown, M1-M3 AI tools, hardened Rust ESC/POS & production Dockerfiles` |
| `3f6a1b4` | Phase 6 | `test(e2e): add Playwright full-stack E2E smoke suite, SVG favicon & GitHub Actions CI workflow` |
| *(this commit)* | Phase 7 | `perf(db): add hot-query PostgreSQL indexes and OVERNIGHT_REPORT_2.md` |

---

## New API Endpoints & Capabilities Added

### Milestone 1 — Purchasing & Supplier Performance (`apps/api/src/routes/inventory.ts`)
- Enhanced `POST /api/purchasing/grn` to auto-generate `grn_variances` rows (`short_delivery`, `over_delivery`, `cost_overcharge`, `cost_savings`) whenever PO-linked receipts diverge in quantity or >1% unit cost.
- `GET /api/purchasing/supplier-scorecards` (`owner`, `manager`, `accountant`) — 90-day OTIF/On-Time/In-Full/lead-time σ/A–D grades + live open variance exposure.
- `GET /api/purchasing/variances` (`owner`, `manager`, `accountant`) — filterable 3-way dock variance queue with financial exposure summary.
- `PATCH /api/purchasing/variances/:id` (`owner`, `manager`) — dispute, resolve with credit note, or write off with audit trail.

### Milestone 2 — Shelf Integrity, Dynamic Markdowns & 07:30 ZPL Tags (`apps/api/src/routes/operations.ts`)
- `GET /api/inventory/phantom-stock` & `POST /api/inventory/phantom-stock/:productId/verify` (`owner`, `manager`, `stock_clerk`) — blind cycle-count recount & ledger adjustment.
- `GET /api/inventory/dynamic-markdowns` & `POST /api/inventory/dynamic-markdowns/:batchId/apply` (`owner`, `manager`) — atomically creates clearance promotion, marks batch `clearance`, queues shelf tag, and marks markdown `applied`.
- `GET /api/labels/queue` & `POST /api/labels/queue/print` (`owner`, `manager`, `stock_clerk`) — generates sanitized combined Zebra ZPL batch and marks tags printed with operator & timestamp.

### Milestone 3 — Loyalty CRM, Coupons, Staffing & Floor Tasks (`apps/api/src/routes/loyalty.ts`, `pos.ts`, `catalog.ts`, `operations.ts`)
- `GET /api/loyalty/customers`, `POST /api/loyalty/customers` — RFM customer directory, search & instant enrollment (409 on duplicate phone).
- `GET /api/loyalty/coupons`, `POST /api/loyalty/coupons`, `GET /api/loyalty/coupons/validate/:code` — targeted single-use coupon issuance & live eligibility validation.
- Enhanced `POST /api/pos/sales` — `FOR UPDATE` row-locked single-use coupon redemption (atomic 409 on concurrent double-redeem while preserving 200 idempotent replay by sale UUIDv7), 1 pt/\$1 customer points accrual, and refund/void points clawback.
- Enhanced `GET /api/pos/recent-sales` — includes `lines`, `payments`, and `alreadyVoided` flag for Manager Void/Refund modal.
- `PATCH /api/promotions/:id` (`owner`, `manager`) — pause/activate promotions with audit logging.
- `GET /api/operations/staffing-plan`, `POST /api/operations/staffing-plan/generate`, `PATCH /api/operations/staffing-plan/:id` — 28-day footfall-driven hourly checkout lane roster generator & cashier assignment.
- `GET /api/operations/tasks`, `POST /api/operations/tasks/:id/complete` (`owner`, `manager`, `stock_clerk`) — daily floor task checklist with optional blind-count ledger reconciliation.

### Production Hardening, AI Tools & Rust POS
- `GET /api/health` (live PostgreSQL `SELECT 1` readiness + `dbLatencyMs`, returns `503` on DB failure) and `GET /api/health/live` (fast liveness).
- Graceful `SIGTERM`/`SIGINT` Fastify + PG pool shutdown in `apps/api/src/server.ts`.
- 4 new AI Copilot read tools (`get_supplier_scorecards`, `get_phantom_stock_alerts`, `get_dynamic_markdowns`, `get_floor_tasks`) wired into both Gemini tool definitions and local fallback router.
- Hardened `apps/pos/src-tauri/src/escpos.rs`: strict RFC1918/loopback LAN printer allowlist blocking SSRF (`169.254.169.254`, public IPs, port 0), full C0/C1 control-character sanitization (`c.is_control()`), `MAX_RECEIPT_BYTES` (64 KiB) guard, socket write timeout, and 7 unit tests.

---

## PostgreSQL `EXPLAIN ANALYZE` Query Plan Audit & New Indexes

Added 3 targeted idempotent indexes in `apps/api/src/db/applyConstraints.ts`:
1. `idx_sales_kind_sold_at` on `sales (kind, sold_at)` — supports date-range analytics filtered by `kind = 'sale'`.
2. `idx_sales_original_sale` partial index on `sales (original_sale_id) WHERE original_sale_id IS NOT NULL` — reduced void lookup to **0.039 ms** (`Index Scan`, 2 buffer hits).
3. `uq_targeted_coupons_upper_code` functional unique index on `targeted_coupons (upper(code))` — guarantees case-insensitive coupon uniqueness and fast POS lookup.

Observed live execution times on 3,120-SKU seeded PostgreSQL 16 DB:
- Catalog paginated query with `v_product_live_stock`: **0.647 ms** (`Index Scan using products_sku_unique`)
- 30-day executive overview aggregate: **3.543 ms** (`Index Scan using idx_sales_sold_at`)
- Daily floor task checklist: **0.173 ms** (`Index Scan using idx_store_tasks_date_status`)
- Void duplicate check: **0.039 ms** (`Index Scan using idx_sales_original_sale`)

---

## Full Verification Matrix

| Check | Command | Result |
|---|---|---|
| TypeScript Strict Typecheck | `pnpm typecheck` | **PASS** (shared, api, web) |
| Production Build | `pnpm build` | **PASS** (tsc + Vite production bundle) |
| Shared Pricing & Math Unit Tests | `pnpm --filter @supermarket/shared test` | **PASS** — 21/21 passed |
| Web Cache & API Unit Tests | `pnpm --filter @supermarket/web test` | **PASS** — 7/7 passed |
| API Integration Tests (live PG 16) | `pnpm --filter @supermarket/api test` | **PASS** — 15/15 passed |
| Python Analytics Test Suite | `uv --directory services/analytics run pytest -v` | **PASS** — 17/17 passed |
| Analytics Idempotency (2× back-to-back) | `pnpm analytics:run && pnpm analytics:run` | **PASS** — 0 duplicate rows/tasks |
| Rust ESC/POS Unit Tests | `cargo test --manifest-path apps/pos/src-tauri/Cargo.toml` | **PASS** — 7/7 passed (0 warnings) |
| Playwright Headless E2E Suite | `pnpm test:e2e` | **PASS** — 5/5 passed (0 console/page/API errors) |
| Production `AUTH_SECRET` Fail-Fast | `NODE_ENV=production AUTH_SECRET=too-short node apps/api/dist/config/env.js` | **PASS** — exits non-zero with FATAL guard |
| Production Docker Multi-Stage Builds | `docker build` (`Dockerfile.api`, `Dockerfile.web`, `Dockerfile.analytics`) | **PASS** — 3/3 images built cleanly |

---

## Known Notes & Merge Commands

- Live `GEMINI_API_KEY` is intentionally absent in the cloud VM; all AI Copilot, Semantic Search, Briefing, and Invoice Scanner workflows were verified through the deterministic local fallback path.
- `vite build` notes a single chunk at `523.6 kB` (`>500 kB` threshold); route-level `React.lazy` code-splitting is queued in the follow-up Wave 2 optimization pass.

```bash
# Review diff stacked on PR #1 (overnight/production-hardening)
git fetch origin
git log --oneline origin/overnight/production-hardening..origin/overnight/m1-m3-and-prod-readiness

# Merge order: review & merge PR #1 into main first, then rebase/merge PR #2 into main.
```
