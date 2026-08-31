# Epoch A: dormant runtime promotion

**Status: prepared protocol, not authorization to execute.** This runbook is
for the one controlled deployment of runtime R. It does not publish legal
documents, collect notification PII, create a notification request, or
implement Epoch B.

## Immutable identities and topology

```text
controller main at review        = fb4b65f746becf21f70ae75ebf4a1bf31dd9508c
current production-deploy        = 0ddc33d0fd0077fe0ba238ec75ae4090fc38ac34
R                               = 80e152259628719af20d363a76ed6b991d67482a
R parent                        = 0ddc33d0fd0077fe0ba238ec75ae4090fc38ac34
R immutable tag ref             = refs/tags/epoch-a-runtime-r-80e152259628
R immutable tag object          = 5b4a00791cd89c2773aebdcacde4b8dae5b95cb1
```

R is a direct, single-parent child of the deployed runtime. It contains only
the deployable #37 runtime patch: the canonical legal-capability predicate,
its focused tests, and the `SEND_UNKNOWN` notification reconciliation fix.
It does **not** contain the Epoch-A controller, runbook, or legal publication.
The controller is integrated independently on `main`; it binds the literal R
SHA and proves `R^ == production-deploy` instead of requiring R to be an
ancestor of controller history. This is deliberate squash-governance topology,
not an ancestry exception for an arbitrary target.

The annotated R tag **must be protected before Epoch A execution**; it is the
immutable recovery anchor. The controller requires both its exact tag-object ID
and its peeled commit ID before it reads durable state, so an unreviewed
retarget also fails closed. `runtime-candidate` is deliberately **not** that
anchor: it is consulted only while a fresh no-owner `prepare` is about to
acquire Epoch A, then immediately re-read before `acquire`. Once the owner
exists, the durable owner and this tag bind recovery; the mutable proposal
pointer may move without stranding a paused epoch.

Epoch B must later create P as a direct child of this exact R. It may not use
the Epoch-A controller SHA or `main` as its source identity.

## Change classification and coexistence decision

The exact `0ddc33d… → R` diff is limited to:

```text
commerce/src/domain.ts
commerce/src/occurrence-notification-capability.ts
commerce/test/domain.test.ts
commerce/test/occurrence-notification-capability.test.ts
```

It is a **COMPATIBILITY** change because it alters the legal evidence predicate
and its `legal-release.ts` dependency is a compatibility-sensitive reader. It
is not a legal document change, surface-contract change, release-control
semantic change, or migration addition. The generic deploy lane must continue
to refuse this class; the dedicated controller owns it.

`0038_occurrence_availability_notifications.sql` is already present in both
the deployed Gen2 tree and R, with identical bytes. Epoch A nevertheless reads
the full applied inventory and exact 0038 source hash before and after the
cutover. There is no migration to apply in this protocol. If production lacks
0038 or its source-hash inventory differs, this protocol refuses before owner
acquisition; it does not silently turn a compatibility cutover into a schema
migration.

Online coexistence is acceptable only for the current pre-B legal state:

- replay: neither runtime writes or reinterprets release-control history;
- writer: the new notification writer remains disabled, so no PII or new
  notification intent can be written; existing `SEND_UNKNOWN` rows are first
  reconciled against their provider identity;
- authority: release gate and outbox remain `ATTEMPT`, dispatch stays open,
  and no legacy authority path is introduced.

No offline reader/writer exclusion is required merely because 0038 exists. A
future legal publication, capability activation, unknown migration, or
authority mismatch fails closed instead of relying on this coexistence proof.

## Emergency-gate policy

Epoch A requires the release-specific sales pause, not the emergency latch.
R does not alter checkout authority, adds no migration, and keeps notification
collection unavailable. Requiring an emergency hold across the unknown interval
to Epoch B would create unnecessary sales downtime without strengthening
Epoch-A's compatibility proof.

The controller reads and reports `emergency_sales_paused` before every durable
mutation and rechecks it before pointer CAS and reopen. It never changes it.
If it differs within a run, the run stops with the release owner retained; an
operator must decide the independent emergency state before a fresh
same-owner run. The release-control schema has no durable emergency-revision
field, so this protocol does not claim a cross-run snapshot it cannot prove.

## Stages

The manual workflow accepts only `stage=prepare` or `stage=complete`; R is
literal controller policy, never workflow input.

