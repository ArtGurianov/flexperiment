# Prepared V2 manual email refund flow

The owner selected `refunds@flexperiment.ru` → Admin registration → separate
decision → separate execution. The closed course payment/refund has already
completed; this product change does not authorize another financial operation.

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

This implementation is prepared for review. It is not installed by its PR.
The accepted closed-test legal review.4 still says `art@flexperiment.ru` and
must not be rewritten or have its consents transferred. Before publishing the
new flow, prepare/approve a subsequent legal contact revision and verify the
refunds mailbox can actually receive mail. The code cannot prove mailbox setup.

The serving historical LAB V1 at `flexperiment.ru/refund` has a customer
confirmation/self-service branch and a manual `art@flexperiment.ru` branch.
Historical orders, accepted terms, pending email capabilities and refund
obligations remain on that system/provider. No historical route or financial
obligation is disabled or migrated by this change. Public F9 remains closed.

Tracking remains in existing ART-224; ART-338 is Done. The completed financial
test is documented separately in PR245. Local/mock tests are not an additional
real LAB refund, mailbox-delivery proof or an installed common-flow acceptance.
