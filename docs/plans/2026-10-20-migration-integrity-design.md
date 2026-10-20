# ART-316: immutable Commerce V2 migrations

The migration files are the schema authority. Existing SQL stays byte-for-byte
unchanged; `commerce-v2/migrations/migration.lock` names the ordered chain and
records each file's SHA-256. The lock uses the existing `flexperiment-v2`
lineage and contiguous four-digit migration numbers starting at 0001.

## Enforcement

On every startup, CLI migration and direct `applyV2Migration` call, read and
validate the entire SQL bundle against the lock before changing the database.
Under `BEGIN IMMEDIATE`, require the database journal to be an exact prefix of
that bundle, with matching stored hashes for every applied version. Reject
unknown versions, gaps, missing/empty journals on a populated V2 database and
digest mismatches. A direct application must supply the locked bytes and the
next version, or be an already-applied, verified no-op.

The journal stores a non-null, lowercase SHA-256 along with the existing
version and application timestamp. Pending SQL and the journal entries commit
together. The entire migration invocation, including the legacy upgrade,
rolls back on failure. V1 and unknown database lineages remain refused.

## Legacy upgrade

Existing deployed journals have no digest. Their upgrade is allowed only for
an exact, nonempty prefix of the 0001–0032 chain at `dc351af2`. A digest of that
complete chain is pinned in code, independently of the editable lock file.
Rebuild only the journal in the same transaction, retaining every version and
timestamp, then apply pending migrations normally. Do not extend this legacy
allowance when adding later SQL. No database reset or application-row rewrite
is part of the journal upgrade.

This establishes a digest for the reviewed legacy version identities; a
version-only old journal cannot retrospectively prove which bytes actually
ran. It assumes a legitimate legacy ledger from the supported deployment
chain. Arbitrary privileged database/DDL replacement is outside the guarantee.
Isolated restore and retention retain the old reviewed schema fingerprints
and admit the corresponding schemas with the new journal shape.

## Git history

`pnpm commerce-v2:check-migrations` requires a full checkout, validates the
current bundle and compares it against all historical SQL blobs and lock
entries reachable from HEAD, including both sides of merges. It also rejects
historical deletion/restoration. This protects clean databases from SQL and
lock edited together, including initial lock adoption and reverted edits.
Missing or shallow history fails closed. CI keeps its exact source checkout
and adds `fetch-depth: 0` plus this check; deployment workflows do not change.

## Alternatives and validation

Journal-only hashes cannot protect clean installations. A lock-only check
cannot detect a jointly rewritten SQL file and lock. Use both, with the
history comparison as the independent source check and a sealed legacy chain
instead of unconditionally backfilling digests from the working tree.

Tests cover persistent reopen, supported legacy prefixes, timestamp/data
preservation, atomic failure, journal/lock tampering, direct apply, full Git
history, merge-side drift and actual server refusal before serving traffic.
Run the Commerce V2 suite, TypeScript, lint and the history command. Passing
repository checks does not install the upgrade on any host.
