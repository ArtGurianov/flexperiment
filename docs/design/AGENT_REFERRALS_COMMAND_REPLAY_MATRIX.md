# Agent Referrals: command replay matrix

Produced by the PR-C idempotency audit, corrected twice in review. It is the
input to **PR-C2**, which is a rollout blocker.

## The criterion

```text
A commits
its HTTP response is lost
ANY legally possible sequence B* occurs
old A is retried

→ old A must NEVER mutate authority or evidence created after A
```

**This is stronger than the obligation the first three versions of this
document used**, which was effectively `A, immediate retry A`. Under the weak
form, three things were accepted as proofs. None of them survive:

- **A state gate.** "Suspend requires ACTIVE, so a retry is refused" holds
  only until a legal reactivation puts the engagement back in ACTIVE. Same
  for audience revoke after a new verification, and for ORD `open` once the
  first draft has been confirmed into CORRECTION_ONLY.
- **Equality against the CURRENT row.** `A → B → A` is frequently a
  legitimate revert - back to the previous contract text, channel policy or
  campaign terms - so content equality cannot distinguish a revert intent
  from a stale retry, and after B the equality branch simply does not fire.
- **A converging in-place UPDATE.** It writes no second row, but a stale
  retry can overwrite evidence *newer* than itself. ORD submission is the
  clearest case: `submit A(vk1)`, `submit B(vk2)`, retry `A(vk1)` puts vk1
  back.

Two further things that look like replay safety and are not, carried over
from the earlier versions:

- **A single-use step-up grant** stops a *grant* being replayed, not an
  *intent* being repeated: the retry mints a fresh grant which, after the
  authoritative refresh, is legitimately valid against the new revision.
- **A CAS on a revision counter the SERVER re-reads** refuses a *stale
  writer*; a retry is not stale, it re-reads the counter the first attempt
  bumped. This is the one that needs care, because the shape that DOES work
  looks similar: a counter the CLIENT supplies in the request body travels
  with the retry, so the retry still carries the value A was authored
  against and is refused. That is `STALE_BOUND`, and it is why
  `/feature-state/suspend` — which has carried `expected_revision` since it
  was written — needed no change.

Only three kinds of proof are accepted now:

| proof | meaning |
|---|---|
| `DURABLE_KEY` | exact replay through a caller-supplied key, whatever B* did |
| `STALE_BOUND` | the request pins the predecessor/version it was made against, so a stale retry is refused rather than applied |
| `MONOTONIC_REPLAY_SAFE` | no legal B* can restore the command's write precondition |

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
again between now and PR-C2. It also pins the exact membership of each
proven class and the count of still-`UNPROVEN` routes, so neither can drift
silently.

That registry found three partner routes (`/invite/consume`, `/login/request`,
`/login/verify`) that a careful manual pass over the same file had missed.

Classifications - these are the CURRENT six, and they replaced an earlier
set (`REPLAY_SAFE`, `REPEATABLE`, `UNAUDITED`) that was defined against the
weak obligation. The rename is not cosmetic: `REPLAY_SAFE` asserted a
conclusion, while the three proof names each state WHY the conclusion holds,
which is what makes a wrong classification visible on inspection.

`NAMED_REFUSAL` was in this table for one revision and is gone: under
`A -> B* -> retry A` a named refusal is a proof only when the state it
depends on is unrestorable, which is exactly `MONOTONIC_REPLAY_SAFE`.
Keeping both invited classifying by the error message instead of by the
invariant - and `placeLegalHold`, the one route that had it, turned out to
need a key.

| value | meaning |
|---|---|
| `DURABLE_KEY` | exact replay through a caller-supplied command key, whatever B* did |
| `STALE_BOUND` | the request pins the predecessor/version it was made against, so a stale retry is refused rather than applied |
| `MONOTONIC_REPLAY_SAFE` | no legal B* can restore the command's write precondition |
| `SPECIAL_RECOVERY` | the response carries a secret that is never persisted, so no idempotency mechanism can re-serve it |
| `NOT_A_BUSINESS_WRITE` | session / authorization plumbing |
| `UNPROVEN` | not yet proven against the criterion — **must reach zero before rollout** |

### Current state

**Proven: 80 routes. `UNPROVEN`: 0.** Both pinned by the registry test.

| class | admin | partner |
|---|---|---|
| `STALE_BOUND` | 24 | 4 |
| `MONOTONIC_REPLAY_SAFE` | 34 | 6 |
| `DURABLE_KEY` | 8 | 4 |

Each class is pinned by full sorted membership, so a route cannot change
class silently even if the counts still add up.

The count went **0 → 62 → 0**. The 62 was not a regression: it was the
honest recount after the obligation was corrected from `A, immediate retry A`
to `A → B* → retry A`, which invalidated every state-gate and
current-row-equality classification at once. An earlier revision of this
section also said 16 proven where the truth was 18, by forgetting the two
partner monotonic routes — the registry now asserts the total, so that
particular arithmetic cannot be wrong silently again.

