# Promo Codes v0 cutover recovery

Classify durable release-control state before any action. Do not use `HEAD` or
`main` as authority and do not manually reopen sales.

Use the manual
[`controlled-promo-codes-cutover.yml`](../../.github/workflows/controlled-promo-codes-cutover.yml)
workflow only. Its controller SHA is not the deployment source: operators pass
the exact initial `target_sha`, and the durable release ID remains
`promo-codes-v0:<initial-sha>` throughout recovery. The workflow reads
`GET /v1/admin/release-control/candidates/head` with the release-control bearer
credential and uses the returned `state_hash` verbatim for every next CAS
transition. Do not derive a hash from workflow inputs or reconstruct a lease
binding.

The protected `production-deploy` pointer is updated only by the workflow's
exact CAS helper. Configure `PRODUCTION_DEPLOY_REF_TOKEN` as a production
environment secret with repository contents-write and workflow-write authority:
the immutable feature source itself includes a workflow file, which the default
Actions token is not permitted to update through a ref move. The workflow
requires this credential before it can acquire an owner, and uses it only for
the pointer helper. It first removes the checkout-provided GitHub App auth
header so the dedicated credential is actually selected; never pass it as a
dispatch input or print it in logs.

The deploy source (including a `replacement_sha`) must descend from the
authority-head API hardening commit `91c78c9545820698cb2433f426b75bd5e1ca262c`.
Before generation one is acquired, the workflow proves every already applied
production migration is an identical sorted prefix of the candidate inventory.
Before `DEPLOYED_READ_ONLY` can issue a lease, it verifies exact Commerce,
worker, frontend and admin source evidence; fresh worker heartbeat/sweep;
complete migration hashes; immutable legal baseline/copies; and health/ready
responses.

Run `prepare` first without certification inputs. It acquires generation one,
proves public checkout is paused, deploys the exact source, and reaches
`DEPLOYED_READ_ONLY`. Create the hidden/closed 101-kopeck occurrence and active
`FIXED 1` promo, retain a stable checkout idempotency key and pass its SHA-256
with all other certification inputs to `prepare` again. That second pass only
activates the lease and leaves the ordinary public/provider checkout flow to
produce the consumed evidence. After evidence has reached `CERTIFIED`, use
`complete`; it is the only workflow path that reopens sales.

All four certification inputs are all-or-nothing. `retry_reason=OPERATIONAL`
requires a fresh full fixture after resolved terminal payment failure.
`replacement_sha` is accepted only by `prepare` from `RECOVERY_REQUIRED` and
adopts generation N+1 under the same release ID; it never rewrites the old
generation or reuses a consumed fixture.

## Lease clock discipline

- Finish all human preparation — fixture created and verified, occurrence and
  promo IDs confirmed, checkout idempotency key generated — *before* calling
  `prepare` with certification inputs. Do not activate the lease and then go
  start unrelated diagnostics, a deployment, or a code review.
- `lease_seconds` is bounded to 180–300 (`CERTIFICATION_LEASE_INVALID`
  otherwise). Treat that ceiling as a hard limit, not a target: activate only
  when the real checkout will follow within seconds, not minutes.
- Immediately before submitting the real checkout, recompute the lease's
  remaining TTL from its `lease_expires_at`. If it is under 90 seconds, do
  not submit it — let it expire and activate a fresh lease instead of racing
  an expiring one. Both `consumeCertificationLease` and the public checkout
  path already fail closed with `SALES_TEMPORARILY_PAUSED` past
  `lease_expires_at`, so a raced checkout fails safe, but a race that
  straddles the expiry moment leaves the operator unsure whether the order
  actually committed first — that is exactly the ambiguity the next section
  covers, and it is cheaper to just not race it.
- Do not lengthen the lease window to compensate for slow preparation; fix
  the preparation instead.

## Money-action ambiguity protocol

Applies to every checkout, payment, and refund step of a certification run,
not only to recovery:

- Checkout may have timed out after it actually committed: replay only with
  the exact same stored idempotency key and canonical request body. Never
  submit a fresh key for the same attempt.
