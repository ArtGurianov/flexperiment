# Agent Referrals candidate boundary

Release id: `agent-referrals:f540b997d6d31a22293909ded7ce464c3f51732f` — the
release identifier is fixed to `B2`
(`f540b997d6d31a22293909ded7ce464c3f51732f`), the release-semantics bootstrap
candidate now actually running as production's `production-deploy` (see
`docs/release/RELEASE_SEMANTICS_BOOTSTRAP.md`).

**This supersedes an earlier, permanently obsolete materialization.** A
prior candidate, `Q` (`4fcb20d1aee98c9b6892846ec0bc40666f586870`, `Q^ == P`
where `P = 24a382929740a7ead6fb0bb49f5ffc77e063c77a`), was built and reviewed
across several rounds on a separate, now-abandoned branch. It was never
published, promoted, or deployed. Once `P → B2` executed (the release-
semantics bootstrap terminal run, `33973254486`), `P` stopped being
production's `production-deploy`, so `Q^ == P` could never be a valid
detached candidate again - `Q` cannot be repaired, reused, or reinterpreted;
this document and its certificate describe `Q2`, a fresh rematerialization
with `Q2^ == B2`, built from scratch against the real current `BASE`. `Q2`
inherits `B2`'s own certified changes (`commerce/src/release-control-schema.ts`
CREATE, `commerce/src/api.ts`'s import-move) unchanged and adds nothing to
re-certify them.

This is a **control-plane** document: this PR defines the machinery it
describes and commits the real, final certificate and 91 patches. It never
runs in production and takes effect the moment it merges to protected
`main`, per
`docs/release/DEPLOYMENT_INVARIANTS.md#control_plane-is-governed-not-deployed`.

## BASE

