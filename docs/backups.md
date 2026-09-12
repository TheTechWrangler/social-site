# Paired backup, offline restore, and asset reclamation

## Safety decision

**KEEP PHYSICAL GC DISABLED.** Production deletion is hard-disabled in code,
including when `allowPhysicalDeletion` is supplied. There is no production enable
command or environment flag in this release. An operator-reviewed, production-sized
restore drill and off-host recovery copy are still required before a separately
authorized enablement change. Passing isolated tests does not enable deletion.

Do not execute recovery commands against production during development or QA.
Use explicit isolated paths. Never delete a lock merely to bypass a running writer.

## Recovery format and consistency

A format-1 recovery set is a private directory containing `database.sqlite`,
`uploads/`, and `manifest.json`. The manifest records application identity,
schema migration IDs, creation time, completion state, every filename, size and
SHA-256, and total bytes. SQLite `VACUUM INTO` captures committed WAL data in a
single coherent database file. **Copying only the live main database is unsafe.**

Both backup and restore require maintenance: stop the application, scheduled
storage jobs, and all other writers. The app and operational CLI share an exclusive
`<database>.operation-lock` lease. This prevents application startup, concurrent
operational commands, or accidental live backups through supported commands.
It does not police external SQLite tools: stopping those is an operator requirement.
Do not run seed, migration, or arbitrary filesystem tools during maintenance.

With writers stopped, the DB snapshot and immutable upload inventory describe the
same recovery boundary. All regular files in the configured flat upload directory
are included: managed images, avatars, legacy files, and staged files conservatively.
Referenced missing local images make backup fail; they are never silently omitted.
Unknown files are backed up, not inferred to be disposable. Nested upload folders,
symlinks (including ancestor symlinks), hard links, overlapping backup/upload roots,
and unsafe filenames are refused. Review legacy layouts before adoption.

No code, build output, dependencies, environment secrets, or infrastructure is
included. Keep the matching application code separately in version control.
The application package version is currently unchanged across batches; migration
IDs, rather than that ambiguous package number, define schema compatibility.

Backup writes a unique `.staging-*` directory, verifies copies and references,
flushes files/directories, then renames it to `recovery-<uuid>`. Only completed set
IDs are accepted by verification/restore. Failed staging remains for investigation.
No recovery set is overwritten. Checksums detect corruption, not a malicious
operator rewriting both manifest and contents; keep backup roots access-controlled.

## Limits and retention

Limits: 50,000 upload files, 20 GiB total per set, 16 MiB manifest, and 30 entries
per recovery root (including staging). Hashing uses 64 KiB chunks rather than
loading images into memory. Directory traversal is streamed and bounded.
Operations are synchronous maintenance jobs; duration depends on disk speed and
inventory size. They never block an active web request, because the app must stop.
Provision a maintenance window and enough free space for backup, staging, and the
pre-restore copy. A limit failure leaves active data untouched and requires review.

There is **no automatic backup pruning**. Unlike the retired age-only scripts, no
job can remove the only known-good recovery point. When the root is full, verify
and move older completed sets to a separately controlled archive; keep at least
two verified recoverable sets and one off-host copy. Failed/staging directories
never count as known-good backups. Restore also needs room for its pre-restore set.
Retained previous-state directories after restore require deliberate operator
review; they are not automatically collected.

## Operator commands

Use reviewed absolute paths, not values supplied by HTTP callers. First create a
dedicated recovery root with owner-only permissions. The CLI does not create one
implicitly, and requires explicit database/upload paths even in production.

```bash
# Placeholders: replace with reviewed paths for the selected environment.
export NODE_ENV='<test-or-production>'
export DATABASE_PATH='/absolute/path/to/database.sqlite'
export UPLOADS_DIR='/absolute/path/to/uploads'
export RECOVERY_ROOT='/absolute/path/to/private-recovery-root'

# Stop the application and all storage writers using your deployment procedure.
npm run recovery -- backup --maintenance-confirmed
# Returns a server-generated recovery-<uuid> ID only after completion.
npm run recovery -- verify 'recovery-<uuid>'
```

The old `backup:db` and `backup:uploads` commands now exit unsuccessfully with
instructions; they do not create or prune anything. Existing timer installations
must be reviewed by an operator rather than continuing to assume those commands
make complete recovery points. This batch does not install or change timers.
Old DB/tar archives are preserved, but must not be treated as verified paired sets.
Admin backup run endpoints return HTTP 409 with maintenance instructions. The
Admin UI makes no claim that a legacy archive proves recoverability. There is no
online restore endpoint or restore button.

