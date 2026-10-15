# ART-338: renew a protected grant without interrupting playback

## Finding and decision

The existing player effect depends on the complete grant object. A successful
refresh at expiry minus 30 seconds destroys the current iframe, seeks a new one,
and leaves it paused. This makes the two-minute token lifecycle interrupt a long
lesson. The short owner clip cannot qualify continuity across this boundary.

Keep one instance per lesson/video/mode and use Kinescope's documented
`setPlaylistItemOptions({drm:{auth:{token}}})` for a same-video renewal. The grant
endpoint and current access policy remain authoritative. Do not extend token TTL.
Remounting with autoplay restoration would still replace the encrypted media
session and introduce seek/audio races; suppressing renewal would lose the
existing revocation check. Neither is necessary.

## Lifecycle and failure contract

The asynchronous accepted-grant boundary stores a snapshot and commits React
state. Instance creation depends on primitive video/mode identity, rather than
the changing token. A new lesson gets a fresh keyed session; a new video binding
replaces the instance. No token enters server-rendered/public content.

A renewal is committed only after the existing SDK instance acknowledges the
token update. The acknowledgement deadline is at most five seconds and always
before the previous grant expires. Rejection or an uncertain SDK result removes
the player; it is not retried. Late results after unmount cannot authorize a new
instance. Existing finite retries for failed GET transport remain bounded by the
previous expiry. A denied grant, failed admission, revoked consent or session
continues to remove the player. No cached-authority or erasure fallback is added.

## Verification

Use fake-clock component regressions for in-place renewal, no extra seek/destroy,
denial, SDK rejection/timeout, unmount races, new binding and new lesson. Then run
Platform tests/types/lint and exact-head CI. Build and qualify the exact immutable
Platform artifact; retain Commerce/Admin and the SQLite/erasure authorities.
Finally use the real uploaded 150-second owner-derived fixture to observe
continuous playback across renewal, persisted non-end-window resume, and
revocation during an already-started session. Until these run, component checks
are not a live continuity proof.

References: installed Next16.3.3 client-component guide; React19.2.8;
[Kinescope IFrame control API](https://docs.kinescope.com/player-docs/embedding/iframe-api-control-player/).
