# Closed canary Kinescope mechanism and limits

Status: functional provider prototype verified; production security acceptance remains open.
Date: 15 October 2026. Evidence belongs to ART-336 / ART-36 / ART-338.

## Verified mechanism

Commerce mints a short-lived HS256 JWT at the authenticated, consent-gated playback endpoint. Claims carry issuer/audience, customer, video, issue/expiry times and a unique token ID; a key ID selects an owner-custodied signing key. The normal two-minute token is passed to the iframe in `drmauthtoken`. It is a bearer, not a browser/device/origin-bound credential. Authenticated lesson delivery necessarily reveals the video identifier to that viewer; public HTML/content APIs do not expose it.

Kinescope's project Authorization Backend forwards VOD requests to the exact canary callback. Provider Basic Auth, signed token, exact video binding, current consent, entitlement, visibility and withdrawal are checked under the existing erasure fence. Project `strict=true` was independently read back; no provider settings changed in this execution. Positive license responses correlated with actual callback audits and completed playback, rather than operator-origin positive probes.

Actual Chrome/provider evidence:

| Case | Commerce / provider result |
| --- | --- |
| FREE, manual PAID, explicit freePreview | protected grant; license200; DRM_ALLOWED; four-second clip ended |
| Revoked manual entitlement | new grant403; unused unexpired pre-revoke grant license403; DRM_DENIED/NOT_FOR_SALE |
| Atomic withdrawal | new grant403/DENY; unused unexpired pre-withdraw grant license403; DRM_DENIED/DENY |
| Naturally expired genuine grant | provider license403; no playable video |
| No drmauthtoken | provider license403; no playable video |
| Wrong video (operator callback negative) |403 / PLAYBACK_TOKEN_VIDEO_MISMATCH; not presented as a provider-origin test |
| Anonymous browser | grant401; no token |
| UNLISTED with active PAID entitlement | authoritative public course/lesson404; private course200/no-store; explicit relist afterwards |

## Limits

New license authorization checks current policy. A successful license may already have delivered decryption capability and buffered encrypted media; JWT expiry/revocation does not establish immediate revocation of every previously issued license or segment. Do not claim per-segment access checks or immediate interruption from new-license denial. Foreground active-playback and grant-refresh measurements use a separate real 150-second owner-derived clip; their final results are recorded in the execution record.

The original client recreated its iframe on every renewed grant and interrupted active playback. Actual foreground samples on Platform463 showed playback paused at61 seconds after renewal. The initially proposed in-place SDK token update (PR231) timed out against the real player and was superseded before deployment. PR232 uses a fresh authorized iframe, retaining the latest same-video position and playing/paused/ended intent; it seeks and continues only an already playing session. PR233 adds an independent expiry deadline, removing the old player even if renewal transport hangs, with cancellation guards against late success. No JWT TTL or erasure enforcement change. Final live continuity and resume results belong to the execution record.

Production LAB videos share the provider project. No live callback-outage/timeout experiment or provider-setting change was performed against that shared project. Strict fail-closed configuration and real403 behavior are proven; actual provider5xx/timeout behavior remains an explicit release qualification gap. Referrer/domain restrictions and browser-specific DRM variants are not asserted qualified by the Chrome test.

## Download follow-up

Authenticated provider API returns expiring download credentials (`kin_sign`, `kin_ttl`). Removing them yielded403. No unsigned download bypass was observed. For the current1080p variant, API size1,330,494 differs from independently read CDN Content-Length/actual bytes1,329,794 by700bytes. Full and requested-range GET both returned200 and identical SHA256 `2395244c9ba2c2df08a58e6e6d7adbb6ec2a220be183bb67532ad24d9fee213d`; the server ignored Range and omitted Content-Range/Content-Type. Cause of the metadata difference is unproven. It is not compared with originaltour.mp4 or declared a bit-for-bit source integrity PASS.

## Boundaries

No production/V1/Refref/Mikluha, public payment, registration, marketing or F9 change. No raw token, cookie, provider credential/body or owner PII is included. Signed ledger, installation binding, independent fence and recovery keys remain preserved. Finite canary health is not production reliability qualification.

References: `commerce-v2/src/playback-auth.ts`, `commerce-v2/src/app.ts` at e81b93004feab9f90f6b8e4a84049c80afde2a40; PR230, PR232 and PR233; https://docs.kinescope.com/developer-guides/authorization-backend/ ; https://docs.kinescope.com/player-docs/embedding/iframe-api-control-player/
