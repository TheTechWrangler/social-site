# Batch 15 operational integrity

## Pre-implementation inventory

Checkpoint: clean `main` / `pre-batch-15` at c92fd88.

| Operation | Prior state | Batch 15 treatment |
| --- | --- | --- |
| Admin account deletion | User cascade + report resolver nulling transactional; owned groups block deletion; post/avatar detach triggers; auth audit after deletion fails its target FK | Keep cascade/authority; durable in-transaction audit without target FK |
| Self-service account deletion | No such route | No new product operation |
| Group deletion/transfer | Transactional authority, membership and publication graph; best-effort usage log | Preserve Batch 07; durable audit inside transaction |
| Post/comment/repost create/delete | Atomic DB action + Batch 10 notifications; submission keys transactional | Preserve; audit deletion, including administrative deletion |
| Follow accept/reverse, privacy transitions, blocks, reactions | Already transactional; unblock is single-row idempotent deletion | Preserve Batch 08/10/11 policies |
| Conversation creation | Three autocommitted inserts | One transaction; no messaging policy changes |
| Managed attachment, avatar replace/reset | Transactional references + state; detach triggers defer reclamation | Preserve; filesystem staging remains recoverable, not transactionally deleted |
| Provider reclamation | Immediate transaction rotates credentials, revokes sessions, links provider | Preserve; credential revocation helper also independently atomic |
| Reset/verification token replacement | Invalidate then insert without transaction | Atomic replacement; email remains outside transaction; generic enumeration-safe responses unchanged |
| RSS ingestion | Network bounded, but item inserts and success status independently commit | Transaction only after download/parse; roll back partial ingestion |
| Admin ban/role/moderation | Single mutation or report transaction, best-effort audit afterward | Couple necessary audit to mutation |
| Backups | Separate WAL-aware VACUUM INTO DB and tar uploads; date-only pruning; no paired manifest | Replace with verified paired maintenance recovery set; no automatic pruning |
| Restore | Documentation-only manual overwrite/WAL deletion | Verified offline staged replacement with rollback/recovery journal |
| Startup schema | Ordered CREATE/ALTER guards, uniqueness checks; no enclosing transaction/version ledger; notification cleanup and OAuth backfill repeat | Atomic baseline, versioned data conversions; invariants checked on restart |
| Retention/session expiry | Independent single-statement retention, intended best-effort housekeeping | Unchanged; operational audit excluded from retention |
| GC | Production hard-disabled; reference check precedes unlink but no write lock; untracked name/age sweep | Revalidate under write lock, hash/identity/path checks; never sweep unknown files |

SQLite uses WAL and foreign keys. Migration order is base schema, post edit fields,
follow-state preconditions/backfill, notification invariants, RSS indexes/status,
asset attachment fields/triggers, identity uniqueness, user fields, logs/tokens,
OAuth verification backfill, sessions. Batch 15 retains this dependency order.
Previous swallowed OAuth migration errors and partial earlier DDL were unsafe.

Uploads are one configured flat persistent root: managed post images, avatars,
legacy uploads. Multer writes staged images there before DB commit; rejected
uploads are removed immediately. Committed images are not overwritten. There is
no scheduled physical reclamation worker. Unknown/legacy files cannot be inferred
deletable from their names. Existing auth/usage logs are best-effort, retained for
a bounded period, and lose target IDs through SET NULL; not durable deletion evidence.

## Chosen operational boundary

Paired backup and restore require the application and all storage writers stopped.
A shared exclusive storage lease prevents overlap with the application and other
operational commands. No live application request waits for a file-copy operation.
Backup includes all regular files in the persistent upload root (including legacy
and staged files conservatively), not code/configuration/caches. No symlinks.
Manifest and resource limits fail closed; incomplete sets are not recovery points.
Old standalone backups remain untouched and are not represented as paired sets.

Production physical GC stays hard-disabled. Recommendation remains **KEEP
PHYSICAL GC DISABLED** pending an operator-reviewed production-sized restore drill,
off-host recovery copy, and separately authorized enablement. No Batch 16 work.
