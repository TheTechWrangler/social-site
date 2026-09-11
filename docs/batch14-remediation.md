# Batch 14 investigation and contract

Checkpoint: main and pre-batch-14 both 3bb22ea, clean worktree. No production database was opened for this investigation.

Before implementation: RSS CRUD used literal-host sanitization, while rss-parser.parseURL fetched stored URLs directly. DNS, redirect destinations and response bytes were unchecked. Parser timeout was 10 seconds; there was no shared refresh concurrency control. Admin fetch-all set its running flag after scheduling (race); replenish used sequential source loops. CLI fetching uses the same service; no in-process scheduled refresh was found. Legacy URLs are ordinary stored rows, not trusted configuration.

Extended feed applied offset only to a 75% followed slice and reused discovery page one. World suggestions were reinserted at offset zero into the same lexically sorted array. SQLite and ISO timestamps are not lexically interchangeable. Enrichment queried counts/state per post. Comments, conversations and group detail members were unbounded; notification output was capped only after loading/filtering all candidates. Messages already had a before-ID cursor, but invalid values silently defaulted and full last pages overstated hasMore.

Existing rate categories: authentication 10/15min, password recovery 5, resend 3; writes 60/15min omitted groups; uploads 20; feed reads 120; all user endpoints shared a 60 limit; unread polling 600. RSS admin network work had no separate budget. No broad persistence or event-system rewrite is intended.

Network contract: HTTP/HTTPS, no credentials, public unicast destinations only. Resolve every hop, reject any non-public answer, pin one validated address using Node's connection lookup while retaining original Host/TLS identity and certificate verification. Five redirects, loop detection, 2 MiB streamed body, 3s connection, 5s headers/inactivity, 15s whole-chain deadline. Compressed and obvious non-XML responses are rejected; RSS/Atom XML forbids DTD/entities and exceeds neither 2 MiB nor 500 items. Errors contain fixed descriptions, not remote URLs/credentials. Legacy rows pass the same boundary and are never automatically deleted.

Feed contract: chronological union of eligible followed/self and extended authors, one server-side limit/offset; no 75/25 quota. World recommendations are a separate module, not positions in the native sequence. World mode has its own sequence. SQL uses normalized Julian timestamps (invalid = zero), then stable ID. Offset pagination is deterministic for unchanged data; concurrent insertions can shift offsets. Limits are strict, not silently clamped.

Refresh contract: four active network operations per process, same-feed single flight and 60s bounded result cache. No external queue or infrastructure. Batch refresh selects a bounded oldest-first set and uses four workers; all entry points share the coordinator. Multi-process scheduling remains a deployment coordination limitation, not DNS-rebinding protection.

## Implemented network and refresh policy

