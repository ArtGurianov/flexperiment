# Epoch B: notification legal activation design

**Status: design only. This document does not authorize or execute Epoch B.**

Epoch B starts only from the terminal Epoch A baseline recorded in
`docs/runbooks/EPOCH_A_TERMINAL_BASELINE.md`.

## Immutable predecessor and target legal identity

```text
Epoch A runtime R             = 80e152259628719af20d363a76ed6b991d67482a
R direct parent               = 0ddc33d0fd0077fe0ba238ec75ae4090fc38ac34
Epoch A release id            = epoch-a-dormant-notifications:80e152259628719af20d363a76ed6b991d67482a
pre-B legal version           = 2026-08-26.1
Epoch B legal version         = 2026-08-28.1
Epoch B legal manifest SHA256 = fb879a80c48a50c41694d83118e5f8004a4fec5fbf36f954b15f4b678f4efe02
Privacy Policy SHA256         = 642d11458733e8c1e5bfb28d0cde7f917a276dfcb3e32dc52adc34fac6326339
PD Consent SHA256             = acdb8a31a846c1c697cfd977fb67f24e75d280ab72cb6fbce5bbf0146d4ba5b6
```

The checked-in `production-manifest.2026-08-28.1.draft.json` contains the
reviewed document identities and hashes but deliberately contains
`PENDING_AUTHORITATIVE_PUBLISH_TIMESTAMP`. The draft timestamp is never legal
authority. `legal-publish` writes the durable active release and returns the
authoritative `effectiveAt`; only that value may be copied into the promoted
canonical manifest.

## Epoch B meaning

Epoch B is the activation boundary for occurrence-availability notifications.
Unlike Epoch A, deploying the Epoch B promotion artifact with active legal
`2026-08-28.1` makes `occurrenceNotificationsAvailable()` true once runtime,
durable legal, current legal copies, and required consent hashes agree.

The release sales pause does **not** block
`POST /v1/public/occurrence-notifications`. Therefore `stage=prepare` is itself
an explicit authorization to activate notification PII collection. It is not a
non-activating dry preparation stage. `stage=complete` only performs a fresh
post-activation proof and releases the independent sales pause.

This distinction must be visible in workflow naming, comments, tests, and the
human GO sequence.

## Promotion artifact P

P is not supplied by a workflow input and is never inferred from `main`.
The controller creates or recovers exactly one promotion artifact after legal
publication.

P must satisfy all of the following:

```text
P has exactly one parent
P^ == exact R
P contains the authoritative publish timestamp returned by legal-publish
P canonical production manifest version == 2026-08-28.1
P current Privacy Policy bytes == reviewed 2026-08-28 archive bytes
P current PD Consent bytes == reviewed 2026-08-28 archive bytes
P does not add or change migrations
P keeps checkout/admin surface contracts unchanged
P contains no unrelated runtime/product change
```

The intended deterministic mutation is the existing legal promotion operation:

- replace `commerce/legal/production-manifest.json` with the reviewed
  `2026-08-28.1` draft plus the authoritative publisher timestamp;
- copy the reviewed archive documents into the non-versioned current legal
  paths;
- update legal certification defaults to the same version/hashes.

The controller must prove the exact R-to-P changed-path allowlist before P can
become durable release expectations or `production-deploy`.

A deterministic recovery ref may hold P, but that mutable ref is not authority.
After P exists, durable same-owner expectations plus exact P identity are the
recovery authority. A fresh no-owner path must never adopt an already-moved
production pointer or an unbound P.

## Epoch B release owner

Epoch B uses a new release id distinct from Epoch A, for example:

```text
epoch-b-notification-activation:80e152259628719af20d363a76ed6b991d67482a
```

The exact identifier is controller policy, not workflow input.

Before first durable mutation, the controller must prove:

- exact Epoch A completion record and expectations;
- `production-deploy == R`;
- Commerce and worker exact R;
- release owner null and sales gate open;
- active legal exactly `2026-08-26.1`;
- public occurrence notification capability false;
- full R migration inventory and source hashes exact;
- outbox authority `ATTEMPT`, email dispatch open, dispatch owner null;
- emergency latch read and preserved, never repurposed;
- reviewed `2026-08-28.1` draft manifest/hash and archive bytes exact;
- no previously active conflicting `2026-08-28.1` release.

The fresh path then acquires the Epoch B owner and pauses sales. Candidate
freshness is not represented by `runtime-candidate == P`, because P does not
exist before authoritative legal publication. The controller instead binds
fresh acquisition to exact R plus the reviewed legal candidate identity.

## Stage prepare: activation authorization

A separately authorized `stage=prepare` performs the activation sequence and
must remain fail-closed at every seam:

1. Assert exact controller `main`, exact R, Epoch A completion, tag/topology,
   legal draft hashes, and required credentials.
2. Read authenticated durable state and public surfaces.
3. Reconcile only from durable Epoch B state.
4. For the fresh no-owner path, reprove the exact R + pre-B legal baseline
   immediately before acquisition.
5. Acquire the Epoch B owner and pause sales.
6. Prove checkout is paused and emergency/outbox authority are unchanged.
7. Reprove exact owner expectations, R runtime, migration inventory, pre-B
   legal state, and notification dormancy immediately before publication.
8. Publish legal `2026-08-28.1` exactly once through the existing controlled
   `legal-publish` seam. A replay is accepted only when the existing active
   release has the exact same canonical manifest.
