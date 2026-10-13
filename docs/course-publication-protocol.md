# Course publication protocol (ART-207–210, ART-223)

## Commerce editorial transition (ART-330, implemented in source; rollout pending)

Migration 0026 adds a Commerce-owned editorial draft aggregate and immutable
published version snapshots. The current published graph is the existing
`catalog_*_projection` tables. Admin draft reads/writes and publication use
`/v1/admin/v2/courses/:courseRef/{draft,published,publish,unlist,withdraw}`
under Control Room authentication. Publication checks draft and published
versions, records an idempotency result, audit event and version snapshot, and
updates the graph in one `BEGIN IMMEDIATE` transaction. The draft is never
read by player/public routes. Previously published sections and lessons omitted
from a later draft remain `UNLISTED`, with refs and video bindings retained.
FREE/PAID, price and sale mode remain under catalog control; withdrawal also
updates the product in the same transaction. Legacy manifest ingest rejects a
Commerce-authored course. Existing Payload courses and their manifest protocol
below remain the live path until the staged cutover. ART-331 removes the
manifest lease and override dependency from live access, and ART-339 makes
publication effects durable; this source change alone is not runtime proof.

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

## Precise Payload author and publication boundary (ART-208/209)

The first authenticated author is the sole supported author; author registration is then closed, with no public or multi-author signup. Payload is in the same Next.js `apps/platform` server, but the editorial SQLite is separate from Commerce v2. Author-facing commercial summaries are read-only and carry a Control Room deep link; failure to load the summary must not block editing. **Notify students** requires an explicit preview and author confirmation for already-published lessons; publishing or scheduling a lesson never itself sends a broadcast.

Payload transactional save must use `transactionOptions`; boot/test without that support must fail. The transactional outbox enqueues `syncCourseManifest` only for committed published content. Public/author data access uses the authorized data-access layer, with a lint prohibition on direct `payload.find` calls outside that layer. Public, cacheable server route `/search-index.json` (not a prebuilt static artifact) and sitemap use published, effectively listed and non-WITHDRAWN content; no drafts or Kinescope IDs. Search normalization is lowercase/ё→е with prefix/fuzzy support.

`POST /v1/internal/access-overrides` accepts `operationId`, `courseRef`, `scope: {level, ref}`, `expected: {kind: EFFECTIVE_VISIBILITY | FREE_PREVIEW, value}`, `deadlineAt`, and `platformEpoch`. It does not accept a generic `restriction`/manifest-version pair. For each operation, the receiving Commerce boundary checks the same operation facts on replay, rejects reused operationId with different facts, and applies the `DENY_NON_ENTITLED` restriction before acknowledging editorial publication. Effective visibility is **course ∧ section ∧ lesson**; an unlisted ancestor restricts the descendant. A full published-state manifest contains all sections and lessons; missing previously stored children are removed atomically. Validation precedes override mutation. The authoritative committed operation is later resolved as FINALIZED or SUPERSEDED only by an applied verified manifest; ambiguous saves remain restrictive, and RELEASED_ROLLED_BACK needs absence/non-in-flight/process-epoch proof after the separate transaction deadline, not the 24-hour manifest lease.
