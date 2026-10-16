# Common refund intake for courses and LAB

Owner decision,16October2026: the customer writes to
**refunds@flexperiment.ru**. An administrator verifies the purchase, records the
request, decides it and separately executes an approved refund in Admin.
Customers do not receive a financial self-service refund button. A submitted
request is not itself a bank refund.

This is the approved target. The currently installed product flows differ.

## Verified current behavior

| Surface | Customer intake | Decision and financial execution |
| --- | --- | --- |
| Existing LAB V1, `flexperiment.ru/refund` | Order number + CAPTCHA → confirmation link to the purchase email | Eligible confirmation before the one-hour cutoff cancels participation, voids the ticket and creates a full-refund obligation; worker submits/reconciles without an individual Admin decision |
| Existing LAB V1, manual branch | Contact shown as `art@flexperiment.ru`; Admin order has a compensation-refund action | Administrator enters amount/reason/note; the worker executes and reconciles through the historical provider |
| Closed courses V2 | No customer refund UI; an authenticated customer request API exists | Separate authenticated Admin decision and execution; accepted canonical Refref Refund ends the purchased entitlement |
| Closed LAB V2 | Read-only catalogue/account/history, purchases closed; no refund consumer in its UI | Shared V2 case/decision/execution foundation exists, but an email-originated request cannot yet be registered through Admin UI |

The existing LAB page was observed in a real browser on the actual public
`flexperiment.ru` host. Read-only router/image/source inventory identifies
frontend and Commerce source `3ad07cfcb53e861fc481c44d806b91743eb239c6`.
The immutable implementation is
[request/confirmation UI](https://github.com/ArtGurianov/flexperiment/tree/3ad07cfcb53e861fc481c44d806b91743eb239c6/app/refund)
and [refund domain](https://github.com/ArtGurianov/flexperiment/blob/3ad07cfcb53e861fc481c44d806b91743eb239c6/commerce/src/domain/refunds.ts#L159).
The similarly named `lab.flexperiment.ru` host returned «no available server»;
it was not treated as the serving historical LAB. No order number, CAPTCHA,
confirmation capability or financial operation was submitted during this review.

V2's `apps/lab-v2/components/LabV2Client.tsx` explicitly excludes legacy refund
consumers. `apps/admin/components/v2/ControlRoomV2.tsx` can decide/execute an
existing request, but has no form to register a request received by email.
The course's closed financial test used the authenticated request API under
owner operation, then normal Admin endpoints. It does not qualify mailbox
intake or a complete email-to-Admin customer journey.

## One target process

1. Course and LAB customer surfaces show the same contact and request wording:
   email `refunds@flexperiment.ru` from the purchase account, with the order
   reference when available. No automatic financial action is exposed.
2. Admin registers the actual received request against its existing order,
   retaining the email evidence reference, operator identity and idempotency.
   Customer identity is derived from the order; no forged customer session is
   created. Mailbox parsing, automatic approval and automatic execution are not
   part of this decision.
3. The administrator reviews the applicable offer/product policy and payment
   state, then records a reasoned approval or rejection. Equal intake does not
   imply equal course/event refund eligibility or change published terms.
   The present V2 rail executes full refunds only.
4. A separate Admin action executes the approved amount through the order's
   actual financial lineage. Ambiguous results are reconciled against the same
   operation; a second submission/new identity is not a timeout recovery.
5. Bank result, fiscal return receipt and the product's resulting access or
   participation state are recorded separately. Customer communication follows
   the confirmed result.

## Existing work and release boundaries

Keep this work in ART-224, related to ART-39/83; no new Linear issue is needed.
The missing Admin email-request registration is a concrete implementation gap.
The customer contact belongs in both next customer surfaces and their next
approved legal release. The exact accepted closed-test review.4 currently says
`art@flexperiment.ru` and remains immutable evidence of the completed purchase.
The mailbox's ability to receive messages has not been tested by this review.

V1 is retired and retains historical orders, tickets, confirmation capabilities
and refund obligations. This comparison does not authorize changing its live
contracts, migrating orders into V2 or disabling an outstanding historical
confirmation path. Historical financial operations retain their original
ledger/provider. Future V2 intake and Admin behavior should share the process
above, with product-specific policy evidence.

The real100-kopeck course purchase/refund is
[separately verified](../evidence/2026-10-16-paid-checkout-financial-e2e/README.md).
LAB was inspected read-only; no real LAB payment/refund or public launch is
claimed. ART-338 remains Done; ART-36/351/F9/production gates are unchanged.
