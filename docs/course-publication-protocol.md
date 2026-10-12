# Course publication protocol (ART-207–210, ART-223)

## Authorities and immutable identity

Payload in the Next.js `apps/platform` server owns published editorial content: courses, ordered sections, lessons, stable `courseRef`/`sectionRef`/`lessonRef`, visibility, display and SEO. Commerce independently owns FREE/PAID, price, sale mode, entitlement, and private Kinescope asset bindings. Never copy a private video binding or provider secret into public Payload DTOs. GraphQL is disabled; server-side Payload reads that represent the public use Local API with `overrideAccess: false`.

Once published, a ref/slug and a lesson's parent course cannot change; publication cannot be undone by deleting/unpublishing. Use `visibility=unlisted` for discovery hiding and the Commerce WITHDRAWN state for takedown. Unlisting does not revoke a paying customer's acquired access. Do not infer that a newly drafted parent version is published when a child changes.

## Commit, manifest and override contract

The unversioned `course-manifest-states` records version, public content modification and invalidation markers independently of draft versions. Manifest input comes only from the committed published tree; changes increment the version in the publication transaction. A full-state manifest contains courseRef, version, committed-state hash, sections, lessons and restrictive operations. Out-of-order versions fail. Same-version, same-hash retries renew their lease without publishing draft content and re-report outstanding operation results after lost acknowledgements. Validation must run **before** restrictive-override state changes.

A restrictive visibility change remains fail-closed when commerce is unavailable: pending operations must be enforced until a verified published manifest acknowledges them. Lifecycle: `PENDING → FINALIZED` when applied, `SUPERSEDED` when a later committed manifest makes it obsolete, or `RELEASED_ROLLED_BACK` only with transaction non-commit proof. `ORPHANED` operations require attention after the one-hour safety boundary. Periodic reconciliation runs every five minutes; if the manifest lease is not reconciled/renewed for 24 hours, free and preview access fails closed while established purchased grants remain usable. The maximum duration/lifetime of an in-flight Payload save transaction is a **separate** safeguard governing when `RELEASED_ROLLED_BACK` may be established; the 24-hour manifest lease is not that transaction lifetime. A timeout is not proof of rollback; do not release restrictions on an ambiguous commit. A delayed commit following release must re-enforce restriction. Separate effects (ISR revalidation, search, sitemap, IndexNow) are triggered once per real published version; no-op retries do not repeat them.

## Public discovery and access

Catalog, search index and sitemap exclude withdrawn/unlisted items as appropriate. Unlisted purchased lessons remain available to eligible customers. Preview/free access requires authentication and valid publication visibility/lease; grant holders retain access across unlisting. All-course entitlement includes future courses. Do not expose editorial drafts or lesson-to-asset private mappings.

## Regression obligations

Test parent-draft isolation, no-op lease renewal, lost ACK recovery, out-of-order manifests, invalid section membership, failure after jobs.queue, transaction in-flight and hard-lifetime kill, rollback race, commit-after-release, strict validate-before-override, restrictive outage, relisting, one-per-version side effects, public output filtering and playback isolation. Historical implementation evidence: Flexperiment PR #169, Linear ART-207–210.