- Payment result is unclear (network error, timeout, ambiguous provider
  response): never call payment create again for this order. Reconcile
  against the provider's own read-only state until it resolves to a terminal
  status.
- Refund result is unclear: never create a second refund for the same
  payment. Reconcile against the provider's own read-only state until it
  resolves to a terminal status.
- Any other unknown provider financial outcome: issue no new financial
  command (create, refund, or retry) until an authoritative provider read
  confirms the actual outcome.
- `retry_reason=OPERATIONAL` exists precisely for this class of failure. It
  always requires a fresh fixture, never reuses a consumed occurrence or
  promo, and only applies after the ambiguous outcome above has actually
  reconciled to a terminal state — it is not a shortcut past reconciliation.

## Runtime-readiness defect classification

`PAUSED → RECOVERY_REQUIRED` is not a substitute for a successful
readiness proof and is never performed by the polling loop. It is available
only through the explicit `classify_runtime_readiness_defect` workflow stage,
after an operator has recorded a bounded provider-readiness failure. The stage
reads the durable head and its server-issued CAS token afresh, requires the
candidate to be deployed on both Commerce and worker with sales still paused
and no certification binding, then appends exactly this evidence:

```text
reason              = RUNTIME_READINESS_DEFECT
readiness_component = PROVIDER_READINESS
replay-accepted     = TLS_CERT_CHAIN_UNTRUSTED | PROVIDER_BAD_REQUEST |
                      PROVIDER_HTTP_ERROR | PROVIDER_NETWORK |
                      PROVIDER_RESPONSE_INVALID
classifiable         = TLS_CERT_CHAIN_UNTRUSTED | PROVIDER_BAD_REQUEST |
                      PROVIDER_NETWORK | PROVIDER_RESPONSE_INVALID
error_code          = controlled uppercase code, for example HTTP_400
source_commit       = authoritative candidate source
```

No provider body, JWT, request headers, buyer data, order, payment, or
certification evidence may be included. Replay rejects a generic phase change,
a certification binding, or any other evidence for this edge. The stage does
not deploy, change `production-deploy`, create a lease, call payment create,
or perform an adoption. It is for a candidate whose deployed runtime already
contains this authority endpoint; an older paused candidate that lacks it
requires a separately reviewed one-shot bootstrap authority operation. Do not
misrepresent that bootstrap as `PAUSED → DEPLOYED_READ_ONLY`, hot-deploy a
different source, or edit its durable source commit.

### Offline bridge execution sequence

Every fixed bridge below (and any future one) is executed in this order.
Skipping or reordering a step is not a supported variant:

1. Reproduce the defect live, immediately before shutdown — capture the exact
   evidence the bridge will encode while it is still true.
2. Record the exact Commerce/worker/frontend source SHAs involved.
3. Read a fresh authoritative head and `state_hash` immediately before
   shutdown; a value read earlier in the incident is stale.
4. Stop Commerce.
5. Stop the worker.
6. Prove both are stopped (no process, no listening port) before touching the
   database.
7. Take a fresh SQLite backup of the stopped database.
8. Record the backup's SHA-256.
9. Run a database integrity check against the backup.
10. Let the bridge's own static `target_replay_sha256` check run (it verifies
    itself before opening the database) rather than skipping straight to
    execution.
11. Run the bridge exactly once, with the freshly read `expected_state_hash`
    as its only mutable input.
12. Reread the head, projection, and last ledger events to confirm the
    persisted result matches what the bridge returned.
13. Do not restart the old (pre-bridge) runtime after a successful commit —
    see the replay compatibility barrier in
    [`DEPLOYMENT_INVARIANTS.md`](../release/DEPLOYMENT_INVARIANTS.md).
14. Only then move `production-deploy` to the new generation's exact source
    by CAS, and deploy it, before traffic resumes.

### Fixed generation-two bridge

