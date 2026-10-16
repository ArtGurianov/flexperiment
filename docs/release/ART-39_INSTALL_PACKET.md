# ART-39 — bounded installation preparation

**Current, 16 October 2026: ART39_INSTALLED_READY_FOR_MONEY_GO / MONEY HOLD.**
See [installed evidence](../evidence/2026-10-16-paid-checkout-installed/README.md) for actual merged sources/images, review.4 publication, owner-backed
fiscal qualification and independent recovery. The preparation statements below
are historical; they do not describe the installed runtime. Separate financial
GO remains mandatory.

## Historical preparation record

**HISTORICAL a548774 PACKET; superseded by [autonomous preparation](../evidence/2026-10-16-paid-checkout-autonomous-preparation/README.md).**
Current owner authority: AUTONOMOUS INSTALLATION GO / MONEY HOLD. Dependencies remain
mandatory; the old no-execution statements below describe that historical packet.

**HISTORICAL REVIEW PACKET / INSTALLATION HOLD / MONEY HOLD.**16October2026. This updates the current closed canary; it does not reopen ART-338, run the old ART-338 qualification matrix or authorize production/public sales. The owner-approved engineering scope includes preparing these artifacts. Final legal approval, admitted exact runtime and a separate owner1₽ GO remain necessary.

## Superseding consent-guard preparation

PR239 documentation merged as `6e48e22a7a6c958ca7deb77d665726b522a382ee`,
without deployment. The [config delta review](ART-39_CONFIG_DELTA_REVIEW.md)
and [new legal review package](../legal/closed-paid-test/2026-10-16-review-2/README.md)
supersede the consent/manual-only proposal for a future installation. The image
pair below remains a historical prepared baseline: **neither image contains the
new server guard or its UI recovery link**. New exact-source CI and role digests
are required before installing that repair. Do not edit the sealed a548774 receipt
or call its old image vector guard-qualified. All installation/money HOLDs remain.

## Merged source and immutable candidate artifacts

