# RefugeCloud Privacy and Visibility Policy

`server/visibility.ts` is the source of truth for normal-user identity and
content visibility. Routes should use its object checks for direct lookups and
its SQL predicates for lists. Administrative and moderation routes are explicit
exceptions: normal routes do not acquire moderation visibility merely because a
viewer has a moderator-like role.

## Account visibility matrix

| Viewer | Public account | Private account | Banned account | Either-direction block |
|---|---|---|---|---|
| Anonymous | Full public profile | Hidden | Hidden | Not applicable |
| Signed-in non-follower | Full public profile | Limited identity card | Hidden | Hidden |
| Follower | Full public profile | Full profile | Hidden | Hidden |
| Self | Full own profile | Full own profile | Authentication denies banned users | Not applicable |
| Admin on a normal endpoint | Full profile | Full profile | Hidden | Hidden |
| Admin/moderator on a dedicated moderation endpoint | Endpoint-specific moderation access | Endpoint-specific moderation access | Endpoint-specific moderation access | Endpoint-specific moderation access |

A limited identity card contains only the user ID needed by the follow UI,
username, display name, avatar, private/limited flags, and relevant follow
state. It does not contain bio, structured interests, verification or role,
profile post/count data, game preferences, or follower/following details beyond
the follow UI state.

## Content scopes

- **Profile scope:** profile metadata, profile posts, game/profile discovery,
  reposts, and other account-scoped material require full profile visibility.
- **Identity scope:** search, connection cards, and public group membership may
  return the limited card to a signed-in non-follower. Anonymous users cannot
  discover private identities through these surfaces.
- **Public-context scope:** a specific item deliberately published to a public
  surface remains visible even when its author has a private account. This
  covers public group posts, comments in a visible post thread, public LFG
  listings, and World Feed comments. Only the item's minimal author identity is
  exposed; the item never upgrades access to the author's profile or other
  content.

Banned-author suppression and either-direction blocking override every normal
scope, including public-context publication. A reply/comment also requires its
parent content to be visible. Inaccessible direct objects return the same 404
shape as nonexistent objects where practical, including report targets.

All groups in the current schema are public contexts. If private or restricted
groups are added, group access must be authorized before applying the
public-context author rule; membership alone must not turn the group public.

## Media and deferred upload work

Attached post media inherits the post's centralized visibility decision, and
responses use private cache control. Avatar serving and unattached-upload
ownership/previews retain their existing behavior for the later upload
ownership milestone. Milestone 4 does not redesign the upload lifecycle.

## Query behavior

Feed, search, connection, group, game/LFG, World Feed, notification, and unread
count lists inject centralized SQL predicates so they do not perform one block
or follow lookup per returned row. Direct object checks use small indexed
lookups. Existing post enrichment still performs per-post aggregate queries,
and notification post-reference sanitization performs at most one visibility
check for each of the bounded 50 returned notifications; those bounded,
pre-existing-style tradeoffs are retained rather than changing data-loading
architecture in this milestone.
