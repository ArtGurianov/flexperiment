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

**Proven: 16 routes. `UNPROVEN`: 62.** Both pinned by the registry test, along
with the membership of each proven class.

That number grew when the obligation was corrected, and the growth is the
honest outcome rather than a regression. The previous `REPEATABLE = 0` was
measured against `A, immediate retry A`; re-measuring against
`A → B* → retry A` invalidated most of the state-gate and current-row-equality
classifications at once. Nothing regressed in the code - what changed is what
counts as a proof.

Worth naming specifically, because it inverts an earlier decision: under the
weak obligation `placeLegalHold` was reclassified from "needs a key" to "needs
a name", since the partial unique index refuses a second ACTIVE hold. Under
the strong one it needs a key after all - `place → release → retry place`
creates a second hold, and a release is entirely legal.

The `SPECIAL_RECOVERY` case is also still open: `/partners/:id/invite/reissue`
returns a raw token that is never persisted, so no idempotency mechanism can
re-serve the original after a lost response. A zero elsewhere does not cover
it, and the rollout gate is not closed until it has defined recovery
semantics - plausibly "an explicit recovery reissue atomically supersedes T1
and returns T2, leaving only T2 live", named and tested as such.

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

**Step 2b — done.** Where repeating the same body **can** be a deliberate new
command, only a caller-supplied command key can tell a retry from an intent,
because no content comparison can. Admin commands use the existing
`admin_command_idempotency` through a shared helper taking an explicit
`entityIdOf` selector; partner commands use `partner_command_idempotency`
(migration 0054), keyed `(partner_identity_id, command, key_hash)` so two
partners picking the same raw key are independent rather than in conflict.
Closed this way:

- `activateEngagement` — re-activating onto the same revision after a genuine
  suspension is a real business action.
- `recordNpdStatusCheck` — a fresh check with the same status is the point;
  freshness is what the payment guard consumes.
- `verifyAudienceForPartnerCity` — re-verification after a revocation is
  legitimate, and it has no guard of its own (unlike its revoke twin).
- `reportDistribution` (both realms) — each call is a new distribution
  identity by design.
- `mintRetentionPolicyRevision` — a restated policy is a governance act.
- partner payout set / revoke, partner NPD receipt evidence.

**One reclassification, found by the invariant matrix rather than by
review.** `placeLegalHold` was on this list and does not belong on it:
0044's `partner_identity_legal_holds_active_unique` is a PARTIAL unique index
on `released_at IS NULL`, so a partner can carry at most one ACTIVE hold and
a retry cannot create a second. It met that index as a raw `SqliteError` —
a 500 for "already on hold" — so it needed a named refusal, not a command
identity. Placing another hold after a release stays legal, exactly as the
partial predicate says.

Admin realm can reuse `admin_command_idempotency` directly. The partner realm
needs a principal-scoped equivalent — a partner must not be able to replay
another partner's command key. In both realms, exact replay must resolve
**before** any mutable-state or gate read, exactly as
`recordVerifiedTaxTreatment` already does.

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
