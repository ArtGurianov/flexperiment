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

## Matrix

### Durable command identity — safe

| command | mechanism |
|---|---|
| `recordVerifiedTaxTreatment` | `admin_command_idempotency` + caller-supplied `Idempotency-Key`, resolved **before** any gate or mutable-state read (PR-F round 3) |

### Replay-safe by construction — safe

| command | mechanism |
|---|---|
| `offerEngagement` | `engagementByPartnerAndOccurrence` → `AGENT_REFERRALS_ENGAGEMENT_ALREADY_EXISTS` |
| `acceptEngagement` | existing acceptance row → `replayed: true` |
| `acceptSettlementAct` | existing acceptance → `replayed: true` |
| `acceptFrameworkAndDelegation` | exact-parameter replay → idempotent no-op, no writes |
| `preparePartnerSettlement` | `settlementForEffectiveSnapshot` → `replayed: true` |
| `activatePartner` and onboarding transitions | one-way edges + CAS on `onboarding_revision`; a retry finds the edge already taken |
| `submitLegalProfileSupersession` | partial unique index → `ALREADY_PENDING` |
| `verifyLegalProfileSupersession` | terminal-state replay contract → `REPLAYED`, resolved before every gate |
| `beginPayment` | unique active attempt → `ATTEMPT_ALREADY_ACTIVE` |

### Named refusal on retry — closed in PR-C

Both were raw `SqliteError`, i.e. a **500 for a command that had succeeded**.

| command | constraint | code |
|---|---|---|
| `provisionPartnerOwner` | `partner_identities.agent_id` UNIQUE | `AGENT_REFERRALS_PARTNER_ALREADY_PROVISIONED` |
| `createPartnerPromo` (same code) | `promo_codes.normalized_code` UNIQUE | `PROMO_CODE_ALREADY_EXISTS` |
| `createPartnerPromo` (different code, partner already has one) | `partner_promos.partner_id` UNIQUE | `AGENT_REFERRALS_PARTNER_PROMO_ALREADY_EXISTS` |

### Repeatable — **PR-C2 scope, rollout blocker**

Each mints a new durable fact on an identical retry.

| realm | command | what a retry creates |
|---|---|---|
| admin | `activateEngagement` | revokes the live promo authorization, mints a new one, writes a **second activation event** — and the final CAS succeeds against the revision the first attempt bumped. The heaviest of these: activation events are legal evidence, pinned by settlement and ORD. |
| admin | `authorizeCreative` | revokes the current authorization and inserts a new one even for the same creative revision |
| admin | `correctDistribution` | `revision + 1` plus a fresh classification event, with no same-content branch |
| admin | `mintCreativeRevision` | `revision + 1` |
| admin | `verifyAudienceForPartnerCity` | `aggregate_revision + 1`, new VERIFIED event |
| admin | `recordNpdStatusCheck` | `sequence + 1` |
| admin | `setAgentReferralsChannelPolicy` | `MAX(policy_revision) + 1` |
| partner | `setPartnerPayoutDestination` | `revision + 1` (see the grant note above) |
| partner | `revokePartnerPayoutDestination` | `revision + 1` |
| partner | `reportDistribution` | a **fresh distribution identity**, with its own compliance and ORD tail |
| partner | `submitPartnerLegalProfile` | re-accepts `PROFILE_SUBMITTED`, re-writes the draft and appends another `LEGAL_PROFILE_SUBMITTED` event. Reachable normally: the partner form stays on screen in that state after the refresh. |

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
