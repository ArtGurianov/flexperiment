# ART-39 — bounded installation preparation

**REVIEW PACKET / INSTALLATION HOLD / MONEY HOLD.**16October2026. This updates the current closed canary; it does not reopen ART-338, run the old ART-338 qualification matrix or authorize production/public sales. The owner-approved engineering scope includes preparing these artifacts. Final legal approval, admitted exact runtime and a separate owner1₽ GO remain necessary.

## Current concrete inputs

Host `flexperiment-vps`, existing stack `/opt/flexperiment-fast-cut-canary`, existing private input directory `/etc/flexperiment-fast-cut-canary`. Existing Commerce SQLite volume, WAL/data lineage, five erasure mounts, private gateway, network and timer units are retained. Do not run initial `prepare` or a generic deployment workflow to repurpose this stack.

| Role | Observed configured source | Immutable installed image digest |
| --- | --- | --- |
| Commerce | `0d7dee0c8352dfb6cc1ea8ca7850b5d03fa18309` | `ghcr.io/artgurianov/flexperiment-commerce-v2@sha256:650ec79b0f8c5eb0f89bb2e93ed674e5548cc54daf10a57a204ff125342566ab` |
| Platform | `2cb47c46ee3cca50546d327ae57245c85235c153` | `ghcr.io/artgurianov/flexperiment-platform-v2@sha256:379f43ad63f624ec2b4e83078688b9a9f3170f85e86c3aeb165cb649aab22ee3` |
| Admin retained | native source085; no SOURCE_COMMIT env expected | `ghcr.io/artgurianov/flexperiment-admin-v2@sha256:85eadc71e50fdab0bc4d154a242a46188bd85bbe7f0edfed516f8863eb14dc77` |

This is a fresh inspect/config observation, not new native-image qualification. All three containers were healthy. Fence was canary/OPEN/sequence1/no owner/zero leases. Payments disabled. Current database description is LISTED/projection2, no free preview; offer PAID/CLOSED/100kopecks/empty allowlist, zero orders/entitlements/fiscal policies for test-course. No new app install was performed.

Most recent existing backup status read SUCCESS, source0d7dee0…, SHA256 `14bc5697a7d55a81a5a8bf442006ea8902d4ec11f40ae3b95b0f9dc235a340e5`, size864664, status-file mtime18:15UTC15October. Both backup/freshness timers were active/waiting. That older archive is **not** proof of the subsequently corrected LISTED state or the future candidate; require a fresh verified backup before installation. No timer, transport, retention or historical ART-351 incident was changed by this packet.

## Merchant manifest and custody

Private owner artifact directory: `art39-checkout-preflight-20261016`, mode0700. Actual files are0600:

- `owner-identity-production.private.json`, independently copied from the pre-existing owner execution custody, not synthesized from database audit;
- `platform-production.private.json`, exact repository platform seed manifest;
- `owner-commerce-production.review-candidate.private.json`, SHA256 `ab8d370280650f6f898b0bb938251cf0be97bdf485813a71141601605ad64f91`;
- `owner-commerce-production-review.private.json`, strict parser and live read-only comparison receipts.

The candidate binds existing PRODUCTION Business/typed OWNER/database and independent owner manifest hash. Destination is exactly `https://canary-platform.flexperiment.ru`, only `/checkout/return`; both actual attribution handoff and payment success return use that path, then Platform verifies state and routes to the course. No broad `/courses` or `/` prefix is needed. Key scopes: `integrations:checkout`, `integrations:refund`, `integrations:fulfillment`. No evidence or partner scope is requested. One private unattributed campaign targets `course:test-course`, reward0; provider-verified payment/refund, no merchant-reported evidence. Its signed internal-regulation hash reference does not approve the customer's still-DRAFT paid terms. Review the exact candidate's zero-reward technical timing/classifier/refund-policy fields before immutable publication; it has not been admitted or executed.

Strict manifest parsers pass. A READ ONLY transaction under `refref_runtime` compared independent custody pins with the protected registry, one ACTIVE OWNER/Business and exact platform seed; all matched, no merchant keys/offers exist. This is no write or live provider permission proof. Existing production runtime source202c0fb…/schema25 and bank connection/profile/client/callback remain independent of the operator/controller source in Refref77.

Use only the reviewed exact operator build after its full CI and concrete-manifest admission. Key target is a new file in a canonical private UID-owned0700 custody directory, for example the prepared packet's proposed `/root/flexperiment-v2-owner/art39-checkout/merchant.key`; do not populate it by shell expansion or print it. The reviewed CLI exclusively creates0600/no-follow, fsyncs before COMMIT and verifies the existing key hash on READY replay. DNS_CHALLENGE_PENDING creates no key; publish only its actual returned TXT through the normal authorized DNS process, then replay identical manifest bytes. An uncertain capture/COMMIT answer is RECONCILE_REQUIRED, never a fresh-file retry. The [Refref77 runbook](https://github.com/ArtGurianov/refref/blob/2f9d13a9bf410d2c8ed1f0eda04f75658dc163f9/ops/runbooks/owner-commerce-enablement.md) defines the exact CLI and exit semantics.

