# Readiness backport for the installed closed canary

The owner delegated the choice between a storefront-mount rollout and a
separate backport. Use the backport: deploying storefront controls would also
change application admission, images and mounts outside this backup repair.

The installed host helper is byte-identical to
`56f864ee5b5325acd2ed5c5ad6ea756182326bf7:scripts/v2/fast-cut.py`, SHA-256
`9ce826f47e8e07e1ea124fadc7ec39dcde5e4c52efe2094d9e80c4812a435583`.
The canonical helper on main additionally requires storefront mounts which
the admitted Commerce container does not have. Do not remove that guard from
the canonical helper or copy the current main helper over the installed file.

## Chosen artifact

Keep a temporary compatibility helper in
`deploy/host/canary-readiness-backport/`. Start from the exact installed bytes
and transplant only the host probe bounds, allowlisted diagnostics and finite
readiness waits reviewed in PR273–275 (upstream `b2702c6597da8d487322a1fee7a713d2d77d2de4`).
Keep snapshot/upload, signed authority, fence, schema, artifact and network
checks unchanged. Add a strict pin to the currently admitted role/image/source
vector. The old legacy release fallback is refused. A future runtime cannot
reuse this pre-storefront helper by merely replacing its release descriptor.
Expose only check, check-backup and backup through this compatibility CLI.

An optional systemd drop-in raises only the backup unit timeout to90 minutes.
It does not replace the existing unit or its alert hooks. No application,
Compose file, timer cadence, credential, mount or erasure authority changes.

The backport does not install Commerce's8-second server deadline or Platform's
10-second upstream wait. Those require separately qualified application images.
The current Platform may still answer503 after3 seconds; bounded fresh GET
attempts tolerate an isolated failure without claiming that mismatch is fixed.

## Evidence and lifecycle

Carry the upstream helper suite with compatibility-specific expectations,
plus tests for the frozen release vector and byte/AST provenance. Pin every
unchanged base node and the database/fence/remote-ledger tail of check().
Refusals must not reach snapshot/upload or overwrite the preceding SUCCESS.
Evaluate the candidate's check/check-backup read-only on the admitted host
before any separately authorized installation.

This change prepares code and a runbook. Installation has custody impact;
it requires the exact-operation authorization and inventory/capture process
in adman-vps-infrastructure/AGENTS.md. Retire the compatibility lane only after
the normal storefront/runtime rollout and host-helper requalification succeed.
