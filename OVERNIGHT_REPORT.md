# Overnight Production Hardening Report

**Repository:** `Dominic-S-Sethea/Supermarket-Project`  
**Branch:** `overnight/production-hardening` (branched from `main` @ `0243c0c`)  
**Date:** 2026-11-25  
**Scope:** End-to-end security, financial/inventory correctness, web portal & offline POS resilience, and Python analytics/ML worker hardening across `packages/shared`, `apps/api`, `apps/web`, and `services/analytics`.

---

## 1. Executive Summary

Starting from a live baseline where fresh-clone seeding failed, `apps/api` failed TypeScript compilation with 7 errors, `GET /api/meta` crashed with a `ReferenceError` at runtime, `cashier4`/`cashier5` were seeded with unusable `"{}"` PIN hashes, security headers/CSRF checks were unregistered, and several numerical/frontend edge cases risked financial miscalculation or crashes, this overnight hardening pass resolved **30+ concrete bugs and security gaps** across all four workspace packages without adding unnecessary dependencies or breaking existing API contracts or seed data:

- **Security & RBAC (`apps/api`):** Wired previously unregistered security headers and CSRF origin checks, closed a CORS origin-reflection hole on the hijacked SSE `/api/ai/chat/stream` endpoint, enforced live `users.active = true` checks on every authenticated request, restricted financial analytics & AI Morning Briefing endpoints from low-privilege roles (`cashier`/`stock_clerk`), mitigated login username enumeration timing, sanitized 5xx SQL/stack traces, and hardened malformed cookie/UUID/query handling.
- **Financial, Pricing & Inventory Invariants (`packages/shared` + `apps/api`):** Replaced naive promo rounding with Hamilton Largest Remainder allocation (eliminating multi-line cent over-allocation), fixed combinable promo double-discounting, enforced server-side tax-aware line totals and 18+ alcohol age verification on POS uploads, added `FOR UPDATE` locking on FEFO batch depletion, MWAC GRN cost updates, shift closeouts, and AI action execution, prevented double-voids and double-executed AI actions, and added partial PO receipt tracking plus PostgreSQL partial unique / CHECK constraints.
- **Web Portal & Offline POS (`apps/web`):** Introduced a typed `ApiError` class with HTTP status and Zod flattened error formatting—fixing a critical bug where `PosTerminalView` failed to detect 400/403 rejections and queued rejected sales forever while printing fake `[SYNCED]` receipts. Added double-tender locking, alcohol age-check reset on empty baskets, scanner input focus/selection UX, `startsAt`/`endsAt` offline promo mapping, IndexedDB handle cleanup & snapshot validation, RBAC UI gating across all views (fixing broken 403 banners for `stock_clerk` and `accountant`), SSE `AbortController` cleanup, responsive CSS breakpoints, and a zero-dependency Node test suite (`apps/web/tests/posCache.test.ts`).
- **Analytics & ML Worker (`services/analytics`):** Eliminated `NaN`/`Infinity` write hazards via `safe_float`, `sanitize_series`, and `safe_json_dumps(..., allow_nan=False)`, fixed a K-Means++ crash on identical rows (`ValueError: probabilities do not sum to 1`), fixed afternoon shift duration (`5.0h`, was `3.0h`), hardened Ridge/DiD/Croston/ETS/OTIF/phantom/markdown edge cases, wrapped the entire 7-stage pipeline in atomic psycopg 3 transactions, and proved idempotency with back-to-back runs against PostgreSQL 16.
- **Test Coverage Growth:** Total automated tests increased from **27** (with 1 pre-existing API failure and 0 web tests) to **54 passing tests** across all 4 packages (`21` shared + `10` API integration + `6` web + `17` Python analytics), with **0 failures** and **0 TypeScript errors**.

---

## 2. Commit-by-Commit Log & Files Changed

| Commit | Phase | Summary | Scope |
| :--- | :--- | :--- | :--- |
| `ea95079` | Phase 1 | Harden auth/RBAC, POS/pricing/inventory invariants, AI resilience & tests | 22 files (`package.json`, `packages/shared/*`, `apps/api/*`) |
| `9cd6646` | Phase 2 | Harden web portal, RBAC UI gating, offline POS queue/cache & tests | 16 files (`apps/web/*`) |
| `c74da35` | Phase 3 | Harden analytics worker numerical safety, JSONB/DB transactions & edge-case tests | 2 files (`services/analytics/*`) |
| *(this commit)* | Phase 4 | Add `OVERNIGHT_REPORT.md` with full audit log and verification matrix | 1 file (`OVERNIGHT_REPORT.md`) |

