# Batch 13 inventory and decisions

Checkpoint: clean main and pre-batch-13 at 6d26584 (final Batch 12).

Baseline inventory: 17 confirm calls (15 destructive/relationship/moderation confirmations and two non-destructive backups) and 18 alert calls (nine mutation failures, seven validation/warnings, two success/information messages). All 35 were replaced; no scoped native calls remain or were deferred.

Before implementation, native confirmations occurred in PostCard (delete, mute, block), ProfilePage (mute, block, game removal), GroupPage (leave, remove member), MessagesPage (delete message), WorldPage (block source), and AdminPage (server/user deletion, ban/unban, role change, hide/resolve moderation). Admin database/media backup confirmations are non-destructive. Native alerts reported mutation failures in these components plus FriendsPage/GameDetailPage, upload validation in Home/Profile, verification warnings in PostCard, and mute/discovery information in Profile. No source-delete, conversation-delete, backup-delete, or restore UI was found; restore is SSH-only documentation.

PostCard's repost and report overlays had no dialog semantics, initial focus, trap, Escape or focus restoration. Group deletion was an inline typed-name section, not a modal. Preserve its exact-name safeguard and full cascading-deletion warning in the shared dialog. Ownership transfer remains a deliberate inline two-step review, not an overlay.

Before implementation, uploads created owned pending managed assets. Attachment atomically created a unique post_media relation and activated the asset; replay returned the same relation. The handler silently truncated altText to 500, copied it into both tables, and GET returned raw rows. Home had staged upload/retry but no description authoring; Group was text-only. PostCard fetched media locally and rendered post_media.alt_text; text PATCH touched only posts. No schema migration is needed for descriptions.

Post-image descriptions use post_media.alt_text as the sole authoritative mutable value. The legacy managed_assets.alt_text column is retained but is not read or updated for post-image descriptions. No production backfill or description fabrication. Input is a trimmed plain string, maximum 500 characters, with explicit empty string clearing. Missing attachment description defaults to empty for older clients; null, wrong types, excessive length and unknown fields fail 400. Pending attachment uses the latest submitted description. Once attached, replay returns the current canonical relation without overwriting it; revisions use the dedicated owner-only description endpoint. This preserves response-loss retry identity and prevents stale attachment retries from undoing later edits.

Descriptions are independent of post text edit_version/edited_at. Hidden/inaccessible posts and non-owners fail closed; group/site roles confer no author privilege. No asset identities, lifecycle columns, image bytes, publication context or text fields change.

## Implemented dialogs and authoring

All inventoried native confirm/alert calls were replaced; none remain in production src. Destructive actions use ActionDialog/useActionDialog. Database/media backups and reposting use its non-destructive intent. Reports use the same primitive with labeled reason/details controls. Group deletion requires the exact group name; admin account deletion additionally requires the exact username. Existing authority checks remain server-side. Group ownership transfer keeps its existing inline review step.

The native HTML dialog is DOM-controlled, not a JavaScript browser-modal API. It supplies modal background inertness; accessible title/description, Cancel-first focus, explicit Tab wrapping, Escape cancellation, triggering-control focus restoration where the control survives, pending focus within the dialog, and an immediate ref lock against duplicate confirmation. Cancellation is disabled during the checked request. Destructive typed inputs do not implicitly submit on Enter. Failures stay in an accessible inline alert and retain the operation/typed confirmation for retry or cancellation. Ordinary information uses inline status text; existing error regions remain.

The denied broad PostCard state-removal patch was not applied. Reposting, reportSubmitting, reportSubmitted, reportError, mutation errors, and request-scope guards remain. The shared dialog consumes the existing action pending/error state in addition to its own submission lock. Repost/report handlers have synchronous ref locks as well. Real Chrome regressions verify rapid duplicate clicks, pending cancellation prevention, unchanged canonical state on failure, preserved report details, visible errors, successful retry, and success-only reporting/reconciliation.

