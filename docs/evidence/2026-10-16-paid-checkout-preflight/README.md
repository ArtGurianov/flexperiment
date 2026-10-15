# Real course checkout — read-only preflight, 16 October 2026

Result: **CONTROLLED_PAYMENT_PREPARATION_HOLD**. No payment session, bank charge or refund was created. This is the next ART-39 / ART-224 work item after final ART-338 closure, not another LMS qualification cycle.

The owner selected one `test-course`, one already-existing customer account and **100 kopecks (RUB1)**, followed by a full refund. The buyer address is retained privately; it must not enter Git, tracker comments or public receipts. Public sales and F9 remain closed. Test-course does not currently exist.

## Current evidence

Fresh read-only host/SQLite/PostgreSQL observations at17:05–17:11UTC on15October (16October client date):

| Boundary | Observed state | Meaning |
| --- | --- | --- |
| Installed LMS Commerce | source0d7dee0…, exact image650ec79b…, protected Kinescope, payments disabled | Working LMS retained; no real payment configured |
| Canary erasure admission | OPEN / sequence1 / owner null / leases0 | No current erasure blocker observed |
| Selected buyer | Existing customer account | Normal fresh login is still required after BOOT_RESTORE |
| Selected course | `test-course` absent | Must be authored/published with actual video before fulfillment proof |
| Current offers | All CLOSED; no payment purposes | Existing manual-access fixtures do not qualify checkout |
| Current fiscal policies | Zero | A quoted purchase has no offer-specific qualified fiscal item |
| Active COURSES legal release | `2026-10-15.closed-e2e`, Stage A | Four free-account documents; no paid offer/refund/receipt-contact release |
| Flexperiment Refref inputs/refund-envelope keyring | Absent | Enabling the rail is a separate configuration/install step |
| Refref canary and production | source202c0fb…, migration head25 | Do not repeat obsolete schema10/23 rollout instructions |
| Refref production Flexperiment Business | ACTIVE, one ACTIVE OWNER | Identity already exists; do not bootstrap another Business |
| Refref production acquiring connection | Tochka ACTIVE; sealed credential present; PRODUCTION profilev1; minimum100kopecks | Owner-selected amount equals the stored minimum |
| Latest stored capability snapshot | Payment/read/full refund true, partial refund false | Full-only profile; not a fresh authenticated bank probe |
| Refref production merchant enablement | Zero API keys, offers, campaigns, domain verifications | No usable merchant integration credential yet |
| Refref canary Flexperiment | ACTIVE Business/OWNER, no acquiring connection or API key | Merely probing canary Refref READY cannot qualify the production rail |
| Refref Flexperiment orders/payments/refund executions | None in both environments | No previous Flexperiment real order to reuse or refund |

Refref production uses one runtime with `REFREF_ACQUIRING=alfa,tochka`, per-connection routing. Recreating a bank connection or a second provider runtime is unnecessary. The capability/profile read does **not** prove fresh bank permission, fiscal receipt issuance or a completed payment.

Merged-main documentation CI38769364780 at49fc1c5… is now SUCCESS for both test and docker-build. The installed application source remains0d7dee0…, not that documentation SHA.

## Concrete engineering gaps before the selected payment

1. Platform's existing canary configuration and readiness explicitly require `PAYMENT_MODE=disabled`. A bare env switch makes this private storefront refuse readiness.
2. The installed fast-cut runtime/backup helper also requires disabled payments. Changing only the app env would invalidate runtime checks and normal backup admission.
3. Staging Commerce readiness permits only `canary-ops.refref.ru/readyz`. A private staging merchant using production Refref must qualify its **actual** dependency, with explicit pinned origin/environment binding; production merchant traffic must not be admitted by a successful canary-only probe.
4. Refref's deployed `provision-merchant enable-commerce` parser requires `acquiring.provider=alfabank`, and `provisionedBusiness` requires bootstrap provenance from that specific tool. Flexperiment instead has owner-identity bootstrap provenance and Tochka. A fake Alfa manifest or forged audit record is not a valid way to obtain the key.

These are implementation/provisioning tasks, not evidence that the buyer's card or bank request failed. No contract guard was removed or bypassed in this preflight.

## Smallest execution path

Use the current private LMS gateway with the production Refref Flexperiment connection and an explicitly scoped acceptance profile. Keep all public host guards and other offers closed. The detailed proposal, required owner facts and evidence sequence are in [the controlled checkout packet](../../release/ART-39_CONTROLLED_CHECKOUT.md).

A separate Refref-canary acquiring setup would duplicate bank/client/callback provisioning. A direct bank payment would omit the Refref merchant checkout, accepted Payment/Refund and fulfillment path we need to prove. Neither is a substitute for the proposed end-to-end run.

ART-39/224 own this experiment and its engineering preparation. ART-83 owns merchant enablement; ART-88/89 own real bank payment/refund evidence; ART-92/12 retain production conformance; ART-231/234 own paid legal/fiscal facts. ART-240 remains production acceptance with its separate gates. ART-338 stays Done; ART-36/351 and public F9 are not closed by this packet.

Sanitized evidence: [receipts.json](receipts.json). Raw read-only scripts/observations and owner input are kept under the private `art39-checkout-preflight-20261016` artifact directory. No secret, card field, cookie, signed payment URL or buyer email is included here.

## Subsequent document preparation — no runtime change

After this read-only observation the owner requested a minimal paid-test package, then confirmed USN_INCOME, continuing VAT exemption based on aggregate IP income in2025/2026, the IP registration address, FULL_PAYMENT and SERVICE. The [eight draft texts and fiscal proposal](../../legal/closed-paid-test/2026-10-16-draft/README.md) record those statements with their actual owner authority. No independent counsel/accountant conclusion is claimed.

Document bytes and SHA-256 values now exist; the initial inventory above remains the historical runtime observation. Exact-byte approval, real document hosting/read-back, legal-basis references and engineering preparation are still outstanding. No policy was created/qualified, legal release activated, merchant enabled, application installed, payment created or refund sent by this documentation step. ART-338 remains Done.
