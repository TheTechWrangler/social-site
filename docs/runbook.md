# RefugeCloud Runbook

## Post-deploy smoke test

After deploying or restarting the production service, run the read-only smoke test from the project root:

```bash
npm run smoke:live
```

Check service status:

```bash
sudo systemctl status refugecloud --no-pager
```

Review recent service logs without printing environment values:

```bash
sudo journalctl -u refugecloud -n 80 --no-pager
```

---

## Site down / service crash loop

Check whether the service is running and see recent logs:

```bash
sudo systemctl status refugecloud --no-pager
sudo journalctl -u refugecloud -n 100 --no-pager
```

If the service is in a crash loop, systemd will show `(Result: exit-code)` and repeated restart attempts.
Common causes and checks:

**Port already in use:**
```bash
sudo ss -tlnp | grep 3003
```
Kill the stale process or wait for it to exit, then restart.

**Missing environment variable:**
Look for `[startup] FATAL:` lines in the journal. Add the missing variable to the `.env` file and restart.

**Database locked or corrupt:**
```bash
sqlite3 /home/brock/social-site/data/social.db "PRAGMA integrity_check;"
# Expected: ok
```
If corrupt, restore from backup (see docs/backups.md).

**Out of disk space:**
```bash
df -h /home/brock
```
If disk is full, see the Disk-full emergency section below.

**Node version or dependency issue:**
```bash
node --version
# Confirm matches .nvmrc or expected version
ls /home/brock/social-site/node_modules | head
```

After fixing the root cause:
```bash
sudo systemctl restart refugecloud
sudo systemctl status refugecloud --no-pager
npm run smoke:live
```

---

## Smoke test after deploy

Run after every code deploy or service restart:

```bash
# From the project root:
npm run smoke:live

# With a custom target (e.g. staging):
SMOKE_BASE_URL=http://127.0.0.1:3003 npm run smoke:live
```

All checks should print `[ok]`. If any print `[fail]`, check the service logs before declaring the deploy good.

Full deploy sequence:

```bash
npm run build
sudo systemctl restart refugecloud
sudo systemctl status refugecloud --no-pager
npm run smoke:live
```

---

## Admin lockout recovery

If no admin account can log in (all admins locked out or deleted):

**Option 1 — Direct database update (requires SSH access to server):**

> ⚠️ Stop the service first to avoid write conflicts.

```bash
sudo systemctl stop refugecloud

# Promote a user to admin by username
sqlite3 /home/brock/social-site/data/social.db \
  "UPDATE users SET role='admin', banned=0 WHERE username='<username>';"

# Verify
sqlite3 /home/brock/social-site/data/social.db \
  "SELECT id, username, role, banned, is_verified FROM users WHERE username='<username>';"

sudo systemctl start refugecloud
sudo systemctl status refugecloud --no-pager
```

**Option 2 — Create a temporary admin account via the register API (if registration is still open):**

```bash
curl -s -X POST http://127.0.0.1:3003/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"temprecovery","displayName":"Recovery","email":"recovery@example.com","password":"changeme123"}' \
  | jq .

# Then promote in DB:
sqlite3 /home/brock/social-site/data/social.db \
  "UPDATE users SET role='admin', is_verified=1 WHERE username='temprecovery';"
```

After recovery, immediately change the password and delete or demote the recovery account.

---

## Database restore

See **docs/backups.md** for the full step-by-step restore procedure, integrity checks, and WAL sidecar file handling.

Quick reference:
```bash
# 1. Stop service
sudo systemctl stop refugecloud

# 2. Safety-copy current live DB
cp /home/brock/social-site/data/social.db \
   /home/brock/social-site/data/social.db.pre-restore-$(date +%Y%m%d%H%M%S)

# 3. Remove WAL sidecars (CRITICAL — do not skip)
rm -f /home/brock/social-site/data/social.db-wal \
      /home/brock/social-site/data/social.db-shm

# 4. Copy backup into place (replace filename)
cp /home/brock/backups/refugecloud-db/refugecloud-social-YYYY-MM-DD_HH-MM-SS.db \
   /home/brock/social-site/data/social.db

# 5. Verify
sqlite3 /home/brock/social-site/data/social.db "PRAGMA integrity_check;"

# 6. Restart
sudo systemctl start refugecloud
npm run smoke:live
```

