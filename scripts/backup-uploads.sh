#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# RefugeCloud — uploads/media backup
#
# Creates a compressed archive of /home/brock/social-site/uploads without
# modifying live uploads. Tar stores symlinks as symlinks by default and this
# script does not use dereference options.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SOURCE_DIR="/home/brock/social-site/uploads"
BACKUP_DIR="/home/brock/backups/refugecloud-uploads"
RETENTION_DAYS=14

TIMESTAMP="$(date +%Y-%m-%d_%H-%M-%S)"
BACKUP_FILE="${BACKUP_DIR}/refugecloud-uploads-${TIMESTAMP}.tar.gz"
LOG_PREFIX="[backup-uploads ${TIMESTAMP}]"

echo "${LOG_PREFIX} Starting uploads backup."

if [[ ! -d "${SOURCE_DIR}" ]]; then
  echo "${LOG_PREFIX} ERROR: Source uploads directory not found." >&2
  exit 1
fi

if ! command -v tar &>/dev/null; then
  echo "${LOG_PREFIX} ERROR: tar command not found." >&2
  exit 1
fi

mkdir -p "${BACKUP_DIR}"

# Archive the uploads directory as a relative path. Do not follow symlinks.
tar --create --gzip --file "${BACKUP_FILE}" \
  --directory "/home/brock/social-site" \
  --one-file-system \
  uploads

if [[ ! -f "${BACKUP_FILE}" ]]; then
  echo "${LOG_PREFIX} ERROR: Upload backup archive was not created." >&2
  exit 1
fi

BACKUP_BYTES="$(wc -c < "${BACKUP_FILE}")"
if [[ "${BACKUP_BYTES}" -lt 128 ]]; then
  echo "${LOG_PREFIX} ERROR: Upload backup archive is suspiciously small (${BACKUP_BYTES} bytes)." >&2
  rm -f "${BACKUP_FILE}"
  exit 1
fi

ENTRY_COUNT="$(tar -tzf "${BACKUP_FILE}" | wc -l | tr -d ' ')"
echo "${LOG_PREFIX} Archive: $(basename "${BACKUP_FILE}")"
echo "${LOG_PREFIX} Size   : ${BACKUP_BYTES} bytes"
echo "${LOG_PREFIX} Entries: ${ENTRY_COUNT}"

DELETED="$(find "${BACKUP_DIR}" -maxdepth 1 -name "refugecloud-uploads-*.tar.gz" \
  -mtime "+${RETENTION_DAYS}" -print -delete 2>/dev/null | wc -l)"
if [[ "${DELETED}" -gt 0 ]]; then
  echo "${LOG_PREFIX} Retention: removed ${DELETED} upload backup(s) older than ${RETENTION_DAYS} days."
fi

echo "${LOG_PREFIX} Done."
