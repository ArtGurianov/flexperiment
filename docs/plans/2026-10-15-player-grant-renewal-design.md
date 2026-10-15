# ART-338: preserve playback through protected grant renewal

## Evidence and decision

The original player effect destroys/recreates its iframe whenever a protected
JWT renews (two-minute TTL, refresh30seconds before expiry). It seeks the new
instance but leaves it paused. A real150second owner-derived upload reproduced
two iframe identities and playback remaining paused at61seconds on Platform463.
The original four-second clip cannot qualify this boundary.

PR231 proposed updating the token in place through the documented
`setPlaylistItemOptions({drm:{auth:{token}}})`. Exact-head CI passed and the code
merged, but **it was not deployed**: actual SDK qualification repeatedly reached
that method and returned `Response timeout (5000)`. A published interface is not
a successful runtime acknowledgement. Do not deploy that candidate or assert
that this method worked. Its uncertainty remained fail-closed.

Use the existing proven fresh-grant iframe path and preserve play intent and
latest observed position. `Playing`, `Pause` and `Ended` track intent. On a
successful same-video/mode renewal, remove the old iframe, seek the authorized
replacement and call its supported `play()` only if the viewer was playing.
Paused/ended media stays paused. A different video or a newly keyed lesson does
not inherit autoplay. A brief license/rebuffer transition is possible; there is
no claim of one uninterrupted encrypted media session.

## Safety

The authoritative grant endpoint, JWT lifetime, current policy checks and
existing finite grant-request retries remain unchanged. Denied/expired/failed admission
removes the player without replacement. Old media is never kept as an
availability fallback. No uncertain SDK token mutation is repeated. A failed
new iframe shows the existing error state; browser autoplay refusal leaves the
valid new player's normal controls available for an explicit Play.

Expiry has its own timer, independent of request rejection. A never-settling renewal
is aborted and the old player removed at its existing deadline. Late successful
responses cannot reopen it. An old timer cannot clear a newer accepted grant.

The accepted-grant ref is written at the asynchronous state-commit boundary.
Cleanup compares it to the outgoing video/mode before preserving play intent.
Old listeners and late create/read/grant responses are cancelled, so they cannot
change a replacement's position or restart media after unmount. Cleanup saves
known observed progress without starting a stale asynchronous SDK read.

## Verification

Component regressions cover playing/paused/ended renewal, latest-time resume,
401/403/503 denial, failed iframe, browser autoplay refusal, late events/creates/
grants, new video/lesson and transport failure through the old expiry. All
Platform tests, types and lint must pass, followed by exact-head and merged-main
CI. Build/qualify only the final immutable Platform artifact; preserve Commerce,
Admin, current SQLite and erasure authority. Then repeat actual150second playback
across renewal, non-end-window pause/reload resume and active-session revocation.
Until these finish, component tests are not live continuity proof.

References: installed Next16.3.3 client-component guide; React19.2.8;
[Kinescope control API](https://docs.kinescope.com/player-docs/embedding/iframe-api-control-player/).