`DURABLE_KEY` stayed the smallest class through the whole pass, which was
the point. Twelve routes out of eighty need a caller-supplied key; the rest
answer the question out of their own semantics.

The `SPECIAL_RECOVERY` case is the one thing still open:
`/partners/:id/invite/reissue` returns a raw token that is never persisted,
so no idempotency mechanism can re-serve the original after a lost response.
It needs defined recovery semantics — plausibly "an explicit recovery
reissue atomically supersedes T1 and returns T2, leaving only T2 live" —
named and tested as such. **A zero in the UNPROVEN column does not close the
rollout gate while this is open.**

## How the 62 were closed

Not by defaulting to a key. Each route answered one question:

> Can a legal B* make the OLD request A a valid command against the NEW
> authority again?

- **No, and it never can be** → `MONOTONIC_REPLAY_SAFE`. A one-way edge, a
  consumed capability, a terminal row, a uniqueness that is never freed.
  Forty routes, and most of them needed no code at all — the proof was
  already there and had simply never been stated.
- **No, because A names what it was made against** → `STALE_BOUND`.
  Twenty-eight routes.
- **Yes** → `DURABLE_KEY`. Twelve routes.

### The STALE_BOUND mechanism

One helper, `requireObservedVersion`
(`commerce/src/agent-referrals-command-precondition.ts`), called inside each
command's own transaction before any mutation. The command names the version
it was authored against; after a legal B* that version is no longer current,
so the retry is refused instead of applied.

**The pinned value must be MONOTONE** — a counter that only increases, or the
id of the newest row in an append-only chain. This is the rule the whole
mechanism rests on, and the reason a pin on the aggregate's current STATE is
never routed through it: `A → B → A` restores a cyclic state to exactly the
value A was authored against (a distribution required for removal, claimed,
then required again; a draft edited and edited back), so a stale retry would
pass the check and apply anyway. That is the current-row-equality trap
wearing a different hat.

The pins, and why each is the monotone one rather than the obvious one:

| aggregate | pin | why not the obvious choice |
|---|---|---|
| feature state | `expected_revision` (already existed) | — |
| engagement lifecycle | `lifecycle_revision` | "requires ACTIVE" is re-opened by every legal reactivation |
| creative authorization | the chain HEAD, live or revoked | the LIVE authorization returns to null on every revocation |
| distribution removal/compliance | `event_sequence` | the states are cyclic by design |
| partner legal-profile draft | a new counter (migration 0055) | `onboarding_revision` does not move on a resubmission; the draft's content is edit-revertible |
| legal-profile supersession | the verified revision NUMBER **and** the request-chain head (0056) | two pins, not one: a REJECTION mints no revision, so it leaves the revision pin unmoved while freeing the pending slot |
| audience verification | `aggregate_revision` | "requires a current VERIFIED" is re-opened by re-verification |
| content chains (engagement, creative, framework, delegation, channel policy, ORD provider profile, distribution revisions, ORD period reports) | the revision/id being superseded | content equality cannot separate a revert from a stale retry |
| reward correction | the effective snapshot it was decided against | every call mints a new E |

Where a content no-change branch already existed, it answers **first** and
the pin guards only the actual mint. A no-op mutates nothing, so it is safe
for any retry whatever its pin says, and letting it answer first keeps an
ordinary lost-response retry a success rather than a 409.

### The client side of the same proof

A `STALE_BOUND` route is safe against a literal HTTP retry. That is weaker
than the operational model this console actually has: the sanctioned mutation
layer **refreshes authoritative state on an ambiguous outcome**, and then the
operator repeats the same logical intent. A form that re-derives its
`expected_*` pin from the refreshed query at that moment is no longer
retrying A — it is authoring a NEW command against B's state carrying A's
body, and the server applies it, correctly, because that is what the request
now says.

So the pin has to survive the ambiguity the same way the idempotency KEY
does. Both hooks now retain the command's full variables on an ambiguous
outcome, read from the same disposition table rather than a second policy
that can drift: **if it is unsafe to mint a new key, it is unsafe to
re-derive the pin.** A definitive business refusal means the command did not
happen, so the snapshot is dropped and the next submit derives a fresh pin.

`RetainedIntentNotice` then asks the operator which of two genuinely
different commands they mean, rather than guessing:

```text
first attempt          -> snapshot the variables, pin included
ambiguous outcome      -> keep the snapshot; refresh authoritative state
"повторить прежнюю"    -> replay that exact snapshot
"это новое действие"   -> discard it, author against what is on screen now
success / definitive   -> cleared
```

