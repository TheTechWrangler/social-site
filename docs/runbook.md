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
If corrupt, keep the service stopped and preserve the database, sidecars, uploads,
and recovery evidence. The paired restore CLI requires a valid current database
and cannot repair corruption or bootstrap missing storage. Escalate for an
operator-reviewed recovery plan; see [backup and recovery](backups.md).

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

## Paired backup and offline restore

Use the [Batch 15 recovery procedure](backups.md). A recovery set pairs a
WAL-aware SQLite snapshot with all persistent uploads and a checksummed manifest.
Standalone DB/tar archives are not verified paired recovery sets. Do not overwrite
the database, delete WAL/SHM files, or restore uploads independently.

Before either operation:

1. Schedule maintenance and stop the application, scheduled storage jobs, and all
   other database/upload writers. The shared operation lock blocks the application
   and recovery CLI from overlapping, but does not police external SQLite tools.
2. Select explicit absolute paths for the intended environment. Use a dedicated,
   existing recovery directory with owner-only permissions, outside the database
   and upload storage. Symlinks, hard links and unsupported upload layouts are
   refused; review the limits in [backups.md](backups.md).
3. Allow space for staging, a pre-restore recovery set, and retained previous
   files. The recovery root permits 30 entries including staging; there is no
   automatic pruning. Keep matching application code available.

Run from the project root as the storage owner. Replace every placeholder with
reviewed values; these are operator commands, not commands to run during QA:

```bash
export NODE_ENV='<test-or-production>'
export DATABASE_PATH='/absolute/path/to/database.sqlite'
export UPLOADS_DIR='/absolute/path/to/uploads'
export RECOVERY_ROOT='/absolute/path/to/private-recovery-root'

# For this systemd deployment; also stop every other storage writer.
sudo systemctl stop refugecloud
sudo systemctl is-active refugecloud
# Confirm inactive before proceeding. A surviving lock requires investigation.
```

To create a backup while writers remain stopped:

```bash
npm run recovery -- backup --maintenance-confirmed
# Use the returned recovery-<uuid> ID:
npm run recovery -- verify 'recovery-<uuid>'
```

To restore a selected completed recovery set while writers remain stopped:

```bash
npm run recovery -- verify 'recovery-<uuid>'
npm run recovery -- restore 'recovery-<uuid>' --restore-offline-confirmed
# Verify the pre-restore ID returned in the recoveryPoint field:
npm run recovery -- verify 'recovery-<pre-restore-uuid>'
```

Restore requires a valid current database with exactly matching migration IDs,
an existing upload directory, and current referenced media sufficient to create
a coherent pre-restore recovery point. Missing/corrupt current storage requires
an operator-reviewed recovery plan; do not bypass these checks.

The CLI verifies hashes, SQLite integrity, foreign keys and local references,
stages the replacement, and creates the pre-restore recovery set. It checkpoints
WAL and retains original database/sidecars/uploads under unique `.previous-*`
paths. Renames are journaled and ordinary failures reverse completed moves; the
filesystem swap is not globally atomic. Historical sessions and reset/verification
tokens are invalidated, so everyone must log in again. Review bans and privacy
changes made after the selected snapshot.

Only after successful completion and verification, restart the compatible app:

```bash
sudo systemctl start refugecloud
sudo systemctl status refugecloud --no-pager
npm run smoke:live
```

Also check restored content and media with the appropriate access permissions.
Preserve the pre-restore set and previous files until operator review. On failure,
keep maintenance mode and preserve the lock, `.restore-journal`, staging and
previous paths. Follow [crash or failure recovery](backups.md#crash-or-failure-recovery);
never remove a live lock or delete a journal just to make startup succeed.
Production physical GC remains disabled.

## Retired backup timers

The old database and uploads backup services invoke scripts that intentionally
fail. Do not install, enable, or manually start them. Follow the
[deployment retirement instructions](../deploy/README.md) for installed copies.
Batch 15 supplies no automatic replacement timer: operators must arrange reviewed
maintenance windows for the paired recovery workflow above and maintain an
off-host copy. Preserve old archives as evidence; do not label them paired sets.

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

1. Review completed paired recovery sets using `npm run recovery -- verify` with the explicit environment/storage paths above. There is no automatic or age-based pruning. Archive older verified sets to separately controlled storage, retaining at least two verified recoverable sets and one off-host copy. Preserve failed staging and previous-state files until operator review; leave room for the next pre-restore set.

2. Vacuum the journal:
   ```bash
   sudo journalctl --vacuum-time=7d
   ```

3. Check for large temp files or build artifacts:
   ```bash
   du -sh /home/brock/social-site/dist/
   du -sh /tmp/
   ```

> Do not delete live database/sidecar/upload files, operation locks or restore journals to free space. Preserve recovery evidence; production physical GC remains disabled.

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

# Reload systemd after editing unit files
sudo systemctl daemon-reload
```
