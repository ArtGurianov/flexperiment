# Agent Referrals: command replay matrix

Produced by the PR-C idempotency audit, corrected twice in review. It is the
input to **PR-C2**, which is a rollout blocker.

## The criterion

One question, applied to every command:

```text
the command commits
its HTTP response is lost
the sanctioned mutation layer refreshes authoritative state
the operator (or partner) repeats the same logical action

→ does another durable fact, revision or identity appear?
```

Two things this criterion deliberately does **not** accept as replay safety:

- **A single-use step-up grant.** It stops a *grant* from being replayed. It
  does not stop an *intent* from being repeated: the UI mints a fresh grant
  for the retry, and after PR-C's own authoritative refresh that grant is
  bound to the new current revision — so the second write is not merely
  possible, it is legitimate. `setPartnerPayoutDestination` is the clearest
  case.
- **A CAS on a revision counter.** It refuses a *stale* writer. A retry is
  not stale: it re-reads the counter the first attempt just bumped and
  proceeds. `activateEngagement` is the clearest case.

## Boundary

**Every write route published by `agent-referrals-api-admin.ts` and
`agent-referrals-api-partner.ts`** — 67 admin and 20 partner routes, not the
subset the React surfaces happen to call. Both routers are authenticated but
externally callable: a caller does not need a button to reach a route, so a
matrix scoped to buttons leaves the HTTP path unaudited.

This boundary was chosen after three review rounds in which the matrix
claimed "every command" and delivered the UI-reachable subset each time. The
missing entries were never found by re-reading the document.

## Where the matrix lives

In `commerce/test/agent-referrals-command-replay-registry.test.ts`, not here.
The test extracts every write route from both routers and fails if any is
unclassified, so **a new POST route cannot ship without a replay
classification** — which is the only thing that stops this document rotting
again between now and PR-C2. It also pins the `REPEATABLE` set and the count
of still-`UNAUDITED` routes, so neither can drift silently.

That registry found three partner routes (`/invite/consume`, `/login/request`,
`/login/verify`) that a careful manual pass over the same file had missed.

Classifications:

| value | meaning |
|---|---|
| `DURABLE_KEY` | exact replay returns the original response |
| `REPLAY_SAFE` | a repeat is refused or replayed by construction |
| `NAMED_REFUSAL` | a repeat is refused with a named code (added by PR-C) |
| `REPEATABLE` | an identical repeat mints a **new durable fact** — PR-C2 scope |
| `SPECIAL_NON_REPLAYABLE_SECRET` | the response carries a secret that is never persisted, so ordinary durable identity cannot re-serve it |
| `NOT_A_BUSINESS_WRITE` | session / authorization plumbing |
| `UNAUDITED` | not yet checked against the criterion — **must reach zero before rollout** |

### Current state

20 `REPEATABLE` routes (14 admin, 6 partner) and **35 still `UNAUDITED`** (32 admin, 3 partner). Both
numbers are asserted by the test. PR-C2 has to drive `UNAUDITED` to zero and
`REPEATABLE` to zero, in that order — an unaudited route may well turn out to
be a twenty-first repeatable one.

Two entries deserve naming here because their remedy is not the generic one:

- **`/engagements/:id/activate`** is the heaviest repeatable command. A lost
  response plus the same click revokes the live promo authorization, mints a
  replacement, and writes a **second activation event** — evidence that
  settlement and ORD both pin. CAS does not help: the retry re-reads the
  `lifecycle_revision` the first attempt bumped, and `ACTIVE` is an accepted
  starting state.
- **`/partners/:id/invite/reissue`** returns a raw invite token that is
  deliberately never persisted. If its response is lost, the original secret
  cannot be re-served by any idempotency mechanism, so this one needs
  explicitly defined lost-response recovery semantics rather than a command
  key.

Note also that `reportDistribution` and `correctDistribution` are each
published in **both** realms. C2 must close both, or state why one surface is
not a rollout surface.

## PR-C2 shape

The remedy is not uniform, and should not be forced to be:

- Where the same semantic body is **never** a legitimate second command, an
  explicit replay / no-change branch is enough (`authorizeCreative` for the
  same creative revision; `correctDistribution` for identical content).
- Where repeating the same body **can** be a deliberate new command, only a
  caller-supplied command key can tell a retry from an intent. Activation is
  the example: re-activating onto the same revision after a genuine
  suspension is a real business action, and CAS cannot distinguish it from a
  lost-response retry. `K1 + activate(E,R1)` replays to the original
  activation event; `K2 + activate(E,R1)` is a new one.

Admin realm can reuse `admin_command_idempotency` directly. The partner realm
needs a principal-scoped equivalent — a partner must not be able to replay
another partner's command key. In both realms, exact replay must resolve
**before** any mutable-state or gate read, exactly as
`recordVerifiedTaxTreatment` already does.
