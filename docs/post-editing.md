# Post editing policy

RefugeCloud post editing changes only the authored `content` field. The author
must be signed in and verified. Site roles and group roles do not grant a right
to rewrite another person's content.

| Post class | Editable | Rule |
|---|---:|---|
| Profile post | Yes | Author only |
| Public-group post | Yes | Author only; group and public-context identity are preserved |
| Reply/comment stored in `posts` | Yes | Author only; parent identity is preserved |
| Repost wrapper | No | Wrappers contain no authored commentary field |
| Hidden/moderated post | No | Editing cannot reactivate or alter moderated content |
| Deleted/unavailable post | No | Returned with the privacy-preserving not-found response |

The request contract is `PATCH /api/posts/:id` with exactly `content` and
`expectedEditVersion`. Text is trimmed, must be nonempty, and is limited to
5,000 characters, matching post creation. RefugeCloud currently represents an
image-only post with nonempty placeholder text, so clearing content is not an
allowed edit even when media is attached.

Posts begin with `edit_version = 0` and `edited_at = NULL`. A content-changing
edit atomically checks the expected version, updates only `content`, advances
the integer version, and sets `edited_at`; `created_at` is never changed. A
stale expected version returns `409 Conflict`. An identical normalized request
is a successful no-op and changes neither edit field.

Reports currently reference live post content rather than storing an immutable
content snapshot. To preserve evidence without adding revision history, a post
with any open report cannot be edited. Dismissed reports no longer freeze the
post; resolved reports use the existing moderation path that hides the post,
which independently makes it ineligible for editing.

Editing does not query or update media, managed assets, group membership,
ownership, parent/repost relationships, privacy classification, or lifecycle
fields. The canonical post DTO returned by the mutation is reconciled through
the same top-level and nested entity path used by other post mutations.