### Complete List of Changed Code Files (40 files)
- **Root:** `package.json`
- **Shared (`packages/shared`):** `src/money.ts`, `src/pricing.ts`, `src/schemas.ts`, `src/__tests__/shared.test.ts`
- **API (`apps/api`):** `src/app.ts`, `src/db/applyConstraints.ts`, `src/db/seed.ts`, `src/plugins/auth.ts`, `src/plugins/security.ts`, `src/routes/ai.ts`, `src/routes/analytics.ts`, `src/routes/auth.ts`, `src/routes/catalog.ts`, `src/routes/inventory.ts`, `src/routes/pos.ts`, `src/ai/copilot.ts`, `src/ai/invoice.ts`, `src/ai/semantic.ts`, `src/ai/tools.ts`, `src/ai/triage.ts`, `src/__tests__/api.integration.test.ts`
- **Web (`apps/web`):** `package.json`, `tsconfig.node.json`, `src/App.tsx`, `src/api.ts`, `src/index.css`, `src/lib/posCache.ts`, `src/components/AiCopilotDrawer.tsx`, `src/components/LoginScreen.tsx`, `src/views/AbcLossView.tsx`, `src/views/CatalogView.tsx`, `src/views/ForecastingBasketView.tsx`, `src/views/OperationsView.tsx`, `src/views/OverviewView.tsx`, `src/views/PosTerminalView.tsx`, `src/views/ShiftDiagnosticsView.tsx`, `tests/posCache.test.ts` *(new)*
- **Analytics (`services/analytics`):** `run_all.py`, `test_analytics.py`

---

## 3. Bugs, Vulnerabilities & Edge Cases Fixed

### Phase 1 — Backend, Shared Pricing & Security

