# Batch 16B: limited-state UX and truthful availability

Batch 16B is the final planned RefugeCloud remediation/polish batch. It changes
presentation and small response contracts only; it adds no schema or data
migration.

## Load-state contract

Affected list and feed views distinguish the following states:

- an unresolved initial request shows loading, never an empty-result claim;
- a successful empty response may show an empty state;
- a failed initial request shows an error and retry without revealing private
  counts, identities, or object existence;
- a failed refresh may retain previously authorized data but labels it stale;
- successful retry clears the prior failure;
- request generations prevent older responses from replacing the current view.

Session initialization treats only authentication rejection as anonymous.
Transport, malformed-response, and server failures keep the application in a
retryable session-check state rather than presenting a logged-out UI.

## Privacy settings

DM privacy, game discovery, and World-on-Home writes are serialized behind one
immediate lock. Controls continue to display the last server-confirmed value
while a write is pending. A failure leaves that value active and explains that
the attempted change was not saved. A success reconciles all related controls
from the returned authoritative user object.

## Auth and email feedback

Registration and resend copy is conditional on email delivery availability and
does not claim that a message was sent when the provider outcome is unknown.
Forgot-password success remains account-enumeration resistant. Transport and
rate-limit failures are visibly unsuccessful, while the successful response is
the same for matching and non-matching accounts. OAuth errors contain no
operator `.env` instructions.

## Media availability

`GET /api/uploads/capabilities` returns only non-sensitive booleans and generic
reasons for image uploads, avatar uploads, external YouTube embeds, and direct
video uploads. It is served with `Cache-Control: private, no-store`.

The UI fails closed while capability discovery is loading or failed, offers a
retry after failure, and explains disabled controls. Upload and attachment
routes still enforce configuration on every mutation, so stale discovery state
cannot bypass the server. Direct video upload is always reported unavailable;
Batch 16B does not implement it.

## Admin password resets

Admin user responses include `can_generate_password_reset`, computed by the
server from local-password presence without exposing the hash. OAuth-only users
receive an explanation instead of a reset action. Local-password and mixed-auth
users retain the existing audited reset flow.

Batch 15 operational audit semantics, recovery operations, storage leases,
operation locks, and physical asset GC behavior are unchanged. Batch 16A
telemetry interfaces and minimization behavior are unchanged.
