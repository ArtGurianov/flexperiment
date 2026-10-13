# ART-333 · Control Room course editor

2026-10-13. The Commerce V2 product is created through the existing commercial
command before editorial publication. The editorial UI selects that course ref;
it never changes price, sale mode or acceptance allowlist as a side effect.
Legacy manifest projections are read-only and cannot be selected for editing.

## Approach

Use a standalone Lexical client field inside the existing Control Room Courses
page. A custom rich-text format would break the approved aggregate contract;
retaining Payload would keep a second editor and SQLite writer. The first
version registers only paragraph, text and line-break nodes, with simple inline
formatting. Commerce validates this same small set before saving any draft.

The editor loads the saved draft and published projection under the current
Control Room session. It edits one bounded aggregate: course details, ordered
sections and ordered lessons. Refs remain stable; published slugs are locked.
New section and lesson refs are generated locally from UUIDs. Omitted published
refs remain in Commerce as unlisted history under the existing publication
rules. The interface warns before removal.

`Save draft` sends `expectedRevision`; `Publish` sends the saved revision,
observed published version and one idempotency key. An ambiguous publish keeps
the key for retry, while a conflict offers an explicit server refresh without
silently overwriting local changes. Ordinary publication cannot release an
emergency unlist. `Unlist` uses the restrictive command, and `Relist` requires
its separate audited command with a reason.

## Qualification

DOM tests exercise create/edit, stale revision, failed network response,
read-only published state and double-submit prevention. Commerce tests reject
unsupported Lexical nodes. Typecheck and static Admin build run on the exact
branch. Live course creation and protected playback remain canary gates with
separate owner approval; this source change does not deploy or open public
registration, payments or marketing.
