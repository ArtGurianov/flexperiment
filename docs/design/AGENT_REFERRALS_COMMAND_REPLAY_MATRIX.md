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
- **A CAS on a revision counter** refuses a *stale writer*; a retry is not
  stale, it re-reads the counter the first attempt bumped.

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

Classifications - these are the CURRENT seven, and they replaced an earlier
set (`REPLAY_SAFE`, `REPEATABLE`, `UNAUDITED`) that was defined against the
weak obligation. The rename is not cosmetic: `REPLAY_SAFE` asserted a
conclusion, while the three proof names each state WHY the conclusion holds,
which is what makes a wrong classification visible on inspection.

| value | meaning |
|---|---|
| `DURABLE_KEY` | exact replay through a caller-supplied command key, whatever B* did |
| `STALE_BOUND` | the request pins the predecessor/version it was made against, so a stale retry is refused rather than applied |
| `MONOTONIC_REPLAY_SAFE` | no legal B* can restore the command's write precondition |
| `NAMED_REFUSAL` | a repeat is refused with a named, catchable code, **and** no legal B* can restore the state that refusal depends on |
| `SPECIAL_RECOVERY` | the response carries a secret that is never persisted, so no idempotency mechanism can re-serve it |
| `NOT_A_BUSINESS_WRITE` | session / authorization plumbing |
| `UNPROVEN` | not yet proven against the criterion — **must reach zero before rollout** |

### Current state

**Proven: 18 routes. `UNPROVEN`: 62.** Both pinned by the registry test,
along with the membership of each proven class:

| class | admin | partner |
|---|---|---|
| `DURABLE_KEY` | 6 | 4 |
| `MONOTONIC_REPLAY_SAFE` | 4 | 2 (`/framework/accept`, `/invite/consume`) |
| `STALE_BOUND` | 2 | 0 |

The first write-up of this state said **16**, by counting the admin classes
and forgetting the two partner monotonic routes. That is exactly the
arithmetic a pinned total prevents, so the registry test now asserts the
total as well as the membership.

The 62 grew out of a corrected obligation, not out of a regression. The
previous count was measured against `A, immediate retry A`; re-measuring
against `A → B* → retry A` invalidated most of the state-gate and
current-row-equality classifications at once. Nothing in the code got worse -
what changed is what counts as a proof.

Worth naming specifically, because it inverts an earlier decision twice over:
`placeLegalHold` was first classified "needs a key", then reclassified to
"needs a name" because 0044's partial unique index on `released_at IS NULL`
refuses a second ACTIVE hold. Under the strong obligation it needs a key
after all - `place → release → retry place` creates a second hold, and a
release is entirely legal. The named refusal it gained is still correct and
stays; it is simply not a replay proof.

The `SPECIAL_RECOVERY` case is also still open: `/partners/:id/invite/reissue`
returns a raw token that is never persisted, so no idempotency mechanism can
re-serve the original after a lost response. A zero elsewhere does not cover
it, and the rollout gate is not closed until it has defined recovery
semantics - plausibly "an explicit recovery reissue atomically supersedes T1
and returns T2, leaving only T2 live", named and tested as such.

## PR-C2 shape

The remedy is not uniform, and was not forced to be.

**What steps 2a and 2b BUILT — mechanisms, not coverage.** Both steps are
implemented and shipped; neither is a claim that the routes they touched are
now proven. Step 2a added content-addressed no-change branches to the
revision chains (engagement, creative and its authorization, distribution
corrections in both realms, ORD provider profiles, framework/delegation
templates, channel policy, the partner's legal-profile draft). Step 2b added
durable command identity: the shared admin helper over
`admin_command_idempotency` with an explicit `entityIdOf` selector, and
`partner_command_idempotency` (migration 0054) keyed
`(partner_identity_id, command, key_hash)` so two partners picking the same
raw key are independent rather than in conflict.

**Where step 2a does NOT discharge the obligation.** Equality against the
CURRENT row is not a replay proof: after an intervening B the equality branch
does not fire at all, and `A → B → A` is frequently a legitimate revert -
back to the previous contract text, channel policy or campaign terms - so
content alone cannot separate a revert intent from a stale retry. Those
routes are content-*coherent*, which is worth having on its own merits, and
still `UNPROVEN`.

**The question each remaining route has to answer**, in this form rather than
as a reflex toward a key:

> Can a legal B* make the OLD request A a valid command against the NEW
> authority again?

- **No, and it can never be** → `MONOTONIC_REPLAY_SAFE`. A one-way edge, a
  consumed capability, a terminal row.
- **No, because A names the thing it was made against** → `STALE_BOUND`. A
  command that is naturally stale-bound should answer STALE rather than be
  handed a command identity; a key on top of it would only add a second way
  to say the same no.
- **Yes** → `DURABLE_KEY`. Only a caller-supplied key separates the retry
  from the intent.

`DURABLE_KEY` is the fallback, never the default: reaching for it first
hides the routes whose own semantics already answer the question, and every
key added is a key the client has to keep.

**Each closed classification carries a regression test in one generic shape**
- `A`, then a legal `B*` chosen to be the strongest attack on that class,
then a retry of the original `A` - asserting all three of:

1. no row created by B is overwritten,
2. no new row derived from A exists after B,
3. the current authority is still B's.

Plus the per-class assertion: `DURABLE_KEY` returns the byte-identical
original response; `STALE_BOUND` refuses with its named stale/conflict code;
`MONOTONIC_REPLAY_SAFE` refuses with the named code its one-way edge raises.

In both realms, exact replay must resolve **before** any mutable-state or
gate read, exactly as `recordVerifiedTaxTreatment` already does.

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
