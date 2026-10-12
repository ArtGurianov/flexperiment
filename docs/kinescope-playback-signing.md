# Kinescope playback signing key (ART-221)

Protected playback (`KINESCOPE_DELIVERY_MODE=protected`) hands the player a short-lived token (2 minutes,
at most 10) that Kinescope's DRM license request presents back to commerce (`POST /v1/kinescope/drm/authorize`), where
it is verified against the customer and the video. The key that signs it is the boundary.

## Custody

- The keys live **only** in the commerce service's secrets. No other service, image, repository or log
  holds them, and the recovery bundle (deploy/host/flexperiment-recovery-backup) does not either: nothing
  stored depends on a key, so a lost one is replaced by minting a new key, not restored.
- A refref-mode runtime does not start in protected mode without a valid keyring, and no runtime starts
  with an invalid or ambiguous one (`KINESCOPE_DRM_TOKEN_KEYS_AMBIGUOUS`, `…_KEYRING_INVALID`,
  `…_SECRET_TOO_SHORT`, `…_KEY_ID_INVALID`).

```
KINESCOPE_DRM_TOKEN_KEYS={"2026-10":"<at least 32 random bytes>"}
KINESCOPE_DRM_TOKEN_CURRENT_KEY=2026-10
```

The single legacy `KINESCOPE_DRM_TOKEN_SECRET` still works (key id `legacy`); setting it together with the
ring is refused.

## Rotation

Tokens name their key (`kid`). Any key in the ring verifies its own tokens; only the current key signs.

1. Add the new key to `KINESCOPE_DRM_TOKEN_KEYS`, keep `…_CURRENT_KEY` on the old one. Deploy.
2. Set `…_CURRENT_KEY` to the new key. Deploy. New tokens are signed with it; old ones still verify.
3. After at least 10 minutes (the longest token lifetime), remove the old key. Deploy. A token naming it is
   refused (`PLAYBACK_TOKEN_KEY_UNKNOWN`).

Suspected exposure: skip the wait — remove the old key in step 1's deploy. Playback in progress
re-requests a token on its next license request.

## What is proven, and what is not yet

Proven in commerce-v2's tests: a token is bound to its customer and video, expires, survives rotation only
while its key is in the ring, and cannot be relabelled to another key.

**Capability preflight (ART-342, 2026-10-12):** the paid workspace has an API token,
but authenticated `GET /v1/drm/auth` at both workspace and Flexperiment-project
scope returned `404 / 400404`, which Kinescope documents as authorization
disabled. Its [Authorization Backend guide](https://docs.kinescope.ru/instrukcii-dlya-razrabotchikov/avtorizatsionnyy-bekend-dlya-kontrolya-dostupa-k-video/)
documents a callback URL, Basic Auth and `drmauthtoken`; its
[DRM API reference](https://docs.kinescope.com/api/player-delivery/protection/)
documents `strict`. A configured callback must use `strict=true`: with
`strict=false` Kinescope grants a license on any response except `403`, while
this endpoint returns `401` for bad Basic Auth and `400` for malformed input.
No provider configuration was changed; account-specific PUT entitlement and a
Kinescope-origin POST remain unproven. Decision: `HOLD_PROVIDER_CONTRACT`.

**Not yet proven (ART-36):** how Kinescope itself enforces the
license — whether every segment is checked, what the browser sees as the video identifier, referrer and
domain restrictions, and what revoking access does to a session already playing. ART-36's decision record
states those from a working prototype against the real account; until then protected playback is not
qualified for sale (ART-240).

## Video upload/binding and webhook authority (ART-217)

The Payload lesson-video editor calls an author-checked platform endpoint (authenticated `req.user`), which asks Commerce `POST /v1/internal/video-uploads`. Commerce alone holds the Kinescope Bearer API token, and calls `POST https://uploader.kinescope.io/v2/init` using `type: video`, lesson-folder `parent_id`, `title`, `filename` and `filesize`. Return only an opaque upload-session ID and `data.endpoint`; the browser sends file bytes directly to that Tus endpoint with `tus-js-client`, never receiving the provider API token or video ID.

The status moves `UPLOADING → PROCESSING → READY | FAILED`. `POST /v1/webhooks/kinescope` receives `media.update.status` events authenticated with dedicated **Basic auth only**: there is no event signature, delivery ID or ordering guarantee. Validate the event, dedupe by `videoId + status`, **always re-read authoritative video status from Kinescope**, and apply monotonic transitions; polling recovers missing webhooks. Atomic replacement keeps the previous lesson binding live until the new video reaches READY, and failed or abandoned replacements leave the old binding unchanged. Only `durationSeconds` is persisted back to Payload. The provider video ID and secret bindings remain private in Commerce.

## Exact lesson playback authorization (ART-218)

`decideLessonAccess(customer?, lesson, courseProduct, grants, overrides)` must evaluate in this order:

1. Missing authenticated session → `SIGN_IN_REQUIRED`.
2. Unknown or never-published lesson → `DENY`.
3. WITHDRAWN course or lesson → `DENY` for everyone.
4. Active unrevoked COURSE/ALL_COURSES grant → `ALLOW` even if unlisted, stale lease or DENY_NON_ENTITLED override.
5. Expired manifest lease → `DENY` for customers without a grant.
6. Course/section/lesson effective visibility unlisted or active DENY_NON_ENTITLED override → `DENY`.
7. `products.access = FREE` → `ALLOW` (product authority, not offer).
8. Lesson freePreview → `ALLOW`.
9. Otherwise → `PURCHASE_REQUIRED` or `NOT_FOR_SALE`.

`POST /v1/lessons/{lessonRef}/playback` requires a session, is rate-limited, sends `Cache-Control: no-store` and discloses nothing about other customers' rights. A grant is `{mode:"open", videoId, resumeAt}` or `{mode:"protected", videoId, token, expiresAt, resumeAt}`. Protected tokens are short lived and bound to customer/video; the DRM callback re-checks current entitlement and withdrawal on use. Core Commerce v2 `/readyz` also verifies Refref reachability; the implementation returns 503 when the configured Refref `/readyz` is unavailable (see `commerce-v2/src/app.ts` and `docs/plans/2026-10-10-commerce-v2-foundation-design.md`). DB and configuration faults also fail readiness. This supersedes the older ART-218 baseline that isolated Refref health exclusively at feature boundaries.

## Playback resume and player behavior (ART-219)

Only the latest per-user/per-lesson position is stored, not percentage, course completion, streaks or certificates. `PUT /v1/lessons/:lessonRef/resume` is authenticated and no-store; order writes first by `clientTs`, then `clientSeq`, so late older packets cannot roll progress back. Save every approximately 15 seconds during playback, on pause and on `pagehide` (beacon). `resumeAt` arrives in the playback grant; seek once player is ready, but start from zero if prior position is within the final 20 seconds of the video. Disable Kinescope localStorage resume entirely. Protected player uses `drmauthtoken`, refreshes before expiry, refuses expired credentials and stops on revoked access; token-free open playback remains distinct.
