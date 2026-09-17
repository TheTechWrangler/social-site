# Batch 16A telemetry privacy

RefugeCloud telemetry is minimized identifiable telemetry. Usage events may retain
the authenticated user's stable database ID so admins can calculate distinct
active-user counts. It is not anonymous analytics.

New usage events store only a finite route template, allowlisted event/feature/error
values, bounded allowlisted metadata, and the server-authoritative user ID. Unknown
routes are stored as /other; query strings, fragments, literal path parameters,
and encoded path parameters are never persisted. Auth events retain stable
actor/target relationships, timestamps, bounded user-agent and IP evidence, safe
result reasons, and event-specific metadata. Redundant usernames, display names,
emails, attempted login text, and arbitrary metadata are not written.

Production diagnostics use stable subsystem and failure codes. Provider response
bodies, unexpected exception messages, request objects, raw URLs, tokens, email
addresses, and filesystem paths are excluded. Sensitive admin telemetry and status
responses use Cache-Control: private, no-store.

Telemetry expiry runs at startup and periodically during continuous uptime. The
defaults remain 90 days for usage_events, 180 days for auth_events, and 30 days
for client_errors. TELEMETRY_CLEANUP_INTERVAL_MINUTES defaults to 60 and
TELEMETRY_CLEANUP_BATCH_SIZE defaults to 500 rows per table per pass. Every value
must be a finite positive integer; invalid values fall back to these defaults.
Cleanup failures are reported by stable diagnostic code and do not stop the
service. operational_audit is excluded from this cleanup.

This change is forward-only. It does not add a schema migration and does not rewrite
historical telemetry. Older rows may contain fields written by earlier versions and
will age out under the established retention periods. Backup files and Batch 15
recovery compatibility are unchanged.
