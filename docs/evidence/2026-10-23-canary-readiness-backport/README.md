# Read-only compatibility qualification

On 23 October 2026 at 01:38:58 UTC, the exact candidate bytes identified
by `candidateSha256` in [read-only-qualification.json](./read-only-qualification.json)
were loaded into memory on adman-vps. Only check() and check_backup() ran.
The candidate was not written to the host filesystem or installed.

The recorded runtime check passed image/RootFS/native-source and private
descriptor checks, readiness, SQLite schema/integrity/foreign keys, OPEN fence
with no owner/leases and independent signed remote-ledger read-back. The last
backup was FRESH. Before/after container identities, private input bytes and
installed helper bytes matched; private bytes and their hashes were not logged.

This proves compatibility of these candidate bytes with this admitted runtime.
It does not prove a calendar backup with the new helper, new snapshot/upload,
systemd timeout installation, alert delivery, host custody or production SLOs.

`CUSTODY_IMPACT: NO` — this record contains read-only qualification, no host change.
