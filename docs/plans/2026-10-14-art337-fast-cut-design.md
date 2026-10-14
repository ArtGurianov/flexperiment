# ART-337 fast cut (owner amendment, 14 October)

## Keep from original plan

Required independent erasure installation/ledger/fence/keys and normal boot;
qualified source085 digests/native identities; encrypted history; closed public,
payment and marketing gates. Old resources, journals and uncertain receipts
remain archived. No replay or invented completion.

## Adopt from alternative plan

- **Material improvement:** isolated Compose instead of Coolify env POST;
  removes automatic preview mirrors and API mutation choreography.
- **Material improvement:** one pre-cut classification and one post-cut actual
  remote ciphertext/decrypt/restore proof, plus verified recurring backups.
- **Material improvement:** final technical acceptance, rather than per-operation
  reviews. Replacement PR stays separate from historical PR222.
- **Critical fix:** qualify new runtime directly against preserved REQUIRED
  erasure installation; historical journal is not the new Compose authority.

## Reject from alternative plan

No owner requirement is rejected. Fresh DB is an allowed alternative, but
reuse of already qualified schema26 is simpler here. No app data is discarded
or imported. A Compose backup must target Compose, not old Coolify UUID lookup.

## Conflicts / decisions needed

Owner amendment supersedes old no-reset/journal-v3 requirements. Select schema26
reuse; no reset is necessary. Scope is canary only. All deployment images stay
source085; replacement infrastructure commit is a separate identity.

## Risk delta

Direct Compose is temporary host-managed operation. Dedicated bridge allows
outbound independent ledger reads; it has no host-published ports, Docker proxy
labels or attachment to Coolify/production networks. Admin's approved native
image needs a readonly canary nginx config (its baked v1 upstream is unsuitable).
Source085 Platform's canary origin whitelist requires the original Commerce
alias, supplied only inside the new private network.

## Revised merged plan

1. Recheck bounded inventories, stopped writers, drained OPEN fence, verified
   ledger, exact images and retained off-host restored snapshot hashes once.
2. Export original root-controlled Commerce inputs into a new private raw env
   file; keep provider/erasure credentials. Generate one new canary-only admin
   password for normal login smoke; preserve original hash/config. Platform env
   has no Payload inputs/mounts. Park old partial resource; no API repair.
3. Start three digest-pinned Compose services, using original Commerce volumes
   and existing erasure mounts, unchanged. No host ports or public ingress.
4. Check actual image/RootFS/native identity, schema26/erasure readiness,
   retired404 routes, normal Control Room login/read/logout via private nginx,
   Platform readiness and external four403 guards.
5. Produce actual encrypted backup; normalize root-owned600 transport custody,
   independently GET/decrypt off-host, restore/boot copied fence in published
   image. Install only new canary backup/freshness calendar timers; verify
   enabled/waiting with future deadline and successful current backup.
6. One evidence packet, replacement PR, Linear fast-cut acceptance. DRM/browser
   E2E/F9 remain separate; no merging PR222 or modifying production.
