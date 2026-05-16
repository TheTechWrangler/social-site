# RefugeCloud — Database Backup & Restore Guide

## Overview

The main database (`data/social.db`) contains all community data:
users, posts, comments, messages, notifications, groups, sessions,
analytics events, auth logs, and more.

Uploaded media lives outside the database in `uploads/`. A complete restore needs
both the database backup and a matching uploads backup.

**Back up regularly. Verify your backups. Test restore before you need it.**

---

## Where Backups Are Stored

```
/home/brock/backups/refugecloud-db/
  refugecloud-social-YYYY-MM-DD_HH-MM-SS.db
  refugecloud-social-YYYY-MM-DD_HH-MM-SS.db
  ...

/home/brock/backups/refugecloud-uploads/
  refugecloud-uploads-YYYY-MM-DD_HH-MM-SS.tar.gz
  refugecloud-uploads-YYYY-MM-DD_HH-MM-SS.tar.gz
  ...
```

Database and uploads backups older than **14 days** are automatically removed
when their scripts run.

---

## Backup Method

Backups use **`VACUUM INTO`** — SQLite's safe live-snapshot command.

Why this matters:
- The live database runs in **WAL (Write-Ahead Logging) mode**, which means
  the database is spread across `social.db`, `social.db-wal`, and `social.db-shm`.
- A plain `cp` would capture only the main file, missing uncommitted WAL pages
  and potentially producing an inconsistent snapshot.
- `VACUUM INTO` reads the current consistent state (main DB + WAL) and writes
  a single, clean, defragmented file — no sidecar files, no service stop needed.

---

## Manual Backup

From the project directory:

```bash
npm run backup:db
# or directly:
bash scripts/backup-db.sh
```

For uploads/media:

```bash
npm run backup:uploads
# or directly:
bash scripts/backup-uploads.sh
```

Expected output:
```
[backup-db 2026-05-16_03-00-00] Starting backup.
[backup-db 2026-05-16_03-00-00] Source : /home/brock/social-site/data/social.db
[backup-db 2026-05-16_03-00-00] Dest   : /home/brock/backups/refugecloud-db/refugecloud-social-2026-05-16_03-00-00.db
[backup-db 2026-05-16_03-00-00] Size   : 8523776 bytes
[backup-db 2026-05-16_03-00-00] Integrity check: ok
[backup-db 2026-05-16_03-00-00] Done. Backup stored at: ...
```

If integrity check does not return `ok`, the script exits with a non-zero status
and the bad backup file is not kept.

Upload backups are gzip-compressed tar archives of the relative `uploads/` path.
The script verifies that the archive exists, is non-empty, and can be listed.

---

## Verifying a Backup

Always verify before relying on a backup for restore:

```bash
# Quick integrity check
sqlite3 /home/brock/backups/refugecloud-db/refugecloud-social-YYYY-MM-DD_HH-MM-SS.db \
  "PRAGMA integrity_check;"
# Expected: ok

# Check row counts look sane
sqlite3 /home/brock/backups/refugecloud-db/refugecloud-social-YYYY-MM-DD_HH-MM-SS.db \
  "SELECT 'users', COUNT(*) FROM users UNION ALL
   SELECT 'posts', COUNT(*) FROM posts UNION ALL
   SELECT 'sessions', COUNT(*) FROM sessions;"
```

---

## Automatic Backup (Daily via systemd Timer)

Systemd unit files are in `deploy/`. They are **not active yet** — you must
install and enable them manually after reviewing:

```bash
# Install units
sudo cp deploy/refugecloud-db-backup.service /etc/systemd/system/
sudo cp deploy/refugecloud-db-backup.timer   /etc/systemd/system/
sudo systemctl daemon-reload

# Enable and start the timer (fires daily at ~02:30 AM)
sudo systemctl enable --now refugecloud-db-backup.timer

# Verify it is scheduled
sudo systemctl list-timers refugecloud-db-backup.timer --no-pager

# Check last run
sudo journalctl -u refugecloud-db-backup -n 50 --no-pager
```

Optional uploads/media timer files are also in `deploy/`. They are **not active
until installed and enabled manually**:

