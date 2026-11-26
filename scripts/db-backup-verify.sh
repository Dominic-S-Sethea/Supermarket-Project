#!/usr/bin/env bash
set -euo pipefail

# SupermarketOS Disaster-Recovery Backup & Restore Verification Script (M-23)
# Proves a consistent pg_dump custom archive restores cleanly into an isolated database
# and validates EVERY table in the `public` schema plus SQL views.
#
# Modes:
#   STRICT_PARITY=1 (default): requires exact row-count parity for every public table
#                              (ideal for CI / quiescent maintenance windows).
#   STRICT_PARITY=0          : tolerates live concurrent writes after snapshot start
#                              while still verifying every table restores with 0 errors
#                              and core transactional/catalog tables are non-empty.

PG_CONTAINER="${PG_CONTAINER:-supermarket-os-postgres}"
PG_USER="${POSTGRES_USER:-supermarket}"
SRC_DB="${POSTGRES_DB:-supermarket_os}"
VERIFY_DB="supermarket_os_restore_verify_$$"
DUMP_PATH="/tmp/smos_dr_backup_$$.dump"
STRICT_PARITY="${STRICT_PARITY:-1}"

cleanup() {
  docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${VERIFY_DB}' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
  docker exec "$PG_CONTAINER" dropdb -U "$PG_USER" --if-exists "$VERIFY_DB" >/dev/null 2>&1 || true
  rm -f "$DUMP_PATH"
}
trap cleanup EXIT

echo "[dr-backup] Taking consistent compressed pg_dump (--serializable-deferrable) of ${SRC_DB}..."
docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -Fc --serializable-deferrable --no-owner --no-acl "$SRC_DB" > "$DUMP_PATH"
DUMP_BYTES=$(wc -c < "$DUMP_PATH")
echo "[dr-backup] Backup archive written: ${DUMP_PATH} (${DUMP_BYTES} bytes)"
test "$DUMP_BYTES" -gt 10240

echo "[dr-backup] Creating isolated verification database ${VERIFY_DB}..."
docker exec "$PG_CONTAINER" dropdb -U "$PG_USER" --if-exists "$VERIFY_DB"
docker exec "$PG_CONTAINER" createdb -U "$PG_USER" "$VERIFY_DB"

echo "[dr-backup] Restoring archive into ${VERIFY_DB}..."
docker exec -i "$PG_CONTAINER" pg_restore -U "$PG_USER" -d "$VERIFY_DB" --no-owner --no-acl --exit-on-error < "$DUMP_PATH"

# Dynamically discover EVERY base table in the public schema (no hand-curated blind spots)
mapfile -t SRC_TABLES < <(
  docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$SRC_DB" -tAc \
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name;"
)
mapfile -t DST_TABLES < <(
  docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$VERIFY_DB" -tAc \
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name;"
)

if [[ "${#SRC_TABLES[@]}" -eq 0 ]]; then
  echo "[dr-backup] ERROR: No public base tables found in ${SRC_DB}" >&2
  exit 1
fi

if [[ "${#SRC_TABLES[@]}" -ne "${#DST_TABLES[@]}" ]]; then
  echo "[dr-backup] ERROR: Table count mismatch (source=${#SRC_TABLES[@]} restored=${#DST_TABLES[@]})" >&2
  exit 1
fi

echo "[dr-backup] Verifying all ${#SRC_TABLES[@]} public schema tables (STRICT_PARITY=${STRICT_PARITY})..."

build_count_sql() {
  local sql="BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;"
  for tbl in "${SRC_TABLES[@]}"; do
    sql="${sql} SELECT '${tbl}|' || COUNT(*) FROM public.\"${tbl}\";"
  done
  sql="${sql} COMMIT;"
  printf '%s' "$sql"
}

COUNT_SQL=$(build_count_sql)
declare -A SRC_COUNTS
declare -A DST_COUNTS

while IFS='|' read -r tbl cnt; do
  [[ -z "$tbl" ]] && continue
  SRC_COUNTS["$tbl"]="$cnt"
done < <(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$SRC_DB" -tAq -c "$COUNT_SQL")

while IFS='|' read -r tbl cnt; do
  [[ -z "$tbl" ]] && continue
  DST_COUNTS["$tbl"]="$cnt"
done < <(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$VERIFY_DB" -tAq -c "$COUNT_SQL")

for tbl in "${SRC_TABLES[@]}"; do
  src_cnt="${SRC_COUNTS[$tbl]:-MISSING}"
  dst_cnt="${DST_COUNTS[$tbl]:-MISSING}"
  if [[ "$dst_cnt" == "MISSING" ]]; then
    echo "[dr-backup] ERROR: Table ${tbl} missing in restored DB" >&2
    exit 1
  fi
  if [[ "$STRICT_PARITY" == "1" && "$src_cnt" != "$dst_cnt" ]]; then
    echo "[dr-backup] MISMATCH on ${tbl}: source=${src_cnt} restored=${dst_cnt}" >&2
    exit 1
  fi
  printf "  ✓ %-34s %8s rows (source=%s)\n" "$tbl" "$dst_cnt" "$src_cnt"
done

# Always assert core catalog & auth tables are populated in the restored DB
for core_tbl in products product_barcodes users sales sale_lines; do
  if [[ "${DST_COUNTS[$core_tbl]:-0}" -le 0 ]]; then
    echo "[dr-backup] ERROR: Core table ${core_tbl} restored with 0 rows" >&2
    exit 1
  fi
done

echo "[dr-backup] Verifying restored v_product_live_stock view..."
view_cnt=$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$VERIFY_DB" -tAc "SELECT COUNT(*) FROM v_product_live_stock;")
echo "  ✓ v_product_live_stock returned ${view_cnt} SKU live stock rows"
test "$view_cnt" -ge 3000

echo "[dr-backup] SUCCESS: All ${#SRC_TABLES[@]} public tables & SQL views verified cleanly."
