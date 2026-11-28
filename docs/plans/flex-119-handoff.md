# FLEX-119 handoff · PR #289

The launch sequence is governed by [the native launch and fiscal profiles](../v2-merchant-schema.md#native-launch-and-fiscal-profiles-owner-decision-2026-11-22). First paid LMS uses Tochka acquiring with Tochka Cheki. LAB remains closed for sales until the Ferma profile has its own qualification. Native execution does not migrate an earlier RC.2 order.

## Verified in source and synthetic tests

- A native order, its consumed quote and sealed payment request commit together. A restart between commit and the first send can recover the same intent. Reconciliation cannot reopen a quote issued under a prior sales generation.
- Read-back recovers a buyer payment URL after a lost create response. It applies only a payment for the original order and never creates a replacement URL on the merchant's own authority.
- Refref historical read-back and refunds use their separate original executor. Historical payment recovery cannot initiate a new Refref charge in native mode.
- Ambiguous create and refund requests are replayed automatically only when the provider explicitly guarantees those replays. Tests establish both paths using synthetic providers.

## Before connecting Tochka Cheki

1. Pin an immutable execution and fiscal profile per order. Additive schema only. Keep the branch migration name in this PR until its clean integration candidate introduces the final number.
2. Qualify the merchant and receipt settings for an immediately delivered course with `FULL_PAYMENT`. Read the payment through its authenticated `operationId`. Before the operation id is known, correlate by the frozen `paymentLinkId`, expected merchant, amount and currency. A missing result in the list alone does not prove that a lost create was rejected. Treat the local checkout snapshot hash as merchant evidence unless the provider contract demonstrates an authenticated equivalent. [Create with receipt](https://developers.tochka.com/docs/tochka-api/api/create-payment-operation-with-receipt-acquiring-v-1-0-payments-with-receipt-post), [operation read-back](https://developers.tochka.com/docs/tochka-api/api/get-payment-operation-info-acquiring-v-1-0-payments-operation-id-get), [operation list](https://developers.tochka.com/docs/tochka-api/api/get-payment-operation-list-acquiring-v-1-0-payments-get).
3. Qualify full-refund read-back and the distinct refund receipt. Check the bank operation and the fiscal receipt independently. Historical October evidence is indexed in [paid-checkout financial E2E](../evidence/2026-10-16-paid-checkout-financial-e2e/README.md). The first direct native release requires its own FLEX-82 evidence.
4. Finish MY checkout against the admitted native payment and legal review contract. Keep the closed RC.2 acceptance route and historical operations intact.
5. Before paid LAB, wire closing receipt issuance to an explicit authorized operator command after the workshop and independent service evidence. The same command must not submit a bank charge. Reconciliation may continue an already accepted fiscal request. Keep this path disabled under Tochka Cheki.

The fake provider remains local/test only. This handoff changes source and tests. CUSTODY_IMPACT: NO.
