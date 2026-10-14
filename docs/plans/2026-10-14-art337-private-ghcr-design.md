# ART-337 approved private registry preparation

Owner approved these exact repositories on 2026-10-14:

- ghcr.io/artgurianov/flexperiment-commerce-v2
- ghcr.io/artgurianov/flexperiment-platform-v2
- ghcr.io/artgurianov/flexperiment-admin-v2

Publish through a separate unmerged engineering branch using the ephemeral
GitHub Actions token with contents read and packages write. The installed gh
OAuth token lacks package scopes; it is not copied into a registry credential.
New GHCR packages are private by default. Read package visibility before push
when it exists and independently after push; public packages refuse.

The one-time push workflow is restricted to the exact engineering branch and
approved repository. It builds source 08523bdf38eeddf5e745ce04d05e1f980a7ced93
only, verifies current main and exact-source green checks before publication,
and uses one unique run/attempt tag per service. Tags are discovery handles;
admission consumes the single-platform manifest digest. Preserve image archive,
archive hash, manifest bytes, image ID, RootFS and native baked identity after
an independent digest pull. Admin uses its existing release.json contract;
Commerce/Platform use their existing build-identity contract. No code is added
to the deployment source and no changes enter main or PR #222.

Alternative local PAT publication requires owner-created package credentials;
publishing from main would change the pinned deployment source. The separate
Actions branch preserves the reviewed controller and target while avoiding a
new persistent write credential. Actual VPS pulling will still require an
owner-managed read:packages credential, under separate authorization.

This workflow has no SSH, Coolify, erasure, runtime, live database, production
or Kinescope operation. Registry preparation is not GO TO EXECUTE ART-337.
