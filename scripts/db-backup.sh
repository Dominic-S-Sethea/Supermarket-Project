#!/usr/bin/env bash
set -euo pipefail
umask 077

# SupermarketOS Production Encrypted Off-Site Backup Script (AUD-031)
# Creates a consistent --serializable-deferrable pg_dump custom archive, writes a SHA-256
# checksum, optionally encrypts with age or GPG, uploads off-site if configured, and
# prunes local archives past retention. Supports either PG_CONTAINER or discrete PG* vars.

BACKUP_DIR="${BACKUP_DIR:-/var/backups/supermarket-os}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
PG_CONTAINER="${PG_CONTAINER:-}"
PG_HOST="${PGHOST:-localhost}"
PG_PORT="${PGPORT:-5432}"
PG_USER="${PGUSER:-${POSTGRES_USER:-supermarket}}"
PG_DB="${PGDATABASE:-${POSTGRES_DB:-supermarket_os}}"
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/smos_backup.XXXXXX")
chmod 700 "$TMP_DIR"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

RAW_DUMP="${TMP_DIR}/supermarket_os_${TIMESTAMP}.dump"
echo "[backup] Dumping database '${PG_DB}'..."
if [[ -n "$PG_CONTAINER" ]]; then
  docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -Fc --serializable-deferrable --no-owner --no-acl "$PG_DB" > "$RAW_DUMP"
else
  PGHOST="$PG_HOST" PGPORT="$PG_PORT" PGUSER="$PG_USER" PGDATABASE="$PG_DB" \
    pg_dump -Fc --serializable-deferrable --no-owner --no-acl > "$RAW_DUMP"
fi

test -s "$RAW_DUMP"
FINAL_ARTIFACT="supermarket_os_${TIMESTAMP}.dump"
OUT_PATH="${BACKUP_DIR}/${FINAL_ARTIFACT}"

if [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]]; then
  command -v age >/dev/null 2>&1 || { echo "[backup] ERROR: 'age' CLI not found" >&2; exit 1; }
  FINAL_ARTIFACT="${FINAL_ARTIFACT}.age"
  OUT_PATH="${BACKUP_DIR}/${FINAL_ARTIFACT}"
  age -r "$BACKUP_AGE_RECIPIENT" -o "$OUT_PATH" "$RAW_DUMP"
elif [[ -n "${BACKUP_GPG_RECIPIENT:-}" ]]; then
  command -v gpg >/dev/null 2>&1 || { echo "[backup] ERROR: 'gpg' CLI not found" >&2; exit 1; }
  FINAL_ARTIFACT="${FINAL_ARTIFACT}.gpg"
  OUT_PATH="${BACKUP_DIR}/${FINAL_ARTIFACT}"
  gpg --batch --yes --trust-model always -e -r "$BACKUP_GPG_RECIPIENT" -o "$OUT_PATH" "$RAW_DUMP"
else
  mv "$RAW_DUMP" "$OUT_PATH"
fi

chmod 600 "$OUT_PATH"
sha256sum "$OUT_PATH" > "${OUT_PATH}.sha256"
chmod 600 "${OUT_PATH}.sha256"
echo "[backup] Archive saved: ${OUT_PATH}"

if [[ -n "${BACKUP_S3_URI:-}" ]]; then
  command -v aws >/dev/null 2>&1 || { echo "[backup] ERROR: 'aws' CLI not found" >&2; exit 1; }
  DEST="${BACKUP_S3_URI%/}/${FINAL_ARTIFACT}"
  aws s3 cp "$OUT_PATH" "$DEST" --only-show-errors
  aws s3 cp "${OUT_PATH}.sha256" "${DEST}.sha256" --only-show-errors
  echo "[backup] Uploaded off-site: ${DEST}"
fi

find "$BACKUP_DIR" -maxdepth 1 -type f \( -name "supermarket_os_*.dump*" \) -mtime "+${BACKUP_RETENTION_DAYS}" -delete
echo "[backup] Complete (retention=${BACKUP_RETENTION_DAYS}d)."
