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

## Build evidence: the dependency is patched

`patches/@kinescope__react-kinescope-player@0.5.4.patch` fixes the library's
`Loader`, which otherwise reaches `handleJSLoad` during render — before the
element it mounts into exists — and latches, so the player is never created at
all. A build that silently drops the patch produces a page with zero player
iframes and no error.

Two consequences for publication:

- **A release build must not reuse a `.next` cache.** Webpack keys the chunk on
  the package identity, not its contents, so a rebuild after a patch change
  serves the previous chunk. Build from `rm -rf .next out`, and treat a build
  that did not do so as no evidence at all.
- **Assert the fix reached the bundle**, not just the working tree:

```sh
grep -ho 'componentDidMount=function(){this\.jsLoading()}' \
  out/_next/static/chunks/*.js | head -1
```

An empty result means the patch did not make it into what ships.

## Acceptance checks on the deployed page

- Both hero surfaces have an `iframe`; zero is the failure this patch fixes.
- The square backdrop is filled edge to edge, with no band above or below.
- The foreground player has no overlay of ours in front of it: a press must
  reach the iframe, because user activation is not propagated into a
  cross-origin frame and cannot be proxied.
- On a physical iPhone: one tap on the player's own button starts playback;
  fullscreen enters and exits; controls still take touches afterwards.
