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

**`UNAUDITED` is zero** (PR-C2 step 1). **10 `REPEATABLE` routes remain** — 6
admin, 4 partner — after step 2a closed the content-addressed half.

All 35 previously pending routes resolved to `REPLAY_SAFE`, and that result is
the useful part: the repeatable class is exactly *"mint the next revision in
an append-only chain with no state gate"*. Every state **transition** in this
system is already guarded by the state it transitions from, and every
mint-if-absent command already returns the existing row. What is left
repeatable is the set of commands that append unconditionally.

The sharpest illustration is a matched pair on the same table:
`revokeAudienceVerificationForPartnerCity` requires the current event to be
`VERIFIED` and so refuses a retry, while `verifyAudienceForPartnerCity` — its
twin, writing to the same event chain — has no guard at all and mints another
`VERIFIED` event every time it is called.

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

The remedy is not uniform, and was not forced to be.

**Step 2a — done.** Where the same semantic body is **never** a legitimate
second command, an explicit no-change branch is enough, and the chain's own
content hash is the comparison. Closed this way: engagement revisions
(`content_hash` plus the occurrence material revision, since the same terms
against changed material *are* a new revision), creative revisions
(`creative_hash`), creative authorization (the live authorization already
naming that creative), distribution corrections (`canonical_hash`, both
realms), ORD provider profiles and the framework/delegation template chains
(`content_hash`), channel policy (same status from the same instant), and the
partner's own legal-profile draft resubmission.

**Step 2b — remaining.** Where repeating the same body **can** be a deliberate
new command, only a caller-supplied command key can tell a retry from an
intent, because no content comparison can:

- `activateEngagement` — re-activating onto the same revision after a genuine
  suspension is a real business action.
- `recordNpdStatusCheck` — a fresh check with the same status is the point;
  freshness is what the payment guard consumes.
- `placeLegalHold` — a second hold for a different matter is legitimate.
- `verifyAudienceForPartnerCity` — re-verification after a revocation is
  legitimate, and it has no guard of its own (unlike its revoke twin).
- `reportDistribution` (both realms) — each call is a new distribution
  identity by design.
- `mintRetentionPolicyRevision` — a restated policy is a governance act.
- partner payout set / revoke, partner NPD receipt evidence.

Admin realm can reuse `admin_command_idempotency` directly. The partner realm
needs a principal-scoped equivalent — a partner must not be able to replay
another partner's command key. In both realms, exact replay must resolve
**before** any mutable-state or gate read, exactly as
`recordVerifiedTaxTreatment` already does.
