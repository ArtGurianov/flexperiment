# ART336 — accept the provider's VOD authorization contract

## Observed boundary

Closed canary now has a real owner magic-link session, authenticated required
consents and a protected Commerce grant. The existing Tus upload became READY
and acquired a binding without reupload. The real player receives a nonempty
`drmauthtoken`; its license POST receives403 and emits ERR-DRM-LICENSE. Project
GET confirms strict=true, expected callback and matching Basic credentials; an
authenticated schema probe reaches Commerce. This is not yet playback PASS.

The [current Kinescope contract](https://docs.kinescope.com/developer-guides/authorization-backend/)
specifies `type: "vod"` for video callbacks. Commerce accepted only `"video"`,
therefore it deterministically rejected a valid documented request before token
and entitlement validation. The new canonical VOD regression reproduces400
instead of200 on the previous source. Exact cause of every earlier403 is not
claimed until a real provider callback succeeds after deployment.

## Choice

Accept exact `vod` plus the existing `video` operator-probe compatibility alias.
Reject live/unknown types, missing/empty tokens and malformed IDs as before.
Removing the alias would unnecessarily break existing qualified diagnostics;
accepting arbitrary types would widen the lesson-only boundary. Neither is
needed. No Kinescope project setting change, enforcement bypass or browser-token
fabrication is involved.

Basic Auth, signed short-lived token/video binding, required consent, current
access/withdrawal decisions, no-store and erasure fencing remain mandatory.
Tests exercise canonical and alias requests through the real handler, unsupported
types, missing authentication/token, wrong video, withdrawal and consent loss.
The two canonical tests fail against the old handler and pass after this fix.

## Delivery / acceptance

Owner's current autonomous canary GO permits engineering, merge and deployment
without another per-step approval. Use green exact-head and merged-main CI,
a new private digest-qualified Commerce image, retained Platform/Admin images
with Platform expected upstream refreshed, current-data backup and normal
prepareErasureRuntime startup. Preserve signed authority and present course,
owner account/consents and READY binding. No real customer/production changes.

Then repeat the actual UI journey. Require provider-origin authorization, license
success and observed playback, followed by deny/revocation/resume checks. Local
unit tests or a manually invoked callback alone are not that acceptance.
