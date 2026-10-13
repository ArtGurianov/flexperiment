# ART-330: atomic Commerce editorial publication

## Decision and boundaries

The P0 owner decision in ART-329 applies to the two archived canary snapshots,
not to production or a later database state. ART-330 starts from the existing
Commerce V2 lineage after migration 0025. It does not import Payload rows,
clear seeded or operational evidence, touch the erasure ledger, or activate a
runtime release. A fresh canary inventory is required before any later cutover.

Three approaches were considered. Keeping Payload authoritative with a new
mirror would retain the two-database commit and lease problem. A separate
Commerce published tree would create a second published authority. The chosen
approach stores one bounded editorial draft aggregate per course and updates
the existing `catalog_course_projection`, `catalog_section_projection` and
`catalog_lesson_projection` as the only current published graph. Immutable
per-version JSON snapshots are history, not a second live reader.

## Schema and identity

Migration 0026 adds `course_editorial_drafts` with course ref, revision CAS,
validated bounded Lexical-compatible JSON, and update metadata; a published
version snapshot table; and a publish-command idempotency table keyed by
course and command key with request digest and stored result. Minimal title,
slug, summary, rich-text and SEO fields are added to the existing projection
rows. The original projection identity keys remain stable. Current schema
uses `ON DELETE CASCADE` for sections and lessons, so migration guards must
reject deletion or parent/ref/slug changes of published rows. A later draft
that omits a previously published section or lesson retains that row as
`UNLISTED`; it cannot remove a grant, binding or playback history by cascade.
The new writer marks Commerce-authored courses so legacy manifest ingest
cannot overwrite them during the ART-330 to ART-331 transition.

The aggregate is validated as a whole: unique immutable refs and slugs,
bounded size and graph depth, valid course/section/lesson membership and
positions, safe Lexical node shapes, and no commercial terms. FREE/PAID,
price, sale mode and payment purpose continue through `configureProduct` and
catalog control. The first draft may exist without a product; publication
requires the appropriate product/offer authority without creating a sale.

## Review amendment: restrictive state and verifiable versions

Emergency unlist and withdrawal are durable course-level publication states,
separate from the draft's requested visibility. A normal publish may update
content while an emergency hold is active, but the effective published course
remains `UNLISTED`. Only an explicit `relist` command with the current published
version, reason, idempotency key and audit record can release an emergency
unlist. It requires the latest editorial intent to be `LISTED` and an active
course product. Withdrawal cannot be released through `relist`.

Every immutable version stores the exact current published graph JSON without
its own digest. `content_hash` is SHA-256 of the UTF-8 bytes of that saved
`document_json`, including retained hidden refs and the restriction state.
The same digest is stored on the current course projection. This single rule
applies to publish, emergency unlist, withdrawal and relist; a historical
version can be checked independently after later draft changes.

## Operations and transaction

Admin create/edit returns draft revision; stale revisions fail. Fetch draft is
admin-only; published reads use the projection tables and never include draft
JSON. `publish(expectedRevision, expectedPublishedVersion, idempotencyKey)`
validates the request digest and commits in one `BEGIN IMMEDIATE` transaction:
recheck both CAS values and the complete graph, update the existing projection
rows and restrictive visibility, retain absent published refs as unlisted,
insert one immutable version snapshot, one audit record and one idempotency
result. A same-key same-digest replay returns the stored result; a changed
digest fails. A crash or SQL failure rolls the entire transaction back.
External cache/ISR or notification work occurs only after commit under later
durable-effects work (ART-339); there are no network calls while SQLite is
locked. Unlist and withdraw use the same publication transaction and existing
product withdrawal authority, preserving entitlements and history.

## Proof and rollout boundary

Tests run migration 0026 on a database created from the real 0001–0025 DDL,
including `foreign_keys=ON`. They cover draft isolation, complete publish,
injected SQL failure, concurrent revision/version CAS, same-key replay,
orphan FK rejection, immutable ref/slug and parent, retained unlisted rows,
immediate restrictive visibility, historical grant and video binding
preservation, and rejection of late legacy manifests on Commerce-authored
courses. ART-331 separately removes lease and override read/write dependencies
after this local publication path is qualified. ART-342 and live protected
playback remain independent provider gates.
