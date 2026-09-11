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

**`UNAUDITED` is zero and `REPEATABLE` is zero.** PR-C2 is complete: step 1
audited the whole published surface, step 2a closed the content-addressed
half with no-change branches, step 2b gave durable command identity to the
nine commands where an identical body can be a legitimate second command,
and one more turned out to need only a name. All four numbers are asserted
by the registry test.

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
