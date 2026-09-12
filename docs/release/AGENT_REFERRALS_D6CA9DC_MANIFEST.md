# Agent Referrals candidate manifest for BASE `d6ca9dc`

**Status: a classification proposal for review. No certificate is authored
here, and this document does not authorize a release.**

The classification itself is
[`.release/controlled-candidates/agent-referrals-d6ca9dc5f25e4df49ef15a72fae75ef69ee42172/classification.tsv`](../../.release/controlled-candidates/agent-referrals-d6ca9dc5f25e4df49ef15a72fae75ef69ee42172/classification.tsv) -
one line per path, all 417 of them - and
`commerce/test/agent-referrals-candidate-classification.test.ts` proves it is
a genuine partition of the real endpoint diff. This document explains the
rules; the artifact is what a reviewer checks.

## Frozen inputs

```text
BASE            d6ca9dc5f25e4df49ef15a72fae75ef69ee42172   production-deploy, and the
                                                           image production actually runs
source_main     7f6167277dcf429d3fdec52c2f55527680707fc6   main after the authoring
                                                           machinery merged
```

`BASE` is a detached materialized candidate, **not an ancestor of main**, so
`git diff BASE..source_main` is the feature's intent mixed with everything
else that landed since. Compare only the two exact trees: GitHub's compare
view applies merge-base semantics, which for these diverged histories reports
a different and misleading set.

## The rule

A path is certified only when it is needed for one of:

