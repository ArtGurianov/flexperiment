# ART-337 · Retire Payload-origin Commerce writers

## Decision and boundary

The Payload-free platform source is merged, but the installed canary can still
run the older Payload author until a separately approved hard cut. This source
step removes the service-token routes used by that author: course manifests,
restrictive override create/pending/release, and old internal catalog product,
commercial, payment-purpose and withdrawal writes, plus the legacy video upload
init and status routes. It retains the Commerce
editorial publication and Control Room product/withdrawal routes, which derive
the actor from the admin session. Historical manifest and override tables and
pure helpers remain so access to any legacy course stays restrictive until the
reviewed cutover and data classification are complete. No merchant DDL changes.

Three options were considered. Keeping the routes as permanent compatibility
aliases leaves a second writer after the cut. Adding a runtime flag lets a
later deployment accidentally re-enable them. Removing the routes makes the
new image fail closed; the existing installed image is unchanged until ART-337
installation. This requires coordinating the reviewed source merge with the
cutover: no intermediate Commerce-only deployment may use this source while
the old Payload author is still active.

## Proof and release gate

An authenticated service-token request to every retired route must return 404
and leave course projections, products, overrides, video upload sessions,
lesson video bindings and audit rows untouched, without contacting Kinescope.
The actual Commerce image smoke repeats these negative calls. Existing tests
continue to exercise manifest/override helper behavior directly for historical
legacy safety, while the Control Room admin routes retain their own positive
coverage. No external provider, live DB, secret, scheduler or host changes are
part of this PR. ART-337 must independently archive and read back the old
Payload SQLite and backup chain, disable its writer and timer, preserve the
Commerce erasure fence, install the exact reviewed source, and verify runtime
identity, 404 routes, schema, backup/restore and the closed guards. Protected
browser playback and F9 remain separate gates.
