# Kinescope playback signing key (ART-221)

Protected playback (`KINESCOPE_DELIVERY_MODE=protected`) hands the player a short-lived token (2 minutes,
at most 10) that Kinescope's DRM license request presents back to commerce (`/kinescope/drm/auth`), where
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

**Not yet proven (ART-36, HOLD on Kinescope API access, ART-212):** how Kinescope itself enforces the
license — whether every segment is checked, what the browser sees as the video identifier, referrer and
domain restrictions, and what revoking access does to a session already playing. ART-36's decision record
states those from a working prototype against the real account; until then protected playback is not
qualified for sale (ART-240).