```bash
sudo cp deploy/refugecloud-uploads-backup.service /etc/systemd/system/
sudo cp deploy/refugecloud-uploads-backup.timer   /etc/systemd/system/
sudo systemctl daemon-reload

# Enable and start the timer (fires daily at ~02:50 AM)
sudo systemctl enable --now refugecloud-uploads-backup.timer

sudo systemctl list-timers refugecloud-uploads-backup.timer --no-pager
sudo journalctl -u refugecloud-uploads-backup -n 50 --no-pager
```

---

## Restore Procedure

> ⚠️  **Read all steps before starting. Restoring overwrites live data.**

### Before you start
1. **Make fresh safety backups of the current live database and uploads** even if you think they are broken:
   ```bash
   npm run backup:db
   npm run backup:uploads
   ```
2. Identify the database and uploads backups you want to restore:
   ```bash
   ls -lht /home/brock/backups/refugecloud-db/
   ls -lht /home/brock/backups/refugecloud-uploads/
   ```
3. Verify the database backup is intact:
   ```bash
   sqlite3 /home/brock/backups/refugecloud-db/refugecloud-social-YYYY-MM-DD_HH-MM-SS.db \
     "PRAGMA integrity_check;"
   # Must return: ok
   ```
4. Verify the uploads archive can be listed:
   ```bash
   tar -tzf /home/brock/backups/refugecloud-uploads/refugecloud-uploads-YYYY-MM-DD_HH-MM-SS.tar.gz | head
   ```

### Restore steps

```bash
# 1. Stop the service — REQUIRED. Do not restore while the app is writing.
sudo systemctl stop refugecloud

# 2. Keep safety copies of the current live DB and uploads.
#    Never delete live uploads without a fresh backup.
cp /home/brock/social-site/data/social.db \
   /home/brock/social-site/data/social.db.pre-restore-$(date +%Y%m%d%H%M%S)
tar -czf /home/brock/social-site/uploads.pre-restore-$(date +%Y%m%d%H%M%S).tar.gz \
   -C /home/brock/social-site uploads

# 3. Remove WAL sidecar files from the OLD database.
#    CRITICAL: if you leave these behind they will be applied to the restored
#    database on next open, corrupting it.
rm -f /home/brock/social-site/data/social.db-wal \
      /home/brock/social-site/data/social.db-shm

# 4. Copy the backup into place
cp /home/brock/backups/refugecloud-db/refugecloud-social-YYYY-MM-DD_HH-MM-SS.db \
   /home/brock/social-site/data/social.db

# 5. Restore uploads if needed.
#    This archive contains the relative uploads/ directory.
tar -xzf /home/brock/backups/refugecloud-uploads/refugecloud-uploads-YYYY-MM-DD_HH-MM-SS.tar.gz \
   -C /home/brock/social-site

# 6. Verify the restored database file
sqlite3 /home/brock/social-site/data/social.db "PRAGMA integrity_check;"
# Must return: ok

# 7. Restart the service
sudo systemctl start refugecloud
sudo systemctl status refugecloud --no-pager

# 8. Confirm the app is responding
curl -s http://127.0.0.1:3003/api/health
# Expected: {"ok":true,"app":"social-site"}
```

### After restore
- Users whose sessions were created after the restored snapshot will be logged out
  (their session IDs will not exist in the restored sessions table). This is expected.
- If you restore a database snapshot without the matching uploads archive, posts and
  avatars may reference media files that do not exist on disk.
- Inform the community if significant recent data was lost.

---

## What Is NOT Backed Up by This Script

| Item | Location | Status |
|---|---|---|
| SQLite database | `data/social.db` | ✅ Backed up |
| User uploads / media | `uploads/` | ✅ Backed up locally |
| Environment config | `.env` | ❌ Do not back up to shared storage (contains secrets) |
| App code | git repository | ✅ Version controlled |

---

## Offsite / Remote Backup (Recommended Future Step)

The current database and uploads backups write to the same physical disk as the
live app. A disk failure would lose the live files and local backups. Consider
adding a secondary copy:

```bash
# Example: rsync to a NAS or remote host (add to cron or after the backup script)
rsync -a /home/brock/backups/refugecloud-db/ user@nas:/backups/refugecloud-db/
rsync -a /home/brock/backups/refugecloud-uploads/ user@nas:/backups/refugecloud-uploads/
```

Do not store `.env` or secrets in any shared backup target.
