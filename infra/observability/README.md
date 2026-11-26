# SupermarketOS Observability & Disaster Recovery Runbook

## 1. Prometheus Scrape Configuration

Set a strong `METRICS_TOKEN` in `.env` (passed to the `api` service in `infra/docker-compose.prod.yml`) and point Prometheus at `/api/metrics`:

```yaml
scrape_configs:
  - job_name: supermarket-os-api
    metrics_path: /api/metrics
    scrape_interval: 15s
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/secrets/supermarket_metrics_token
    static_configs:
      - targets: ["api:4000"]

rule_files:
  - /etc/prometheus/alerts/supermarket-os-alerts.yml
```

Import [`grafana-dashboard.json`](./grafana-dashboard.json) into Grafana and load [`alerts.yml`](./alerts.yml) into Prometheus / Alertmanager.

### Key Exposed Metrics
- `http_requests_total{method,route,status_class}` (unmatched 404 paths collapsed to `__unmatched__` and bounded at 500 series)
- `http_request_duration_ms` and `http_route_request_duration_ms{route,status_class}`
- `supermarket_pos_sales_total` (strictly `kind="sale"`) and `supermarket_pos_reversals_total{kind="void"|"refund"}`
- `supermarket_sse_active_streams` and `supermarket_sse_streams_total{status="completed"|"error"|"aborted"}`
- `supermarket_analytics_last_run_age_seconds` and `supermarket_analytics_dq_passed`
- `supermarket_auth_lockouts_total`
- `pg_pool_connections{state="total"|"idle"|"waiting"}`

## 2. Frontend Error Telemetry Hook

`apps/web/src/lib/telemetry.ts` exports `setClientErrorReporter(reporter)` and `reportClientError(scope, error, componentStack)`. All React Error Boundaries (root and per-tab) automatically invoke `reportClientError`. To forward client exceptions to Sentry, OpenTelemetry, or an internal collector, register a reporter in `apps/web/src/main.tsx`.

## 3. PostgreSQL Disaster Recovery & Point-in-Time Recovery (PITR)

### Automated Logical Backup Verification
Run `pnpm db:backup-verify` (implemented in `scripts/db-backup-verify.sh`) to verify a consistent `pg_dump --serializable-deferrable` custom archive restores cleanly into an isolated database with full verification across **every table in `public`** plus `v_product_live_stock`.

- In CI / quiescent windows: `STRICT_PARITY=1` (default) enforces exact row-count parity across every `public` table.
- Against a live production store with concurrent checkouts: run with `STRICT_PARITY=0` to avoid false failures from sales committed after the snapshot started while still verifying every table, FK, CHECK constraint, and view restores with zero errors.

### Production PITR (Continuous WAL Archiving — RPO < 5 min, RTO < 15 min)
For production stores, complement daily `pg_dump` snapshots with continuous WAL archiving via **pgBackRest** or **WAL-G** to encrypted off-host object storage (S3 / Backblaze B2 / GCS):

1. Enable WAL archiving in PostgreSQL (`postgresql.conf` or Compose command args):
   ```ini
   wal_level = logical          # already enabled; satisfies both PITR & replication
   archive_mode = on
   archive_timeout = 300        # force WAL segment archive every 5 minutes
   archive_command = 'pgbackrest --stanza=supermarket_os archive-push %p'
   ```
2. Schedule `pgbackrest --stanza=supermarket_os backup --type=full` weekly and `--type=diff` daily, with off-host encryption (`repo1-cipher-type=aes-256-cbc`).
3. Periodically drill PITR recovery into an isolated staging container using `pgbackrest --stanza=supermarket_os --type=time --target="YYYY-MM-DD HH:MM:SS+00" restore` and verify all ledger invariants.
