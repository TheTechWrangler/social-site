# Post editing policy

RefugeCloud post editing changes only the authored `content` field. The author
must be signed in and meet the existing creation verification rule (verified,
or an admin editing their own post). Site roles and group roles do not grant a
right to rewrite another person's content. Delete's existing admin exception
does not apply to edits.

| Post class | Editable | Rule |
|---|---:|---|
| Profile post | Yes | Author only |
| Public-group post | Yes | Author only; group and public-context identity are preserved |
| Reply/comment stored in `posts` | Yes | Author only while the parent thread remains accessible; parent identity is preserved |
| Repost wrapper | No | Wrappers contain no authored commentary field |
| Hidden/moderated post | No | Editing cannot reactivate or alter moderated content |
| Deleted/unavailable post | No | Returned with the privacy-preserving not-found response |

The request contract is `PATCH /api/posts/:id` with exactly `content` and
`expectedEditVersion`. Text is trimmed, must be nonempty, and is limited to
5,000 characters, matching post creation. RefugeCloud currently represents an
image-only post with nonempty placeholder text, so clearing content is not an
allowed edit even when media is attached.
Missing fields, nulls, nonstrings, unknown fields and invalid versions return
400. Malformed JSON returns 400 and the existing request-body size limit
returns 413. `expectedEditVersion` is required and must be an integer from zero
through `Number.MAX_SAFE_INTEGER - 1`.

Posts begin with `edit_version = 0` and `edited_at = NULL`. A content-changing
edit atomically checks the expected version, updates only `content`, advances
the integer version, and sets `edited_at`; `created_at` is never changed. A
stale expected version returns `409 Conflict`. An identical normalized request
is a successful no-op for an eligible post and changes neither edit field.
The eligibility/read/version/write checks run in one immediate SQLite
transaction. No media or network operation participates in that transaction.

Reports currently reference live post content rather than storing an immutable
content snapshot. To preserve evidence without adding revision history, a post
with any open report cannot be edited. Dismissed reports no longer freeze the
post; resolved reports use the existing moderation path that hides the post,
which independently makes it ineligible for editing.
Closed reports still reference live content: if moderation later permits an
edit (for example after dismissal or deliberate unhiding), the closed report
will display the updated text. This is not a historical-evidence archive.

Editing does not query or update media, managed assets, group membership,
ownership, parent/repost relationships, privacy classification, or lifecycle
fields. The canonical post DTO returned by the mutation is reconciled through
the same top-level and nested entity path used by other post mutations.
The DTO includes `editedAt`, `editVersion`, `isRepost`, and viewer-specific
`canEdit`; the interface displays only the modest Edited marker alongside the
original creation time. It never displays the concurrency version.

The inline editor keeps only draft state, while parents own canonical posts
and loaded comments. Successful edits reconcile duplicate posts, nested
reposts, and inline/detail comments. Older interaction or comment-fetch
responses cannot restore earlier text. A stale edit keeps its original draft
and version; Load latest text shows the current server text alongside that
draft and updates the expected version only on this explicit action. Saving
again still requires a separate user action. No full-page reload is required.
