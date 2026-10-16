# ART-39 — separate account consent and purchase acceptance

**PROPOSED MODEL / FINAL LEGAL APPROVAL AND PAYMENT HOLD.**16October2026.
Source reviewed: `a548774692fa8a9b50fe8da02890e913857537d3` (merged PR238).
This records the installation packet's proposed procedure; it neither approves
new legal bytes nor changes the existing DRAFT package/hash.

## Proposed model for the single closed purchase

Retain a separate `personal_data` action for the specifically approved account
operations, with the final document defining purposes, recipients and duration.
Necessary purchase/receipt operations must have their confirmed contractual or
statutory basis in the final documents; do not broaden account consent to cover
every operation. Do not infer that buying, providing a receipt email or accepting
purchase terms grants optional marketing permission.

The existing authenticated account form can supply the separate action:

1. After separately authorized publication/activation of final Stage B bytes,
   the buyer opens `/account` and reviews the actual final documents.
2. `AuthenticatedConsentGate` has separate `personalDataConsent` and
   `accountTermsAccepted` checkboxes. Marketing is optional and remains false for
   this experiment. The normal session-derived `POST /v1/me/consents` records an
   action and an individual `personal_data` event with its document version/hash.
   Do not insert or manufacture acceptance evidence.
3. Before financial admission, independently verify the actual buyer,
   `verifiedAccount=true`, `requiredChoicesConfirmed=true`, the current release
   ID/version/manifest hash and granted `personal_data` event for the final bytes.
   Recheck after changing the release or account. Earlier free-access acceptance
   does not qualify a different release: `authenticatedConsentStatus` checks all
   those bindings.
4. The checkout checkbox separately accepts purchase/refund terms and
   acknowledges the data/receipt information. Its `PAID_CHECKOUT_TERMS_ACCEPTED`
   event is evidence of that purchase action, **not independent PD consent**.

## Current implementation limit

At this source, `CourseCheckout` is not wrapped in
`AuthenticatedConsentGate`; `POST /v1/checkout/preview` and
`POST /v1/checkout` do not call `hasRequiredAccountConsents`. The existence of the
account form therefore does not prove that a buyer completed it before payment.
The read-back above is a mandatory separate pre-payment gate for the proposed
single-buyer procedure. It is not an automatic server guard. If final legal
approval requires that guard, implement and qualify it before payment rather
than declaring the current runtime compliant.

The final model, actual recipients/retention and exact legal bytes remain
unapproved. [The DRAFT legal package](../legal/closed-paid-test/2026-10-16-draft/README.md)
and [installation packet](ART-39_INSTALL_PACKET.md) retain their HOLDs. No claim
that the present checkout checkbox proves all consents is made.

Code traced: `apps/platform/components/auth/AuthenticatedConsentGate.tsx`,
`apps/platform/components/checkout/CourseCheckout.tsx`,
`commerce-v2/src/authenticated-consents.ts`, `commerce-v2/src/app.ts` and
`commerce-v2/src/checkout.ts`. This is a code/procedure review, not a real buyer
acceptance receipt or legal opinion.
