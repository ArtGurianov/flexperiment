# ART-39 / ART-83 / ART-224 — installed closed checkout

**ART39_INSTALLED_READY_FOR_MONEY_GO / MONEY HOLD.** 16 October 2026.
The owner authorized autonomous installation of the existing canary and approved
exact review.4. No real purchase or refund is authorized or reported here.
ART-338 remains Done; public F9 and production security qualification stay closed.

## Sources and installed artifacts

[Flexperiment PR242](https://github.com/ArtGurianov/flexperiment/pull/242)
merged as `1f27cbd2e7470f394ad27d8ee624efb0b7cfa922`.
Its own [merged-source CI38877558506](https://github.com/ArtGurianov/flexperiment/actions/runs/38877558506)
passed both `test` and `docker-build`. Head71a5f210 had separate successful CI;
head evidence is not substituted for merged-source evidence.

| Role | Installed immutable image |
| --- | --- |
| Commerce | `ghcr.io/artgurianov/flexperiment-commerce-v2@sha256:644709e5d4ef2a098af0356fafc96bd82746d968445d3ea441a17b271d2f42f6` |
| Platform | `ghcr.io/artgurianov/flexperiment-platform-v2@sha256:9484f177ead01f0e4b5c0d04524de40947386379897b265ec3405cb15f83d92c` |
| Admin, retained | `ghcr.io/artgurianov/flexperiment-admin-v2@sha256:85eadc71e50fdab0bc4d154a242a46188bd85bbe7f0edfed516f8863eb14dc77` |

Registry manifest/config, independent VPS pull, native service source identity
and full RootFS layers were checked. Commerce/Platform both identify the merged
source above. Native config digests are respectively
`sha256:1dc8618c4f53f4b9d8e87b1cf3856388881274a92a02cd8ed2b15b975203a920`
and `sha256:5da41664bfab068d62dac6ffb23a2800d1702fe0ffeb7265f25fd79cc3ffec9b`;
these differ from the manifest digest stored by the VPS Docker driver.

The installed controller comes from the same exact source, file SHA-256
`cd58ad2589332606302616fbd272eab8cd5ddea1bcaea885301640632e970c85`.
Schema27 fingerprint is
`b71a08d5f785b98516d4c2fbde8184d25bb91ce1b880d614d637be76876dd84f`.
Migration is additive; prior financial records and the SQLite device/inode,
volumes, retained Admin container and erasure authority were preserved.

Refref serving source remains `202c0fb3c63b53cc7d1fdb3f1ee07235319dd13c`.
[Refref PR79](https://github.com/ArtGurianov/refref/pull/79) merged as
`e228786bd292334a23b18d6ec3431e4321a08964`; its own full local CI22/22
and `local-ci/required` passed. That documentation source is not reported as
installed in shared Refref.

## Legal and fiscal admission

The owner approved exact [review.4](../../legal/closed-paid-test/2026-10-16-review-4/README.md),
package SHA-256
`f67033443312a368b42d2d114e6b775d0e96035e2bc4bdd5587e859a035bb86b`.
All12 covered files were independently rechecked in the merged source. All8
served document responses passed HTTPS/TLS, byte hash, host and method checks;
review.3 and Stage A archives remain available. Active Stage B version is
`2026-10-16.closed-paid-test.review.4`, manifest SHA-256
`5ed1728066fff98efd001b1fa27bfab817252989cce9cf7f6f28099904b659a2`.
The manifest hash and package hash serve different purposes.

The actual immutable `OwnerLegalDecision`
`530af54e-0a26-4fdd-8e7c-cce4af106bf7` version1 is bound to qualified fiscal policy
`c0454fb4-1e2e-484f-b0ea-34327046635f` version1 and evidence SHA-256
`5576a94343cb2d8b3a103888be397855b953020375215c218ac51c9c7d082e9c`.
Owner and recording operator are separately identified. Evidence binds the real
owner decisions, current legal bytes, facts, norms and implementation limits;
it is not a fabricated counsel opinion or independently verified signature.
See [decision model](../../legal/OWNER_LEGAL_DECISIONS.md) and
[fiscal research](../../legal/ART-234_FULL_PAYMENT_RESEARCH.md).

Actual policy: `SERVICE`, `FULL_PAYMENT`, `USN_INCOME`, `NONE`, receipt item
**Доступ к курсу «Test Course»**. The purchased scope is the evolving course,
including later published updates without another payment. Initial ready-content
observation is audit evidence only. No second closing receipt is implemented or
promised. There is no claim of distributed atomicity between bank/CIB and the
local fulfillment transaction or blanket intermediary cash-basis exemption.

The separate current PD/account consent guard is installed. Review.3 acceptance
cannot count as review.4 consent. No consent, session, paid acceptance, order or
entitlement was manufactured during installation.

## Merchant, custody and recovery

Existing signed OWNER/Business and active production Tochka connection were
retained. One merchant API key was issued, safely captured and independently
recovered; no new Business or banking connection was created. READY read-back
returned the actual evidence policy. Only its Business mapping was added to
shared `UNATTRIBUTED_EVIDENCE_POLICIES`, preserving other mappings, credentials,
workers, callbacks and financial data; the serving Refref source stayed fixed.
The prior merchant-key/config escrow and isolated Refref database recovery
remain separate proofs, not inferred from READY.

Fresh pre-install encrypted backup was provider-fetched, decrypted off host and
restored. The exact new image migrated the isolated26 copy to27 with all52 old
tables and historical rows preserved. Copied OPEN fence refused use before fresh
remote-ledger BOOT_RESTORE admission; actual protected read then admitted the
isolated image. No HTTP server, worker or payment client started in that proof.
Only owned isolated copies were removed; live fence authority was unchanged.

After actual installation and sole-offer opening, a second fresh backup was
independently fetched from S3 and restored off host: ciphertext SHA-256
`3b91c31c1928efe30ecb7f85260209c92e8d18b9559e269265a42ca8a277d12c`,
909720bytes. Integrity/FK, schema27, active review.4, actual qualified policy,
owner decision/evidence and ACCEPTANCE_ONLY100 were checked in the restored DB.

The installed snapshot also passed a separate copied-fence admission with the
actual qualified owner-backed policy retained: copied OPEN was refused, fresh
remote ledger admitted schema27, restored sessions were invalidated and no
workers/HTTP/payment clients were started. Live fence was unchanged and the
isolated plaintext/credential copies were removed.

Installed configuration was separately encrypted and provider-fetched:
ciphertext SHA-256
`452d3e5462b08f6700ce5736181de45a55699e9cb8eaa0d2fe2df8e43ec206f0`.
Off-host memory-only decryption recovered and hashed all12 runtime/config files,
merchant/handoff/refund secrets, Admin credential and the separate owner fiscal
evidence. Platform has no merchant secrets. No plaintext configuration archive
or private recovery key was placed on the VPS. The private key stays with the
owner; the encrypted recoverable configuration does not replace erasure custody.

## Actual canary and genuine buyer preflight

Commerce/Platform readiness, source/image/RootFS and schema/ledger admission
passed. All4 public hosts still return403. Backup and freshness timers are
active with their original schedules and source-matching backup is FRESH.
Only `course:test-course` is ACCEPTANCE_ONLY,100kopecks, one selected verified
buyer; every other paid offer is CLOSED. Marketing is disabled. No new order,
manual entitlement, payment operation, charge or refund was created.

A separate official Chrome profile was launched with owner permission and
hostname mapping through a loopback SSH tunnel. HTTPS certificate verification
remains enabled; no OS DNS/proxy change or certificate bypass was used. Direct
TLS/readiness through that tunnel passed. The native UI tool could select only
the personal Chrome process, so the owner operated the isolated test profile.
This is a genuine owner-operated browser run with independent server read-back,
not an agent-observed screenshot or an automated browser fixture.

The owner completed normal login and separate review.4 consent. Authenticated
server evidence at10:01:29UTC confirms personal_data=true, account_terms=true,
marketing_consent=false, bound to the selected buyer/current release. No consent
was transferred from review.3. The real Refref handoff returned to the same
private course. Current UI requires a second **«Купить курс»** press after return
to request preview; it does not request preview automatically. That second
press completed successfully without a promo code.

The owner reported the actual preview: **1₽**, the selected receipt email, all8
review.4 document links, purchase checkbox and **«Подтвердить и оплатить»**.
Independent server read-back10:07:31UTC confirms the same handoff's REVIEW quote,
catalog100/final100kopecks, merchant/referral discounts0, current legal release,
requiresImmediateAccess and exact qualified fiscal policy in the frozen line.
Quote SHA-256 is
`e8b224f35b37fdfa2db9c9767b3825df4e94d25927758f90539ea005e7df8c4b`;
frozen-line SHA-256 is
`0dd79999fc28b544588d7c4aa52a8ff530cca2fda268c43643530bd2c2a8a8a1`.
No bearer return token or selected-buyer identity is copied into this index.

A fresh post-preflight encrypted backup also passed independent provider GET,
off-host decrypt/hash and isolated schema27 restore at10:10:39UTC. It recovers
the actual buyer consents, same handoff REVIEW100 quote, qualified policy and
owner decision with zero checkout attempts/orders. Ciphertext SHA-256:
`2e88a12ca8deb4555ff847c81b1ff06d4c554e6c4401f3830a4a3f1b2afa7ed3`
(909720bytes). Owned plaintext restore was removed after verification.

Execution stopped before `POST /v1/checkout` and the final payment button.
Read-back confirms **zero checkout attempts, zero test-course orders and zero
test-course entitlements**. The preview is temporary and is not a payment
operation or purchase acceptance. If it expires before a financial GO, obtain a
fresh preview through the normal flow rather than reuse expired return data.

**ART39_INSTALLED_READY_FOR_MONEY_GO** records completion of installation,
recovery and genuine buyer preflight only. MONEY HOLD remains. Payment, receipt,
paid entitlement/playback, full refund, refund receipt and revocation remain
unrun and require separate financial GO. ART-39/83/224 remain in progress.

Private receipt names: `installation-receipt.json`, `offer-opening-receipt.json`,
`installed-independent-restore.json`, `copied-fence-restore-proof.json`,
`installed-config-recovery-proof.json`, `installed-copied-fence-restore-proof.json`,
`installed-final-readback.json`, `buyer-preflight-proof.json`,
`post-preflight-independent-restore.json`, under
owner-only `art39-checkout-preflight-20261016/owner-legal-decisions-20261016`.
No buyer identifiers, secret values or fiscal receipt coordinates are included
in this public index. Older sealed installation packets are retained unchanged.