- `ipaddr.js` classifies addresses; anything other than public unicast is rejected. IPv4 private, loopback, link-local/metadata, shared, benchmark, documentation, multicast and reserved ranges are blocked. IPv6 additionally requires global `2000::/3`, rejects mapped/translation/tunnel/special-purpose addresses, and explicitly excludes `3fff::/20` (the documentation allocation newer than the library's table). [IANA registry](https://www.iana.org/assignments/iana-ipv6-special-registry/).
- Node HTTP/HTTPS requests use a pinned lookup, fresh non-pooled connections, original Host/SNI and `rejectUnauthorized: true`. Every redirect resolves again. This removes the validate-then-resolve-again gap; it does not claim to defend against a compromised OS/network route or a public upstream acting as a proxy. [Node HTTPS request options](https://nodejs.org/api/https.html#httpsrequesturl-options-callback).
- Limits: 2 MiB streamed bytes; 16 KiB headers; 3s connection/TLS handshake; 5s headers; 5s idle body; 15s overall network chain including DNS; five redirects. HTTP 200 only. Content type is advisory except obvious HTML/JSON/image/audio/video; compressed responses are refused to avoid expansion. RSS/Atom parsing has a bounded input and 500-item ceiling, not a hard CPU-preemption deadline. DTD/entity declarations are rejected.
- No network destination is exempt because it was previously stored or validated. Unsafe legacy rows remain intact. Fixed safe failures are recorded in `last_fetch_error` with `last_fetch_attempt_at`, surfaced on the admin source table and bounded batch status. URLs, query credentials, headers and cookies are not included in fetch errors.
- Single-feed failures return 404 for missing source, 429 for capacity, 504 for timeout, or 502 for blocked/malformed/upstream failure. CRUD validation returns 400. Accepted asynchronous batches report per-source failures instead of claiming every fetch succeeded.
- Each batch attempts at most 20 least-recently-attempted active sources with four workers (at most roughly 75 seconds of network waits plus bounded parsing/DB work). Failed sources advance their attempt timestamp, preventing permanent starvation of later sources. Ordinary replenish retains five sources and its existing daily quota. Admin replenish is also capped at 20 and guarded against per-user overlap. Completed outcomes are cached for 60 seconds in a 200-entry process-local cache; URL corrections use a different cache key. Changed configuration during a download is not overwritten with old results.
- The DNS wait has an application deadline; the underlying OS resolver may finish later and cannot be cancelled through `dns.lookup`. Its late answer cannot start a connection. Separate processes do not share the in-memory capacity/cooldown; deployment-wide coordination remains deferred. No new scheduler, queue or infrastructure was added.

## Pagination and workload contract

| Surface | Default / maximum | Continuation and order |
| --- | --- | --- |
| Native feed | 50 / 100 | `offset` 0–100000; normalized timestamp descending, then ID descending |
| World feed / World mode | 50 / 100 | Same bounded offset; normalized publication time, then ID |
| Post and World comments | 50 / 100 | Positive `after` ID; ascending ID |
| Conversation list | 50 / 100 | Bounded offset; normalized last-message time, message ID, conversation ID descending |
| Messages in conversation | 50 / 50 | Positive `before` ID; newest-first query, oldest-first display |
| Notifications | 50 / 100 | Positive `before` ID; descending ID, eligibility checked before LIMIT |
| Group members | 50 / 100 | Positive `memberAfter` user ID; ascending ID |

Malformed, duplicate, negative, fractional, overflowing or oversized pagination values return 400. Optional cursors are omitted for the first page; explicit zero is not a valid ID cursor. End-of-list flags use a lookahead, not an exact-page-length guess. Clients have continuation controls and retain prior pages/cursors on failed requests. Offset feeds remain susceptible to shifts when new records arrive; refresh starts a new traversal. No snapshot history is promised.

World suggestions are emitted only for the initial native page as `worldItems`, with `worldPlacement: "separate"`; native `items` contains only native posts. Home renders suggestions separately. World mode and WorldPage paginate their own stream. Existing unfiltered World diversity policy (latest eight items per source) remains; selecting a source/category removes that cap. Invalid dates, including SQLite relative words such as `now`, map to a stable zero sort value. Conversation client reconciliation normalizes SQLite UTC and ISO values too.

Post/comment/group page enrichment batches comment counts, repost counts, reaction totals, viewer reaction and media; one versus 50 ordinary non-owner posts uses the same five enrichment queries. Up to three nested repost levels are prefetched in batches. Group origin, nested source authorization and owner moderation checks still use the central privacy policies. Media serialization is shared with the attachment route, including canonical `alt_text`; late batched reads cannot overwrite successfully reconciled descriptions or newer text edits. No attachment identities, bytes, ownership or lifecycle state change.

Conversation hydration no longer runs four queries per conversation or loads the whole inbox. Its unread total is independent of the page. Notification list/count/read-all now use SQL eligibility with the same 64-ancestor fail-closed rule; read-all is one atomic update and still leaves later arrivals unread. Group totals and current member role are queried separately from the member page, preventing pagination from hiding owner/admin capabilities. World discussion parent references are separately batch-authorized, including parents on earlier pages.

Remaining scale concerns deliberately not redesigned: SQL totals and World ranking still scale with eligible history; owner moderation checks and group/nested-post authorization retain bounded per-entity queries; other existing profile/detail enrichment paths remain unchanged; media fan-out on a single legacy post and source catalogs are not newly paginated. No denormalized counters, snapshot cursors, general caching layer or persistence-framework rewrite was introduced.

## Rate limits

Authentication, upload and generous unread-polling limits remain. RSS refresh/replenish has a separate six-POST-per-minute IP budget; status polling does not consume it. A 300-read-per-15-minute budget covers World, groups, comments, messages, notifications and games, excluding unread polling. Existing 60-write-per-15-minute protection now also covers groups (create/join included), user mutations and notification writes. Feed's existing read budget excludes writes; user search's existing budget applies to search reads rather than unrelated writes/profile reads. These are process-local limits using the existing trusted-proxy configuration. Multiple very active tabs can share/exhaust the list-read budget; clients show retryable errors. A proposed increase was rejected during review and was not applied.

## Schema, compatibility and safety

Idempotent startup checks add two nullable RSS status columns and seven indexes: post parent/ID, repost/ID, notification recipient/ID, World comment item/ID, native feed timestamp/ID, World timestamp/ID and World source/timestamp/ID. No rows/URLs are rewritten by this migration. Index creation may take time on a large database; no production timing was measured. Existing runtime CRUD allowlists remain fixed.

Compatibility changes are intentional: invalid pagination now fails rather than silently defaulting/clamping; comments/members/notifications follow stable ID order; lists require continuation; extended feeds are one chronological union instead of 75/25 slices; World suggestions are a separate module; “fetch-all” retains its legacy URL but now processes at most 20 sources per call with explicit UI/CLI copy. Feeds needing credentials, compressed bodies, non-public or special-use addresses, over 500 items, oversized responses, or slow responses will fail safely and require administrator correction. No physical GC or backup/recovery behavior changed.

## Verification and changed files

New tests: `tests/batch14/rss-network.test.ts` (11 controlled network/concurrency tests, including actual local TLS), `availability.integration.test.ts` (9 isolated API tests), and `workload.test.ts` (4 query-count/migration/state/timestamp tests). The existing security pagination regression now asserts deliberate 400 responses rather than the former fallback behavior. Test storage and certificates use temporary directories; no metadata or arbitrary internal service was contacted.

Results: Batch 08 15/15; 09 8/8; 10 7/7; 11 9/9; 12 20/20; 13 22/22; 14 24/24; security/privacy 70/70. Total 175 passing tests. TypeScript, production build, isolated smoke and `git diff --check` passed. Final narrow follow-up changes were rechecked successfully before handoff.

Files changed:

- Dependency/scripts: `package.json`, `package-lock.json`.
- Server infrastructure: `server/database.ts`, `index.ts`, `pagination.ts`, new `feedTime.ts`, `mediaDto.ts`, `notificationVisibility.ts`, `rssNetwork.ts`, `rssRefresh.ts`; `notificationService.ts`, `rssService.ts`, `rssFetch.ts`.
- Server routes: `comments.ts`, `feed.ts`, `groups.ts`, `messages.ts`, `notifications.ts`, `posts.ts`, `rss.ts`, `uploads.ts`, `worldComments.ts` under `server/routes/`.
- Client contracts/state: `src/api/client.ts`, `src/postEntityState.ts`, `src/messageState.ts`, new `src/timestampOrder.ts`.
- Client UI: `src/components/PostCard.tsx`; `AdminPage.tsx`, `GroupPage.tsx`, `HomePage.tsx`, `MessagesPage.tsx`, `NotificationsPage.tsx`, `PostDetailPage.tsx`, `WorldPage.tsx` under `src/pages/`.
- Tests: the three Batch 14 files above and `tests/security/privacy.integration.test.ts`.
- Documentation: this report.

Production data, users, posts, RSS configuration, uploads and infrastructure were not modified. No deployment or production QA cleanup occurred. `reclaimManagedAssets` still refuses physical deletion in production. Batch 15 was not started.
