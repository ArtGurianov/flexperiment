# Production legal-release publisher

`commerce:legal-release:publish` is the only production bootstrap path for a
legal release. It never creates cities, occurrences, or development fixtures.
The operator supplies a checked-in canonical JSON manifest containing an
approved immutable release version, four document versions, source hashes, and
current plus immutable archive URLs. The command verifies that its four bundled
legal source files match the declared hashes before touching SQLite.

Publication is serialized with `BEGIN IMMEDIATE`. A new version deactivates the
previous release, inserts exactly one active release, and writes a publication
event containing the release version and canonical-manifest SHA-256. Repeating
the same active version and manifest is a no-op publication with a replay audit
event. A changed manifest for an existing version, an inactive existing version,
missing archive URL, invalid URL, or source-hash mismatch fails closed.

The repository intentionally includes only a manifest example. The operator
must create the approved `commerce/legal/production-manifest.json` with real
immutable archive URLs before the command may run in production.