| Severity | Area & Location | Root Cause | Fix Implemented | Covering Test |
| :--- | :--- | :--- | :--- | :--- |
| **Critical** | SSE CORS Origin Reflection (`apps/api/src/routes/ai.ts`) | Hijacked `/api/ai/chat/stream` echoed any incoming `Origin` header with `Access-Control-Allow-Credentials: true`, bypassing Fastify's CORS allowlist. | Checked `app.allowedOrigins.has(origin)` before emitting ACAO/ACAC headers; added security headers, client disconnect handling, and error sanitization. | `apps/api/src/__tests__/api.integration.test.ts` (SSE CORS guard test) |
| **Critical** | Unregistered Security Headers & CSRF Check (`apps/api/src/app.ts`) | `registerSecurityHeaders()` and `registerCsrfOriginCheck()` existed in `security.ts` but were never registered on the Fastify instance; CORS denials threw HTTP 500 instead of 403. | Registered both plugins in `buildApp()`, exposed `app.allowedOrigins`, mapped CORS denials to `403`, and added centralized error handler mapping PG codes (`22P02`, `23505`, `23503`, `23514`) while hiding 5xx SQL/stack traces. | `api.integration.test.ts` (security headers, CSRF cross-origin block, CORS 403) |
| **High** | Runtime Crash in `GET /api/meta` & Build Break (`apps/api/src/routes/catalog.ts`, `seed.ts`) | `GET /api/meta` referenced `req.authUser` without accepting `(req)` in its handler signature (TS error + runtime `ReferenceError` 500). `seed.ts` missed `await` on `hashPin()` for `cashier4`/`cashier5`, writing `"{}"` into `pin_hash`, and had 4 TS type errors on `customerRows`. | Fixed handler signature, added `await` + self-heal for corrupted `pin_hash` rows, fixed `customerRows` typing, and updated root `db:seed` script to build `@supermarket/shared` first. | `pnpm typecheck`, `pnpm build`, `api.integration.test.ts` (`cashier4` login + `/api/meta`) |
| **High** | Stale Session / Deactivated User Auth Bypass (`apps/api/src/plugins/auth.ts`, `security.ts`, `routes/auth.ts`) | `extractSession` trusted JWT role/status without checking live `users.active`; malformed percent-encoded cookies caused uncaught `URIError`; non-existent usernames returned early without scrypt work. | Joined `users` table in `extractSession` enforcing `users.active = true` and `userSessions.userId = verified.user.id`; wrapped `decodeURIComponent` safely; added `runDummyPinWork` timing mitigation. | `api.integration.test.ts` (deactivated user immediately rejected, malformed cookie handled) |
| **High** | RBAC Data Leakage on Financial & Briefing Routes (`routes/analytics.ts`, `routes/ai.ts`, `routes/pos.ts`) | `cashier`/`stock_clerk` could query financial P&L (`overview`, `departments`, `abc-xyz`, `forecasts`, `shift-diagnostics`) and `GET /api/ai/briefing` (exposing LP anomalies). | Enforced `requireRole(["owner", "manager", "accountant"])` on financial analytics & briefing endpoints; restricted `/api/pos/bootstrap` and `/api/pos/recent-sales`. | `api.integration.test.ts` (RBAC 403 checks for `cashier` / `stock_clerk`) |
| **High** | POS Integrity: Tampered Totals, Unverified Alcohol, Double-Voids & FEFO Races (`routes/pos.ts`, `db/applyConstraints.ts`) | Server did not validate tax-aware `lineTotalCents`, did not enforce `ageVerified` for `requiresAgeCheck` SKUs, allowed double-voiding the same `originalSaleId`, and lacked `FOR UPDATE` locking on FEFO batches and open-shift closeouts. | Added authoritative product/tax lookup, line-total & payment tender validation, mandatory 18+ `ageVerified`, duplicate-void 409 guard, deterministic `FOR UPDATE` batch locking, atomic shift close, `getPgErrorCode` inspection (`err.cause?.code`), and partial unique index `uq_pos_shifts_open_register` + CHECK constraints. | `api.integration.test.ts` (tampered total 400, alcohol 400, duplicate receipt 409, double-void 409, concurrent FEFO depletion) |
| **High** | Pricing Engine Rounding Over-Allocation & Promo Double-Discounting (`packages/shared/src/pricing.ts`, `money.ts`, `schemas.ts`) | Naive per-line `Math.round` over-allocated `flatDiscountCents` (e.g., 5 lines sharing 3¢ allocated 4¢); combinable `clearance` + `mix_and_match` double-discounted off original price; non-finite / negative params propagated `NaN` or `-$0.00`. | Implemented Hamilton Largest Remainder (`allocateProportionalCents`), computed remaining per-pack price before stacked `mix_and_match`/`bogo`, sanitized all numeric inputs in `money.ts`/`pricing.ts`, and refined `CreateGrnSchema` (≥1 case) and `CreatePromotionSchema` (paired daypart & `startsAt <= endsAt`). | `packages/shared/src/__tests__/shared.test.ts` (21/21 passing) |
| **High** | Concurrent Double-Execution of AI Proposed Actions & Unvalidated Tool Inputs (`routes/ai.ts`, `ai/tools.ts`, `ai/triage.ts`, `ai/copilot.ts`, `ai/semantic.ts`, `ai/invoice.ts`) | Concurrent POSTs to `/api/ai/actions/:id/execute` could execute the same PO/price/promo twice; Copilot tool arguments lacked UUID/range validation; `triage.ts` propagated `NaN`; Gemini errors could leak tokens; partial embedding batch failure left mixed vectors. | Added `FOR UPDATE` lock + Zod payload validation on action execution, enqueued `shelfTagQueue` on AI price updates, validated all tool args with strict UUID/SKU resolution, guarded triage metrics, redacted keys in Gemini error strings, cleared partial `upsertRows` on embedding failure, and added base64 text/CSV decoding for offline invoices. | `api.integration.test.ts` (concurrent action execute 200+409, malformed tool args, `NaN` triage, base64 invoice) |
| **Medium** | Inventory & Catalog Concurrency / Validation Gaps (`routes/inventory.ts`, `routes/catalog.ts`) | `?days=abc` produced `NaN` dates; `margin-alerts/apply-price` lacked Zod validation & barcode locks; GRNs didn't lock products for MWAC or update `purchaseOrderLines.receivedCases` / PO status; `POST /api/products` allowed multiple primary barcodes; empty `PATCH` barcode failed cryptically. | Added UUID/NaN guards, Zod validation (`customPriceCents >= 1`), `FOR UPDATE` locks on GRN MWAC & cycle counts, partial/full PO receipt tracking, blocked GRNs on `cancelled` POs, atomic primary barcode swap, and transactional `shelfTagQueue`. | `api.integration.test.ts` (invalid UUID 400, `?days=abc`, 0-case GRN 400, partial PO receipt, negative price 400, empty PATCH 400) |

### Phase 2 — Web Portal & Offline POS

