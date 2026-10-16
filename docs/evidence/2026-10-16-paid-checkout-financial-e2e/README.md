# ART-39 — one real closed course purchase and full refund

Status: **ART39_CLOSED_PAID_E2E_PASS**, 16 October 2026.

The owner separately authorized one real 100-kopeck purchase and one full
100-kopeck refund. The selected buyer completed the actual SBP checkout,
received the sale fiscal receipt and played the protected course video. The
same payment was refunded in full after viewing. The owner confirmed receipt
of the money and supplied the refund fiscal receipt. No second purchase or
financial refund submission was made.

This is closed-canary financial evidence. Public sales/F9 and production
acceptance remain closed. ART-338 remains Done. A further financial operation
requires a new owner instruction.

## Installed sources and independent artifact admission

| Role | Native source | Immutable image digest |
| --- | --- | --- |
| Commerce | `1f27cbd2e7470f394ad27d8ee624efb0b7cfa922` | `644709e5d4ef2a098af0356fafc96bd82746d968445d3ea441a17b271d2f42f6` |
| Platform | `8f8f3216dae5aeec1890662cf72aab1896e74d9a` | `133478c900d21be160c3bbd5ec24555f353494271e535ac4d171243dc65f172d` |
| Admin, retained | `08523bdf38eeddf5e745ce04d05e1f980a7ced93` | `85eadc71e50fdab0bc4d154a242a46188bd85bbe7f0edfed516f8863eb14dc77` |

