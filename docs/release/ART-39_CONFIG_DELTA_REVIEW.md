# ART-39 / ART-83 — successor install/config review

**AUTONOMOUS INSTALLATION GO / MONEY HOLD; DEPENDENCIES PENDING.**16October2026.
Latest execution facts: [autonomous preparation](../evidence/2026-10-16-paid-checkout-autonomous-preparation/README.md).
This supersedes the manual-only consent procedure of the sealed
`install-review-a548774` packet; that historical packet is not rewritten.
PR239 merged docs only as `6e48e22a7a6c958ca7deb77d665726b522a382ee`.

## Exact changes proposed

| Component | Baseline/prepared identity | Proposed delta |
| --- | --- | --- |
| Host controller | reviewed a548774 source, helper SHA256 `c4d5eb6516a147a7536c466b559f156349aafe2c0bcf8e41bca399a0c0b7160d` | No helper/workflow repair in this change; retain separately pinned controller |
| Commerce/Platform candidates | a548774 images in [old packet](ART-39_INSTALL_PACKET.md) | Merged3222845 owns green CI and new independently verified digest pair; old a548 artifacts cannot satisfy this gate |
| Admin | retained source08523bd…/existing immutable image | Retain unchanged, no rebuild |
| Refref operator | source4f533ec…; digest10645410… | Retained one-off artifact; admitted exact manifest executed to DNS_CHALLENGE_PENDING, no key issued |
| Shared serving Refref | observed202c0fb…; observed policy map `{}` | After actual READY only, add selected Business→returned `evidencePolicyVersionId`, preserving all existing entries; source/runtime upgrade not implied |
| Legal | active free Stage A, paid draft unactivated | [review.3](../legal/closed-paid-test/2026-10-16-review-3/README.md) is not approved; require approved exact bytes + HTTPS read-back + actual qualified policy |
| Closed profile | payments disabled, sole offer CLOSED | Only separately admitted matching Commerce/Platform runtime may use scoped refref/ACCEPTANCE_ONLY; price stays100kopecks |

The private merchant candidate remains SHA256
`ab8d370280650f6f898b0bb938251cf0be97bdf485813a71141601605ad64f91`.
It was technically admitted under delegated owner authority; execution returned
**DNS_CHALLENGE_PENDING**, not READY. Independent DB read-back matched the actual
offer/campaign/terms/evidence IDs and pending challenge; API keys0. Return origin is canary-platform, only `/checkout/return`;
scopes checkout/refund/fulfillment; single unattributed zero-reward campaign.
No policy UUID, merchant key or final legal hash may be invented to complete it.

## Configuration construction after actual dependency admission

A successor private review delta records each role source/image separately,
reviewed controller, unchanged operator artifact, current observed serving source,
merchant manifest hash, private buyer custody and the new consent requirement.
It intentionally cannot be used as `release.json`, `paid-test.json`, env input or
operator manifest. No runtime file with unresolved/null fields is emitted.

Before constructing an applicable shared map patch, obtain actual READY report
from the admitted identical manifest, independently read back the policy and
merchant identity, then fetch the **then-current** production map. Compare against
its approved preimage/hash immediately before application. If any entry changed,
regenerate/review the delta. Add only the selected Business entry; an existing
different selected entry is a conflict requiring review, not an overwrite.
Do not use the historical empty map as authority to replace a later shared map.
Preserve all other merchant entries, acquiring/refund/evidence keyrings, provider
connections, workers and unresolved operations. Archive the exact old config
privately before the separately admitted config-only restart.

Common proposed inputs retain profile `art39-test-course-rub1-v1`, staging,
marketing=false, production Refref API/checkout/readiness and separately pinned
serving source. Approved final legal version/hash remain unresolved. Commerce
alone receives private buyer hash, API/handoff/refund keys and protected/erasure
inputs; Platform never receives them. A qualified current account action and
separate purchase acceptance are required before payment creation. Read-back and
reconciliation of an existing payment/refund remain available.

The updated [Tochka tariff review](ART-39_TOCHKA_CHEKI_OCTOBER.md) changes the
seller's planned test expenses, not the100kopeck checkout or full refund.
The owner has accepted the receipt-fee planning assumption; no separate bank
confirmation of refund-receipt pricing is required. Installation and money GO
remain separate.

Fresh encrypted backup/off-host retrieval/decrypt/isolated restore, erasure
admission, custody and the actual buyer→documents→handoff→preview proof remain
prerequisites. No new installation/restore/provider proof is claimed by source
CI or this delta. ART-338 stays Done; no new tracker issues are required.

Owner decision16October2026: `REFUND_RECEIPT_FEE_RISK_ACCEPTED`; planning assumption up to10₽ for two receipts plus acquiring, not a bank-confirmed refund tariff or guaranteed total cost cap. Separate bank confirmation of refund-receipt pricing is no longer a blocker. Execution permission is now present; actual DNS/READY, custody/recovery, legal/fiscal admission and financial GO remain separate.

Current unresolved facts: DNS confirmation for the admitted unchanged manifest; true fiscal legal basis/counselRef under the existing gate; final exact-byte legal approval/publication; actual merchant key escrow/recovery and final live profile admission. No new per-step technical GO is required.
