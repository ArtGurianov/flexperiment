# ART-329 canary inventory evidence — 12 October 2026

**Owner decision: `ZERO_REAL_DATA_CONFIRMED` on 2026-10-12 at 14:06 UTC, for
the exact canary-only snapshots below, preserving seeded/reference data and
immutable operational evidence.** The immutable machine report was produced
before owner review and therefore retains its original
`STOP_REVIEW_REQUIRED` decision. The owner's prior statement that
sales/registrations were test-only was context, not proof of database contents;
the decision follows the complete inventory and backup readback below.

## Exact source identities

| Authority | Active Coolify resource / environment | Host source | Device / inode | App image source |
| --- | --- | --- | --- | --- |
| Commerce V2 | `flexperiment-commerce-v2-canary` / `canary-v2` | `/var/lib/docker/volumes/xzuy7pk5y6ywjr9kh6nsk5ap-xzuy7pk5y6ywjr9kh6nsk5ap-commerce-v2-data/_data/commerce.sqlite` | `2050 / 1235264` | `84b1a6abcb43e9abf8f781e830f84822207c0dca` |
| Payload/editorial | `flexperiment-platform-v2-canary` / `canary-v2` | `/var/lib/docker/volumes/ks8c2wmlle1kvdfuwbiwthe1-flexperiment-platform-v2-canary-editorial/_data/platform.sqlite` | `2050 / 1336508` | `b0ba13a3f58e5649afcc771da385959b14a06539` |

The separate active **production** Commerce V2 instance is
`flexperiment-commerce-v2`, image source
`02f1f8322fe6e37f181de30163ca72440309130e`, database inode `1377364`
on device `2050`, and has 22 migrations. The canary Commerce snapshot has 25
migrations. Production was read only for identity and selected counters; it was
not included in the two canary archives. No production Payload instance was
identified among active Flexperiment containers.

## Point-in-time counts and classification

Snapshots completed at `2026-10-12T13:44:25Z` (UTC). Both source main-file
stats were stable during their online backup. Commerce lineage is
`flexperiment-v2`; Payload has its expected migration/editorial tables.

| Group | Commerce | Payload | Classification |
| --- | ---: | ---: | --- |
| User, session, account, verification, customer | 0 | users 0, sessions 0 | Empty in this snapshot |
| Orders, lines, checkout attempts/quotes, refund records | 0 | — | Empty in this snapshot |
| Grants, free enrollments, course access starts | 0 | — | Empty in this snapshot |
| Consents, campaigns, recipients, email outbox/suppressions | 0 | — | Empty in this snapshot |
| Course/section/lesson projections and editorial content/versions | 0 | 0 | Empty in this snapshot |
| Media bindings, uploads, webhooks, playback events | 0 | media 0 | Empty in this snapshot |
| Pending access overrides, commercial commands, refund executions, uploads | 0 | unacknowledged access operations 0, jobs 0 | No unfinished rows observed |
| Cities, products, offers | 3, 1, 1 | — | Seeded reference/test catalogue; preserve |
| Deployment durability | 2 | — | Immutable operational evidence; preserve |
| Schema identity/migrations/launch seed | 1, 25, 1 | Payload migrations 6 | Immutable lineage evidence; preserve |

The three city slugs are `moscow`, `novosibirsk`, `saint-petersburg`. The sole
product and offer are the closed, zero-price `bundle:all-courses` seed. The
`launch_seed.catalogue_sha256` is
`dff9d2d945af2d0cbf77721312a49124a0b3eb23ff6262bdf6243e7c5483028d`,
matching `v2CatalogueDigest` of the committed launch catalogue. No nonempty
unmapped table was found. All 50 Commerce and 22 Payload non-internal tables
are listed individually in the private `inventory.json` report; this summary
does not infer real-data absence from the order count alone.

## Backups, uploads and erasure evidence

The new host archive is
`/var/lib/flexperiment-art-329-archive/20261012T134409Z` (`0700`, root-only).
Independent readback in a separate process matched every table count and
`PRAGMA integrity_check=ok` for both snapshots:

| Snapshot | Plaintext SHA-256 | age ciphertext SHA-256 |
| --- | --- | --- |
| Commerce | `611e27b9d6240cbb5869b3d8c1c194f7332995f516233c8c16fa9c268c0ac702` | `58138407521d83eca598221d521d419bd66b5767d7f62e9edb65612786f53879` |
| Payload | `7168269bb0e6e3176caaca562aae1675183f87fb39afbd04ad25a7ca8ba0596b` | `bd99981929d1f4c99aab0a7193d199a9c6daa7eeb6b2df0feced2b3ca99c5b07` |

`inventory.json` SHA-256 is
`da8728dedc413b9634df37ca461c3f9cc1a3bbbe89b19584307044832c60b57e`.
The two encrypted copies were stored under
`cloud:art-backups/flexperiment/art-329/20261012T134409Z/` with distinct
service recipients; streaming each remote object back produced the matching
ciphertext SHA-256 above. No existing backup was deleted. Existing scheduled
canary backup status for both services was `SUCCESS`; each named local
ciphertext still matched its recorded size and SHA-256. This status records
the earlier scheduled remote verification, not an independent current remote
readback of those older objects.

Payload has no media rows and no `S3_BUCKET`/`S3_ENDPOINT` configured in its
active container. Its jobs are disabled. Commerce has no upload sessions and
uses `KINESCOPE_DELIVERY_MODE=open`. Kinescope's separate project has two
pre-existing site videos (`фоновое видео`, `интро`); preserve them. The
inventory cannot prove the absence of unreferenced files in all external
systems, so any later media migration still needs a scoped check.

Erasure installation is present with state `REQUIRED` (installation descriptor
SHA-256 `1e6356af9823a40748923419e170ccacf7d18ce780ff84e4fda78825cd81e9ae`).
The separate admission proof has `realRemoteLedgerAck=PASS`, 25 isolated
migrations, `syntheticIdentityOnly=true`, and zero financial effects (proof
SHA-256 `a611300237d160dc2e1f1d1c421dd320d048b3f773dd7b2387e59ca68a856a3c`).
The ledger has one identity and one entry; the fence has one state row and no
leases. Both restore-proof SQLite files passed `PRAGMA quick_check=ok`.
These are existing proof artifacts, not a new erasure or restore execution.

## Owner decision boundary

The owner approved `ZERO_REAL_DATA_CONFIRMED` for the **exact canary snapshot
scope** at 14:06 UTC on 2026-10-12 and accepted preservation of the seeded
reference catalogue and immutable operational evidence. This is not a statement
about later database state or production. No importer/backfill, dual-write,
reset, hard cut, ingress change or archive/ledger cleanup is authorized by
this inventory or the owner decision.
