#!/usr/bin/env bash
set -euo pipefail

# SupermarketOS Disaster-Recovery Backup & Restore Verification Script (Wave 2 Phase 5)
# Proves a live pg_dump custom archive restores cleanly into an isolated database
# with exact table row-count parity and functional SQL views.

PG_CONTAINER="${PG_CONTAINER:-supermarket-os-postgres}"
PG_USER="${POSTGRES_USER:-supermarket}"
SRC_DB="${POSTGRES_DB:-supermarket_os}"
VERIFY_DB="supermarket_os_restore_verify"
DUMP_PATH="/tmp/smos_dr_backup_$$.dump"

cleanup() {
  docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${VERIFY_DB}' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
  docker exec "$PG_CONTAINER" dropdb -U "$PG_USER" --if-exists "$VERIFY_DB" >/dev/null 2>&1 || true
  rm -f "$DUMP_PATH"
}
trap cleanup EXIT

echo "[dr-backup] Taking compressed custom-format pg_dump of ${SRC_DB}..."
docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -Fc --no-owner --no-acl "$SRC_DB" > "$DUMP_PATH"
DUMP_BYTES=$(wc -c < "$DUMP_PATH")
echo "[dr-backup] Backup archive written: ${DUMP_PATH} (${DUMP_BYTES} bytes)"
test "$DUMP_BYTES" -gt 10240

echo "[dr-backup] Creating isolated verification database ${VERIFY_DB}..."
docker exec "$PG_CONTAINER" dropdb -U "$PG_USER" --if-exists "$VERIFY_DB"
docker exec "$PG_CONTAINER" createdb -U "$PG_USER" "$VERIFY_DB"

echo "[dr-backup] Restoring archive into ${VERIFY_DB}..."
docker exec -i "$PG_CONTAINER" pg_restore -U "$PG_USER" -d "$VERIFY_DB" --no-owner --no-acl --exit-on-error < "$DUMP_PATH"

TABLES=(
  "products"
  "product_barcodes"
  "sales"
  "sale_lines"
  "users"
  "inventory_batches"
  "analytics_abc_xyz"
  "analytics_demand_forecasts"
  "analytics_promo_roi"
  "analytics_pipeline_runs"
)

echo "[dr-backup] Verifying row-count parity between ${SRC_DB} and ${VERIFY_DB}..."
for tbl in "${TABLES[@]}"; do
  src_cnt=$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$SRC_DB" -tAc "SELECT COUNT(*) FROM ${tbl};")
  dst_cnt=$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$VERIFY_DB" -tAc "SELECT COUNT(*) FROM ${tbl};")
  if [[ "$src_cnt" != "$dst_cnt" ]]; then
    echo "[dr-backup] MISMATCH on ${tbl}: source=${src_cnt} restored=${dst_cnt}" >&2
    exit 1
  fi
  printf "  ✓ %-28s %8s rows (exact match)\n" "$tbl" "$dst_cnt"
done

echo "[dr-backup] Verifying restored v_product_live_stock view..."
view_cnt=$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$VERIFY_DB" -tAc "SELECT COUNT(*) FROM v_product_live_stock;")
echo "  ✓ v_product_live_stock returned ${view_cnt} SKU live stock rows"
test "$view_cnt" -ge 3000

echo "[dr-backup] SUCCESS: Backup & isolated restore verified cleanly (temp DB will now be dropped)."