The only supported bridge shape for the existing pre-endpoint generation is the
offline `commerce:promo:gen2-bootstrap-adopt` utility; its execution always
requires separate explicit authorization. It is intentionally not a workflow
stage: an Actions runner does not own the SQLite volume and cannot prove that
the old Commerce and worker have stopped. The utility accepts no
release, generation, source, replacement, or error inputs. Its only mutable
input is a fresh authoritative `expected_state_hash`, and it is hard-bound to:

```text
promo-codes-v0:b01f217ffd2a798fd32aa3d88e125a2e460bd39f
generation 2 / 631876c16d03bf593d2a383ef89099b1f9d435ca
generation 3 / 4ae2e047ef9236a22cb8bcd5f4dc9127d282d6ca
```

After separately authorized service shutdown, it uses one `BEGIN IMMEDIATE`
transaction to verify the exact paused generation-two head, hash, owner,
empty certification binding, and applied migration prefix; append the bounded
`RUNTIME_READINESS_DEFECT`; adopt generation three with the inherited legal
and migration contracts; verify that its bundled migration inventory is
byte-identical to generation two; replay the whole proposed ledger using the
exact SHA-256-pinned `4ae2e04` replay source; reconcile the projected gate;
and commit. Any failed check rolls back the whole transaction. A second invocation fails
`GEN2_BOOTSTRAP_ADOPT_ALREADY_APPLIED` without changing state. Do not start
old `631876c` again after a successful commit: update `production-deploy` by
its exact CAS and deploy `4ae2e04` before traffic resumes.

### Fixed generation-three readiness classification bridge

The offline `commerce:promo:gen3-classify-readiness-defect` utility covers the
case where generation three is already deployed and paused, but its readiness
endpoint itself returned a documented `PROVIDER_BAD_REQUEST` (missing
`customerCode` on `/acquiring/v1.0/retailers`) — unlike the generation-two
case, this candidate already understands the `RUNTIME_READINESS_DEFECT`
authority, so it does not adopt a new generation; it classifies the existing
one in place. It accepts no release, generation, source, or error inputs.
Its only mutable input is a fresh `expected_state_hash`, and it is hard-bound
to:

```text
promo-codes-v0:b01f217ffd2a798fd32aa3d88e125a2e460bd39f
generation 3 / 4ae2e047ef9236a22cb8bcd5f4dc9127d282d6ca
PROVIDER_READINESS / PROVIDER_BAD_REQUEST / HTTP_400
```

After separately authorized service shutdown, it uses one `BEGIN IMMEDIATE`
transaction to verify the exact paused generation-three head, hash, owner,
empty certification binding, and applied migration prefix against fresh
runtime evidence; append the bounded `RUNTIME_READINESS_DEFECT` in place
(`PAUSED → RECOVERY_REQUIRED`, same generation); replay the whole proposed
ledger; reconcile the projected gate; and commit. A second invocation fails
`GEN3_CLASSIFY_ALREADY_APPLIED` without changing state. This bridge does not
adopt generation four itself — a normal `adoptCandidate` to the fixed
generation follows separately, per the fixed bridge's own fix commit.

### Fixed generation-four-to-five public-frontend bridge

The offline `commerce:promo:gen4-to-gen5-public-frontend-bridge` utility
covers the case discovered only after generation four had already reached
`CERTIFIED`: a systemic 403 on nested public frontend routes (an
Nginx/static-export `try_files` defect), unrelated to the certified
payment/refund evidence, which must be preserved byte-for-byte. It accepts no
release, generation, source, or defect inputs beyond a fresh
`expected_state_hash`, and it is hard-bound to:

```text
promo-codes-v0:b01f217ffd2a798fd32aa3d88e125a2e460bd39f
generation 4 / 5bdbb1a16505fc1711ba8eccdcdd64c6fc1451d9 (CERTIFIED)
generation 5 / 97678cc19d2549146b0d4999466a4cded9320208
defect: PUBLIC_FRONTEND / STATIC_ROUTING / NESTED_TRAILING_SLASH_403
probe:  /legal/public-offer/ -> HTTP 403 on 4ae2e047ef9236a22cb8bcd5f4dc9127d282d6ca
```