The owner authorized merge **without deployment**. Flexperiment238 merged as
`a548774692fa8a9b50fe8da02890e913857537d3`; its own merged-main
[CI38843890923](https://github.com/ArtGurianov/flexperiment/actions/runs/38843890923)
passed test/docker-build. Refref77 merged as
`4f533ec65688c29f6732ec32c799d4dd4fc05c37`; its own full merged-source CI passed
22/22 and attested `local-ci/required=SUCCESS` (status56492505630). The one-off
operator artifact and complete evidence are recorded in the
[final preparation receipt](../evidence/2026-10-16-paid-checkout-install-review/README.md).
Both merges retain exactly their reviewed head trees. Head CI is not transferred
to a merge SHA.

| Candidate role | Source | Private GHCR immutable reference |
| --- | --- | --- |
| Commerce | `a548774692fa8a9b50fe8da02890e913857537d3` | `ghcr.io/artgurianov/flexperiment-commerce-v2@sha256:62133f4fdcd5777c77b984cc9c9a17cc239ac2630451fe94d0205d64cdc5b7d1` |
| Platform | `a548774692fa8a9b50fe8da02890e913857537d3` | `ghcr.io/artgurianov/flexperiment-platform-v2@sha256:062e4528a269aa0fecb899302eae0db9393dca601d64dd7af867b89d62aee474` |
| Admin retained | `08523bdf38eeddf5e745ce04d05e1f980a7ced93` | existing digest below; no rebuild/replacement |

The two candidates were built from a clean committed source archive for
linux/amd64. Private registry GET verified manifest bytes/digest and config bytes;
VPS digest pull, RootFS and native identity matched. Commerce config digest is
`sha256:aab495dd447aaa8265d78f9c05382ea9d6a2cfd572693eb57289646aeffa4609`;
Platform config digest is
`sha256:01e175b7342a461008850826d8c95fae6fc8cab3f075eb2c52740a2d6ebb9607`.
The VPS containerd image IDs equal their manifest digests; these are not the Mac
Docker/config IDs. Exact RootFS/native descriptors and encrypted image archives
are retained in private `art39-checkout-preflight-20261016/install-review-a548774`.
The owner registry credential stayed on its existing host. Only artifact
load/publication/identity reads occurred; neither candidate application started
on the VPS and neither live container was replaced.

Host controller source is independently pinned to `a548774…`,
`scripts/v2/fast-cut.py` SHA256
`c4d5eb6516a147a7536c466b559f156349aafe2c0bcf8e41bca399a0c0b7160d`.
It has not been installed. The serving Refref source remains `202c0fb…`, separate
from the operator source. Merchant enablement/key issuance, shared Refref
configuration/restart, Flexperiment refref-mode installation and money are all
explicitly **HOLD**. No executable paid profile is issued while legal/key pins
are missing.

[Separate PD consent versus purchase acceptance](ART-39_CONSENT_DECISION.md) is a
proposed legal/procedure decision. The checkout event does not prove separate PD
consent; final approval and actual buyer evidence remain required before money.

## Current concrete inputs

Host `flexperiment-vps`, existing stack `/opt/flexperiment-fast-cut-canary`, existing private input directory `/etc/flexperiment-fast-cut-canary`. Existing Commerce SQLite volume, WAL/data lineage, five erasure mounts, private gateway, network and timer units are retained. Do not run initial `prepare` or a generic deployment workflow to repurpose this stack.

| Role | Observed configured source | Immutable installed image digest |
| --- | --- | --- |
| Commerce | `0d7dee0c8352dfb6cc1ea8ca7850b5d03fa18309` | `ghcr.io/artgurianov/flexperiment-commerce-v2@sha256:650ec79b0f8c5eb0f89bb2e93ed674e5548cc54daf10a57a204ff125342566ab` |
| Platform | `2cb47c46ee3cca50546d327ae57245c85235c153` | `ghcr.io/artgurianov/flexperiment-platform-v2@sha256:379f43ad63f624ec2b4e83078688b9a9f3170f85e86c3aeb165cb649aab22ee3` |
| Admin retained | native source085; no SOURCE_COMMIT env expected | `ghcr.io/artgurianov/flexperiment-admin-v2@sha256:85eadc71e50fdab0bc4d154a242a46188bd85bbe7f0edfed516f8863eb14dc77` |

This is a fresh inspect/config observation, not new native-image qualification. All three containers were healthy. Fence was canary/OPEN/sequence1/no owner/zero leases. Payments disabled. Current database description is LISTED/projection2, no free preview; offer PAID/CLOSED/100kopecks/empty allowlist, zero orders/entitlements/fiscal policies for test-course. No new app install was performed.

Existing backup status read SUCCESS, source0d7dee0…, verified00:15:08UTC16October,
SHA256 `ae42531db5757107af196e119387d9c9aee6586a3698c2a76921554b92f12e9d`,
size876952. Both backup/freshness timers were active/waiting. Reading that status
is not a new independent restore or proof of the future candidate; require a
fresh verified backup before installation. A fresh read-only fence observation
was OPEN/sequence1/no owner/zero leases and the signed remote read was
REMOTE_VERIFIED. This is a point-in-time preparation receipt, not candidate boot
admission. No timer, transport, retention or historical ART-351 incident was
changed by this packet.

## Merchant manifest and custody

Private owner artifact directory: `art39-checkout-preflight-20261016`, mode0700. Actual files are0600:

- `owner-identity-production.private.json`, independently copied from the pre-existing owner execution custody, not synthesized from database audit;
- `platform-production.private.json`, exact repository platform seed manifest;
- `owner-commerce-production.review-candidate.private.json`, SHA256 `ab8d370280650f6f898b0bb938251cf0be97bdf485813a71141601605ad64f91`;
- `owner-commerce-production-review.private.json`, strict parser and live read-only comparison receipts.

The candidate binds existing PRODUCTION Business/typed OWNER/database and independent owner manifest hash. Destination is exactly `https://canary-platform.flexperiment.ru`, only `/checkout/return`; both actual attribution handoff and payment success return use that path, then Platform verifies state and routes to the course. No broad `/courses` or `/` prefix is needed. Key scopes: `integrations:checkout`, `integrations:refund`, `integrations:fulfillment`. No evidence or partner scope is requested. One private unattributed campaign targets `course:test-course`, reward0; provider-verified payment/refund, no merchant-reported evidence. Its signed internal-regulation hash reference does not approve the customer's still-DRAFT paid terms. Review the exact candidate's zero-reward technical timing/classifier/refund-policy fields before immutable publication; it has not been admitted or executed.

Strict manifest parsers pass. A READ ONLY transaction under `refref_runtime` compared independent custody pins with the protected registry, one ACTIVE OWNER/Business and exact platform seed; all matched, no merchant keys/offers exist. This is no write or live provider permission proof. Existing production runtime source202c0fb…/schema25 and bank connection/profile/client/callback remain independent of the operator/controller source in Refref77.

Use only the reviewed exact operator build after its full CI and concrete-manifest admission. Key target is a new file in a canonical private UID-owned0700 custody directory, for example the prepared packet's proposed `/root/flexperiment-v2-owner/art39-checkout/merchant.key`; do not populate it by shell expansion or print it. The reviewed CLI exclusively creates0600/no-follow, fsyncs before COMMIT and verifies the existing key hash on READY replay. DNS_CHALLENGE_PENDING creates no key; publish only its actual returned TXT through the normal authorized DNS process, then replay identical manifest bytes. An uncertain capture/COMMIT answer is RECONCILE_REQUIRED, never a fresh-file retry. The [merged Refref77 runbook](https://github.com/ArtGurianov/refref/blob/4f533ec65688c29f6732ec32c799d4dd4fc05c37/ops/runbooks/owner-commerce-enablement.md) defines the exact CLI and exit semantics.

Before runtime use, encrypt and escrow merchant key, handoff secret and refund-envelope keyring to actual independently retained owner recovery recipients. Independent off-host GET/decrypt/hash proof must cover the issued key and necessary refund recovery keys. Stage these only in Commerce owner custody; Platform gets no private buyer digest or secrets. No key/secret was generated or installed by this packet. A plan is not custody PASS.

## Required Refref runtime configuration admission

The actual consumer `apps/app/src/acquiring-runtime.ts` reads `UNATTRIBUTED_EVIDENCE_POLICIES` once at process start and passes businessId→policyId to settlement acceptance. Operator READY returns the exact newly published `evidencePolicyVersionId` and proposed map entry, but provisioning does **not** load it into the serving runtime. A merchant key/quote alone cannot qualify payment settlement without that mapping.

After verified enablement, merge only this Business entry into the actual existing production map; preserve every other merchant and all acquiring/receipt/evidence/refund keyrings, connection/client/callback, worker settings and unresolved executions. Bind the entry to the independently read-back policy returned by the identical manifest transaction. No invented UUID or replacement of the whole multi-merchant map. Review and back up this exact Refref configuration delta before one separately admitted config application/restart of the existing immutable runtime. This is a shared production effect and remains under installation HOLD. No runtime-source upgrade follows merely from using Refref77's one-off operator build; the exact admitted serving source/image stays separately pinned. Re-read READY/native source, effective selected map entry, current provider/profile and existing pending-state preservation before a real buyer/payment. Include necessary Refref configuration/policy/key recovery in custody evidence. Do not discover a missing settlement policy after a bank charge.

## Complete the exact role vector before execution

The merged Flexperiment238 source includes the buyer-route/Suspense repair and
passed its own test/docker-build. Only Commerce/Platform were built/published;
Admin is retained. The immutable candidate identities are above, independently
read back on the actual VPS. CI's local test image tags are not publication
receipts. Never substitute the old ART-338 target or infer an installed image
from main.

Freeze separately: reviewed host-controller SHA/helper hash; per-role application
source/image/native descriptors; exact final paid legal version and
`legalManifestHash`; actual production Refref runtime source; sole buyer digest;
private merchant/custody receipt. Candidate target digests are resolved above;
final legal approval/version/hash, merchant execution/custody and installation
admission remain unresolved. No executable `release.json`/`paid-test.json` is
issued. Missing values are HOLD, not placeholders to install. The
[profile contract](ART-39_PRIVATE_CHECKOUT_PROFILE.md) lists exact required fields
and per-role separation.

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
