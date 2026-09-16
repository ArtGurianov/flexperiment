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

## What "successfully deployed" has to mean

Deployment success is a property of the runtime, not of the request that asked
for it. An HTTP 2xx from a Coolify webhook says the enqueue was accepted; the
invariants already say that, and this incident is what it looks like when the
two are conflated. The surfaces above make the stronger statement available:

```text
production-deploy may equal TARGET only if every required production runtime
surface has independently attested source_commit == TARGET.
```

Attested by the surface itself, from the `SOURCE_COMMIT` baked into the
artifact — not by the deployer reporting on its own work, and not by anything
this repository infers about Coolify's internal state.

## Why the pointer cannot simply move later

The obvious fix is to advance the pointer only after that proof. It is not
available as things stand, and the reason is worth stating plainly, because it
is easy to propose the impossible version of this.

`scripts/controlled-coolify-deploy.sh` fires webhooks that carry no SHA at
all. Coolify builds whatever `refs/heads/production-deploy` points at; the
script's only guard is asserting that the ref already equals the expected
source commit:

```sh
configured_deploy_ref="$(git ls-remote origin refs/heads/production-deploy | ...)"
[[ "$configured_deploy_ref" == "$expected_source_commit" ]] || fail
```

So the ref is the deployment source. It has to move before the deploy, by
construction — which is exactly why it can end up asserting a runtime that was
never built.

That leaves two honest options:

1. **Split the two roles.** One ref is what Coolify pulls; `production-deploy`
   becomes the post-convergence attestation and is advanced only once every
   surface reports the target. This makes the invariant above true by
   construction, and is the only shape in which "advance after proof" means
   anything. It requires re-pointing Coolify at the new source ref.
2. **Keep one ref, and reconcile.** The move stays where it is, but a deploy
   whose convergence is not proved restores the pointer to whatever the
   surfaces report. The invariant then holds eventually rather than always,
   and there is a window in which the ref asserts something untrue — the
   window this incident has been sitting in.

The first is cleaner and the second is cheaper. Either way, the convergence
check belongs in its own read-only, freely re-dispatchable step: the
invariants already argue for that, since a combined submit-and-verify job that
times out cannot be re-run without re-triggering the mutation it performed.

## A failed deploy also holds the release open

The pointer is the lesser half. The same failure leaves two things behind, and
the second one is customer-facing.

`controlled-production-deploy` acquires the release owner and pauses new orders
before it asks Coolify for anything. When the build fails there is no path that
releases either. On 2026-09-16 the `a9ea010` attempt left:

```text
sales_paused      true
owner_release_id  deploy-a9ea0107191b6e1abaeb8e7794c600646815faec
owner_mode        CONTROLLED_CUTOVER
paused_at         2026-09-16 09:16:26
```

Sales stayed closed. Nothing timed out, nothing reconciled, and nothing said
so: the refs looked merely wrong, while the shop was shut.

Worse, the state is self-sealing. `reopen` requires the live runtime to match
the request's expectation *and* the request to match the durable one. The
runtime is `3ab36fd` and the durable expectation is `a9ea010`, so no single
request satisfies both. That refusal is the gate working — it will not declare
open a release it cannot account for — but it means a failed deploy can close
the shop in a way that its own recovery path cannot reopen.

So the missing piece is not only convergence semantics. A controller that can
acquire an owner and pause sales **must** have a terminal failure path that
releases both, and reopening must happen only after runtime convergence has
been proved and the control plane reconciled — never as an independent act to
get sales back.

Ordering matters within that repair too. The pointer should be corrected
before sales reopen, not after: otherwise there is a window in which customers
can buy again while the release authority still publicly asserts a runtime
that was never deployed.

## What was done, and what was not

The incident is closed. `production-deploy` was reconciled to the runtime that
never moved, sales reopened, and `b3310238baa1f05229985cc1ab811dc6fc605a69`
then reached production through the ordinary lane — publication, promotion,
controlled deploy — with convergence proved on all four surfaces.

Two things changed as a result, and both are in `main`:

- `Test` builds all three deployable images from a clean checkout, so the
  successful run that generic publication accepts as provenance now covers
  buildability. The failure that started this could not have reached a deploy.
- The evidence surfaces are written down in `KINESCOPE_PLAYER_SURFACE.md`, and
  the readout workflow can report the durable and runtime state on demand
  without anyone copying a credential out of the production environment.

The one-shot workflow that performed the reconciliation was deleted with this
document. It was hardcoded to `deploy-a9ea010`, `a9ea010` and `3ab36fd`, and a
recovery tool that silently fits exactly one past incident is worse than none:
the next operator would reach for it, and it would refuse at its first seal
with no explanation of why it cannot help.

Nothing else here has been implemented. The ordering, the split of the
deployment source from the attestation, and a universal terminal failure path
remain design record rather than code. That is deliberate — proving new release
machinery is how a frontend fix turns into another week — but it means the
defect is still live:

**A controlled deploy still acquires the owner and pauses sales before Coolify
builds, and still has no terminal failure path.** Another failed build will
leave the shop closed, and there is no longer a recovery workflow for it.
Recovering from the next one means classifying the durable state and composing
the primitives by hand, as was done here. The steps are recorded above.