---

## Uploads restore

See **docs/backups.md** for the full uploads restore procedure.

Quick reference:
```bash
# Stop service first
sudo systemctl stop refugecloud

# Safety-archive current uploads
tar -czf /home/brock/social-site/uploads.pre-restore-$(date +%Y%m%d%H%M%S).tar.gz \
   -C /home/brock/social-site uploads

# Restore from archive (replace filename)
tar -xzf /home/brock/backups/refugecloud-uploads/refugecloud-uploads-YYYY-MM-DD_HH-MM-SS.tar.gz \
   -C /home/brock/social-site

sudo systemctl start refugecloud
```

---

## Disk-full emergency

If the server is out of disk space the service will fail to write logs, sessions, or database WAL pages.

**Check disk usage:**
```bash
df -h /home/brock
du -sh /home/brock/social-site/data/
du -sh /home/brock/social-site/uploads/
du -sh /home/brock/backups/
```

**Check journal size:**
```bash
sudo journalctl --disk-usage
```

**Safe recovery options (in order of preference):**

1. Rotate old backup files — the backup scripts keep 14 days by default. If you have more, remove the oldest manually from `/home/brock/backups/` after confirming newer ones are intact.

2. Vacuum the journal:
   ```bash
   sudo journalctl --vacuum-time=7d
   ```

3. Check for large temp files or build artifacts:
   ```bash
   du -sh /home/brock/social-site/dist/
   du -sh /tmp/
   ```

> ⚠️ Do NOT delete `data/social.db`, `data/social.db-wal`, or any file in `uploads/` without a confirmed good backup. Do NOT delete backups until you have verified at least two newer backups are good.

---

## OAuth provider outage fallback

If Google OAuth or Steam OAuth is down or returning errors:

- Users with a **local password** can still log in at `/login` with username + password.
- Users who registered exclusively via OAuth (no local password) cannot log in until the provider is restored.

Admin actions available:
1. Log in with your local password admin account.
2. In Admin → Users, use "Generate Password Reset Link" for any OAuth-only user who needs access. This creates a time-limited reset link (2 hours) that lets them set a local password.
3. Inform affected users via any out-of-band channel.

If you need to disable OAuth login buttons in the UI during an outage, unset `GOOGLE_CLIENT_ID` (or `STEAM_RETURN_URL`) in `.env` and restart the service. The local login form will still work.

**Note on self-serve password reset:** OAuth-only accounts cannot use the "Forgot your password?" flow on the login page — that flow only sends emails to accounts with a local password. If an OAuth-only user asks why they didn't receive a reset email, direct them to reset through Google or Steam. If they need a local password added, use "Generate Password Reset Link" in Admin → Users.

---

## Useful systemctl / journalctl commands

```bash
# Check service status
sudo systemctl status refugecloud --no-pager

# Start / stop / restart
sudo systemctl start refugecloud
sudo systemctl stop refugecloud
sudo systemctl restart refugecloud

# Follow live logs
sudo journalctl -u refugecloud -f

# Last N lines
sudo journalctl -u refugecloud -n 100 --no-pager

# Logs since a timestamp
sudo journalctl -u refugecloud --since "2026-05-16 03:00:00" --no-pager

# Check backup timer status
sudo systemctl status refugecloud-db-backup.timer --no-pager
sudo systemctl list-timers refugecloud-db-backup.timer --no-pager

# Check uploads backup timer
sudo systemctl status refugecloud-uploads-backup.timer --no-pager
sudo systemctl list-timers refugecloud-uploads-backup.timer --no-pager

# Last backup service run logs
sudo journalctl -u refugecloud-db-backup.service -n 30 --no-pager
sudo journalctl -u refugecloud-uploads-backup.service -n 30 --no-pager

# Reload systemd after editing unit files
sudo systemctl daemon-reload

# Enable a timer to survive reboots
sudo systemctl enable --now refugecloud-db-backup.timer
```