Repositories are the corresponding private
`ghcr.io/artgurianov/flexperiment-{role}-v2` packages. Commerce's own merged
CI [38877558506](https://github.com/ArtGurianov/flexperiment/actions/runs/38877558506)
passed. Platform repair [PR244](https://github.com/ArtGurianov/flexperiment/pull/244)
passed exact-head CI38890053079 and its own merged-source
[CI38891065722](https://github.com/ArtGurianov/flexperiment/actions/runs/38891065722),
both test/docker-build SUCCESS. The reviewed head and merged trees match.

The buyer's first refund request exposed a missing Platform proxy path:
`/v1/refunds` returned `404 NOT_FOUND` before reaching Commerce. PR244 permits
only GET/POST on that exact customer collection, with the existing session,
origin, body and idempotency controls. Decision/execution paths stay in Admin.
All146 Platform tests, including51 proxy tests, typecheck and targeted ESLint
passed. Registry manifest/config, target digest pull, complete RootFS and
native source identity were independently checked on the VPS.

Only Platform was replaced. Commerce and Admin container identities, the
controller, SQLite/WAL lineage, schema27, credentials, fiscal policy and legal
evidence were preserved. The installed configuration matches all12 files of
the independently recovered candidate escrow. Private HTTPS GET/POST on the
refund collection now reaches Commerce and returns401 SIGN_IN_REQUIRED when
unauthenticated. The genuine buyer's retry with the same idempotency key
returned201 REQUESTED.

## Financial and access evidence

| Boundary | Observed result |
| --- | --- |
| Actual buyer checkout | Fresh handoff/return/preview,100kopecks, zero discount, explicit review.4 acceptance |
| Bank payment | Authenticated direct Tochka GET: APPROVED100kopecks, SBP, exact merchant/principal/operation bindings |
| Refref payment | Accepted SUCCEEDED Payment,100kopecks; fulfillment acknowledged |
| Commerce delivery | FULFILLED, one course entitlement and one initial-access audit |
| Playback | Owner confirmed real video playback; normal protected grants/DRM events recorded |
| Refund request | One genuine authenticated buyer request, then normal authenticated Admin approval and execution endpoints |
| Bank refund | Same operation's authenticated GET: REFUNDED, exactly one refund order for100kopecks |
| Refref refund | Accepted canonical Refund SUCCEEDED100kopecks, exact payment binding, remaining refundable amount0 |
| Commerce refund | Request/order/checkout REFUNDED, execution SUCCEEDED, entitlement revoked with reason REFUNDED |
| New playback | Normal runtime GRANT_DENIED after revocation; no synthetic grant was created for this check |

The Refref execution projection still uses `REFUND_PROCESSING` with a non-null
canonical refund ID. Terminal financial proof is that linked canonical
`Refund.status=SUCCEEDED`, matched to the original payment and amount; Commerce
consumes that fact. The projection label alone is not used as completion proof.

Observed UTC times: bank payment10:29:43, initial access10:29:58.786; bank refund
11:21:34, canonical Refund11:22:31.732, entitlement revocation11:22:57.806,
normal grant denial11:23:06.272. Bank times have second precision. These are
observations, not an atomic bank/access transaction or a latency guarantee.
The accepted MVP limitation on already-issued DRM licenses is unchanged.

## Fiscal receipts and legal scope

Exact approved review.4 remains active and unchanged: package SHA256
`f67033443312a368b42d2d114e6b775d0e96035e2bc4bdd5587e859a035bb86b`,
manifest `5ed1728066fff98efd001b1fa27bfab817252989cce9cf7f6f28099904b659a2`.
The genuine OwnerLegalDecision and QUALIFIED policy from the installed
preflight are retained. No counsel statement, consent or fiscal qualification
was fabricated or replaced for the money run.

The owner supplied both actual fiscal receipt texts and confirmed email
delivery. Both identify CIB, the seller as supplier,100kopecks, quantity1,
FULL_PAYMENT, SERVICE and no VAT. The sale is «Приход» and the refund is
«Возврат прихода». OSN appears in the agent's header; the seller's confirmed
USN_INCOME configuration was not changed.

Actual sale item: «Доступ к курсу «Test Course»». Actual refund item:
«Возврат Доступ к курсу Test Course, закрытая тестовая покупка». The refund
uses another CIB register. Exact byte equality of descriptions or register
identity is not claimed. Receipt coordinates, buyer details and bank operation
identities remain in owner-only evidence. No PDF signature or separate
authenticated OFD lookup was performed. This is functional receipt evidence,
not independent bank/FNS approval of the owner's legal classification.

## Final closure and recovery

The test offer is CLOSED with an empty acceptance allowlist; all other paid
offers remain CLOSED. The paid profile remains configured for reconciliation.
One payment and one refund are retained; no additional transaction is admitted.
The uncertain-operation envelope was purged by the normal terminal-refund path.

A fresh encrypted post-refund SQLite backup passed provider GET/hash,
independent off-host decryption and immutable isolated restore:

* Cipher SHA256: `3703a870100fe767f897f33f0bb3d257e95172ef50fb68729fe3508972b72453`,938408bytes.
* Restored snapshot SHA256: `d065f04d415abbd0aca0ed75dd2e60f876b9f1e6cb369d33e3b6e5bdea5c17dd`.
* Schema27 fingerprint: `b71a08d5f785b98516d4c2fbde8184d25bb91ce1b880d614d637be76876dd84f`.
* Recovered refunded order, successful refund, revoked entitlement, one initial
  activation, genuine post-refund grant denial, current legal/owner/fiscal
  evidence, buyer consents and all offers closed; owned plaintext removed.
* Current installed config escrow: cipher SHA256
  `31e1c933095724190ce30c0a382711e3efbcc97ea2e0af50b9234dd49b4a9081`,49784bytes;
  all12 files independently recovered and matched to installed bytes.

Final readiness/native-image admission, SQLite integrity/foreign keys, OPEN
erasure fence/sequence1/drained leases, four external403 guards and active
backup/freshness timers are checked independently of the owner's browser.

## Remaining product work

The owner selected a shared email/manual-Admin refund flow for courses and LAB.
The controlled console request in this test is not the intended customer UI.
See [the current comparison and target process](../../release/REFUND_FLOW.md).
Admin registration of an email-originated request and the next legal contact
revision remain in existing ART-224; no new issue or public activation follows.
