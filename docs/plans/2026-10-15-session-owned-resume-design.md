# ART-338: session-owned resume writes

The cross-user P0 review found that `PUT` and beacon `POST /v1/lessons/:lessonRef/resume`
spread untrusted JSON after the authenticated customer and route lesson. TypeScript
annotations do not remove extra JSON properties. This can redirect a progress write
to another customer or lesson, despite checking consent for the real session.

## Decision

Construct the storage input explicitly: customer from the authenticated session,
lesson from the route, and only `seconds`, `clientSeq`, `clientTs` from JSON. Keep
the existing validation, ordering, authenticated consent check, transaction and
erasure fence. No DDL, token policy, entitlement policy or deployment guard changes.

Rejecting every unknown property would also prevent the overwrite, but changes
the existing request compatibility. Filtering only in Platform would leave the
authoritative Commerce endpoint vulnerable. An explicit Commerce input is the
smallest complete fix; extra properties remain ignored.

## Verification

For both PUT and POST, seed a second customer's progress on another lesson, submit
both forged identifiers, and verify that only the session customer's route lesson
changes. The victim row must remain byte-for-byte equivalent. Retain the existing
beacon and completion-resume regressions. First demonstrate the failure on the
unmodified handler, then run the affected HTTP/consent/erasure regressions and CI.

Live execution remains canary only. Do not exploit the old endpoint against live
progress. A normal Commerce deployment invalidates previous auth sessions under
BOOT_RESTORE; no hot patch, session-preserving erasure bypass or unsigned token is
allowed to avoid that contract. Separate bearer-transfer and cross-video provider
tests remain explicit P0 results, not assumptions about browser binding.
