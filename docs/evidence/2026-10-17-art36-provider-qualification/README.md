# ART-36: actual provider qualification and remaining production decisions

Status: `PROVIDER_FAULT_AND_DOMAIN_PROTOTYPE_PASS / PRODUCTION_DECISION_OPEN`.
Recorded17October2026 local time; receipts use16October UTC. ART-36 remains In
Progress. ART-338/39/83/351 are not reopened; ART-240 and public F9 are separate.

## Decision

Keep the existing server-minted, short-lived signed bearer and strict Kinescope
Authorization Backend as the demonstrated mechanism for protected delivery.
Actual Chrome playback requires a permitted license. Callback401/403/500,
timeout and isolated upstream failure deny a new license. Domain restrictions
work as an additional embedding restriction when configured on the video.
They do not establish the identity of the browser presenting a valid bearer.

This completes the previously missing real-provider fault/domain experiment,
without faulting the shared project. It does not supply browser/device binding
or accept production bearer-transfer risk on the owner's behalf. The shared
project and all four active bindings still use `privacy_type=anywhere`.

## Exact execution boundary

The [operator prototype](../../../scripts/v2/art36/README.md) was reviewed at
`4a09bc992e509ac52a16cecd3d46f255eb708d25`, [PR252](https://github.com/ArtGurianov/flexperiment/pull/252).
Exact-head [CI38936311926](https://github.com/ArtGurianov/flexperiment/actions/runs/38936311926)
passed both jobs before fixture admission. Merge source
`c2a8d4d4037580e218efc991518d7c9258fc373c` independently passed
[CI38937760997](https://github.com/ArtGurianov/flexperiment/actions/runs/38937760997).
These are prototype/controller sources, not a new native application release.

The temporary handler ran from immutable Commerce image
`ghcr.io/artgurianov/flexperiment-commerce-v2@sha256:c928ef2a9e33e2e2bcb7e646e89fe8b239489395539d9eb9094350a683433e4c`.
Its baked native source remained `80a11bde55c38973bcde99b4a92ee9e09c5dc6ad`;
read-only fixture source SHA-256 was
`8b71a7802863df324891e1ad4d08fcb508de2af589afdea1564032320c16f675`.
The actual image passed offline Node HTTP and Python manifest contracts before
use. [Admission](fixture-admission.json) distinguishes these identities.

Only a new temporary encrypted project, a copy of the owner's four-second
fixture, separate Basic/HMAC credentials, one disposable container and one
exact POST-only route were created. The handler had no customer DB, first-party
session, native signing key, provider API/payment/mail credential, published
port or application entrypoint. Signed fixture capabilities were deliberately
separate from genuine Commerce grants. Existing project settings, services,
database, erasure fence, recovery custody and proxy files were preserved.

## Actual Chrome/provider matrix

Real Chrome155 with EME/CDM used an isolated profile, ordinary TLS, fresh pages
and disabled cache. These were explicit fixture pages on the canary HTTPS
origins, not a buyer authentication/consent/payment simulation. A unique signed
reference connects each license test to the provider-origin callback. See
[browser-matrix.json](browser-matrix.json) for times, frames and correlations.

| Fixture case | Actual provider result | Playback |
| --- | --- | --- |
| Allowed origin; callback200 | Two license200 responses; two matched callback200 events | Four seconds ended;100 decoded frames |
| Callback403 | License403; matched callback403 | Zero decoded frames/time0 |
| Callback401 | License403; matched callback401 | Zero decoded frames/time0 |
| Callback500 | License403; matched callback500 | Zero decoded frames/time0 |
| Callback delayed7seconds | License403 after5302ms; handler saw closed response at7002ms | Zero decoded frames/time0 |
| Handler closes its socket | License403; matched disconnect event | Zero decoded frames/time0 |
| Different origin (`canary-lab`) | Embed403/privacy error before license/callback | No video element |
| Allowed origin with `no-referrer` | Embed403/privacy error; absent HTTP Referer captured | No video element/license/callback |

The delayed handler's logged `intendedStatus=200` is not an actual200 response:
the provider had already disconnected. Upstream disconnect is a scoped fault
of this test handler; no claim is made that Kinescope's entire service failed,
or that a particular proxy502 status was measured. Positive controls ran both
before and after the initial negative matrix. No late cached license or
previously playing iframe was accepted as a positive control.

Copying the source video preserved its `anywhere` privacy despite the target
project's custom allowlist. Explicitly setting the copied video's domains and
independently reading them back was necessary. A first video update used PUT
and received405; GET reconciliation followed by the documented PATCH changed
only the copied video. Project creation/copy were not repeated. Initial browser
navigation/SDK-driving attempts that made no license request were not counted
as provider verdicts. A later SSH network timeout prevented a new token mint;
after the owner restored connectivity the remaining no-referrer test ran.

## Stream, cache and identity boundary

[Read-only stream receipts](stream-boundary.json) used the existing four-second
fixture. Its shared project was intentionally left `anywhere`:

- HLS master returned the same724bytes/hash without a token, with the site
  Referer, and with a different Referer. A variant advertised FairPlay and
  Widevine DRM key formats. This is manifest metadata, not FairPlay playback.
- One advertised media resource returned879107bytes without a Commerce grant
  or Referer and contained `encv`, `cbcs`, `sinf`, `tenc`, `moof`, `mdat` markers.
  The real browser separately fetched HLS and media fragments and required
  license authorization to decode. There is no per-segment Commerce check.
- A download URL obtained through the authenticated operator API returned200;
  removing `kin_sign`/`kin_ttl` returned403. This distinct MP4 sample had only
  `ftyp`/`mdat` among inspected markers: it is not asserted to be CENC encrypted
  or exposed by the ordinary viewer. No original/source integrity claim follows.
  The known700byte API-size discrepancy remains a separate nonblocking finding.

No media bytes, capability URL, raw token, cookie, callback body, license bytes,
viewer IP/UA or API credential is included here. Direct DASH playback, offline
license persistence, custom-player post-expiry lifetime, Safari/FairPlay and
universal screen-capture prevention were not tested or claimed.

The existing [genuine two-account qualification](../2026-10-15-closed-lms/cross-user-qualification.md)
remains distinct from this synthetic fixture. It proved first-party session
isolation and denied wrong-video/modified-signature/expired/missing tokens, but
an intact fresh A bearer played in B's profile. Commerce's HS256 claims
`iss/aud/sub/vid/iat/exp/jti` and header `kid` protect signed identity and video;
they do not bind the holder to a first-party session, device or origin.

The120second expiry limits new authorization. It does not revoke an issued CDM
license. The prior64.953second active-player stop is measured first-party
refresh behavior, not a security guarantee for a modified player. IP/UA checks
would not distinguish two profiles on the same Mac and are not proposed as
cryptographic non-transferability. Domain restrictions cannot replace this.

## Removal and independent final read-back

[Cleanup receipt](cleanup.json):17:31–17:32UTC. Redacted callbacks were preserved
before route/container removal. Only the recorded copied video and empty
temporary project were deleted; each subsequently returned404. An independent
[later read-back](independent-readback.json) confirmed:

- Temporary container/route absent; ephemeral fixture credentials removed.
- One original Kinescope project with six items; original strict DRM and privacy
  snapshots unchanged; the source video still belongs to the original project.
- Original three native container identities/start times and all eight proxy
  file hashes unchanged. No app restart, financial operation or network removal.
- All four canary roots403; removed fixture POST403; native callback without
  Basic401. The dedicated test Chrome was then closed.
- Native source/image/RootFS admission passed; signed ledger sequence1,
  fenceOPEN and zero leases. Schema fingerprint and role identities are retained
  in [native-admission.json](native-admission.json). No DB/fence reset occurred.

The cleanup driver initially stopped after container removal because Docker's
absent-object diagnostic was lowercase. A separate read confirmed absence;
case-insensitive diagnostic handling resumed the remaining provider deletion.
No container start or financial/provider-create operation was retried.

## Remaining production decision

The owner previously accepted intact-bearer transfer only for the closed MVP,
and explicitly retained further protection in ART-36. Choose a production
requirement before marking this gate Done:

1. Explicitly accept the measured bearer model for launch, including transfer
   while authorization is valid and potentially longer already-issued license
   use. Then qualify the exact live project/video domain configuration for the
   chosen launch origins; do not infer it from this deleted prototype.
2. Require non-transferability. That needs a separately designed trusted player/
   license-broker flow with actual session or proof-of-possession enforcement
   and real browser/CDM evidence. A body customerId, masked IP, UA or allowlist
   alone cannot meet that requirement.

Safari/FairPlay joins acceptance only if included in supported launch browsers.
ART-240/F9/public sales remain closed. No new issue, broader infrastructure
audit, repeat payment or ART-351 qualification was introduced.

## Primary provider references

Checked during this execution: [Authorization Backend](https://docs.kinescope.com/developer-guides/authorization-backend/),
[domain restrictions](https://docs.kinescope.com/content-protection/access-restrictions/),
[project API](https://docs.kinescope.com/api/workspace/projects/),
[video API](https://docs.kinescope.com/api/video/core/) and
[protection API](https://docs.kinescope.com/api/player-delivery/protection/).
Documentation describes the intended contract; the observed results above
come from actual API/player/callback receipts.
