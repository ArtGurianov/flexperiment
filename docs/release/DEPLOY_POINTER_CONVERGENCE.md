# The deployment pointer moves before convergence is proved

`production-deploy` is defined as *the exact last successfully deployed
runtime*. Today nothing makes that true: `controlled-production-deploy.yml`
advances the pointer with its CAS lease and only afterwards asks Coolify to
build and start anything. When that build fails, the pointer keeps the new SHA
and production keeps serving the old artifact, so the ref asserts a deployment
that never existed.

This is a different gap from the one already recorded under "Coolify webhook
acceptance is not deployment convergence". That one is about a controller
giving up on a deployment that later succeeds, and warns against reacting to
it. This one is the opposite direction: the deployment definitively did not
happen, and the pointer says it did.

## What it cost

On 2026-09-16 the deploy of `a9ea0107191b6e1abaeb8e7794c600646815faec` failed
in Coolify on all three services, at `pnpm install --frozen-lockfile`, before
any source was copied. No image was ever produced; Coolify removed the new
version and left the previous containers running.

`production-deploy` had already advanced to `a9ea010`. It still points there.
The runtime actually serving production is `3ab36fd`.

The cost is not only auditing. The pointer is the baseline the next ordinary
release leases from and proves topology against. With a false baseline, an
ordinary promotion of `b331023` proves the delta `a9ea010 → b331023` — one
commit — while the real production delta is `3ab36fd → b331023`. The fence
passes on a range nobody is deploying.

## Convergence can be proved today

This was never wired up, but the evidence already exists and three of the four
deployables can be checked without credentials:

| Surface | Evidence | Access |
| --- | --- | --- |
| frontend | `GET https://flexperiment.ru/release.json` → `source_commit` | public |
| admin / partner | `GET https://admin.flexperiment.ru/release.json` → `source_commit` | public |
| commerce | `GET /admin/system/evidence` → `source_commit`, taken from the running process | admin auth |
| commerce worker | `recordRuntimeStartupEvidence(..., "COMMERCE_WORKER", ...)` at startup | durable state |

`public/release.json` is written at build time by
`commerce/src/write-static-release-descriptor.ts` and
`apps/admin/scripts/write-release-descriptor.mjs`, from the `SOURCE_COMMIT`
build arg. It is the artifact stating its own provenance, not an inference
drawn from its markup.

Read today, both public descriptors return
`3ab36fdff404dfa8d31207d221c32f93751d3bb4`, which is what proves the divergence
above exactly rather than by inference.

Note what this does **not** need: polling Coolify's own deployment status,
whose shape the invariants correctly say has never been verified here. Asking
the deployed surfaces which commit they are is independent of the deployer.

## The ordering this should have

A pointer that means "last successfully deployed" cannot be advanced by an act
that does not yet know whether the deployment succeeded. Two shapes work:

1. **Advance after proof.** Trigger the deploy, prove convergence from the
   surfaces above, then move the pointer under its lease. The failure mode is
   a controller that times out after a slow-but-successful deployment, leaving
   the pointer behind the runtime — recoverable by re-reading the surfaces,
   and strictly safer than the current direction, which leaves it ahead.
2. **Advance and reconcile.** Keep the current move, but make a failed or
   unproven convergence restore the pointer to the SHA the surfaces report.

Either way the invariant becomes true by construction rather than by luck.
Whichever is chosen, the convergence check belongs in its own read-only,
freely re-dispatchable step — the invariants already argue for that, since a
combined submit-and-verify job that times out cannot be re-run without
re-triggering the mutation it already performed.

## Before the next ordinary release

`production-deploy` currently asserts a runtime that was never deployed. It
must be restored to the SHA the surfaces report, through a defined recovery
protocol and not a manual ref edit, before any promotion or deploy leases from
it. After restoration every CAS input has to be re-read, and the topology of
the full real delta — `3ab36fd → b331023` — proved rather than the fictitious
one-commit range.

Publication is unaffected: it creates an immutable ref, moves no authority, and
takes `expected_production_deploy_sha` as a snapshot fence rather than as a
claim that the pointer is semantically correct.
