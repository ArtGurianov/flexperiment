# ART-331 · Local editorial access without a manifest lease

## Source transition

Commerce editorial publication writes the course, section and lesson graph in
one SQLite transaction. Playback and library reads for rows marked
`COMMERCE_EDITORIAL` use that graph directly. The 24-hour
`last_reconciled_at` lease and pending Payload `access_overrides` apply only to
`LEGACY_MANIFEST` rows while the old platform remains active. Existing grant,
visibility, withdrawal, consent, FREE, retained enrollment and preview order
is unchanged. Control Room counts only legacy projections as stale.

Before the first Commerce publication, the publish transaction refuses any
pending legacy override for that course. The legacy override writer takes an
immediate SQLite transaction and refuses a Commerce-authored projection,
including same-operation replays. These checks serialize handover and prevent
an unresolved restrictive intent from being bypassed. A reviewed rollback
release or authoritative manifest resolution must precede publication; an age
or deadline alone does not release an override.

## Proof and remaining work

Tests publish actual Commerce editorial courses and check FREE, preview and
retained FREE enrollment after 25 hours and seven days without reconciliation.
Visibility, withdrawal and entitlement revocation deny immediately. A pending override blocks first
publication; a later legacy override is refused. Existing legacy lease tests
remain in place and must pass.

This is source compatibility for a staged cutover, not ART-331 completion.
The old manifest/override endpoints, reconciliation job, readiness and
remaining legacy integration metrics remain until the Payload-free platform and canary hard cut
are reviewed together. Before switching runtime, re-inventory pending
overrides and the active course authoring sources; preserve the erasure ledger
and fence. No canary, production or public access mode changes are included.
