# ART-39 / ART-83 — merged-source installation review

**ENGINEERING REVIEW PACKET / INSTALLATION AND MONEY HOLD.**16October2026.
The owner authorized both merges and engineering preparation without deployment.
This is one bounded review packet; ART-338 remains Done, public sales/F9 closed.

## Sources and checks

- [Flexperiment238](https://github.com/ArtGurianov/flexperiment/pull/238) merged as
  `a548774692fa8a9b50fe8da02890e913857537d3`. Its own
  [merged-main CI38843890923](https://github.com/ArtGurianov/flexperiment/actions/runs/38843890923)
  passed test/docker-build. Includes the buyer-route and leaf Suspense repair.
- [Refref77](https://github.com/ArtGurianov/refref/pull/77) merged as
  `4f533ec65688c29f6732ec32c799d4dd4fc05c37`. Its exact merged-source runner passed
  all22jobs and attested GitHub `local-ci/required=SUCCESS`, status56492505630,
  at03:41:37UTC16October. The full job results/logs are retained privately.
- Both merge Git trees equal their reviewed head trees. CI was still run on
  each actual merge SHA; previous head checks were not relabelled.

An initial local Refref merged run exhausted the Docker VM during PostgreSQL
fixture creation, while the Platform image was being built. No application
assertion caused that failure. The failed log and failure status were preserved.
After retaining the new image bytes and freeing only the owned image/cache
artifacts, the identical source passed the full runner without parallel builds.
Existing application data volumes and installed VPS services were not removed.

## Immutable artifacts and controller

The [machine receipt](receipts.json) and
[installation packet](../../release/ART-39_INSTALL_PACKET.md) pin the Commerce
and Platform images from a548774…, with retained native Admin085. They are private
GHCR linux/amd64 artifacts, not local CI tags. Registry manifest/config GETs,
VPS digest pulls, RootFS and baked native identities matched. Containerd manifest
IDs are explicitly separated from Mac Docker/config IDs. Commerce's actual
archived image passed the existing isolated foundation/storage/restore smoke;
that synthetic test is not a live erasure admission or paid E2E.

The controller remains a548774… with helper SHA256
`c4d5eb6516a147a7536c466b559f156349aafe2c0bcf8e41bca399a0c0b7160d`.
The serving Refref source remains202c0fb…, independent of the one-off operator
source4f533ec…. No application from the new artifacts was started on the VPS.

One-off operator artifact:
`ghcr.io/artgurianov/refref-owner-commerce-operator@sha256:10645410d2e3b08e4ea46195b33f6293011c76659b5bd63f7625aedb9b6c0131`.
Config digest:
`sha256:d3028b0208bed9cd113103d306d49a090b70d48680a452ff65fc29a9c9d858ff`.
Canonical `Dockerfile.runtime`, clean merged source4f533ec…, linux/amd64;
private registry GET/config/RootFS and VPS pull/native read-back PASS. On the
isolated Mac image, strict parsers accepted the actual candidate manifest and
platform seed without opening a DB. The packaged CLI without mandatory inputs
refused with `INPUT_REQUIRED` before any connection/write. This is not production
enablement; no key was generated. Future execution must explicitly override the
runtime image's default server command with the admitted operator command and
its constrained runtime-role inputs, after the separate enablement GO.

Private owner packet: `art39-checkout-preflight-20261016/install-review-a548774`.
It retains the source archives, image descriptors/archives, independent owner
manifest, concrete merchant candidate, strict-parser receipts, read-only live
baseline, proposed configuration, consent decision and bounded execution plan.
Top-level files are0600 under0700. The registry credential stayed in the existing
root-owned0600 host store. Encrypted image copies are retained; this is not proof
of recovery for a merchant key that has not been issued.

## Current live state and consent decision

Commerce0d7dee0… and Platform2cb47c4… remain installed with payments disabled;
Admin085 retained. The selected Refref merchant has no API key or payment
attempt. The required serving policy-map entry is absent. A read-only observation
found OPEN/sequence1/no owner/zero leases and REMOTE_VERIFIED signed erasure
authority. Backup status was SUCCESS for old source0d7dee0…, verified00:15UTC;
this is not a new independently restored installation backup or future-source
proof. Repeat admission checks immediately before any authorized mutation.

[The proposed consent model](../../release/ART-39_CONSENT_DECISION.md) uses a
separate authenticated account action for the final PD document and a separate
checkout action for purchase terms. `PAID_CHECKOUT_TERMS_ACCEPTED` does not prove
independent PD consent. The current checkout lacks an automatic PD-consent guard;
the proposed single-buyer procedure requires independent pre-payment read-back,
and final legal approval may require an additional server guard. Neither a real
buyer acceptance receipt nor legal approval is claimed.

The original DRAFT paid package's10checksums and package SHA
`8899446eb7442cfb16ddaa48166d9061fc04ac803622210c88dbfbea5ddbabb8`
remain unchanged. No paid legal release or fiscal policy was activated.

## Remaining decisions

Merchant manifest admission and key issuance/custody; shared Refref policy-map
configuration/restart; final legal bytes/consent model, actual fiscal recipients,
retention and genuine fiscal qualification evidence; fresh backup/restore and
bounded canary installation; actual buyer handoff/preview and separate financial
GO all remain explicit gates. The packet issues no executable runtime env or
paid-test observer file with invented legal/secret values. ART-39/83/224 remain
In Progress. No payment/refund, public-sales opening or new LMS matrix occurred.