| Severity | Area & Location | Root Cause | Fix Implemented | Covering Test |
| :--- | :--- | :--- | :--- | :--- |
| **High** | Offline POS Queued Rejected 400/403 Sales Forever & Printed Fake `[SYNCED]` Receipts (`apps/web/src/api.ts`, `lib/posCache.ts`, `views/PosTerminalView.tsx`) | `api.ts` stripped HTTP status codes from structured JSON `{ error: "..." }` messages, so `msg.includes("(400)")` never matched; `completeSale` also set `[SYNCED]` receipt preview *before* `apiPost` resolved. | Created typed `ApiError` with `.status` + Zod flattened error formatter; added `classifySaleSyncError()` separating `"permanent"` (400/403/404/409/422), `"auth"` (401 — preserved in queue!), and `"retryable"` (5xx/network); built receipt preview only after final status is known. | `apps/web/tests/posCache.test.ts` (6/6 passing) |
| **High** | Broken `OperationsView` for `stock_clerk` & Unauthorized Buttons for `accountant`/`cashier` (`App.tsx`, `OperationsView.tsx`, `CatalogView.tsx`, `AbcLossView.tsx`, `ForecastingBasketView.tsx`, `ShiftDiagnosticsView.tsx`, `OverviewView.tsx`) | `OperationsView` unconditionally fetched manager-only `/api/inventory/margin-alerts` (403 for `stock_clerk`); `CatalogView`, `AbcLossView`, `ForecastingBasketView`, and `ShiftDiagnosticsView` exposed manager/operator actions to `cashier`/`accountant`; `OverviewView` allowed `accountant` to click briefing links into disallowed tabs. | Propagated `userRole` and `allowedTabs` from `App.tsx` and gated all restricted fetches, buttons, and navigation targets cleanly per role. | `pnpm --filter @supermarket/web typecheck && build` |
| **High** | Alcohol Age-Check Carryover & Double-Tender Race (`PosTerminalView.tsx`) | Decrementing the last basket item to 0 left `ageVerified = true` for the next customer; rapid Cash/Card clicks submitted duplicate sales; unknown barcode scans stayed unselected so the next USB HID scan concatenated onto the bad code. | Reset `ageVerified` whenever `cart.length === 0`, added ref+state `submittingSale` lock, auto-selected failed scan input, added `online` event auto-flush, Escape modal close, and scanner auto-focus on tab switch. | `pnpm --filter @supermarket/web typecheck && build` |
| **Medium** | Offline Expired Promos & IndexedDB Handle Leaks (`lib/posCache.ts`) | `PosBootstrapSnapshot` omitted `startsAt`/`endsAt` on promotions, `loadPosCache`/`savePosCache` never closed `IDBDatabase` handles, and corrupt cache/localStorage entries could crash hydration. | Added `startsAt`/`endsAt` mapping (`mapBootstrapPromotions`), `isValidPosSnapshot` guard, `db.close()` in all settlement paths, `onblocked`/`onabort` handling, `clearPosCache()`, and resilient `loadOfflineQueue`/`saveOfflineQueue`. | `apps/web/tests/posCache.test.ts` |
| **Medium** | Unhandled Errors, Blank Screens & Stale SSE/Fetch Races (`OverviewView.tsx`, `CatalogView.tsx`, `AbcLossView.tsx`, `AiCopilotDrawer.tsx`) | `OverviewView` and `AbcLossView` had no error catch UI (`if (!overview) return null` rendered blank screen); `CatalogView` computed gross instead of net margin on pack tiers and showed errors in green banners; `AiCopilotDrawer` lacked `AbortController`, dropped trailing SSE chunks without `\n\n`, and left orphaned optimistic messages on error. | Added error/retry banners, empty states, `AbortController` cleanup, `computeNetMarginBp` on pack tiers, color-coded notices, SSE abort/trailing-flush/rollback, per-action executing lock, and global 401 session-expiry redirect in `App.tsx` + `LoginScreen.tsx`. | `apps/web/tests/posCache.test.ts`, `pnpm --filter @supermarket/web typecheck && build` |
| **Low** | Mobile Responsive Overflow (`apps/web/src/index.css`) | `.abc-grid`, `.form-grid`, `.persona-grid`, `.tender-grid`, `.panel-header`, and `.pos-scan-bar` overflowed or crushed inputs below 600–820px. | Added wrapping and responsive breakpoints at `<= 820px` and `<= 600px` with horizontal scroll container on `.abc-grid`. | `pnpm --filter @supermarket/web build` |

### Phase 3 — Analytics & ML Worker (`services/analytics`)