| Stage | Preconditions | Durable mutation | Success / replay |
| --- | --- | --- | --- |
| PREPARE preflight | main controller and immutable R tag exact; fresh/no-owner path also requires `runtime-candidate == R` and `production-deploy == 0ddc…`; same-owner recovery is anchored by durable owner + R tag; no foreign owner; full 0038 inventory; pre-B legal evidence; notification capability false | none | fresh proof only |
| ACQUIRE / PAUSE | fresh candidate immediately before first mutation | `ReleaseSalesGate.acquire` then `pause`, each database transaction and event | same expectations replay; checkout returns `SALES_TEMPORARILY_PAUSED` |
| POINTER / DEPLOY | matching paused owner, emergency unchanged in this run, plus a fresh authenticated proof before CAS or R recovery deployment of exact gate expectations, pre-B/current legal copies, dormant capability, ATTEMPT/open/no dispatch owner, full migration inventory, and pointer `0ddc…` or R; a new CAS additionally requires the old runtime still be Gen2 | guarded `production-deploy` CAS `0ddc… → R`, then Coolify enqueue | pointer already R is replay, never a path back to Gen2 |
| CONVERGENCE | bounded polling after enqueue | none | Commerce and worker source R; frontend/admin R contracts; exact 0038 inventory; release replay clean; `ATTEMPT/open`; legal still pre-B and capability false |
| PRODUCT CERTIFICATION | converged R while release pause is held | none | public `legal-config` reports false; authenticated evidence proves worker/gate/outbox; no PII, no synthetic notification row, payment, or refund is created |
| COMPLETE | matching paused owner plus all fresh convergence/certification evidence | `ReleaseSalesGate.reopen` transaction and event | owner null, release pause open; emergency is not changed |

Convergence timeout is an execution failure, not a runtime-defect event. The
next run rereads durable state and may resume the same owner. A 2xx Coolify
webhook only acknowledges enqueue; it is never certification.

## Compatibility evidence

Before acquire, immediately before pointer CAS, and after R convergence the
controller proves all of these (the pre-CAS snapshot also rebinds the exact
durable owner expectations):

```text
active durable legal version             = 2026-08-26.1
runtime canonical legal manifest         = exact pre-B source
public legal-config version/hashes       = exact durable pre-B release
current legal copies                     = match
occurrence_notifications_available       = false
2026-08-28.1                             = not active
```

The first four bind the authoritative legal value and R's interpreter; the
fifth proves the actual public capability, rather than assuming a successful
deployment means it stayed dormant. A true capability or any future legal
version stops the run before reopen.

## Recovery matrix

| Fresh durable observation | Classification | Only allowed next action |
| --- | --- | --- |
| no owner, open, production pointer Gen2 | not started | `prepare` after fresh preflight |
| no owner, open, production pointer R | invalid adoption attempt | stop; never create a fresh owner around an already-moved pointer |
| foreign owner or paused without owner | release conflict/corruption | stop; use that owner's runbook |
| same owner, paused, pointer Gen2, runtime Gen2 | pre-deploy or CAS not applied | same-owner `prepare` |
| same owner, paused, pointer R, runtime Gen2 | CAS applied, deployment absent/old | same-owner `prepare`; re-enqueue R only |
| same owner, paused, Commerce R/worker old | partial convergence | wait/retry `prepare`; never reopen |
| same owner, paused, Commerce+worker R but a surface stale | partial convergence | retry `prepare`; never move pointer backward |
| same owner, paused, all R evidence and dormant capability | ready | explicit `complete`, not automatic reopen |
| capability true, future legal active, legal evidence differs | compatibility boundary spent externally | stop; do not publish, rollback, or reclassify as generic |
| 0038 absent/hash mismatch, outbox not ATTEMPT/open, or replay corrupt | durable evidence invalid | stop; no deploy/reopen |
| emergency changes during one run | independent authority changed | stop with owner retained; operator decides, then fresh same-owner proof |
| completion exists with exact expected R | terminal replay | read-only proof only |

## Epoch B handoff

Epoch A completion hands off an evidence record, not authorization for Epoch B:

```text
R and R parent; production-deploy == R;
full migration inventory and exact 0038 hash;
checkout/admin surface contract versions;
pre-B active legal release and hashes;
notification capability == false;
release owner == null; release pause open.
```

Only a separately reviewed Epoch-B controller may acquire a new legal owner,
build P directly from R, publish `2026-08-28.1`, deploy P, certify a real
notification, and decide its emergency-gate policy.
