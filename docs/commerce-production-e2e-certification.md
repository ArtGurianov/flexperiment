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

## Start

```bash
EXPECTED_SOURCE_COMMIT=<exact-deployed-SOURCE_COMMIT> ./certification.sh
```

It prompts for the Admin password, schedule/venue facts, then Customer name,
email, and date of birth. It opens the provider payment link locally without
printing or persisting it. The operator completes the payment and confirms
actual ticket-mailbox/ticket-page verification.

The certification proves exactly one local refund obligation and one local
refund command associated with the payment. It does not claim an unprovable
count of external provider HTTP transmissions.

## Interruptions and cleanup

After the first mutation a mode-`0600` JSON state file is retained in
`.certification-state/`. It contains IDs, phase markers, idempotency keys and,
only while an Admin mutation is in flight, its safe schedule/venue/reason JSON
body so the exact command can be replayed. It never contains a password,
cookie, customer email/name/date of birth, payment URL, ticket capability, or
provider credential. Before `POST /checkouts`, it also stores only a SHA-256
of the canonical checkout request; a resumed operator must re-enter matching
customer data before that same idempotent request is replayed.

```bash
./certification.sh --resume .certification-state/production-e2e-<run-id>.json
./certification.sh --cleanup .certification-state/production-e2e-<run-id>.json
```

Do not create a second checkout or refund after an ambiguous outcome. Resume
the existing order and use its evidence/reconciliation path. If a run is
interrupted after publication, close sales as soon as it is safe, then use the
explicit cleanup command. Cleanup is `PUBLISHED + OPEN → PUBLISHED + CLOSED →
HIDDEN + CLOSED`; it verifies the occurrence is `404` publicly and absent from
the public tour. It never deletes historical certification evidence.

## Evidence

Only a fully cleaned run writes a mode-`0600`, git-ignored redacted manifest
under `artifacts/certification/`. It contains safe IDs, normalized statuses,
legal/build evidence, and provider references. It excludes contact data,
capabilities, raw webhook payloads, cookies, and secrets.

`PASS` requires signed Tochka webhook evidence; confirmed payment, booking and
ticket; authenticated Unisender `DELIVERED` evidence for `TICKET`,
`BOOKING_CANCELLED`, and `REFUND_SUCCEEDED`; the customer-cancellation refund
path; and public cleanup. A timeout/ambiguous provider outcome is
`INCOMPLETE`, not `PASS`.