| Severity | Area & Location | Root Cause | Fix Implemented | Covering Test |
| :--- | :--- | :--- | :--- | :--- |
| **High** | K-Means++ Crash on Identical Points (`run_all.py:kmeans_missions`) | `probs = sq_d / max(1e-9, float(sq_d.sum()))` produced all-zero `probs` when points were identical, raising `ValueError: probabilities do not sum to 1`. | Added distinct-point check (`< 2` unique rows -> single cluster), `nan_to_num` sanitization, and uniform fallback when `total_sq <= 1e-12`. | `test_analytics.py::test_kmeans_missions_handles_identical_points_empty_and_nan_without_crashing` |
| **High** | `NaN`/`Infinity` Corruption Risk to Postgres Numeric & JSONB Columns (`run_all.py`) | Python's `json.dumps` allows `NaN`/`Infinity` by default (which PostgreSQL `jsonb` rejects), and non-finite inputs in series/DiD/Ridge/OTIF/markdown propagated `NaN`/`Inf`. | Added `safe_float`, `sanitize_series`, `sanitize_json_payload`, and `safe_json_dumps(..., allow_nan=False)`; verified `0` `NaN`/`Infinity` rows in live Postgres across all analytics tables. | `test_analytics.py` (5 new edge-case test functions) + live `psql` NaN/Inf audit |
| **High** | Non-Atomic Multi-Stage Commits & Stale Rows on Empty Sources (`run_all.py`) | `main()` executed 7 independent `conn.commit()` calls without rollback isolation; `run_loss_prevention_anomalies` returned early without deleting stale rows when sales were empty; deleted suppliers remained in scorecards. | Wrapped `main()` and every stage in psycopg 3 `with conn.transaction():` (outer atomic transaction + inner savepoints, safe both in pipeline and standalone); cleared stale LP rows and pruned deleted supplier scorecards. | Back-to-back `pnpm analytics:run` idempotency check (identical row counts across all 10 tables) |
| **Medium** | Incorrect Afternoon Open-Hours Fallback (`run_all.py:run_shift_diagnostics`) | `SHIFT_HOURS["afternoon"]` was `3.0` instead of `5.0` (afternoon bucket is `12:00-16:59`, 5 full hours), inflating fallback revenue-per-hour by 1.67×. | Corrected `SHIFT_HOURS["afternoon"] = 5.0`. | Verified via live `pnpm analytics:run` |
| **Medium** | Ridge, Forecasting, DiD, Phantom, Markdown & Lane Edge Cases (`run_all.py`) | Zero/negative quantities or prices in `solve_optimal_markdown`, zero-holdout `y_te` or `lam <= 0` in Ridge, `NaN` in DiD/RFM/OTIF/lanes, or `min_lanes > max_lanes` could produce negative outputs, divide-by-zero, or singular matrix errors. | Hardened all pure analytical functions with bounds/finiteness guards and `np.linalg.lstsq` fallback on `LinAlgError`. | `services/analytics/test_analytics.py` (17/17 passing) |

---

## 4. Verification Matrix (Baseline vs. Final)

| Check / Command | Phase 0 Baseline (Pre-Edits) | Final State (`overnight/production-hardening`) |
| :--- | :--- | :--- |
| `pnpm db:up` | PASS (`supermarket-os-postgres` PG 16 healthy) | PASS (PG 16 healthy on port `5433`) |
| `pnpm db:seed` | **FAIL** on fresh clone (`@supermarket/shared/dist` missing); `cashier4`/`cashier5` seeded with `pin_hash="{}"` | **PASS** (builds `@supermarket/shared` first; self-heals `pin_hash`; applies new partial unique & CHECK constraints) |
| `pnpm typecheck` | **FAIL** (7 TS errors in `apps/api`: `seed.ts` & `catalog.ts`) | **PASS** (`packages/shared`, `apps/api`, `apps/web` incl. `apps/web/tests` — 0 errors) |
| `pnpm build` | **FAIL** (`apps/api` failed due to 7 TS errors) | **PASS** (`shared`, `api`, `web` Vite bundle built cleanly) |
| `pnpm test` (`@supermarket/shared`) | PASS (15/15) | **PASS (21/21)** |
| `pnpm test` (`@supermarket/api`) | **FAIL** (5/9 before analytics, 8/9 after analytics due to `GET /api/meta` 500) | **PASS (10/10)** (expanded with 20+ security, RBAC, concurrency & AI assertions) |
| `pnpm test` (`@supermarket/web`) | *(no test suite)* | **PASS (6/6)** (Node 22 built-in `node:test`, zero new deps) |
| `uv --directory services/analytics run pytest -v` | PASS (12/12) | **PASS (17/17)** |
| `pnpm analytics:run` (Run 1) | PASS | **PASS** (`3120` ABC-XYZ, `3120` forecasts, `65` basket rules, `5` LP, `1` shift diag, `7` suppliers, `80` phantom, `30` markdowns, `28` rosters, `15` tasks) |
| `pnpm analytics:run` (Run 2 — back-to-back idempotency) | *(unverified)* | **PASS** (100% identical row counts across all 10 tables; `0` `NaN`/`Infinity` rows verified via `psql`) |
| `git status` | Clean on `main` | Clean working tree on `overnight/production-hardening` |