1. D->C3 Agent Referrals runtime semantics;
2. 0050-0057 schema/runtime compatibility;
3. the Agent Referrals HTTP/UI surfaces;
4. an explicitly agreed rollout-gate requirement - currently server-fault
   observability (#104).

## Ownership does not decide the transport on its own

The first version of this classification used "the feature owns the file" as
sufficient for `WHOLE_FILE`. That is wrong, and `commerce/src/agent-referrals-otp.ts`
falsified it: **`BASE` is not an older main.** It carries production-only
changes, and the feature owning a path says nothing about whether the source
blob is the right RESULT for it.

```text
CREATE   BASE absent, source present
         -> the source blob is the whole intent; WHOLE_FILE is safe

MODIFY   present in both
         -> WHOLE_FILE only after explicit endpoint reconciliation;
            otherwise SHARED

DELETE   BASE present, source absent
         -> certified only when the deletion is itself part of the rollout
            intent. Never as cleanup, and never for control plane.
```

A certified `WHOLE_FILE` modification that drops an export `BASE` had must
carry a written reconciliation in the artifact's last column, and the test
refuses one that does not. Two exist today:

- `agent-referrals-legal-profile.ts` - `LegalForm`/`TaxMode`/`ProjectedContractorType`
  moved to `lib/legal-profile-rules.ts` in PR-B, which is certified;
- `agent-referrals-partner-identity.ts` - `reissuePartnerInvite` was renamed
  to `rotatePartnerInvite` in PR-C3.

## Totals

```text
BASE..source_main                     417 paths
  certified                            61      50 WHOLE_FILE + 11 SHARED
  excluded: control plane             174
  excluded: tests                     152
  excluded: unrelated runtime          23
  excluded: repository root             4
  forbidden by the certificate          3
```

## SHARED - reviewed hunks only

| path | delta |
|---|---|
| `apps/admin/components/agents/Agents.tsx` | +71/-12 |
| `apps/admin/lib/errors.ts` | +104/-0 |
| `apps/admin/lib/idempotency.ts` | +74/-2 |
| `apps/admin/lib/invalidation.ts` | +63/-1 |
| `apps/admin/lib/query-keys.ts` | +45/-0 |
| `apps/admin/lib/use-admin-mutation.ts` | +35/-2 |
| `commerce/src/agent-referrals-feature-state.ts` | +2/-10 |
| `commerce/src/api.ts` | +64/-55 |
| `commerce/src/db.ts` | +38/-7 |
| `commerce/src/domain.ts` | +90/-39 |
| `commerce/src/types.ts` | +8/-23 |

`commerce/src/agent-referrals-feature-state.ts` is in this list for a reason
worth naming: certifying it whole drops `activateAgentReferralsInTransaction`
and `transitionAgentReferralsFeatureInTransaction`, and **BASE's own
`agent-referrals-activation-readiness.ts` consumes the first** - a file that
is now excluded and therefore kept at `BASE`. Excluding the control plane and
certifying this file whole would have produced a candidate that does not
compile. The two corrections interact, and only the combination is safe.

**A constraint on hunk selection.** `api.ts` imports `./release-control-schema`;
`domain.ts` imports `./release-control` and `./certification-dispatch`. All
three are excluded and all three exist in `BASE`, so the candidate inherits
production's versions - the hunks chosen may not depend on main-only changes
inside those modules. Per hunk, not assumed.

## Excluded: OTP delivery and its wiring

```text
commerce/src/agent-referrals-otp.ts
commerce/src/server.ts
```

`BASE` contains `UnisenderOtpSender`, `otpSenderFromEnvironment()` and
`OtpDeliveryCapability`, and its `server.ts` wires the sender into
`createApp`. The frozen source main has none of it: only
`UnconfiguredOtpSender` remains, and `createApp` is called without a sender.

Certifying either path would have compiled cleanly and removed production OTP
delivery - the first real partner could not have received a login code. No
step of D->C3 requires a change here: D-F are legal/tax, A/B are
projection/invariants, C/C2 are command and UI replay infrastructure, C3 is
invite rotation.

## Excluded: control plane

Six paths were certified by the first classification purely because they are
named `agent-referrals-*`, which is the same mistake in miniature that this
whole exercise exists to avoid:

- `commerce/src/agent-referrals-candidate.ts` - candidate reconstruction
  machinery, absent from `BASE`, so certifying it would ADD release machinery
  to a product candidate;
- `agent-referrals-activation.ts` - the activation-manifest/schema-evidence
  layer the rollout gate already declined to treat as proof of 0054-0057, and
  no longer imported by the runtime API;
- `agent-referrals-activation-readiness.ts`, `agent-referrals-activation-reconciliation.ts`,
  `agent-referrals-business-facts.ts`, `agent-referrals-dormant-readiness.ts` -
  present in `BASE`, absent from source main, so certifying them would be a
  certified DELETE of control plane. Exclusion leaves the `BASE` tree as it
  is; a product candidate does not tidy up release machinery.

Plus `.github/`, `docs/`, `scripts/`, `.release/`, and the authoring module
this classification was produced with.

## Excluded: tests

On the `f540b997` certificate's own precedent: it certified 91 paths and zero
tests.

The reason is **not** that they are absent from the image - `Dockerfile.commerce`
does `COPY commerce ./commerce`, so `commerce/test/**` is physically present.
It is that tests are not part of the executed production runtime surface and
are not required to reconstruct feature behaviour.

## Excluded: repository root

- `package.json` - the divergence is npm scripts only (`admin:typecheck`, the
  v2 materialize script, `COMMERCE_TEST_DB_SNAPSHOT=1` on `test`). None is
  used by the container, which runs `pnpm commerce:start`.
- `Dockerfile.commerce`, `certification.sh`, `release-surface-contract.json` -
  build and release surface, not feature runtime.

## Forbidden by the certificate

`public/legal/personal-data-consent.md`, `public/legal/privacy-policy.md`,
`commerce/legal/production-manifest.json`. Legal state is inherited from
`BASE` unchanged; the author and the verifier both refuse these by
construction.

## Still open

Every remaining certified `WHOLE_FILE` **modification** has been machine-checked
for dropped exports, which is a proxy for lost behaviour rather than a proof
of its absence. A change that alters an existing export's body without
changing its name is invisible to that check, and the OTP finding means the
proxy has earned scrutiny rather than trust.