9. Read back the durable authoritative `effectiveAt` and exact active legal
   manifest/hash.
10. Create or recover P as the deterministic single-parent child of R using
    that `effectiveAt`. Prove exact parent count and exact changed-path scope.
11. Update the same Epoch B owner's durable expectations from R to exact P;
    never create a new owner around P.
12. Reprove owner, legal publication, outbox/emergency authority, and
    `production-deploy == R` immediately before the pointer mutation.
13. Guarded CAS `production-deploy: R -> P` using expected-old and
    force-with-lease semantics; no plain force.
14. Enqueue exact P only after successful/reflected CAS.
15. Bounded convergence proof for Commerce, worker, frontend, and Admin exact
    P; full migration inventory unchanged; legal/current/archive hashes exact.
16. Prove `occurrence_notifications_available == true` and the public
    notification endpoint is now legally/runtime enabled.
17. Prove no unrelated authority change: outbox remains `ATTEMPT`, dispatch is
    open/no owner, emergency unchanged.
18. Finish **with the Epoch B release owner retained and sales paused**.

Successful `prepare` therefore means notification collection is active while
new sales remain paused. It must emit a terminal activation marker such as:

```text
EPOCH_B_ACTIVATION_PREPARED
```

No automatic reopen is permitted.

## Stage complete: sales reopen after active-state proof

A separately authorized `stage=complete` is permitted only for the same Epoch B
owner with exact P expectations. It performs no legal publication, P creation,
pointer CAS, or deployment.

It must freshly prove:

- exact Epoch A completion remains present;
- exact Epoch B owner/expectations and sales pause;
- `production-deploy == P`;
- Commerce and worker exact P;
- active durable legal exactly `2026-08-28.1` with the authoritative publish
  timestamp and reviewed canonical manifest hash;
- current and archive legal bytes exact;
- `occurrence_notifications_available == true`;
- notification registration capability is active;
- full migration inventory unchanged;
- checkout/admin surface contracts exact;
- outbox authority `ATTEMPT`, dispatch open/no owner;
- emergency latch unchanged within the run.

Only then may it call release-control `reopen`. Terminal proof must establish:

```text
Epoch B completion = exact COMPLETE record and P expectations
sales_paused       = false
owner_release_id   = null
owner_mode         = null
production-deploy  = exact P
runtime / worker   = exact P
legal              = 2026-08-28.1
notifications      = active
outbox authority   = ATTEMPT / dispatch open / owner null
emergency latch    = unchanged
```

## Recovery matrix

| Durable observation | Classification | Only allowed action |
| --- | --- | --- |
| Epoch A not exactly complete | prerequisite missing | stop |
| no owner, open, pointer R, legal pre-B, notifications false | Epoch B not started | fresh `prepare` after separate GO |
| no owner, pointer not R before Epoch B completion | invalid adoption | stop |
| foreign owner or paused without owner | conflict/corruption | stop |
| same Epoch B owner, paused, legal pre-B, pointer R | pre-publication recovery | same-owner `prepare` only |
| same owner, legal B published, P absent | post-publication/pre-promotion recovery | reconstruct exact P from durable `effectiveAt`; same-owner `prepare` |
| same owner, P expectations durable, pointer R | pre-CAS recovery | same-owner `prepare` |
| same owner, pointer P, runtime R | post-CAS deployment recovery | re-enqueue exact P only |
| same owner, runtime/worker/surfaces partially P | partial convergence | retry `prepare`; never roll pointer back |
| same owner, exact P + legal B + notifications active | activation prepared | explicit `complete` only |
| legal B active with no Epoch B owner and Epoch B incomplete | externally spent activation boundary | stop; do not silently acquire/adopt |
| active legal differs, P topology/scope differs, migration/outbox/replay evidence differs | invalid authority | stop |
| emergency changes within a run | independent authority changed | stop with owner retained |
| Epoch B completion exact | terminal replay | read-only proof only |

## E2E is post-completion certification, not controller authority

After terminal Epoch B completion, a separately authorized E2E may exercise a
real notification lifecycle. It is not part of `prepare` or `complete` and must
not be used as the authority that decides whether legal publication, P deploy,
or sales reopen is permitted.

The E2E should prove the intended user lifecycle (registration, eligibility,
outbox/provider evidence, delivery/terminal cleanup) using a controlled test
identity and explicit cleanup policy.

## Controller implementation requirements

The controller PR must include structural/executing regressions proving at
least:

- Epoch A exact completion is a hard prerequisite;
- R is literal policy and P has exactly one parent equal to R;
- legal `2026-08-28.1` draft canonical manifest hash is exact;
- authoritative `effectiveAt`, not the draft placeholder, is used to create P;
- legal publication occurs only while the same Epoch B owner holds the sales
  pause;
- no fresh-owner path exists after legal B has already become active;
- `/expectations` may bind the existing owner to P but cannot create ownership;
- pointer setter uses guarded expected-old `R -> P`, never plain force;
- deploy source is exact P only;
- `prepare` never calls reopen and explicitly treats notification activation as
  occurring before its terminal marker;
- `complete` contains no publication/CAS/deploy path and requires fresh exact-P
  active-legal evidence before reopen;
- existing mutable branches (including historical `codex/epoch-b-*`) are never
  treated as authority.

Until such a controller is implemented, reviewed, merged, and separately
authorized, Epoch B remains **NO-GO**.
