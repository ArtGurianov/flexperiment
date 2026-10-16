<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Production release safety

Before modifying a release workflow, read
[`docs/release/DEPLOYMENT_INVARIANTS.md`](docs/release/DEPLOYMENT_INVARIANTS.md).
For a paused or owned release, classify durable state first and follow the
applicable recovery runbook; never infer recovery state from `HEAD` or `main`.
Keep the controller/workflow SHA separate from the deployment source SHA. Do
not use plain force pushes, do not require fast-forward ancestry relative to
the old `production-deploy` pointer, and do not turn that pointer into an
arbitrary force primitive. After legal publication, do not adopt a new repair;
recover the exact durable source instead. Controller commits must not enter
legal-promotion ancestry, and exact durable recovery takes precedence over
current `main`.

## v1 is retired

Flexperiment v1 is retired by replacement, not reset: the hard cut was admitted
on 2026-09-28, and v1 is tagged `flexperiment-v1-final` (see
[`docs/release/DEPLOYMENT_INVARIANTS.md`](docs/release/DEPLOYMENT_INVARIANTS.md),
"v1 is retired by replacement, not by reset"). LAB V1 was physically stopped
on 2026-10-16 under explicit owner authority. Legacy public hosts return static
410 responses; old frontend, Commerce/worker and Admin must not be restarted
without a fresh owner GO. See
[`the retirement evidence`](docs/evidence/2026-10-16-lab-v1-retirement/README.md).
Historical records and original-provider recovery are archived; do not import
them as fabricated V2 orders or reopen legacy token routes.

`commerce/src/agent-referrals-*` and the partner surfaces in `apps/admin` are
in retirement mode. No new partner, referral, attribution or settlement
operations, and no new participations. Allowed: only what the hard cut needs -
the evidence audit, separately authorized historical-case recovery and closing
external tails. Do not restore a public V1 service for compatibility. Referral capability
moves to Refref; it is not rebuilt here.