Every `STALE_BOUND` surface passes its pin **inside the mutation variables**,
never derived inside `mutationFn` from a query the refresh may already have
moved on — that is what makes the snapshot replayable at all.

Two wiring rules the review round found by reading the surfaces rather than
the hook, both of which the hook being correct did not save:

- **The notice has to be reachable from the state the command actually
  leaves behind.** An ambiguous first legal-profile submission commits:
  onboarding moves `INVITED → PROFILE_SUBMITTED`, which keeps the initial
  form on screen and never renders the `PARTNER_ACTIVE` section. A notice
  living only in that section is unreachable exactly when it is needed, and
  the operator's only route back is an ordinary submit — which re-derives the
  pin and stops being a retry. Each command gets its own notice, beside its
  own form.
- **A route that gains a required pin has to gain it at every call site.**
  The partner removal claim kept sending a body with no
  `expected_event_sequence` after the route began requiring one, so the
  button answered 422. That is a plain regression, not an unproven retry, and
  it is the reason these two surfaces now carry DOM tests asserting the exact
  HTTP body.

**A DROP + CREATE must restate the CURRENT definition of a trigger, never
the one in the migration that first created it.** 0056 recreated this
table's request-fields immutability guard from 0051's text and so silently
dropped the seven requisite columns 0052 had already added to it. The other
two guards do not cover the gap — they block `PENDING → PENDING` and updates
to an already-terminal row, while a resolution is
`PENDING → VERIFIED/REJECTED/STALE`, which both ignore by design. For the one
UPDATE this table legitimately accepts, that guard is the only thing between
a resolution and a rewrite of the evidence being resolved. The regression
suite is table-driven over every request-group column, plus a structural test
that reads the LIVE trigger out of `sqlite_master` and the LIVE column list
out of the table and requires every filed-evidence column to be named in the
guard — so the next stale recreate fails even if it is textually
self-consistent.

`RetainedIntentNotice`'s buttons are `type="button"`: it renders inside the
forms whose command it is about, and a bare `<button>` there would submit the
form as well, issuing a freshly-pinned second command beside the replay.

### Three corrections found while closing

**`placeLegalHold` moved key → name → key.** 0044's partial unique index on
`released_at IS NULL` refuses a *concurrent* second hold, which is not the
same as refusing a retry: a release is ordinary work, and after one,
`place → release → retried place` creates a second hold. The named refusal it
gained is still correct and stays; it is simply not a replay proof.

**Supersession submit needed a SECOND pin.** It was classified
`STALE_BOUND` on the verified legal-profile revision alone, which misses a
rejection: a rejection mints no revision, so the pin does not move, while the
"one PENDING per partner" slot it frees is the write precondition. Retrying A
after its request was refused would file a second request indistinguishable
from a deliberate one. 0056 adds the monotone per-partner request-chain head,
and a submit now pins both. The regression test for this had been passing for
the wrong reason — it called B a verification and retried with `pinA - 1`
instead of the original pin, so the refusal was guaranteed by the test rather
than by the command.

**Both ORD `submitted` routes moved STALE_BOUND → MONOTONIC.** The first pass
gave them a pin on the observed external id, on the theory that the row stays
MUTABLE until confirmation so a corrected re-submission is legal. It is not:
0048's `..._observed_id_immutable_guard` refuses any UPDATE that changes a
non-null `vk_external_id`, so no legal B* exists to pin against. What *was*
reachable is an `evidence_ref` overwrite, which a first-writer-wins branch now
refuses by name — the same shape the ERIR path in the same file already used.

### Regression shape

Every closed classification carries a test in one generic shape — `A`, then a
legal `B*` chosen to be the strongest attack on that class, then a retry of
the original `A` — asserting all three of:

1. no row created by B is overwritten,
2. no new row derived from A exists after B,
3. the current authority is still B's.

Plus the per-class assertion: `DURABLE_KEY` returns the byte-identical
original response; `STALE_BOUND` and `MONOTONIC_REPLAY_SAFE` refuse with
their named codes. The `B*` is deliberately the sequence that RESTORES the
surface condition the old classification relied on — a reactivation after a
suspension, a re-verification after a revocation, a revert back to the
content A itself wrote.

Three files: `agent-referrals-command-replay-stale-bound.test.ts`,
`agent-referrals-command-replay-monotonic.test.ts`, and
`apps/admin/lib/retained-command-intent.dom.test.tsx` for the client half.

The registry pins the **full sorted membership** of every proof class, not a
count: a count leaves two routes free to swap classes without CI noticing,
which after four rounds of this matrix moving is exactly the drift it exists
to stop.

## PR-C2 shape

**Step 2a — content-addressed no-change branches** on the revision chains.
This is content *coherence*, worth having on its own merits: it stops a
double click renumbering a chain and, in two cases, superseding evidence
something else already pointed at. **It is not a replay proof**, and the
routes it touched were closed by the pins above, not by it.

