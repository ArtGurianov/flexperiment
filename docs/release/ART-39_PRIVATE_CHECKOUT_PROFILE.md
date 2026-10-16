# ART-39 — private paid-checkout profile

**INSTALLED / BUYER PREFLIGHT PENDING / MONEY HOLD.** See [installed evidence](../evidence/2026-10-16-paid-checkout-installed/README.md). The existing canary has the exact review.4 profile, qualified owner-backed policy and only the selected ACCEPTANCE_ONLY offer. This is not public sales admission or permission to charge; ART-338 stays Done.

## Exact configuration to review before installation

Common Commerce/Platform values:

| Variable | Required value |
| --- | --- |
| `CLOSED_PAID_TEST_PROFILE` | `art39-test-course-rub1-v1` |
| `DEPLOY_ENV` / `PAYMENT_MODE` | `staging` / `refref` |
| Four first-party origins | Existing `https://canary-{platform,lab,admin,api}.flexperiment.ru` origins |
| `MARKETING_BROADCASTS_ENABLED` | `false` |
| `REFREF_API_BASE_URL` | `https://api.refref.ru/v1-rc` |
| `REFREF_CHECKOUT_ORIGIN` | `https://checkout.refref.ru` |
| `REFREF_READINESS_URL` | `https://ops.refref.ru/readyz` |
| `CLOSED_PAID_TEST_REFREF_SOURCE` | Actual independently verified production Refref source,40lower-case hex; no placeholder/default |
| `CLOSED_PAID_TEST_LEGAL_VERSION` | Actual final approved Stage B version; not the draft filename |
| `CLOSED_PAID_TEST_LEGAL_SHA256` | `legalManifestHash` of the active final manifest including real served URLs/versions/document hashes; not PACKAGE_SHA256 |

Commerce additionally needs `CLOSED_PAID_TEST_BUYER_SHA256` = SHA-256 of the selected existing customer's normalized lowercase trimmed email, `KINESCOPE_DELIVERY_MODE=protected`, `COMMERCE_V2_ENVIRONMENT=canary`, `ERASURE_SCOPE=canary`, `ERASURE_FENCING_ENABLED=true`. Derive the digest from private owner custody and compare it with the actual verified account; do not put buyer email/digest in Git or logs. Keep the actual merchant ID/slug/key, handoff secret and refund-envelope keyring in runtime-only owner custody. Provider bank credentials remain only in Refref. Platform gets common non-secret identity inputs, not the buyer digest/API key/handoff secret/refund keys.

Do not merely set PAYMENT_MODE. The profile refuses another environment, origin, unprotected video, missing buyer/legal pin or disabled erasure. At checkout it requires exactly `ONLINE_COURSE`, PAID, `test-course`, `course:test-course`,100kopecks, ACCEPTANCE_ONLY and one matching allowlisted buyer. Current qualified policy must say `Доступ к курсу «Test Course»`, USN_INCOME/NONE/FULL_PAYMENT/SERVICE. Other paid offers remain CLOSED. No PUBLIC activation, LAB or bundle sale. Price/promotion changes refuse. One existing order for this offer prevents a second experiment; preserve its retries/reconciliation instead of creating another.

The buyer sees the exact paid document links and receipt email. One explicit checkbox records acceptance with the order; account consent or a legal-release row alone cannot substitute. If conditions/contact change, the confirm refuses. No acceptance, grant or provider status may be hand-minted.

That checkout action is purchase acceptance, not independent PD consent. The
[separate account-consent procedure](ART-39_CONSENT_DECISION.md) requires
its own final-document action and pre-payment read-back. The installed server guard enforces current, verified account choices before
handoff, preview and confirm/replay, with a transactional check before order creation.
It requires the exact legal pins and does not record consent on the buyer's behalf.
It is installed from1f27cbd2; the earlier a548774 image pair is superseded. Exact
review.4 is approved and active; real buyer evidence and financial GO remain required.

The course description must be LISTED, without free preview: an unentitled buyer cannot reach CourseCheckout on an UNLISTED course. Keep CLOSED during preparation; only eventual accepted runtime admits ACCEPTANCE_ONLY. Follow the [concrete preparation/install packet](ART-39_INSTALL_PACKET.md).

## Host observer and backup compatibility

The reviewed root-owned0600 `/etc/flexperiment-fast-cut-canary/paid-test.json` has exactly these fields: `schema`=`flexperiment.closed-paid-test/1`, `profile`, `courseRef`=`test-course`, `offerRef`=`course:test-course`, `amountKopecks`=100, `buyerEmailSha256`, `refrefSourceCommit`, `legalVersion`, `legalManifestSha256`. Values must match the common/private runtime inputs above. Unknown/duplicate keys, symlink/hardlink/wrong ownership/mode, wrong amount/identity and drift refuse. The file is an observation contract and belongs to the concrete controlled-install packet; it is not created by this PR. Without it, fast-cut readback/backup still requires disabled payments. Original `prepare` remains disabled-only and does not import Refref secrets.

Install the exact reviewed helper alongside a per-role `release.json`, immutable source/image/native identity proofs and matching env. No env/profile file alone grants erasure authority. Follow normal admission and existing independent backup/restore requirements for the actual installation; don't run a new general LMS qualification cycle. Keep public403 guards and timer schedules. Remove the profile coherently with disabled runtime at experiment shutdown, keeping secret recovery and financial/audit records intact.

## Remaining gates

Refref's [owner-commerce engineering PR77](https://github.com/ArtGurianov/refref/pull/77) supplies a provider-neutral enablement path for the existing signed OWNER. Enablement is READY and the one key, actual policy mapping and independent recovery are confirmed in [installed evidence](../evidence/2026-10-16-paid-checkout-installed/README.md). Preserve that existing manifest and key. No fake Alfa manifest, duplicate Business or bank reprovisioning.

Review.4 publication and owner-backed qualification are complete. Fresh buyer PD/account consent and genuine handoff/return/preview are still required. Only after separately authorized money action may the owner perform card/SBP interaction. No card/OTP data is handled by the agent. [ART-39 execution steps](ART-39_CONTROLLED_CHECKOUT.md) remain authoritative for payment, receipt, entitlement, playback, full refund, refund receipt and access revocation.
