<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Mandatory task tracking — Plane only (2026-10-28)

Agents and developers must use **Plane exclusively** for task tracking.
Workspace: `art-workspace`.
This repository uses project `FLEX` (`abb248d3-dfe2-48ed-ba97-cf07ed86d282`).
Plane owns current task scope, planning, dependencies, acceptance evidence,
comments and statuses. Keep architecture in canonical repository contracts.

**Using Linear is prohibited.** Do not use its web UI, connector, API, CLI,
integrations or scripts to read current tasks/statuses or to create, edit,
comment on, transition, archive or delete tasks/projects. Do not mirror work,
post updates or run synchronization/background tracking in Linear. If Plane is
unavailable, report the blocker; do not fall back to Linear.

Old Linear URLs, `ART-…` IDs, task text, repository documents and agent memories
are historical references, not permission to use Linear. Resolve them through
Plane's migrated provenance, mapping Page or saved exports. This rule applies
to all contributors and agents and supersedes older tracker instructions.
It does not assert that Linear access permissions are technically read-only.

Resolve old `ART-…` references through the Plane title and the original Linear
UUID in `external_id` with `external_source=linear`. The workspace Page
`Linear → Plane · permanent ART map` (ID
`2f3c4b6e-4484-449f-bba2-f63e7cc99dd2`) preserves the 324 imported mappings.
Approved Mikluha v5 cards use `external_source=approved-plan` and keys
`mikluha-native-v5:N…`; N labels are plan aliases, not new issue prefixes.
Resolve actual Plane IDs before changing a parent or relation. Use the current
Plane ID in new task references; preserve ART IDs in historical evidence.

Project mapping: Mikluha → TOUR; Flexperiment → FLEX; Refref → REFREF;
shared infrastructure → VPS; the imported task without a project → INBOX.
Flexperiment has not yet been split into the empty LMS/LAB projects.
Source milestones are existing Plane Modules on the Free plan.

Plane can omit archived endpoints from an active issue's relations. For a
dependency audit, include archived work items and read the relation from the
archived endpoint when necessary. Consult the workspace Page
`Linear migration — archived relationship ledger` for the 55 source-CSV
relations omitted by the Linear connector. Do not infer a missing relationship
from a one-sided list; do not treat an archived Done item as unfinished work.
Original relation tables in provenance describe the migration snapshot;
current Plane relations and subsequent approved changes govern today's plan.

A Done/Canceled status, imported comment or tracker move is not a deployment,
provider, recovery, legal-publication or sales-activation receipt. Preserve
explicit CLOSED gates and their independently accepted prerequisites.
Imported comments retain original author identities, including email addresses;
review that provenance before any separately authorized public sharing.

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

## Infrastructure custody (shared Adman VPS)

This project runs on the shared Adman VPS. Host baseline, encrypted custody and
recovery are owned by `ArtGurianov/adman-vps-infrastructure`; its
[`AGENTS.md`](https://github.com/ArtGurianov/adman-vps-infrastructure/blob/main/AGENTS.md)
is the canonical contract.

Every PR that deploys or changes host state states `CUSTODY_IMPACT: YES|NO`
with a one-line reason. YES covers new or changed credentials and encryption
keys, env files on the host, Docker networks, proxy routes, systemd units,
installers, backup paths, and persistent state that needs a key to restore.
Code that is not yet deployed is NO.

For YES, list each changed resource and its authority (Coolify env, SOPS host
credential, encrypted external bundle, or this project's backup tool) and open
or link an issue in the infrastructure project. Until that repository's drift
check is clean and a fresh capture exists, report `CUSTODY_PENDING`. A
successful deployment is not custody evidence. Never put plaintext secrets in
Git, PRs, Plane, Linear or logs, and never rotate keys or change the host without
explicit owner authorization.
