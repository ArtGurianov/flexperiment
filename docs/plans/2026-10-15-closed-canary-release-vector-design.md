# Closed canary candidate readback — 15 October 2026

## Goal and authority

PR225/226 are merged. Commerce and Platform candidates use source
`46305e7a422a8239def139dab6e2e28790de3c61`; Admin remains source085.
Owner permits offline engineering; live recovery/deployment remains HOLD.
This controller change does not become the application deployment source.

## Options and choice

1. **Choose:** small protected per-role release file for the existing check and
   backup helper. Preserve its old source085 default when no file is installed.
   Independent source/digest readbacks and existing erasure checks remain required.
2. Rebuild Admin merely to make all source labels equal: unnecessary artifact
   work; it does not fix the helper's source085 backup filename/status checks.
3. Run new apps while retaining the old check/backup expectation: unacceptable;
   scheduled backups would fail or an old-source archive could be misclassified.

## Contract

`/etc/flexperiment-fast-cut-canary/release.json` is root0600 beneath the existing
root0700 directory. Exact schema, canary scope, three roles, role-specific private
GHCR repositories, immutable digests and full source SHAs are mandatory.
Originally Commerce and Platform shared a source. The later
[Commerce-only candidate](2026-10-15-commerce-only-release-design.md) permits
independent native role sources while retaining explicit upstream SHA checks.
An invalid present file never falls back. One vector is read per CLI process.
The reviewed candidate JSON is a proposal, not an execution/admission receipt.

The helper compares Compose image, running image ID/RootFS, qualified native
identity and SOURCE_COMMIT env. Platform must expect the vector's Commerce SHA.
Admin's native release.json identifies Admin; its /readyz proxies Commerce and
must identify the new Commerce SHA. An actual nginx regression proves that split.
Backup filename and freshness use the Commerce source, never the controller SHA.

## Boundaries and validation

No new deployment API, automatic restart, journal write, erasure change, DDL or
credential provisioning. Existing schema/fence/remote-ledger/mount/guard checks
remain. Tests cover legacy compatibility, malformed/private/duplicate manifests,
role/tag/source swaps, mixed readiness, actual nginx and new/old backup identity.
The existing Test workflow already runs this suite. Live qualification requires
independent review and a separate owner GO under the linked execution plan.