---

## 5. Assumptions, Known Limitations & Prioritized Next Steps

### Engineering Assumptions Made
- **Session expiry vs. offline POS queue:** On HTTP `401`, `App.tsx` redirects the user to `LoginScreen` with a clear notice, while `PosTerminalView` classifies `401` as `"auth"` rather than `"permanent"` so queued cash/card receipts taken during an outage are **never discarded** when a cashier's session expires.
- **Zero extra dependencies for web tests:** Used Node 22's built-in `node:test` + native TypeScript type-stripping (aligned with `apps/web`'s existing `erasableSyntaxOnly: true`) so `pnpm test` runs frontend unit tests cleanly without introducing Vitest/Vite 8 peer-dependency conflicts.
- **Role access matrix:** Aligned UI visibility strictly with backend `requireRole(...)` definitions (`stock_clerk` sees FEFO expiry queue and blind cycle counts without manager-only margin overrides/GRNs; `accountant` sees financial analytics/briefing/forecasts/diagnostics in read-only mode without write buttons).

### Known Limitations
- **External `GEMINI_API_KEY` absent in VM:** Live Gemini API requests (LLM streaming, vision invoice OCR, Gemini embeddings) could not be exercised against Google's remote API. All local deterministic fallbacks (`local-deterministic-tools`, local semantic 256d embeddings, calibrated local triage, text/CSV invoice parsing, and SSE streaming) were verified end-to-end against PostgreSQL, and error sanitization was hardened for upstream Gemini failures.
- **Browser E2E / Visual Testing:** Frontend changes were verified via strict `tsc -b --noEmit`, Vite production builds, and unit tests for API/offline-cache logic, but headless Playwright browser clicks were not run in this pass.
- **Development Fallback `AUTH_SECRET`:** `apps/api` logs `[config] AUTH_SECRET is not set; using development fallback secret.` in dev/test; production deployments must inject a strong random `AUTH_SECRET` via environment variables.

### Top Prioritized Next Steps
1. **Production Environment Secrets & Deployment Config:** Require non-empty `AUTH_SECRET` when `NODE_ENV=production` (fail-fast startup check) and validate `GEMINI_API_KEY` against live Gemini SSE & invoice OCR in staging.
2. **Playwright E2E Smoke Suite:** Add a lightweight Playwright test suite covering login across all 5 roles (`owner`, `manager`, `cashier`, `stock_clerk`, `accountant`), offline POS outage simulation -> reconnect sync, and AI Copilot approval flow.
3. **Database Migrations Pipeline:** Transition from `drizzle-kit push` to versioned SQL migrations (incorporating `applyConstraints.ts`) for repeatable zero-downtime production rollouts.
4. **Rate Limiting & Brute-Force Lockout:** Add per-username/IP PIN attempt throttling on `POST /api/auth/login` backed by Postgres or Redis to complement the scrypt timing mitigation.

---

## 6. How to Review & Merge into `main`

```bash
# 1. Fetch the overnight branch locally
git fetch origin overnight/production-hardening

# 2. Inspect commit history and diffs against main
git log --oneline main..origin/overnight/production-hardening
git diff --stat main..origin/overnight/production-hardening

# 3. Check out the branch locally if you want to test in your browser
git checkout -b overnight/production-hardening origin/overnight/production-hardening
pnpm install && pnpm db:up && pnpm db:push && pnpm db:seed
pnpm typecheck && pnpm build && pnpm test
uv --directory services/analytics run pytest -v && pnpm analytics:run

# 4. Once satisfied (or after marking the Draft PR Ready for Review on GitHub):
git checkout main
git pull origin main
git merge --no-ff origin/overnight/production-hardening
git push origin main
```
