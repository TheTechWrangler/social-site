# External Content Phase 2

Phase 2 adds approved YouTube channel feeds and review-only user source suggestions to the Phase 1 external-content foundation.

## YouTube channels

Administrators may use a channel ID (`UC` plus 22 URL-safe characters) or a canonical HTTPS `youtube.com/channel/CHANNEL_ID` URL. RefugeCloud constructs the official Atom endpoint itself. Handles, playlists, API keys, arbitrary fetch endpoints, direct uploads, and hosted video are not supported.

Every initial request and redirect must remain on the exact HTTPS `www.youtube.com/feeds/videos.xml?channel_id=CHANNEL_ID` destination and must also pass the existing DNS/IP, TLS, redirect, timeout, byte, and workload protections. Feed and entry channel identities must match the configured channel. Video IDs become global YouTube item identities; canonical watch, privacy-enhanced embed, and thumbnail URLs are derived from validated IDs.

## Feed suggestions

Verified users may submit an RSS/Atom locator or YouTube channel locator for review. Submission performs syntax normalization and writes `external_source_submissions` only. It performs no DNS lookup, provider request, redirect, feed parse, source probe, or `external_sources` write.

Only an authenticated administrator's approval action invokes the relevant hardened provider probe. A failed probe leaves the suggestion pending. Successful source creation/linking, review state, and operational-audit evidence are committed together. Rejection records a durable reviewed state; internal review notes are not returned to the submitting user.

## Rendering and privacy

YouTube videos use the existing generalized subscriptions and blocking rules. World eligibility is active, non-tombstoned, and unblocked. Personal eligibility additionally requires a subscription. Publication time controls unified ordering.

The public catalog remains an allowlisted DTO and never returns ingestion URLs, provider endpoints, failure details, retry internals, or submission records. Embedded playback is enabled only when media capability discovery succeeds and the server reports it enabled; otherwise cards retain a safe derived thumbnail/title/link fallback. Direct video upload remains unavailable.

## Migration and deployment

Migration `external-content-youtube-submissions-v2` creates only the submissions table and its indexes. Existing Phase 1 external tables already contain the typed provider, global provider-item identity, video metadata, membership, subscription, block, and discussion fields required by this phase.

Development and tests must use isolated databases. Production migration requires the same controlled offline, paired-recovery workflow used for Phase 1 and is not performed by ordinary development validation.
