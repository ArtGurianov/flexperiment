# Installed V2 manual email refund flow

The owner selected `refunds@flexperiment.ru` → Admin registration → separate
decision → separate execution. The closed course payment/refund has already
completed; this product change does not authorize another financial operation.

The subsequent [ART-224 release packet](ART224_EMAIL_REFUND_RELEASE.md) and
[preparation evidence](../evidence/2026-10-16-art224-email-refund-preparation/README.md)
record the initial preparation. The [executed release evidence](../evidence/2026-10-16-art224-email-refund-release/README.md)
confirms the installed flow, approved/active review.5 and accepted nonfinancial
mail/live/isolated criterion. Public sales remain closed.

## Implemented process

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
The same handler covers course and LAB V2 order types. Positive LAB acceptance
used an explicitly synthetic order in an isolated copy, without a payment rail;
this does not qualify real LAB payments, attendance/inventory or sales.

## Installation boundaries

PR #246 is merged as `1294b4faa9ae88f90293ee5b036238c272da3ce8` after green
exact-head `d30b0bf` CI 38898998158 (see the CI link in the retirement evidence).
That merge alone did not install it; the subsequent ART-224 release now has
independent installation/read-back and recovery evidence.
Historical review.4 still says `art@flexperiment.ru` and remains unchanged. The
owner-approved review.5 is now published/active with refunds@ and REG.RU disclosure;
its HTTPS hashes and activation manifest were read back. The owner confirmed
receipt/reply and waived exact mail headers/time for this acceptance. No consent
was transferred or fabricated. Future cases retain the actual evidence fields.

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
real LAB refund or independent mailbox-delivery proof; installed acceptance is
reported through the explicitly accepted live/isolated split above.