Before runtime use, encrypt and escrow merchant key, handoff secret and refund-envelope keyring to actual independently retained owner recovery recipients. Independent off-host GET/decrypt/hash proof must cover the issued key and necessary refund recovery keys. Stage these only in Commerce owner custody; Platform gets no private buyer digest or secrets. No key/secret was generated or installed by this packet. A plan is not custody PASS.

## Complete the exact role vector before execution

The Flexperiment238 final source must include the buyer-route/Suspense repair and pass its own test/docker-build. A prior green head does not qualify this new source. Build/publish only Commerce and Platform from the admitted source, retain Admin above, and independently read registry manifest/config digest, architecture, native identity and RootFS on the actual VPS. CI's local test image tags are not immutable published artifacts. Never use the old ART-338 target or an inferred main image.

Freeze separately: reviewed host-controller SHA/helper hash; per-role application source/image/native descriptors; exact final paid legal version and `legalManifestHash`; actual production Refref runtime source; sole buyer digest; private merchant/custody receipt. The candidate target digests and final legal version/hash are currently unresolved, so no executable `release.json`/`paid-test.json` is issued. Missing values are HOLD, not placeholders to install. The [profile contract](ART-39_PRIVATE_CHECKOUT_PROFILE.md) lists exact required fields and per-role separation.

## Bounded sequence after installation admission

1. Fresh current role/vector/Compose/env/helper hashes, signed remote ledger/current fence and no owner/ACTIVE/UNKNOWN leases; preserve current DB, audit and all financial state. Unknown mutation or durable recovery takes precedence over main. Four external hosts must still403. No historical general LMS retest is needed.
2. Finish final approved paid bytes, actual fiscal recipients/retention and genuine qualification references. Serve real HTTPS documents and independently compare response hashes. Freeze Stage B and qualified offer-specific policy through normal Control Room operations; never substitute draft/internal-regulation evidence for paid qualification. If legal release is activated separately, record that authority and exact bytes explicitly.
3. Obtain a fresh encrypted, independently retrieved/decrypted/restored backup of current data. Record timer enabled/active state, isolate only these canary timers while their running service finishes, retain every predecessor archive and custody key.
4. Stage the exact reviewed host helper, release vector, native descriptors and [paid-test observer contract](ART-39_PRIVATE_CHECKOUT_PROFILE.md) root0600. Preserve network, TLS/legal/erasure mounts and existing secrets. Set only the matching scoped Commerce/Platform inputs; do not merely flip PAYMENT_MODE or change DEPLOY_ENV to production. No initial prepare, new admin password or stale DB import.
5. Replace Commerce once through existing Compose by exact digest (`--no-build --pull never --no-deps`), preserving data lineage. Normal verified BOOT_RESTORE owns admission/replay/session invalidation. Only after exact source/healthy/OPEN/drained read-back replace Platform once. Admin retained. Refused/uncertain boot means HOLD; no manual OPEN, blind restart or old DB overwrite.
6. Independently compare native sources/images/RootFS/env/profile/readiness and actual Refref source; schema/integrity/FK and signed erasure state; four403 guards. Produce a candidate-source matching backup and independent off-host restore/copied-fence admission proof. Restore only prior timer schedules and read back active/waiting/future trigger. No old-source status is sufficient.
7. Through normal Control Room set only `course:test-course` ACCEPTANCE_ONLY with the one verified allowlisted buyer/100kopecks; retain LISTED description and freePreview=false, all other paid offers CLOSED. No PUBLIC/sales activation. Recheck no existing test order/access/uncertain execution. Use genuine CAPTCHA/email login after BOOT_RESTORE.
8. **Before money:** actual buyer without entitlement opens the course via the private gateway, completes real production Refref handoff/return and obtains preview with100kopecks, real document links/contact. Buyer reviews documents and marks deliberate acceptance; stop before final payment-create while the separate owner money GO is absent. The isolated browser rehearsal is not this receipt. Only then follow [one paid/refund chain](ART-39_CONTROLLED_CHECKOUT.md), with card/OTP interaction performed by the owner.

After the experiment, close the sole offer and remove scoped refref admission coherently with disabled mode, while retaining financial/refund/audit/custody records and all erasure/recovery guarantees. Any ambiguous payment/refund must be reconciled by its original identifiers before shutdown; no repeat charge to resolve uncertainty. ART-39/83/224 and public gates close only on their own real exit evidence.
