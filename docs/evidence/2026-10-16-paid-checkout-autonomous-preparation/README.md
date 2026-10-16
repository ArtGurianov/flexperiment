# ART-39/83/224 — autonomous preparation and bounded production effect

**ART39_DEPENDENCIES_PENDING / MONEY HOLD.**16October2026.
Owner authority: AUTONOMOUS INSTALLATION GO / MONEY HOLD, explicit in this chat.
No additional per-step technical GO is needed. This is not installed-ready status.
ART-338 remains Done; no new issues/public sales/F9 admission.

## Source and new artifact evidence

[PR240](https://github.com/ArtGurianov/flexperiment/pull/240) merged as
`32228451a5b1a0dbbb57fe503c0cc5c984427af7`; the merged tree exactly equals
reviewed head30f3ea5. Its own [CI38855676969](https://github.com/ArtGurianov/flexperiment/actions/runs/38855676969)
passed test/docker-build. New linux/amd64 artifacts include the server PD guard.

| Role | Immutable private image | Registry config digest |
| --- | --- | --- |
| Commerce | `ghcr.io/artgurianov/flexperiment-commerce-v2@sha256:5d11d3d91563de6aeb414cc0084d3dbf57ee630de4a364ba4449cd00d678dc99` | `sha256:d217801e6240d7bddf872892bc35cc950a925f038c427a92674cd207a38ab5da` |
| Platform | `ghcr.io/artgurianov/flexperiment-platform-v2@sha256:81d96a854b47b5166314fccb044c587296a6b40b89afdeefdeff8a584b504bb3` | `sha256:5580cb623fc0c2f6fe860d2131644521cee1f969d2e0f76782da63fa46a427cc` |

Both received private-visibility/manifest/config GET, independent VPS exact-digest
pull, complete RootFS and native source comparison. Identity extraction used
created-but-never-started containers, then removed only those containers.
The host containerd storage IDs equal manifest digests, distinct from config IDs.
Registry PAT stayed in existing root custody; Mac upload used only transient
repository-scoped bearer tokens in memory. No TLS verification was disabled.
A slow interrupted archive SCP is partial, never used for load/admission;
publication instead reused verified registry layers and uploaded new blobs.
No application container was started or installed from these candidates.

Retain Admin source08523bd/image85eadc71…; controller a548774/helper
`c4d5eb6516a147a7536c466b559f156349aafe2c0bcf8e41bca399a0c0b7160d` remains separately
pinned. Refref operator4f533ec/image10645410… is distinct from serving202c0fb… .

## Actual merchant enablement, pending DNS

Exact unchanged private manifest SHA256
`ab8d370280650f6f898b0bb938251cf0be97bdf485813a71141601605ad64f91`
was reviewed/admitted under delegated technical authority. Existing signed OWNER
custody manifestbe10c7c6… matched the protected registry, original artifact/
signature/certificate bindings and one ACTIVE OWNER/Business under a read-only
runtime-role transaction. This reused the prior genuine signed-identity bootstrap;
GOST signature verification was not rerun or invented in this execution.

Before the mutation: fresh encrypted production backup
`refref-production-20261016T054413Z`, provider GET and equal transport hashes,
owner-Mac decryption/isolated PostgreSQL restore PASS. Snapshot00000005-00049957-1,
157tables/82rows,26migrations/head000025,8roles/8grants/253definers.
Recovery image81bd698b… had all11 RootFS layers equal the actual VPS database image.
No recovery key left the Mac. Scratch restore container was removed.

The exact operator ran with existing runtime DSN only, no DB-owner role,
no new bank connection and no migrations. It returned **DNS_CHALLENGE_PENDING**,
exit3: one actual offer/campaign/terms/evidence policy and a PENDING domain.
Independent DB read-back matched returned IDs/challenge and confirmed API keys0.
No API key file exists. This outcome is committed partial enablement, not a
rollback and not READY. Replay must use the same manifest and key target;
never adopt a new identity, synthetic policy or fresh run to hide uncertainty.

TXT name `_refref-challenge.canary-platform.flexperiment.ru`; exact value is
retained in private report and given to the owner. REG.RU UI was unreachable;
owner is configuring DNS and will report readiness. A subsequent product request
adds DNS TXT/HTTPS challenge choice in successor Refref code; current ART-39
continues with the existing DNS manifest/operator, independently of that work.

Shared `UNATTRIBUTED_EVIDENCE_POLICIES` has not changed; serving Refref has not
restarted. Only after READY + independent key escrow/recovery may the one-entry
map delta and restart proceed. Existing bank JWT/API/webhooks remain configured,
with credentials in Coolify; no bank-portal setup or credential replacement.

## Legal/fiscal, money and current canary

Owner supplied a historical real receipt linking IP supplier→CIB agent→Platforma
OFD. [Evidence](../../legal/closed-paid-test/2026-10-16-review-2/OFD_RECEIPT_EVIDENCE.md)
identifies ООО «Эвотор ОФД», INN9715260691; it is not a receipt for the new test.
No separate OFD login or bank confirmation of refund-receipt fee is required.
Refund fee risk accepted: planning up to10₽ for two receipts plus acquiring,
not a bank-confirmed tariff/cost cap. Charge/refund remain100kopecks each.

[review.3](../../legal/closed-paid-test/2026-10-16-review-3/README.md), package
`48736a07be4b9820fbdfde32fc5a905fe0fef80a539d6c1c375e4a3331bc3282`,
provides concrete customer text candidates and a processing matrix, with CIB/OFD,
separate PD action and minimal retention. Exact-byte approval/publication not
performed. Actual external account/CDN/retention facts are not fabricated.
Existing fiscal gate requires real ART-234 framing/counselRef and evidence hash;
owner SERVICE/FULL_PAYMENT/USN_INCOME/NONE confirmations are retained as such.
No specialist reference was supplied. No DRAFT was marked QUALIFIED.

Canary remains the healthy prior Commerce0d7dee0…/Platform2cb47c4…/retained Admin;
payments disabled, course LISTED and offer CLOSED. Fresh Flex-specific install
backup/restore, runtime installation and actual buyer PD/handoff/preview are
not yet performed: key/READY and legal/fiscal dependencies are pending.
No payment operation, charge or refund was created. Public guards/data/volumes/
erasure/timers remain under the preserved baseline, not a newly claimed install.

Private receipts: owner Mac0700 directory
`art39-checkout-preflight-20261016/install-review-3222845`; root-only merchant
execution custody `/root/flexperiment-v2-owner/art39-checkout`. Do not publish
buyer email/hash, key/DSN, signed personal artifacts or receipt lookup coordinates.