It also carries the exact certification and fixture identifiers recorded at
generation four (lease, occurrence, promo, order, payment, refund IDs, and
the 101/1/100 kopeck amounts), and requires them to still match the live
rows before it will run. In one `BEGIN IMMEDIATE` transaction it appends
`PUBLIC_FRONTEND_DEFECT` (`CERTIFIED → RECOVERY_REQUIRED`, certification
preserved unchanged) immediately followed by `CANDIDATE_SUPERSEDED` to
generation five — see the replay compatibility barrier in
[`DEPLOYMENT_INVARIANTS.md`](../release/DEPLOYMENT_INVARIANTS.md) for why
those two events must never be split across a commit boundary. A second
invocation fails `GEN4_BRIDGE_ALREADY_APPLIED` without changing state. Do not
restart old `5bdbb1a` after a successful commit: update `production-deploy`
by its exact CAS and deploy `97678cc` before traffic resumes.

| Durable phase | Allowed next transition |
| --- | --- |
| `PAUSED` | deploy the exact generation, then `DEPLOYED_READ_ONLY`; or explicit bounded runtime-readiness defect classification to `RECOVERY_REQUIRED` |
| `DEPLOYED_READ_ONLY` | activate a bounded certification lease |
| `CERTIFICATION_ONLY` | exact leased certification checkout |
| `CERTIFICATION_IN_FLIGHT` | evidence classification only |
| `CERTIFIED` | guarded complete and reopen; or the offline public-frontend bridge to `RECOVERY_REQUIRED` (certification preserved) |
| `RECOVERY_REQUIRED` | same-owner forward adoption of generation N+1 |
| `COMPLETE` | read-only verification only |

An operational payment failure may return to `DEPLOYED_READ_ONLY` only after
all payment/refund state is resolved. A source, migration-byte, pricing, or
evidence mismatch requires `RECOVERY_REQUIRED`; revoke the active lease in the
same durable transition. The production certification fixture remains hidden
and closed, and the real checkout must demonstrate 101 → 100 kopecks through
capture and refund on `IN_FLIGHT → CERTIFIED`; that append-only transition is
the exact order/payment/refund evidence authority. `COMPLETE` rechecks the
consumed lease and cleanup invariant instead: the fixture is still hidden and
closed at 101 kopecks and its `FIXED 1` promo is disabled before sales reopen.
After a consumed attempt, any same-owner retry uses a fresh occurrence and a
fresh promo; it must never reuse either part of the prior fixture.

### Partially created fixture artifacts

`commerce:certification:create-fixture` stages the complete key and manifest
with `0600` before its single database transaction. If it exits 2 with
`CERTIFICATION_FIXTURE_ARTIFACT_FINALIZATION_FAILED`, do not retry
automatically: the named hidden occurrence and promo are durable and both
complete `.tmp` artifacts are the recovery evidence. Reconcile the packet,
then either complete both renames manually or deliberately abandon that
identified fixture and create a fresh pair. Never delete the durable history
as compensation and never reuse only one half of it.

## Post-completion public smoke test

After `complete` reopens sales, a manual spot-check of the public catalog
(for example `GET /v1/public/occurrences`) is a reasonable sanity check, but
an empty or short result there is **not by itself** evidence of a routing or
runtime regression. The certification fixture is deliberately `HIDDEN` and
`CLOSED` and stays that way after cleanup; ordinary production occurrences
may legitimately be absent from a given city/date window for entirely
unrelated business reasons (none published yet, all sold out, wrong
filters). Treat route/schema health and catalog business content as two
separate questions:

- Route and schema health: the endpoint returns HTTP 200 with a
  well-formed response shape. This alone is provable generically.
- Catalog business content: whether a *specific, independently known*
  occurrence appears, is visible, and is sellable. This can only be checked
  against a fixture whose expected state you already know going in — never
  infer a regression from "the list looked empty" without first identifying
  which specific row you expected to see and independently confirming its
  intended visibility.

If the list is unexpectedly empty and no specific known-live fixture was
being checked, that is inconclusive, not a finding — investigate each
occurrence's own domain eligibility (visibility, sales window, city/date
filters) before treating it as a frontend or runtime regression.