`BASE` is frozen to `B2` (`f540b997d6d31a22293909ded7ce464c3f51732f`) - not
re-derived from the live, possibly-already-mutated `production-deploy`
pointer. This is a deliberate correction relative to the original PR1
design ("`BASE` is the freshly observed `production-deploy` SHA read
immediately before candidate construction"): that framing conflated the
release's own true predecessor with a value that legitimately changes mid-
release (to `Q2` itself, once the CAS below succeeds), which a naive re-read
would then misclassify as a new release. `controlled-agent-referrals.yml`'s
own `OBSERVED_PRODUCTION_DEPLOY_SHA` remains a separate, freshly-read value,
used only for freshness/predecessor checks, never as `BASE`.

## Candidate construction rule

`Q2` is a deterministic detached commit reconstructed from `BASE` (`B2`)
plus a certified, patch-based transformation series - never a whole-file
overlay copied out of `main`'s tree. Every certified path pins:

```text
path
base_blob_sha
patch_path            committed control-plane artifact in the controller tree
patch_git_blob_sha     binds the proof to the protected-main tree
patch_sha256
result_blob_sha
mode (or explicit deletion)
```

plus the full frozen canonical commit envelope - every field pinned as
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

The certificate also pins `source_main_sha` and `patch_source: "controller_tree"`:
every patch is read from the named controller commit's Git tree, supplied by
the controller at verification time, rather than `source_main_sha` directly
- the frozen source predates this PR's own artifacts, and recording a PR
commit SHA would break under this repository's rebase-only merge policy.

**Reconstruction core**: `Q2` is verified through
`commerce/src/controlled-candidate.ts` / `commerce/src/controlled-candidate-verify.ts`
- the generic `RECONSTRUCTION_BOUND` core already extracted for and proven
by the release-semantics bootstrap (`docs/release/RELEASE_SEMANTICS_BOOTSTRAP.md`),
now genuinely reused by a second, independent feature with zero code
changes to that module. `commerce/src/agent-referrals-candidate.ts` (the
original, feature-named module, still carrying the pre-`controller_tree`
model) is untouched by this PR; a later, purely mechanical consolidation may
turn it into a thin binding over the generic core.

See `commerce/test/controlled-candidate.test.ts` and
`commerce/test/agent-referrals-q2-candidate-materialization.test.ts` for the
proofs this document summarizes:

- two independent reconstructions of one certificate produce the identical
  commit SHA;
- a changed patch byte, a wrong `patch_git_blob_sha`, a wrong base blob, a
  wrong `result_blob_sha`, or a wrong pinned `tree_sha` is rejected;
- a `parent_sha` that disagrees with `base_sha` is rejected;
- `encoding`, `extra_headers` and `signed` are rejected unless they carry
  their one frozen value;
- a whole-file overlay cannot satisfy the contract (it is not a valid patch
  against the pinned base);
- `public/legal/**` and `commerce/legal/**` can never appear in a certified
  path, so `Q2` inherits production legal state from `BASE` unchanged, by
  construction rather than by review convention;
- `Q2^ == B2`, independently re-proven directly, not merely trusted from the
  certificate's own internal `parent_sha` check.

### `RECONSTRUCTION_BOUND`: binding the ancestry proof to the certificate itself

A controller must never prove ancestry for a `SOURCE_MAIN_SHA` read from an
input independent of the certificate. The required shape, positively
enforced by `commerce/test/controller-not-older-than-target.test.ts`:

```text
BASE_SHA="f540b997d6d31a22293909ded7ce464c3f51732f"
git show "$CONTROLLER_SHA:.release/controlled-candidates/agent-referrals-$BASE_SHA/certificate.json" > candidate-certificate.json
SOURCE_MAIN_SHA="$(jq -er '.source_main_sha' candidate-certificate.json)"
git merge-base --is-ancestor "$SOURCE_MAIN_SHA" "$CONTROLLER_SHA"
jq -e --arg base "$BASE_SHA" '.base_sha == $base' candidate-certificate.json
RECONSTRUCTED_SHA="$(node --import tsx commerce/src/controlled-candidate-verify.ts candidate-certificate.json "$CONTROLLER_SHA")"
[[ "$RECONSTRUCTED_SHA" == "$TARGET_SHA" ]]
```

`SOURCE_MAIN_SHA` is extracted from the exact certificate file the earlier
step read - never a separate file, script output, or workflow input.

## Certificate location

`.release/controlled-candidates/agent-referrals-f540b997d6d31a22293909ded7ce464c3f51732f/certificate.json`,
committed to protected `main` by this PR. Patches live alongside it under
`patches/`.

```text
BASE (B2)        f540b997d6d31a22293909ded7ce464c3f51732f
SOURCE_MAIN_SHA  af019452a60b6e968e326eb4684641c5d33cfa58
Q2               a264ee68f597e7a40b6fe4b05359d99365be9149
Q2 tree          3a81d4c75490ed19d037d27276a3748ce14957c7
```

89 of 91 certified paths are byte-identical reuses of the earlier `Q`
materialization's own patches: their base content is unchanged between `P`
and `B2`, so the same patch bytes apply unchanged and produce the same
result. Two are new: `commerce/src/api.ts` (a fresh patch authored against
`B2`'s own current content, since `B2` already moved the
`releaseControlSchema` import - reusing the old `P`-based patch would double-
apply it, though it converges on the exact same final file content) and
`commerce/src/agent-referrals-dormant-readiness.ts` (freshly authored with
an expanded DORMANT predicate - see below).
`commerce/src/release-control-schema.ts` is deliberately **excluded** from
the manifest: `B2` already created it, byte-identical to what `Q`/`Q2` would
otherwise certify there.

## Changed-path allowlist

The canonical, exact allowlist is the 91 sorted `paths[]` entries in the
committed certificate above - limited to Agent Referrals Commerce runtime
(including exact immutable migrations `0042` through `0049`), admin/partner
UI, the two production routing configs, and the minimal ROLLING release-
control surface (inherited, not re-certified, from `B2`'s own certificate).
No test, workflow, documentation, `.release/**` artifact, `public/legal/**`,
or `commerce/legal/**` path is reconstructed into `Q2`. The materialization
test independently rebuilds `Q2`, compares `BASE..Q2` with that complete
manifest, and proves every migration blob equals the protected-main source
blob.

## DORMANT readiness (expanded)

`commerce/src/agent-referrals-dormant-readiness.ts` is the single
authoritative, fail-closed predicate `/complete-rolling` and the dedicated
`GET .../agent-referrals/dormant-readiness` evidence route both use. Beyond
the original three checks (feature state, full schema present, zero
business facts across every Agent Referrals table), it now independently
proves:

- **runtime/worker source identity**: the commerce API process's own
  `SOURCE_COMMIT` (baked in at deploy time, via
  `commerce/src/release-control.ts`'s already-reviewed
  `releaseRuntimeEvidence()`) must agree with the worker's own durably-
  recorded `source_commit` - self-consistency between the two deployed
  processes, never a hard-coded target SHA;
- **exact migration inventory**: all of `0042`-`0049` present in the
  runtime's own applied-migration set;
- **release-surface contract presence**: `release-surface-contract.json` is
  readable and carries both `checkout_contract_version` and
  `admin_contract_version`;
- **legacy flow health**: the core, pre-existing commerce tables this
  feature never touches (`orders`, `payments`, `refunds`) are present and
  queryable - a narrow presence/queryability probe, never a synthetic
  transaction or write.

See `commerce/test/agent-referrals-q2-dormant-completion-negative-matrix.test.ts`
for an executing proof that each axis independently blocks `/complete-rolling`.

## Phase 10B control plane (dormant)

Both workflows are **manual-only** (`workflow_dispatch` only) and gated by
the `production` environment's required-reviewer approval. Merging this PR
executes neither.

- **`.github/workflows/controlled-agent-referrals-candidate.yml`** -
  publication only. Reconstructs the exact certified `Q2` from this
  controller's own tree, then pushes that exact commit to a fresh,
  generation-numbered, **flat** ref:
  `refs/heads/runtime/agent-referrals-<generation>` (never the legacy
  nested shape the earlier, obsolete `Q` materialization used -
  `controlled-runtime-candidate-promotion.yml`'s own single-segment
  discovery glob cannot cross a `/`; see
  `commerce/test/agent-referrals-q2-promotion-compatibility.test.ts` for the
  real-Git proof). Uses a dedicated, least-authority publication credential
  (`AGENT_REFERRALS_CANDIDATE_REF_TOKEN`), never the default write-scoped
  `GITHUB_TOKEN`.
- **`.github/workflows/controlled-agent-referrals.yml`** - the dedicated
  production controller. Installs dependencies before the first step that
  needs them (the ordering the release-semantics bootstrap's own first
  production run got wrong - see
  `docs/release/RELEASE_SEMANTICS_BOOTSTRAP.md`). Uses `ROLLING` release
  semantics, never the generic `CONTROLLED_CUTOVER` lane. Before any
  consequential action it proves: the frozen `BASE` (`B2`) certificate
  reconstructs `Q2`; `Q2` was actually published and promoted to
  `runtime-candidate`; the required Epoch B predecessor completion record;
  and the observed `production-deploy` pointer is exactly one of the two
  sanctioned values (`B2` for a first CAS, `Q2` for a same-release
  recovery) - anything else fails closed. It then acquires `ROLLING`
  ownership, CASes `production-deploy` from `B2` to `Q2` with an explicit
  expected-previous argument, deploys `Q2`, proves exact
  runtime/worker/migration-schema state, proves the expanded DORMANT
  readiness above, calls `completeRolling()`, and proves terminal
  completion. **DORMANT is the terminal state this run leaves the feature
  in - it never activates Agent Referrals.**

## Recovery matrix

Classified into the same minimum set `docs/release/CONTROLLED_RELEASE_BOUNDARY.md`
requires: `ACQUIRE` (fresh start), `CONTINUE_BEFORE_CAS` (owned, not yet
CASed), `DEPLOY_AND_CONVERGE` / `PROVE_READINESS` (CASed, deploy/converge
still pending or already done), `RELEASE_ALREADY_COMPLETE` (terminal
replay). The observed `production-deploy` pointer is fail-closed classified
into exactly `BASE` (`B2`) or `TARGET` (`Q2`) - any third value refuses
(`AGENT_REFERRALS_RELEASE_POINTER_UNEXPECTED`), never silently reclassified
as a new release.

## Terminal record

None. `Q2` has not been published, promoted, or deployed. The two workflows
above exist and are ready; neither has ever been run.
