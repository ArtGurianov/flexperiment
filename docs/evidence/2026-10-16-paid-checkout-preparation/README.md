# ART-39 — closed course prepared, payment still disabled

**COURSE_PREPARED_CHECKOUT_NOT_ENABLED**,16October2026 client date. This follows the [historical read-only preflight](../2026-10-16-paid-checkout-preflight/README.md); it does not rewrite that earlier inventory or qualify a real payment. [Sanitized receipts](receipts.json).

PR237 head `68c4bf36cb0b99eb1dbebd5fad013fd6b30bee4d` passed test/docker-build in CI38777901687 and was merged, by the owner's documentation-only GO, as `90dadea4fee32080495432ab557f8fbd85d6b3cd`. The legal package remains DRAFT; merge did not activate it. The merged-main run is a separate CI observation.

## Actual non-financial canary changes

Used normal authenticated Control Room APIs, with erasure admission observed OPEN/no owner/no leases beforehand, on the existing installed Commerce source `0d7dee0c8352dfb6cc1ea8ca7850b5d03fa18309`. No service token bypass, fabricated session, direct database write, restart, installation or erasure-state change.

- Created `ONLINE_COURSE` / PAID product and offer `course:test-course`, courseRef `test-course`, price100kopecks, saleMode CLOSED, empty acceptance allowlist and the proposed payment purpose.
- Saved editorial draft revision1 and published projection version1, UNLISTED; one section and `test-course-lesson`, no free preview. Publication here means an editorial projection, not opening sales or publishing legal terms.
- Initialized a fresh provider upload through the Control Room, transferred the existing owner-held150second test source via the issued Kinescope Tus endpoint and read authoritative provider status through the normal status API. Source transfer to the host was SHA-256 checked; source size4351423bytes. The uploader URL and session custody stay private. No provider API token was exposed to a browser/tool output.
- Read back READY, active binding, duration150seconds. Independent read-only SQLite observation confirmed the provider ID is bound to exactly this one lesson, course UNLISTED, offer CLOSED/100, payments disabled, no order for this offer and no fiscal policy for it. All other paid offers are CLOSED.

No entitlement was granted. Actual paid checkout, fiscal receipt, protected playback under a purchased entitlement, full refund and refund receipt remain unexecuted. The previously accepted Chrome/DRM/isolation qualification stays in ART-338; this step does not extend it.

## Engineering candidates

[Refref PR77](https://github.com/ArtGurianov/refref/pull/77), source `2f9d13a9bf410d2c8ed1f0eda04f75658dc163f9`, adds a distinct strict signed-owner merchant enablement path. Its focused PostgreSQL suite passes26/26, including legacy bootstrap behavior, owner/provenance refusal, zero bank/identity writes, DNS/key staging, custody failure rollback, replay and non-disclosure. TypeScript/focused lint pass. Full exact-commit attested local CI was started; check its eventual status before any install. The command has not been executed against production; no new key exists from this work.

The Flexperiment candidate adds the [closed paid profile](../../release/ART-39_PRIVATE_CHECKOUT_PROFILE.md): fixed course/offer/price and sole hashed buyer binding, exact production dependency source and final legal manifest pins, live preview/confirm scope checks, no discounts/other paid offer/PUBLIC/LAB/bundle opening, a single historical order limit, and deliberate buyer acceptance recorded atomically with the order. The Platform shows document links and receipt email with one checkbox. The host backup observer recognizes the same separately admitted root-owned profile, preserving default disabled behavior and existing erasure/source/image/lineage checks. No schema migration, manual entitlement or install is part of that candidate.

Local validation:19new closed-profile contracts,127targeted Commerce checkout/refund/foundation/catalog tests overall,136Platform tests, Platform typecheck, focused ESLint and diff/link/JSON checks. CI and image build are separate future receipts on the exact candidate; local tests are not provider or production PASS.

## What still precedes money

Review/CI the code candidates and the concrete enablement/install packet; provision the one API key into verified private custody/escrow and the actual private return path. Finalize/approve one legal package, actual fiscal recipients/retention and genuine qualification references; serve final documents and independently verify response hashes. Only then qualify the policy, admit the exact runtime and sole acceptance offer, obtain the separately required1₽ money authorization and let the owner perform card/SBP interaction. No new Linear issue is needed. ART-39/83/224 stay open, ART-338 stays Done, public F9 stays closed.