**Step 2b — durable command identity.** The shared admin helper over the
existing `admin_command_idempotency` taking an explicit `entityIdOf(result)`
selector (four of the commands return `{ activation_event_id }` /
`{ hold_id }` / `{ verification_event_id }` / `{ distribution_id }`, never
`id`), and `partner_command_idempotency` (migration 0054) keyed
`(partner_identity_id, command, key_hash)` — scoped to the identity, never
the session, so a retry survives a logout and a new login while staying
unreachable to anyone else.

In both realms, exact replay resolves **before** any mutable-state or gate
read, and the business writes plus the idempotency record share one
`BEGIN IMMEDIATE`.

---

# PR-C2 step 2b: durable command identity (design gate)

Ten routes remain. For each, an identical body can be a legitimate second
command, so only a caller-supplied key separates a retry from an intent.

## Partner realm: a new, principal-scoped table

```sql
CREATE TABLE partner_command_idempotency (
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  command             TEXT NOT NULL,   -- stable semantic name, never a URL
  key_hash            TEXT NOT NULL,   -- sha256 of the raw Idempotency-Key; the raw key is never stored
  request_hash        TEXT NOT NULL,
  response_status     INTEGER NOT NULL,
  response_json       TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (partner_identity_id, command, key_hash)
);
```

Scope is `partner_identity_id`, never `partner_session_id`: a retry must
survive logout, a new login and a new session belonging to the same partner,
and must be unreachable by any other partner. Partners are mutually
untrusted, which is why this namespace is stricter than the admin one below.

`response_status` is stored, unlike the admin table, so an exact replay
returns the original status as well as the original body (partner routes mix
200 and 201).

## Execution contract

```text
authenticate  →  partner_identity_id established   (key scope needs the principal first)

BEGIN IMMEDIATE
  lookup(partner_identity_id, command, key_hash)
    found, same request_hash       → return stored (status, body) verbatim
                                     BEFORE any business-state / gate / current-revision read
    found, different request_hash  → IDEMPOTENCY_CONFLICT 409, zero writes
    absent                         → validate current state
                                     execute
                                     persist durable facts
                                     persist (request_hash, status, body)
COMMIT
```

```text
same K + same body      → exact replay
same K + different body → 409
new  K + same body      → a genuinely new command   ← what these ten need
```

`request_hash = sha256(canonicalV2({ command, resource ids from the path, normalized body }))`.
`partner_identity_id` is not repeated inside the hash: the primary key
already scopes it, and duplicating it would only make the same fact fail in
two different ways.

## Admin realm: reuse, with one required change

`admin_command_idempotency` + `withAdminCommandV2Core` already implement this
contract, including `IDEMPOTENCY_CONFLICT` on a fingerprint mismatch and
`IDEMPOTENCY_CONTRACT_SUPERSEDED` for a record predating stored responses.
No new table.

But it cannot be reused unchanged. The helper is typed `T extends Row` and
does `String(created.id)` into a `NOT NULL entity_id` — and four of the six
admin commands return no `id` at all:

| command | result |
|---|---|
| `activateEngagement` | `{ activation_event_id, promo_authorization_id }` |
| `placeLegalHold` | `{ hold_id }` |
| `verifyAudienceForPartnerCity` | `{ verification_event_id, suspended_engagement_ids }` |
| `reportDistribution` | `{ distribution_id, revision }` |

The proposal is to take an explicit `entityIdOf(result)` selector rather than
widening `entity_id` to nullable: every one of these has a durable entity to
name, and keeping the column meaningful is worth more than a migration on a
table the whole commerce core shares.

One asymmetry, stated so it is a decision and not an accident: the admin key
namespace is `(command, key_hash)` — shared across admins, with `admin_id`
inside the fingerprint, so one admin reusing another's key with a different
body gets 409 rather than someone else's response. The partner namespace is
per-identity. That difference is deliberate.

## Client key lifetime

A persistent key lives until a **definitive outcome**, not until the HTTP
call returns:

```text
NETWORK_AMBIGUOUS            → retain (this is the case the key exists for)
authoritative refresh        → retain (a refresh is not an outcome)
success / exact replay       → rotate
definitive business refusal  → rotate, per the existing error classification
```

## Test invariants

1. `K1` commits, response lost, mutable state moves on, retry `K1` → original
   response, no new durable fact.
2. `K1`/body A then `K1`/body B → 409, zero writes.
3. `K1`/body A then `K2`/body A → the second command genuinely happens.
4. Partner A's `K1` and partner B's `K1` are independent namespaces.
5. Payout specifically: `set(K1) → R1`, response lost, refresh observes R1,
   retry `K1` → returns R1, mints **no** grant against R1, creates **no** R2.
