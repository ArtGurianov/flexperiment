# Production E2E certification v2

`certification.sh` is the controlled production proof for the current Tochka,
Unisender, Customer/Participant, cancellation, refund-obligation, and cleanup
paths. It is not a smoke test and creates one real 1-RUB order.

## Preconditions

- Commerce exposes authenticated `GET /v1/admin/system/evidence` and
  `GET /v1/admin/orders/:id/evidence` on `admin.flexperiment.ru`.
- The deployment injects the trusted `SOURCE_COMMIT` value.
- The operator has confirmed the active provider/webhook configuration and has
  a real mailbox and payment method available.
- The canonical `kemerovo` city already exists. The script never creates it.

The script reads public data only from `https://api.flexperiment.ru`; the
website origin is not an API proxy.

The Admin-password and checkout PII request bodies are passed to `curl` on
standard input, never as curl command-line arguments. The script also performs
a best-effort short-timeout Admin logout in its exit trap; logout failure does
not change the certification result.

Before every recovery of an interrupted Admin operation, before checkout
creation, before customer cancellation, and before `PASS`, it verifies the
same deployed source commit, migration head, legal release ID/version, and all
four legal document hashes. A mismatch is `INCOMPLETE`; it never replays a
pending operation on a changed baseline.

## Start

```bash
EXPECTED_SOURCE_COMMIT=<exact-deployed-SOURCE_COMMIT> ./certification.sh
```

It prompts for the Admin password, schedule/venue facts, then Customer name
and email. It opens the provider payment link locally without
printing or persisting it. The operator completes the payment and confirms
actual ticket-mailbox/ticket-page verification.

The certification proves exactly one local refund obligation and one local
refund command associated with the payment. It does not claim an unprovable
count of external provider HTTP transmissions.

## Interruptions and cleanup

After the first mutation a mode-`0600` JSON state file is retained in
`.certification-state/`. It contains IDs, phase markers, idempotency keys and
only an allowlisted pending-operation enum. Occurrence creation additionally
stores its safe schedule/venue body until its returned ID is checkpointed; all
other Admin request bodies are reconstructed by the script. It never contains a password,
cookie, customer email/name, payment URL, ticket capability, or
provider credential. Before `POST /checkouts`, it also stores only a SHA-256
of the canonical checkout request; a resumed operator must re-enter matching
customer data before that same idempotent request is replayed.

The pending-operation allowlist is phase-bound: create only from `NEW`,
publish only from `OCCURRENCE_CREATED`, open-sales only from
`OCCURRENCE_PUBLISHED`, and customer cancellation only after ticket-email
delivery. Before a replay, the script independently proves the canonical
Kemerovo/1-RUB occurrence or the order-to-booking linkage. A saved operation
is therefore not authority to target a different entity.

Before the first close/hide mutation, the script persists
`SALES_CLEANUP_STARTED_AT`. This is monotonic even if the process crashes while
cleanup is partially complete: it permanently prohibits create/publish/open
for that run. `SALES_CLEANED_AT` is recorded only after fresh Admin/public
proof of `CLOSED + HIDDEN`. Cleanup first proves the target's exact stable
certification identity, so an edited state file cannot close an arbitrary
production occurrence.

```bash
./certification.sh --resume .certification-state/production-e2e-<run-id>.json
./certification.sh --cleanup .certification-state/production-e2e-<run-id>.json
```

Do not create a second checkout or refund after an ambiguous outcome. Resume
the existing order and use its evidence/reconciliation path. If a run is
interrupted after publication, close sales as soon as it is safe, then use the
explicit cleanup command. Cleanup is `PUBLISHED + OPEN → PUBLISHED + CLOSED →
HIDDEN + CLOSED`; it verifies the occurrence is `404` publicly and absent from
the public tour. It never replays a pending operation in cleanup mode, does
not overwrite the financial workflow phase, and never deletes historical
certification evidence. A normal run records `OCCURRENCE_CLEANED` separately,
then atomically writes the manifest and marks itself `COMPLETE`; a crash in
between resumes from that cleanup checkpoint. A later normal resume refuses a
pre-checkout phase or pending catalog-opening command after emergency cleanup,
so cleanup cannot be undone by a stale replay. Post-dispatch payment, booking
cancellation, and refund recovery remain resumable while the occurrence stays
hidden; inventory is read through authenticated Admin occurrence evidence, not
a public detail endpoint that correctly returns `404` for hidden occurrences.

An interrupted `CHECKOUT_CREATED` run can reopen only the same provider link
through the saved quote, idempotency key, and re-entered matching checkout
request. The URL itself is never saved or printed.

## Evidence

Only a fully cleaned run writes a mode-`0600`, git-ignored redacted manifest
under `artifacts/certification/`. It contains safe IDs, normalized statuses,
legal/build evidence, and provider references. It excludes contact data,
capabilities, raw webhook payloads, cookies, and secrets.

`PASS` requires signed Tochka webhook evidence; confirmed payment, booking and
ticket; authenticated Unisender `DELIVERED` evidence for `TICKET`,
`BOOKING_CANCELLED`, and `REFUND_SUCCEEDED`; the customer-cancellation refund
path; exactly one fulfilled customer-cancellation refund obligation and one
linked 100-kopek successful refund with a provider reference; a final
`REFUNDED` payment; and fresh Admin/public cleanup proof immediately before
the atomic manifest write. It also proves the adult self-participant
path through redacted order evidence, binds every order/payment/booking/ticket
ID to the current status/occurrence, and rechecks unique `DELIVERED` Unisender
evidence for all three transactional emails. The operator's ticket-page
verification is persisted before cancellation and recorded without PII in the
manifest. A timeout/ambiguous provider outcome is `INCOMPLETE`, not `PASS`.
The manifest is validated as one object with the exact occurrence ID and final
`CLOSED`/`HIDDEN`, cancellation, refund, and payment statuses before its atomic
write.
