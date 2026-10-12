# ART-329 read-only inventory design

## Scope and choice

This one-time preflight targets exactly the active `canary-v2` Commerce V2 and
Payload/editorial SQLite instances. Production Commerce V2 is observed
separately to prevent an environment mix-up. Neither database is reset,
migrated, seeded, imported or attached to the other.

Three ways to collect counts were considered: direct queries on live files,
copying `.sqlite` files, and SQLite Online Backup. Direct queries can span
different moments; copying the main file omits uncheckpointed WAL frames.
`scripts/v2/art329_inventory.py` uses a `mode=ro`, `query_only` source connection
and SQLite Online Backup into a new private directory. The resulting snapshots
are then opened with `mode=ro&immutable=1` for integrity and inventory queries.

The CLI counts every non-internal table, including unknown additions. It groups
the known tables and counts unfinished operations by state. It emits table names,
counts, integrity results, source device/inode/mtime and SHA-256, but never row
values. A nonempty data table or missing expected table yields
`STOP_REVIEW_REQUIRED`; even an entirely empty snapshot cannot autonomously
declare `ZERO_REAL_DATA_CONFIRMED`. The owner must classify each nonempty group
against the exact instance and snapshot time.

## Archive and failure boundary

Both online snapshots and `inventory.json` are written outside application
volumes. A second process independently reopens the snapshots, checks
`PRAGMA integrity_check`, recounts every table and compares SHA-256. The
snapshots are encrypted with each service's existing age recipient and copied
to a new, dedicated Cloud.ru S3 namespace. Remote ciphertext is streamed back
and hashed. Existing backup objects, erasure ledger, fence and application
volumes are left in place. After the evidence assessment is complete, new host
archive files and directory receive the immutable filesystem attribute.

For a repeat, first identify the active containers by Coolify environment and
resource labels, inspect their mount sources and configured database paths, and
pass those exact host files and container identities to the CLI. Use a fresh
archive directory; the CLI refuses an existing one. It does not perform a
production cutover or grant authority to skip a later review if the databases
change.
