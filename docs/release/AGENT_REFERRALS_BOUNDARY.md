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
patch_path            committed control-plane artifact in the controller tree
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

The certificate also pins `source_main_sha`: the exact protected-main source
commit a controller must prove is in its ancestry before trusting anything
else in the certificate. Phase 10A sets `patch_source: "controller_tree"`:
every patch is read from the named controller commit's Git tree, supplied by
the controller at verification time, rather than `source_main_sha`. This is
intentional: the frozen source predates PR10's artifacts, and recording a PR
commit SHA would break under this repository's rebase-only merge policy.
Patch bytes remain bound by both `patch_git_blob_sha` and `patch_sha256`; the
controller tree is trusted only after the certificate itself has been read
from that same tree. See `RECONSTRUCTION_BOUND` below.

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
RECONSTRUCTED_SHA="$(node --import tsx commerce/src/agent-referrals-candidate-verify.ts candidate-certificate.json "$CONTROLLER_SHA")"
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

Phase 10A materializes the actual artifact at
`.release/controlled-candidates/agent-referrals-24a382929740a7ead6fb0bb49f5ffc77e063c77a/certificate.json`:

```text
BASE             24a382929740a7ead6fb0bb49f5ffc77e063c77a
SOURCE_MAIN_SHA  08f21d2293fcc1d908b2cfe23c0b64d8c4ef7e9f
TARGET_Q         eeb7d09973ea59e5c3b959a6db94ab552e1221c9
Q tree           6f2c84cb6e0e8a84a09a73238d3aa02491e1ee71
```

## Changed-path allowlist

The canonical, exact allowlist is the 88 sorted `paths[]` entries in the
committed Phase 10A certificate above. They are limited to Agent Referrals
Commerce runtime (including exact immutable migrations `0042` through `0049`),
admin/partner UI, and the two production routing configs. No test, workflow,
documentation, `.release/**` artifact, `public/legal/**`, or
`commerce/legal/**` path is reconstructed into Q. The materialization test
independently rebuilds Q, compares `BASE..Q` with that complete manifest, and
proves every migration blob equals the protected-main source blob.

## Phase 10B control plane (dormant)

PR10 delivers the machinery Phase 10B execution needs, so that after PR10
merges, Phase 10B is execution-only rather than something still to be built.
Both workflows are **manual-only** (`workflow_dispatch` only — no `push`,
`schedule`, or other automatic trigger) and gated by the `production`
environment's required-reviewer approval, per
`docs/release/DEPLOYMENT_INVARIANTS.md`. Merely merging PR10 executes
neither. See `commerce/test/controlled-agent-referrals-candidate-workflow.test.ts`
and `commerce/test/controlled-agent-referrals-workflow.test.ts` for the
structural proofs that every assertion below is really present in each real
file, and `commerce/test/controller-not-older-than-target.test.ts` for the
shared `RECONSTRUCTION_BOUND` proof both are held to.

- **`.github/workflows/controlled-agent-referrals-candidate.yml`** —
  publication only, never deployment authority. Reconstructs the exact
  certified Q from this controller's own tree (never Q's own tree — that
  would be the circular proof `commerce/src/agent-referrals-candidate.ts`
  refuses to perform), then pushes that exact commit to a fresh,
  immutable, generation-numbered ref:
  `refs/heads/runtime/agent-referrals/<generation>`. It never moves
  `runtime-candidate` or `production-deploy`, never deploys anything, and
  never applies a migration.
- **`.github/workflows/controlled-agent-referrals.yml`** — the dedicated
  production controller for the detached candidate. Uses `ROLLING` release
  semantics (`commerce/src/release-control.ts`), never the generic
  `CONTROLLED_CUTOVER` `controlled-production-deploy.yml` lane, which
  structurally refuses any candidate touching `commerce/migrations/**` and
  so cannot deploy Q at all. Before any consequential action it proves:
  the observed `production-deploy` equals the expected BASE; the
  certificate reconstructs Q from this same controller's tree; the
  published runtime ref and the independent `runtime-candidate` ref (moved
  only by the existing, separate `controlled-runtime-candidate-promotion.yml`
  lane — never by this workflow) both resolve exactly to that same Q. It
  then acquires `ROLLING` ownership (never pausing sales — the domain's own
  `acquire()` cannot pause), CASes `production-deploy` from BASE to Q,
  deploys Q, proves exact runtime/worker/migration-schema state (0042-0049
  included, by per-file blob hash), proves
  `agent_referrals_feature_state == DORMANT` and zero Agent Referrals
  production business facts via the two new bearer-token-gated read routes
  (`GET /v1/internal/release-control/agent-referrals/feature-state` and
  `.../business-facts`, `commerce/src/agent-referrals-business-facts.ts`),
  calls `completeRolling()`, and proves terminal completion. **DORMANT is
  the terminal state this run leaves the feature in — it never activates
  Agent Referrals.**

`api.ts`'s `/complete-rolling` route now wires its dormant-readiness
predicate to Agent Referrals' own feature-state singleton (previously a
PR1-era `() => false` placeholder, since no real ROLLING candidate existed
yet to check) — see `commerce/test/release-control-rolling.test.ts` for the
PASS/FAIL proof against the real feature-state table.

## Recovery matrix

Not yet applicable. Nothing in this feature has deployed, so there is no
recovery scenario to document yet. The full matrix — including why a
post-migration rollback requires a DB restore — lives in the plan's Phase
10B / recovery-matrix section and will be transcribed here once the feature
reaches DORMANT delivery.

## Terminal record

None. This feature has not been built, deployed, or activated. The two
workflows above exist and are ready; neither has ever been run.
