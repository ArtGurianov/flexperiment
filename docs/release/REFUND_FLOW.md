# Common refund intake for courses and LAB

Owner decision, 16 October 2026: customer email to **refunds@flexperiment.ru**,
followed by Admin registration, a separate reasoned decision and separate
financial execution. Customers receive email instructions. The administrator
verifies the actual request and purchase before acting.

## Current installed state

| Surface | Actual behavior |
| --- | --- |
| Former LAB V1 at `flexperiment.ru`, API and old Admin | Retired. All legacy public paths return static HTTP 410 without token execution. V1 frontend, Commerce HTTP/worker and old Admin are stopped. Support retains the existing `art@flexperiment.ru` contact. |
| Closed courses V2 | No customer financial-refund UI. The authenticated customer request API creates a case; normal Admin decision and execution remain separate. The installed Admin has no email-registration form yet. |
| Closed LAB V2 | Read-only catalogue/account/history, purchases closed. Historical V1 consumers are absent. |
| Prepared common V2 intake | PR #246 is merged after green CI, with one shared contact component and an Admin email-registration form/endpoint. It is not installed. Mailbox delivery, the next approved legal contact revision and normal installation admission remain required. |

[LAB V1 retirement](../evidence/2026-10-16-lab-v1-retirement/README.md) is actual
execution under the owner's later directive. It supersedes the earlier
instruction to preserve public V1 compatibility. The original ledger has only
owner-confirmed test buyers and no outstanding financial work; its encrypted
archive was independently restored. No historical order was migrated into V2.

For historical reference, the old LAB used order number + CAPTCHA, a purchase-
email confirmation link, then an eligible full-refund worker path without an
individual Admin decision. Its immutable implementation remains at
[serving source 3ad07cf](https://github.com/ArtGurianov/flexperiment/tree/3ad07cfcb53e861fc481c44d806b91743eb239c6/app/refund).
Those public routes and token execution are now disabled. A later real case is
looked up through the archived original provider/ledger with fresh authority
for any new financial action; it does not become a fabricated V2 request.

## One V2 product process

1. Customer surfaces show the same contact and ask for an email from the purchase
   account, an order reference when available and a reason. No automatic
   financial action is exposed.
2. Admin registers the actual received request against the existing order,
   preserving its message evidence reference, receipt time and real operator.
   Customer identity is derived from the order. A matching typed sender field
   or message ID is not proof of ownership; the operator checks the actual mail
   and purchase. Mailbox parsing and automatic approval/execution are outside
   this process.
3. The administrator reviews the applicable product/offer policy and payment
   state, then records a reasoned approval or rejection. Equal intake preserves
   course/event-specific eligibility. The present V2 rail executes full refunds.
4. A separate Admin action executes the approved amount through the order's
   actual financial lineage. Ambiguous results are reconciled against that same
   operation; a new identity is not a timeout recovery.
5. Bank result, fiscal return receipt and resulting course access or event state
   are recorded separately. Customer communication follows the confirmed result.

The authenticated customer `/v1/refunds` registration API stays compatible and
creates a case only. The email/manual UI is the selected product journey; it is
not the sole technically possible case-entry path. Approval and bank execution
remain separate authority in every path.

## Existing work and publication boundary

Keep this work in ART-224. [Prepared implementation](MANUAL_EMAIL_REFUND_INTAKE.md)
is merged, but the installed runtime still needs its release. The exact accepted
closed-test review.4 says `art@flexperiment.ru` and remains immutable evidence of
the completed purchase. Do not transfer its consents to a new hash. Verify real
receipt at `refunds@` before publishing that contact and approve the subsequent
legal revision through the genuine process.

The release acceptance is actual email receipt → Admin registration → a separate
decision **without a financial execution in the acceptance scenario** → saved
message/operator evidence. Historical V1 remains stopped and archived. Another
real payment/refund is not needed or authorized.

The closed course [100-kopeck payment/refund](../evidence/2026-10-16-paid-checkout-financial-e2e/README.md)
is already verified. ART-39/83/338 remain Done; ART-36/351/F9 and public production
acceptance remain separate. No new Linear issue follows from this document.
