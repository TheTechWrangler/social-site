# External Content Phase 1

Phase 1 generalizes RefugeCloud's existing RSS storage without adding a new provider. RSS remains the only ingested source kind and articles and podcasts remain the only rendered external item kinds. YouTube channels, playlists, video cards, API integration, direct uploads, and recommendation logic are not part of this phase.

## Authoritative model

After migration, application reads and writes use:

- `external_sources` for approved provider/source configuration and bounded operational status
- `external_items` for provider-normalized content
- `external_source_items` for source-scoped entry identity and membership
- `user_external_source_subscriptions` for positive per-user choices
- `user_external_source_blocks` for independent user blocks
- `external_item_comments` for local discussion identity

The legacy RSS tables remain as the migration-time snapshot. The application does not dual-write them and Phase 1 does not delete them.

RSS entry identity is `UNIQUE(source_id, source_entry_id)`. A GUID repeated by one source is idempotent; the same GUID from another source is independent. Unified feed order is normalized publication time descending, then item ID descending. The existing deterministic eight-item per-source cap remains in effect when the feed is not narrowed to a source or category.

## Migration

The migration ledger ID is `external-content-foundation-v1`. Startup runs it inside the existing atomic initialization transaction. It:

1. refuses generalized target tables that exist without the ledger entry;
2. validates legacy source, item, comment, block, identity, length, and parent integrity;
3. calculates the continuity-subscription cross-product and aborts above 250,000 rows;
4. creates all generalized tables and indexes;
5. preserves RSS source, item, comment, and comment-parent IDs;
6. creates one membership for every migrated item;
7. copies blocks and creates subscriptions for every pre-migration user to each active unblocked RSS source;
8. validates counts, ID mappings, constraints, and foreign keys before the ledger entry is recorded.

Any failure rolls back the generalized schema, copied rows, and ledger entry. Repeated startup after success is a no-op. Users and sources created after migration never receive automatic subscriptions.

Before deploying, take and verify a Batch 15 recovery set, stop the application so one controlled process performs startup migration, and retain the legacy tables until a separate verified removal migration is approved. Do not manually pre-create the generalized tables.

## Feed and API behavior

World/discovery eligibility is active, not tombstoned, and not blocked by the viewer. Personal eligibility adds an explicit subscription. `/api/world-feed` remains discovery; authenticated Home injection and `/api/feed?level=world` use personal eligibility. An unauthenticated personal request returns no external items with `authentication_required` rather than degrading to discovery.

Users manage approved numeric source IDs through:

- `PUT /api/world-feed/sources/:sourceId/subscription`
- `DELETE /api/world-feed/sources/:sourceId/subscription`

Both endpoints require a verified authenticated user and are idempotent. A block overrides but does not delete a subscription. New subscriptions require an active, non-tombstoned source and a blocked source must be unblocked first. No user endpoint accepts a provider URL.

The public catalog is an explicit DTO containing only `id`, `name`, `category`, `homepageUrl`, `sourceKind`, `availability`, and viewer subscription/block state. It never exposes ingestion URLs, raw failures, retry internals, or provider configuration. Personalized catalog responses use `Cache-Control: private, no-store`.

## Security and operations

RSS downloads still use the existing admin-controlled URL validation, DNS/address checks, redirect revalidation, TLS verification, size/time/item bounds, global capacity, cooldown, and single-flight coordinator. Server checks remain authoritative. A source configuration change during an active fetch invalidates persistence of that result.

Refresh-all considers every active RSS source. Ordinary replenish considers only active, subscribed, unblocked RSS sources. Failures remain isolated per source. Existing sanitization and retention periods are retained, with retention now deleting generalized items and preserving items with visible generalized comments.

Batch 15 recovery, leases, operation locks, physical asset GC, and `operational_audit` semantics are unchanged. Batch 16 telemetry minimization and limited-state contracts are unchanged.

## Test isolation

`npm run test:external-content-phase1` uses only in-memory SQLite databases or explicit temporary paths under the operating-system temporary directory. Its harnesses assert that the selected database is not `data/social.db`. The live service and production database must not be used for migration rehearsal.