## Offline restore

```bash
# Application and all writers must remain stopped throughout.
npm run recovery -- verify 'recovery-<uuid>'
npm run recovery -- restore 'recovery-<uuid>' --restore-offline-confirmed
# Restart the same compatible application, then run read-only health/media checks.
```

Restore verifies the entire manifest, hashes, SQLite integrity, foreign keys,
local references, and exact current migration IDs before altering active data.
It copies into unique staging paths, creates a verified paired pre-restore recovery
point, invalidates historical sessions/reset/verification tokens in the staged DB,
and rotates every restored user's credential version. **Everyone must log in
again.** Otherwise restoring historical sessions could resurrect revoked access.
Profile/content/relationship state intentionally returns to the snapshot time;
operators must account for bans or privacy changes made after that snapshot.

The current WAL is checkpointed, and original DB, sidecars, and uploads are moved
to unique `.previous-*` paths. Staged DB/uploads are then renamed into place.
Original files and the pre-restore set remain recoverable. A durable restore
journal lists every rename. Ordinary failures reverse completed renames; a failed
rollback or process crash leaves the lease/journal, blocking startup. A two-directory
filesystem swap is not globally atomic: this maintenance fence is essential.

Do not manually copy a backup over a running SQLite database. Do not remove old
WAL files or extract an unverified tar archive into active uploads.

## Crash or failure recovery

1. Keep maintenance mode and stop all writers. Preserve the recovery root, lock,
   `.restore-journal`, staged paths, and `.previous-*` paths.
2. Inspect the lock PID and deployment process state; a missing PID alone is not
   permission to delete data. Confirm no writer is using any selected path.
3. For a restore journal, review its recorded source/destination rename pairs and
   filesystem presence. Reverse only completed moves in reverse order to restore
   original state, or complete the verified staged switch. Do not guess when a
   source and destination both exist. Keep the verified pre-restore set unchanged.
4. Verify SQLite integrity and local media against the selected recovery point.
   If recovery is ambiguous, leave the app stopped and escalate to the operator.
5. Only after reconciliation, remove the exact reviewed journal/lease and restart.
   Crashed backup staging is not valid and can be archived for investigation.

External full-disk failure still requires an off-host copy; local backups alone
do not protect against loss of the machine or disk. No cloud infrastructure is
introduced here.

## Migrations and audit

Startup runs ordered schema guards in one immediate SQLite transaction. Known
data conversions have IDs in `schema_migrations`; they are marked only after
success. The baseline is `015-atomic-baseline`. Follow/identity/version and foreign
key preconditions still run on restart. Failed DDL/backfill leaves no partial
schema or success marker. Ambiguous identities/follows or authored duplicate
reposts require operator review; no guessing or silent content deletion.
Rehearse upgrades on a verified isolated copy before production startup.

`operational_audit` stores event, actor ID when available, target type/ID and time,
with no cascading foreign keys or content payloads. Required mutation evidence
is committed with user/group/post/admin changes. Operator backup/restore/GC events
have a null application actor. Existing best-effort auth/usage logs remain separate.
GC attempt evidence is committed before irreversible unlink; a later failure
can leave an attempt without completion, which is deliberate recovery evidence.
Audit records are not part of automatic log retention.

## GC dry run and deletion gate

```bash
# Explicit isolated or reviewed production paths as above; stop writers first.
npm run recovery -- gc-dry-run
```

Dry run opens SQLite read-only and reports bounded counts: examined, eligible,
referenced, grace-period, unsafe-path, missing, failed. It changes neither lifecycle
metadata nor files. Default batch is 100; library maximum is 500. It does not scan
and delete untracked files. Pending-expiry bookkeeping on non-dry runs is also
bounded to the batch size and grants a fresh 24-hour grace period.

Actual deletion is available only to isolated non-production library callers with
explicit `allowPhysicalDeletion: true`; production is always rejected. Each candidate
is re-read under an immediate DB transaction, including current state, grace time,
post/avatar references (including legacy URL references), managed namespace, ancestor
and leaf symlinks, hard links, file size/hash, and inode identity before unlink.
No transaction includes a network call. Missing files converge to deleted state;
filesystem or DB failures retain reclaimable state for a later bounded retry.
No automatic retry worker is enabled. Unknown files are always left alone.

Before a future production enablement, require a reviewed production-sized paired
backup/restore drill, off-host recovery, all reference/path/failure tests, explicit
operator approval, and a separately implemented default-off production gate.
Until then the code hard-disable is the immediate stop mechanism; do not bypass it.
