#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# RefugeCloud — SQLite database backup
#
# Method: VACUUM INTO
#   Safe for live WAL-mode databases. Reads the current consistent state
#   (main DB + WAL journal) and writes a single, clean, defragmented SQLite
#   file with no -wal or -shm sidecar files. No service stop required.
#
# Usage:
#   bash scripts/backup-db.sh              # from project root
#   npm run backup:db                      # via package.json shortcut
#
# Output:
#   /home/brock/backups/refugecloud-db/refugecloud-social-YYYY-MM-DD_HH-MM-SS.db
#
# Retention: backups older than 14 days are automatically deleted.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Paths (derived from script location so this works from any cwd) ──────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "${SCRIPT_DIR}")"
DB_PATH="${PROJECT_ROOT}/data/social.db"
BACKUP_DIR="/home/brock/backups/refugecloud-db"
RETENTION_DAYS=14

# ── Timestamp & filenames ─────────────────────────────────────────────────────
TIMESTAMP="$(date +%Y-%m-%d_%H-%M-%S)"
BACKUP_FILE="${BACKUP_DIR}/refugecloud-social-${TIMESTAMP}.db"
LOG_PREFIX="[backup-db ${TIMESTAMP}]"

echo "${LOG_PREFIX} Starting backup."
echo "${LOG_PREFIX} Source : ${DB_PATH}"
echo "${LOG_PREFIX} Dest   : ${BACKUP_FILE}"

# ── Preflight checks ──────────────────────────────────────────────────────────
if [[ ! -f "${DB_PATH}" ]]; then
  echo "${LOG_PREFIX} ERROR: Source database not found: ${DB_PATH}" >&2
  exit 1
fi

if ! command -v sqlite3 &>/dev/null; then
  echo "${LOG_PREFIX} ERROR: sqlite3 CLI not found. Install with: sudo apt install sqlite3" >&2
  exit 1
fi

# ── Create backup directory ───────────────────────────────────────────────────
mkdir -p "${BACKUP_DIR}"

# ── Perform backup via VACUUM INTO ────────────────────────────────────────────
# VACUUM INTO is WAL-aware: it produces a single consistent snapshot that
# includes all committed WAL pages without touching the live database files.
sqlite3 "${DB_PATH}" "VACUUM INTO '${BACKUP_FILE}'"

# ── Verify file exists and is non-trivially sized ────────────────────────────
if [[ ! -f "${BACKUP_FILE}" ]]; then
  echo "${LOG_PREFIX} ERROR: Backup file was not created." >&2
  exit 1
fi

BACKUP_BYTES="$(wc -c < "${BACKUP_FILE}")"
if [[ "${BACKUP_BYTES}" -lt 4096 ]]; then
  echo "${LOG_PREFIX} ERROR: Backup is suspiciously small (${BACKUP_BYTES} bytes). Aborting." >&2
  rm -f "${BACKUP_FILE}"
  exit 1
fi

echo "${LOG_PREFIX} Size   : ${BACKUP_BYTES} bytes"

# ── Integrity check on the backup file (never touches the live DB) ────────────
INTEGRITY="$(sqlite3 "${BACKUP_FILE}" "PRAGMA integrity_check;" 2>&1)"
if [[ "${INTEGRITY}" != "ok" ]]; then
  echo "${LOG_PREFIX} ERROR: Integrity check failed: ${INTEGRITY}" >&2
  exit 1
fi
echo "${LOG_PREFIX} Integrity check: ok"

# ── Retention: remove backups older than RETENTION_DAYS ──────────────────────
DELETED="$(find "${BACKUP_DIR}" -maxdepth 1 -name "refugecloud-social-*.db" \
  -mtime "+${RETENTION_DAYS}" -print -delete 2>/dev/null | wc -l)"
if [[ "${DELETED}" -gt 0 ]]; then
  echo "${LOG_PREFIX} Retention: removed ${DELETED} backup(s) older than ${RETENTION_DAYS} days."
fi

echo "${LOG_PREFIX} Done. Backup stored at: ${BACKUP_FILE}"
