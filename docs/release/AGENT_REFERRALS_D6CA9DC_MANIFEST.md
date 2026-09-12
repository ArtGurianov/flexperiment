# Agent Referrals candidate manifest for BASE `d6ca9dc`

**Status: a classification proposal for review. No certificate is authored
here, and this document does not authorize a release.**

## Frozen inputs

```text
BASE            d6ca9dc5f25e4df49ef15a72fae75ef69ee42172   production-deploy, and the image
                                                           production actually runs
source_main     7f6167277dcf429d3fdec52c2f55527680707fc6   main after the authoring
                                                           machinery merged
```

`BASE` is a detached materialized candidate, **not an ancestor of main**. The
two histories are diverged, so `git diff BASE..source_main` is not the
feature's intent - it is the feature's intent mixed with everything else that
landed on main since. That is the whole reason this document exists.

## The rule

A path is certified only when it is needed for one of:

1. D->C3 Agent Referrals runtime semantics;
2. 0050-0057 schema/runtime compatibility;
3. the Agent Referrals HTTP/UI surfaces;
4. an explicitly agreed rollout-gate requirement - currently server-fault
   observability (#104).

Everything else in `BASE..source_main` is excluded and listed below.

Transport follows ownership, and the authoring machinery enforces it:

```text
WHOLE_FILE   the feature owns the path outright -> the approved source's blob
SHARED       the path diverges for unrelated reasons -> reviewed hunks only
```

## Totals

```text
BASE..source_main                     417 paths
  certified                            69      58 WHOLE_FILE + 11 SHARED
  excluded: tests                     152
  excluded: control plane             168
  excluded: unrelated runtime          21
  excluded: repository root             4
  forbidden by the certificate          3
```

Tests are excluded on the established precedent of the `f540b997`
certificate, which certified 91 paths and **zero** tests: they are not in the
runtime image. Control plane (`.github/`, `docs/`, `scripts/`, `.release/`)
is excluded by the same rule that keeps a release from shipping its own
release machinery.

## SHARED - reviewed hunks only (11 paths)

Each of these carries unrelated main-only work that must NOT come along.
`from: "source_main"` is unavailable for them, in the type and at runtime.

| path | change | delta |
|---|---|---|
| `apps/admin/components/agents/Agents.tsx` | M | +71/-12 |
| `apps/admin/lib/errors.ts` | M | +104/-0 |
| `apps/admin/lib/idempotency.ts` | M | +74/-2 |
| `apps/admin/lib/invalidation.ts` | M | +63/-1 |
| `apps/admin/lib/query-keys.ts` | M | +45/-0 |
| `apps/admin/lib/use-admin-mutation.ts` | M | +35/-2 |
| `commerce/src/api.ts` | M | +64/-55 |
| `commerce/src/db.ts` | M | +38/-7 |
| `commerce/src/domain.ts` | M | +90/-39 |
| `commerce/src/server.ts` | M | +1/-3 |
| `commerce/src/types.ts` | M | +8/-23 |

**A constraint that came out of this classification.** `api.ts` imports
`./release-control-schema`; `domain.ts` imports `./release-control` and
`./certification-dispatch`. All three are excluded as unrelated, and all
three exist in `BASE`, so the candidate inherits production's versions. The
hunks selected for `api.ts` and `domain.ts` therefore **may not depend on
main-only changes inside those modules**. This has to be checked per hunk,
not assumed.

## Excluded: unrelated runtime divergence

These live under runtime roots but belong to other work - chiefly Release
Control v2, which `BASE` does not contain at all (`release-control-v2.ts` and
`controlled-candidate.ts` are additions relative to it).

- `commerce/src/agent-referrals-candidate-author.ts`
- `commerce/src/assert-epoch-a-runtime-promotion-ready.ts`
- `commerce/src/assert-epoch-b-notification-activation-ready.ts`
- `commerce/src/calculate-legal-manifest-hashes.ts`
- `commerce/src/certification-dispatch.ts`
- `commerce/src/controlled-candidate-verify.ts`
- `commerce/src/controlled-candidate.ts`
- `commerce/src/epoch-a-runtime-promotion.ts`
- `commerce/src/epoch-b-notification-activation.ts`
- `commerce/src/generic-production-deploy-boundary.ts`
- `commerce/src/materialize-release-control-v2-candidate.ts`
- `commerce/src/release-control-schema.ts`
- `commerce/src/release-control-v2-materialization-schema.ts`
- `commerce/src/release-control-v2-materializer.ts`
- `commerce/src/release-control-v2.ts`
- `commerce/src/release-control.ts`
- `commerce/src/release-expectation.ts`
- `commerce/src/validate-release-control-v2-packet.ts`
- `commerce/src/verify-release-control-v2-materialization.ts`
- `deploy/test-admin-nginx-config.sh`
- `deploy/test-caddyfile-topology.sh`

`commerce/src/agent-referrals-candidate-author.ts` is on this list
deliberately: it is the machinery that builds the candidate and has no place
inside it.

## Excluded: repository root

- `package.json` - the divergence is npm scripts only (`admin:typecheck`,
  the v2 materialize script, and `COMMERCE_TEST_DB_SNAPSHOT=1` on `test`).
  None is needed by the container, which runs `pnpm commerce:start`, and the
  `f540b997` certificate did not include it either.
- `Dockerfile.commerce`, `certification.sh`, `release-surface-contract.json` -
  build and release surface, not feature runtime.

## Forbidden by the certificate

- `public/legal/personal-data-consent.md`
- `public/legal/privacy-policy.md`
- `commerce/legal/production-manifest.json`

Legal state is inherited from `BASE` unchanged. The author and the verifier
both refuse these by construction, so this is a structural guarantee rather
than a review convention.

## WHOLE_FILE (58 paths)

- `apps/admin/components/ui/RetainedIntentNotice.tsx`
- `apps/admin/lib/partner-invalidation.ts`
- `apps/admin/lib/use-partner-mutation.ts`
- `commerce/migrations/0050_agent_referrals_legal_profile_provenance_rebuild.sql`
- `commerce/migrations/0051_agent_referrals_legal_profile_supersession.sql`
- `commerce/migrations/0052_agent_referrals_unified_legal_requisites.sql`
- `commerce/migrations/0053_agent_referrals_tax_treatment_ord_canonicalization.sql`
- `commerce/migrations/0054_partner_command_idempotency.sql`
- `commerce/migrations/0055_partner_legal_profile_draft_revision.sql`
- `commerce/migrations/0056_legal_profile_change_request_sequence.sql`
- `commerce/migrations/0057_partner_invite_capability_head.sql`
- `commerce/src/agent-referrals-admin-command.ts`
- `commerce/src/agent-referrals-candidate.ts`
- `commerce/src/agent-referrals-command-precondition.ts`
- `commerce/src/agent-referrals-legal-profile-supersession.ts`
- `commerce/src/agent-referrals-ord-canonical.ts`
- `commerce/src/agent-referrals-partner-command.ts`
- `commerce/src/agent-referrals-tax-treatment.ts`
- `lib/legal-profile-rules.ts`
- `commerce/src/agent-referrals-activation-readiness.ts`
- `commerce/src/agent-referrals-activation-reconciliation.ts`
- `commerce/src/agent-referrals-business-facts.ts`
- `commerce/src/agent-referrals-dormant-readiness.ts`
- `apps/admin/components/agent-referrals/ChannelPolicy.tsx`
- `apps/admin/components/agent-referrals/Engagements.tsx`
- `apps/admin/components/agent-referrals/Overview.tsx`
- `apps/admin/components/agent-referrals/Partners.tsx`
- `apps/admin/components/partner/Agreement.tsx`
- `apps/admin/components/partner/Engagements.tsx`
- `apps/admin/components/partner/Payout.tsx`
- `apps/admin/components/partner/Profile.tsx`
- `commerce/src/agent-referrals-activation.ts`
- `commerce/src/agent-referrals-api-admin.ts`
- `commerce/src/agent-referrals-api-partner.ts`
- `commerce/src/agent-referrals-channel-policy.ts`
- `commerce/src/agent-referrals-creative.ts`
- `commerce/src/agent-referrals-distribution.ts`
- `commerce/src/agent-referrals-engagement.ts`
- `commerce/src/agent-referrals-feature-state.ts`
- `commerce/src/agent-referrals-framework-delegation.ts`
- `commerce/src/agent-referrals-identity-retention.ts`
- `commerce/src/agent-referrals-legal-profile.ts`
- `commerce/src/agent-referrals-npd.ts`
- `commerce/src/agent-referrals-onboarding.ts`
- `commerce/src/agent-referrals-ord-creative-registration.ts`
- `commerce/src/agent-referrals-ord-paid-invoice.ts`
- `commerce/src/agent-referrals-ord-provider-operation.ts`
- `commerce/src/agent-referrals-ord-provider-profile.ts`
- `commerce/src/agent-referrals-ord-reporting.ts`
- `commerce/src/agent-referrals-otp.ts`
- `commerce/src/agent-referrals-partner-identity.ts`
- `commerce/src/agent-referrals-partner-projection.ts`
- `commerce/src/agent-referrals-payment.ts`
- `commerce/src/agent-referrals-payout-profile.ts`
- `commerce/src/agent-referrals-promo.ts`
- `commerce/src/agent-referrals-settlement.ts`
- `commerce/src/agent-referrals-suspension-policy.ts`
- `commerce/src/agent-referrals-worker-sweep.ts`

## Open judgement calls for review

1. **`apps/admin/components/partner/*` classified WHOLE_FILE.** The partner
   portal exists only for this feature, so it owns those files outright. If
   any unrelated main-only edit touched them, that judgement is wrong and
   they belong in SHARED.
2. **`commerce/src/types.ts` classified SHARED** (`+8/-23`) although most of
   its delta looks feature-related. Kept in SHARED because it is a shared
   declaration file and the cost of being wrong is silent.
3. **`apps/admin/components/agents/Agents.tsx`** is the legacy `/agents`
   surface that PR-A split. Classified SHARED because the file predates the
   feature.
