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

## Actual merchant READY, custody and shared config

Exact unchanged private manifest SHA256
`ab8d370280650f6f898b0bb938251cf0be97bdf485813a71141601605ad64f91`
was admitted under delegated technical authority. Existing signed OWNER custody
manifestbe10c7c6… matched protected registry/artifact/signature/certificate and
one ACTIVE OWNER/Business. This reused the prior genuine signed bootstrap;
GOST signature verification was not rerun or invented in this execution.

Before mutation: encrypted `refref-production-20261016T054413Z`, provider GET,
offhost decryption and isolated PostgreSQL restore PASS; snapshot00000005-00049957-1,
157tables/82rows,26migrations/head000025,8roles/8grants/253definers.
Recovery image81bd698b… matched all11 RootFS layers of the VPS PostgreSQL image.

The pinned4f533ec operator first committed DNS_PENDING with keys0. After the owner
added TXT, authoritative DNS and Google DoH returned the exact token. VPN-local
DNS was unavailable and the application resolver retained NX; only the one-off
operator used8.8.8.8, without changing host/application resolvers. Exact manifest
replay returned **READY**, produced exactly one ACTIVE PROD key in root0600 custody
before COMMIT, and independent DB read-back matched its hash/scopes/domain/policy.
No new Business, acquiring connection, bank credential or migration was created.

The merchant key plus handoff/refund-envelope secrets were encrypted to the
existing owner-Mac age recipient and uploaded to the dedicated S3 escrow object.
Provider GET, offhost decrypt and full plaintext hash/key-ring checks passed;
private recovery key never left the Mac and no plaintext merchant key was saved
there. A new encrypted database backup `refref-production-20261016T061342Z`
was provider-retrieved and restored offhost: snapshot00000005-00049BBC-1,
157tables/94rows, same26migrations/8roles/8grants/253definers. Both generic facts
and **RESTORED_MERCHANT_KEY_POLICY_OWNER=PASS** verified the restored actual key,
OWNER, policy and domain against the independent encrypted secret recovery.

The complete old Refref config also received encrypted S3 escrow, provider GET,
offhost decrypt/hash proof. A compare-and-set changed only the production
`UNATTRIBUTED_EVIDENCE_POLICIES` row and durable env file, adding the actual READY
Business→policy mapping. Preview/other env rows and existing map entries were
preserved. Compose command/entrypoint nulls were checked against image defaults;
mounts, networks, image tag/ID and full environment were checked before restart.
A controlled no-build/no-pull Compose recreation retained serving source
**202c0fb3c63b53cc7d1fdb3f1ee07235319dd13c**, image, native identity, credentials,
callbacks, workers and keyrings; health and all post-restart deltas matched.
Payment/refund-execution/initiation counts remained zero. New merchant credentials
are recoverable in custody, not yet installed into Flexperiment.

The separate [Refref78](https://github.com/ArtGurianov/refref/pull/78) adds selectable
DNS TXT/HTTPS challenge in the merchant/operator manifest; omitted method keeps
DNS compatibility. Its code is not deployed by this ART-39 execution. Existing
bank JWT/API/webhooks remain untouched; no bank portal setup was performed.

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
separate PD action and minimal retention. The owner explicitly approved this exact
package and retention start (1January after last tax-use year). All eight documents
were published to their proposed private HTTPS URLs with exact hash/TLS/method/host
checks; four older Stage A URLs remain unchanged. The private nginx config adds only
the bounded versioned legal location; the same tester container/image/loopback port
was retained. Two newly created public-text directories initially inherited0700
from the private process umask; only those directories were corrected to0755,
then all read-backs passed. Actual external account/CDN/retention facts are not fabricated.

Before legal activation, a fresh encrypted Flex canary backup
`fast-cut-20261016T063453Z-99de0104-5030-474a-9fa4-9dacafdd0bf7.sqlite.age`
received independent provider GET, offhost decrypt and immutable SQLite restore:
integrity/foreign keys PASS, exact schema c99f9ed0… and26migrations, prior active
release2026-10-15.closed-e2e. Temporary plaintext was removed. Fresh normal
controller admission confirmed OPEN/drained fence and matching remote ledger.
The existing authenticated fenced internal API activated COURSES Stage B
`2026-10-16.closed-paid-test.review.3`, manifest SHA256
`1e8a8a145a4ce6ba2263b11972a151996187041a172c06cace5a57869d4be95b`.
API current-release plus independent DB/audit read-backs matched. Activation
created no buyer consent, order, fiscal qualification or sales activation.
Existing fiscal gate requires real ART-234 framing/counselRef and evidence hash;
owner SERVICE/FULL_PAYMENT/USN_INCOME/NONE confirmations are retained as such.
No specialist reference was supplied. Fresh Linear ART-234 read-back is Backlog, with no attachment/document; available canonical source provides no genuine conclusion. No DRAFT was marked QUALIFIED.

Canary remains the healthy prior Commerce0d7dee0…/Platform2cb47c4…/retained Admin;
payments disabled, course LISTED and offer CLOSED. Fresh Flex-specific install
copied-fence restore admission, runtime installation and actual buyer
PD/handoff/preview are not yet performed. READY/custody/map and legal publication
are complete; the specific blocker is the genuine ART-234 legal framing/counselRef
required to qualify the offer. New immutable images remain prepared, uninstalled.
The prelegal restore proves that exact snapshot, not future installation admission.
No payment operation, charge or refund was created. Public guards/data/volumes/
erasure/timers remain under the preserved baseline, not a newly claimed install.

Private receipts: owner Mac0700 directory
`art39-checkout-preflight-20261016/install-review-3222845`; root-only merchant
execution custody `/root/flexperiment-v2-owner/art39-checkout`. Do not publish
buyer email/hash, key/DSN, signed personal artifacts or receipt lookup coordinates.
