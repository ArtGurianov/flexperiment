# Agent Referrals candidate boundary

Release id: `agent-referrals:24a382929740a7ead6fb0bb49f5ffc77e063c77a` — the
release identifier is fixed to the `production-deploy` SHA observed when this
document was first reviewed
(`24a382929740a7ead6fb0bb49f5ffc77e063c77a`, legal manifest `2026-08-28.1`).
That SHA is not necessarily this feature's final `BASE`; see below.

This is a **control-plane** document: PR1 defines the machinery it describes
(`commerce/src/agent-referrals-candidate.ts`, the `RECONSTRUCTION_BOUND`
structural test machinery in
`commerce/test/controller-not-older-than-target.test.ts`, and the topology
exemption in `commerce/test/release-ref-topology.test.ts`). It never runs in
production and takes effect the moment it merges to protected `main`, per
`docs/release/DEPLOYMENT_INVARIANTS.md#control_plane-is-governed-not-deployed`.

## BASE

`BASE` is the freshly observed `production-deploy` SHA read immediately
before candidate construction, not a value pinned in this document ahead of
time — `production-deploy` moves between PR1 landing and the eventual
candidate build in a later PR, and re-reading it fresh is what keeps `Q^ ==
BASE` a live proof rather than a stale assumption. See §B-1 of the Agent
Referrals implementation plan for the full rationale.

## Candidate construction rule

`Q` is a deterministic detached commit reconstructed from `BASE` plus a
certified, patch-based transformation series — never a whole-file overlay
copied out of `main`'s tree. Every certified path pins:

```text
path
base_blob_sha
patch_path            committed control-plane artifact on main
patch_git_blob_sha     binds the proof to the protected-main tree
patch_sha256
result_blob_sha
mode (or explicit deletion)
```

plus the full frozen canonical commit envelope — every field pinned as
independently reviewable evidence, not merely implied by the reconstruction
code:

```text
parent_sha        cross-checked against the certificate's own base_sha
tree_sha          cross-checked against the tree reconstruction actually derives
author_name / author_email / author_timestamp / author_timezone
committer_name / committer_email / committer_timestamp / committer_timezone
message
encoding = "none"        rejected if anything else
extra_headers = "none"   rejected if anything else
signed = false            rejected if anything else
```

The certificate also pins `source_main_sha`: the exact protected-main commit
whose tree every `patch_path` is read from, and the root a controller must
prove `main`-ancestry for before trusting anything else in the certificate —
see `RECONSTRUCTION_BOUND` below.

See the module docstring in `commerce/src/agent-referrals-candidate.ts` for
the exact contract and `commerce/test/agent-referrals-candidate.test.ts` for
the proofs this document summarizes:

- two independent reconstructions of one certificate produce the identical
  commit SHA;
- a changed patch byte, a wrong `patch_git_blob_sha`, a wrong base blob, a
  wrong `result_blob_sha`, or a wrong pinned `tree_sha` is rejected;
- a `parent_sha` that disagrees with `base_sha` is rejected;
- `encoding`, `extra_headers` and `signed` are rejected unless they carry
  their one frozen value;
- a changed canonical commit-envelope field changes the reconstructed SHA;
- a whole-file overlay cannot satisfy the contract (it is not a valid patch
  against the pinned base);
- `public/legal/**` and `commerce/legal/**` can never appear in a certified
  path, so `Q` inherits production legal state from `BASE` unchanged, by
  construction rather than by review convention.

### `RECONSTRUCTION_BOUND`: binding the ancestry proof to the certificate itself

A controller must never prove ancestry for a `SOURCE_MAIN_SHA` read from an
input independent of the certificate — that would let a decoy, genuinely
safe `SOURCE_MAIN_SHA` stand in for the certificate's own claimed authority
while `source_main_sha` (the field that actually gates every `patch_path`
lookup) goes unproven. The required shape, positively enforced by
`commerce/test/controller-not-older-than-target.test.ts`:

```text
BASE_SHA="$(scripts/read-production-deploy-ref.sh)"
git show "$CONTROLLER_SHA:.release/controlled-candidates/agent-referrals-$BASE_SHA/certificate.json" > candidate-certificate.json
SOURCE_MAIN_SHA="$(jq -er '.source_main_sha' candidate-certificate.json)"
git merge-base --is-ancestor "$SOURCE_MAIN_SHA" "$CONTROLLER_SHA"
jq -e --arg base "$BASE_SHA" '.base_sha == $base' candidate-certificate.json
RECONSTRUCTED_SHA="$(node --import tsx commerce/src/agent-referrals-candidate-verify.ts candidate-certificate.json)"
[[ "$RECONSTRUCTED_SHA" == "$TARGET_SHA" ]]
```

`SOURCE_MAIN_SHA` is extracted from the exact certificate file the earlier
step read — never a separate file, script output, or workflow input.

## Certificate location

`.release/controlled-candidates/agent-referrals-<BASE>/certificate.json`,
committed to protected `main` once `<BASE>` is known (a control-plane
artifact PR10 commits, not something `Q` itself carries — reading it from
`Q`'s own tree would be exactly the circular proof this machinery refuses to
perform). Patches live alongside it under `patches/`.

## Changed-path allowlist

Not yet defined. PR1 ships the reconstruction and topology machinery only —
no certificate exists yet, because `Q`'s SHA depends on PR2–PR9's actual
patches (the certificate is a post-implementation release artifact, Phase
10A of the plan). The real allowlist is committed here, alongside the real
certificate at the location above, once PR10 exists.

## Recovery matrix

Not yet applicable. Nothing in this feature has deployed, so there is no
recovery scenario to document yet. The full matrix — including why
`completeRolling()` is unavailable before schema convergence and why a
post-migration rollback requires a DB restore — lives in the plan's Phase
10B / recovery-matrix section and will be transcribed here once the feature
reaches DORMANT delivery.

## Terminal record

None. This feature has not been built, deployed, or activated.
