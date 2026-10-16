# Prepared V2 manual email refund flow

The owner selected `refunds@flexperiment.ru` → Admin registration → separate
decision → separate execution. The closed course payment/refund has already
completed; this product change does not authorize another financial operation.

The subsequent [ART-224 release packet](ART224_EMAIL_REFUND_RELEASE.md) and
[preparation evidence](../evidence/2026-10-16-art224-email-refund-preparation/README.md)
record the exact source, isolated course/LAB acceptance and remaining real-mail
and legal admission. They do not assert an installed common flow.

## Prepared implementation

Courses account and LAB V2 use one static `RefundContact` component. It requests
an email from the purchase account with an order reference and reason. Neither
surface exposes a bank-refund button or submits a financial operation.

In Admin's refund workbench, register the existing order reference, actual email
sender, message evidence reference, receipt time and optional request summary.
`POST /v1/admin/v2/refunds` requires the existing Admin session and origin/fence
checks. Commerce derives the customer from the paid order, matches the sender,
and records `REQUESTED`, email evidence and the true operator audit in a single
transaction. A reference to mail is not independent verification that it was
received: the authenticated operator remains responsible for that check.

No buyer session is created. Client-supplied customer, actor, outcome or amount
does not control registration. A retry retains the original body/key; conflicts
and another open request are refused. The form freezes ambiguous submissions,
refreshes the queue after success and never proceeds to approval/execution.
Existing customer API requests remain compatible but have no financial
self-service UI. Decision, full-refund execution, uncertain-result reconciliation,
receipt handling and entitlement revocation keep their existing authority.

Optional intake evidence is in the existing policy-facts JSON and Admin audit;
no schema migration, provider/credential change or legacy-order import is used.
The same registration works for courses and LAB V2 orders on their actual V2
payment rail; this does not qualify future LAB attendance/inventory or sales.

## Installation boundaries

PR #246 is merged as `1294b4faa9ae88f90293ee5b036238c272da3ce8` after green
exact-head `d30b0bf` CI 38898998158 (see the CI link in the retirement evidence).
This implementation is not installed by that merge.
The accepted closed-test legal review.4 still says `art@flexperiment.ru` and
must not be rewritten or have its consents transferred. Before publishing the
new flow, prepare/approve a subsequent legal contact revision and verify the
refunds mailbox can actually receive mail. The code cannot prove mailbox setup.

The historical LAB V1 at `flexperiment.ru/refund` was subsequently shut down
under separate owner authority. Its public routes now return static HTTP 410 and
execute no old token. Historical orders, accepted terms and settled financial
records remain in the original volume and encrypted archive; later cases use
original-provider lookup with fresh authority for any financial action.
No historical order is migrated into V2. See
[retirement evidence](../evidence/2026-10-16-lab-v1-retirement/README.md).
Public F9 remains closed.

Tracking remains in existing ART-224; ART-338 is Done. The completed financial
test is documented separately in PR245. Local/mock tests are not an additional
real LAB refund, mailbox-delivery proof or an installed common-flow acceptance.