Home and Group composers expose labeled descriptions with previews and an explanation that empty means decorative/redundant. Group now uses the same staged managed-asset submission helper as Home, including partial-attachment retry. No filename or generated description is used. Content images render authored text as escaped alt attributes; avatars adjacent to identity text and redundant World/podcast artwork remain decorative. Changed icon-only PostCard controls have explicit accessible names.

PATCH /api/uploads/media/:mediaId/description accepts exactly { altText: string }. It requires authentication and existing verification eligibility, plus post authorship and current post visibility; nonexistent/non-owned/inaccessible images return 404. Admin verification exemption applies only to the admin's own post. Independent description writes use last successful write semantics; they do not participate in text versioning. Text editing keeps its existing 409 behavior. Within a mounted feed, canonical media-description mutations propagate through duplicate/nested posts and comments, and late initial media loads cannot overwrite a known edited description. Full page reload obtains later external description changes.

GET media uses the existing deliberate media serializer instead of returning raw database rows, with an owner-only canEditAlt capability. Existing snake_case media DTO fields remain compatible; the request boundary uses altText. Attachment postId is now strictly a positive JSON integer (numeric strings rejected). Upload multipart metadata other than the file is rejected; descriptions go on attachment. Missing attachment altText remains backward compatible, defaulting to empty. Invalid/oversized values now fail instead of silently truncating. Legacy managed asset description copies remain untouched and non-authoritative.

## Changes and verification

Production files: server/routes/uploads.ts; src/api/client.ts; src/postComposerSubmission.ts; src/postEntityState.ts; src/styles/index.css; src/components/{ActionDialog,ImageDescription,GroupPostComposer,PostCard}.tsx; src/pages/{Home,Group,Profile,Messages,World,Admin,Friends,GameDetail}Page.tsx. Supporting files: package.json/package-lock.json, this document, tests/batch13/{browser-fixture.tsx,dialogs.browser.test.ts,contracts.unit.test.ts,image-description.integration.test.ts}, and the Batch 11 copy test (now checks the extracted composer and its GroupPage wiring).

No schema/index changes or migrations. playwright-core is a dev-only test dependency; tests use installed Chrome at /usr/bin/google-chrome or BATCH13_CHROME_PATH. Browser fixtures serve only isolated mocked data on loopback and block external requests. API tests create temporary databases/uploads, including real image bytes, and never use production storage. Modern HTML dialog support is required.

Tests cover real keyboard focus/inertness/Escape/Enter, cancel/pending/double-click/failure/retry, real PostCard deletion and typed group deletion, Home/Group attachment retry, plain/decorative rendering, description drafts and nested reconciliation, text conflicts, strict bodies/bounds, real uploads and durable attachment replay, owner/role/ban/verification/privacy denials, unchanged image bytes and lifecycle, and controlled write rollback. AST regression checks ignore comments/docs and prohibit native dialog calls in touched production components.

Production data, configuration, infrastructure, and existing uploads were not changed. No physical managed-asset GC was enabled. No Batch 14 work or production QA cleanup was performed. Existing dev-only Vite/esbuild audit findings remain outside this batch; production dependency audit reports no vulnerabilities. No broad dependency upgrade was attempted.

Final verification against the completed working tree:

| Command | Result |
| --- | --- |
| npm run test:batch08 | 15 passed |
| npm run test:batch09 | 8 passed |
| npm run test:batch10 | 7 passed |
| npm run test:batch11 | 9 passed |
| npm run test:batch12 | 20 passed |
| npm run test:batch13 | 22 passed (10 Chrome, 9 API integration, 3 unit/source) |
| npm run test:security | 70 passed |
| npm run smoke | All isolated smoke checks passed |
| npm run build | TypeScript --noEmit and Vite production build passed |
| git diff --check | Passed |

Total: 151 tests, zero failures or skips. No production deployment, commit, push, or checkpoint/tag change was performed by this batch.
