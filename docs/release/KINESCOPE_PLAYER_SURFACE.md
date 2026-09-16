# Kinescope player surface

The two hero video surfaces are cross-origin Kinescope embeds. Three things
that used to live in this repository now live outside it, and none of them
fail loudly: a provider-side change lands on production without a deploy, and
without a diff.

This file is where they are written down. It is an acceptance checklist, not a
dispatch input — promoting any of it to a required input of
`controlled-production-deploy` is a separate decision.

## Provider configuration this release depends on

Set account-wide in the Kinescope dashboard, served with the embed document:

| Setting | Required value | What breaks without it |
| --- | --- | --- |
| `ui.videoFit` | `cover` | The 16:9 backdrop letterboxes inside its square container and the player paints those bands opaque over the local poster. |
| `theme.colors.primary` | `#B7FF00` | The player's own play button — the only watch affordance there is — stops matching the brand. |
| Corner radius | `0` | The player draws its default 12px radius and the page background shows through the corners. |
| iOS pseudo-fullscreen | enabled | `HeroVideo` implements the documented parent side of this bridge; with the provider side off the player uses native fullscreen, which iOS does not support for a cross-origin frame. |

`ui.videoFit` is the one with no local fail-safe. It was briefly carried as a
prop through a dependency patch and that was removed deliberately, so the only
thing standing between a dashboard reset and a visibly broken hero is this
table.

### Verifying it

The embed document carries the resolved configuration, so it can be asserted
from anywhere without credentials:

```sh
for id in i7n65WzZnSd4bVUBE1mzi5 8ELYTMWXYgz19TjEzqK75J; do
  curl -s "https://kinescope.io/embed/$id" \
    | grep -oE '"(theme|ui)":\{[^{}]*(\{[^{}]*\}[^{}]*)*\}'
done
```

Expect `"videoFit":"cover"` in `ui`, and `"colors":{"primary":"#B7FF00"}` in
`theme`, for both IDs.

## Build evidence: the images are built in CI

`Test` builds all three production images — `Dockerfile.frontend`,
`Dockerfile.admin` and `Dockerfile.commerce`, each with Coolify's own context
— from a clean checkout, without a registry or production secrets.
`commerce` and `commerce-worker` share one image and differ only in `command`,
so one build covers both.

That job exists because of how the `a9ea010` deploy failed: the wrapper this
surface used to depend on needed a dependency patch, a patched dependency is
an input to `pnpm install`, and no Dockerfile copied the patch into the image.
Every other check passed, because none of them built an image, and the first
thing ever to attempt it was the production deploy — which had already
advanced `production-deploy`.

The wrapper and its patch are gone now, but the gap they exposed is the point:
the successful `Test` run that generic publication accepts as provenance for
an exact SHA now covers buildability of every deployable artifact of that SHA,
not just its tests.

A local `docker build` remains a debugging convenience. It is not release
evidence, and neither is a local `next build`, which cannot see a Docker layer
at all.

## Acceptance checks on the deployed page

- Both hero surfaces have an `iframe`; zero is the failure this patch fixes.
- The square backdrop is filled edge to edge, with no band above or below.
- The foreground player has no overlay of ours in front of it: a press must
  reach the iframe, because user activation is not propagated into a
  cross-origin frame and cannot be proxied.
- On a physical iPhone: one tap on the player's own button starts playback;
  fullscreen enters and exits; controls still take touches afterwards.
