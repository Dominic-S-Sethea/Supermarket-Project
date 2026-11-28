# SupermarketOS Operations & Production Runbook

This runbook defines pre-cutover operational controls, secret management, database migrations, disaster-recovery backups, and privacy governance for SupermarketOS.

## 1. Mandatory Production Environment Variables

Start from `.env.production.template` (copy to `.env`, set `chmod 600 .env`) and configure all secrets before starting `@supermarket/api` or `services/analytics` with `NODE_ENV=production`:

- **Database Connectivity (`DATABASE_URL` or discrete `PG*`):**
  - Prefer discrete `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` in containerized deployments (`infra/docker-compose.prod.yml`) so strong passwords containing `@`, `:`, `/`, `?`, `#`, or `%` never break URI parsing.
- **Session Signing & Rotation:**
  - `AUTH_SECRET` (**REQUIRED**, >= 32 random chars; never use legacy dev strings).
  - `AUTH_SECRET_PREVIOUS` for zero-downtime key rotation: deploy with the new secret in `AUTH_SECRET` and old secret in `AUTH_SECRET_PREVIOUS` for at least one session TTL window before removing `AUTH_SECRET_PREVIOUS`.
- **Worker & Webhook Authentication:**
  - `ANALYTICS_WORKER_TOKEN` (**REQUIRED** on both `api` and `analytics`).
  - `PAYMENT_WEBHOOK_SECRET` (**REQUIRED** for HMAC-SHA256 payment webhook verification).
  - `METRICS_TOKEN` recommended when exposing `/api/metrics` across private networks.
- **TLS & Browser Security:**
  - Terminate TLS at your upstream load balancer/ingress and set `X-Forwarded-Proto: https` and `COOKIE_SECURE=true`.
  - Nginx emits `Strict-Transport-Security` only when `$smos_effective_scheme` is `https`, preventing plain-HTTP LAN cache lockout.

## 2. Database Migrations (Zero Data-Loss Path)

Never use `pnpm db:push` against production databases. Always run versioned Drizzle SQL migrations plus constraint/view reconciliation:

```bash
# From workspace source
pnpm db:migrate

# Inside the production API container (drizzle/ and migrateProd.js are bundled in /app/apps/api)
node apps/api/dist/db/migrateProd.js
```

## 3. Encrypted Backups, Restore Verification & RPO/RTO Targets

- **Target RPO:** <= 15 minutes (when continuous PostgreSQL WAL archiving / PITR is configured to off-site object storage) or <= 24 hours for daily logical snapshots alone.
- **Target RTO:** <= 60 minutes (isolated restore + `migrateProd.js` check + `/api/health` readiness).
- **Taking an Encrypted Off-Site Backup (`scripts/db-backup.sh`):**
  ```bash
  BACKUP_DIR=/var/backups/supermarket-os \
  BACKUP_AGE_RECIPIENT="age1..." \
  BACKUP_S3_URI="s3://my-bucket/supermarket-os-backups/" \
  BACKUP_RETENTION_DAYS=30 \
  bash scripts/db-backup.sh
  ```
- **Rehearsing Backup Restoration (`scripts/db-backup-verify.sh`):**
  Uses `umask 077`, private `0700` `mktemp -d` directories, `--serializable-deferrable` custom dumps, and dynamic table + `v_product_live_stock` parity verification without hardcoded row thresholds:
  ```bash
  bash scripts/db-backup-verify.sh
  ```

## 4. Privacy & External AI Data Minimization

- Set `GEMINI_STORE_INTERACTIONS=false` (default) so conversational prompts are not retained server-side on Gemini.
- Keep `AI_REDACT_STAFF_PII=true` (default) so cashier/staff identifiers are pseudonymized before external Gemini triage and morning briefing prompts.
- Use owner-only compliance endpoints (documented in `/api/openapi.json`):
  - `POST /api/admin/customers/:id/anonymize`: Scrubs `fullName`, `phone`, `email`, and parked basket labels while keeping FK-restricted financial and loyalty ledgers intact.
  - `POST /api/admin/retention/purge`: Deletes expired/revoked `user_sessions` and aged unreferenced `ai_messages`.

## 5. Pre-Cutover Release Gate Checklist

1. `pnpm lint` exits 0 (`oxlint --deny-warnings`).
2. `pnpm typecheck` and `pnpm build` succeed cleanly across `@supermarket/shared`, `@supermarket/api`, and `@supermarket/web`.
3. `uv --directory services/analytics run --frozen pytest -v` passes.
4. `pnpm --filter @supermarket/api test` passes against an isolated test PostgreSQL 16 instance (`DATABASE_URL_TEST`).
5. `bash scripts/docker-smoke.sh` and `bash scripts/db-backup-verify.sh` pass against containerized PostgreSQL 16.
6. Confirm `.env` contains non-default `POSTGRES_PASSWORD`, `AUTH_SECRET`, `ANALYTICS_WORKER_TOKEN`, `PAYMENT_WEBHOOK_SECRET`, and `VITE_ENABLE_DEMO_LOGIN=false`.
