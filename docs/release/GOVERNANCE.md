# Repository governance

Every safety property in [`DEPLOYMENT_INVARIANTS.md`](DEPLOYMENT_INVARIANTS.md)
assumes two things that are not properties of this repository's code: that `main`
cannot be rewritten, and that a production deployment is a deliberate act. Until
GitHub enforced them, both were conventions — the controller could refuse an
unsafe promotion while nothing stopped a force push from moving the ground it
stood on.

## Settings in force

| Control | Setting |
|---|---|
| `main` force push | denied |
| `main` deletion | denied |
| `main` direct push | denied — changes go through a pull request |
| `main` required check | `test` (GitHub Actions, app id 15368), strict |
| Bypass | admins included; no bypass allowlist |
| History | linear required; conversations must resolve |
| `production` environment | required reviewer before any deployment job runs |
| `production` branches | `main` only |

## What single-maintainer changes

This repository has one collaborator. That does not weaken the force-push,
deletion or required-check controls at all — those are machine-enforced and have
no human in them.

It does change what the review controls mean. `prevent_self_review` is
deliberately **off**, and required approvals are **0**: with one maintainer,
either would make `production` undeployable and `main` unmergeable, which is a
lockout rather than a control. What remains is real but should be named
accurately — these give **deliberateness**, not separation of duties. The
production reviewer prompt is a stop before a deployment job acquires anything;
it is not a second pair of eyes, and no one should reason as though it were.

The one incident this would have caught was not a disagreement between two
people. It was a `prepare` dispatched before anyone had checked whether an abort
path existed, which paused production for 12h09m. A prompt was all that was
missing.

## Proof

Settings can be read back as configured and still not be enforced, so each was
probed against the live remote rather than trusted from its API response.

| Probe | Result |
|---|---|
| direct push to `main` | rejected — `GH006`, naming both the PR requirement and the `test` check |
| force push to `main` | rejected — `GH006` |
| delete `main` | rejected — refused as the current default branch |
| merge with `test` not yet green | blocked — PR unmergeable while the check is pending |
| merge with `test` green | permitted — this document's own pull request |

The last two are why this file arrived through a pull request instead of a push:
the positive probe has to be a real merge, or it proves only that the negative
ones fire.

Note that the deletion refusal above is issued by the default-branch rule, which
fires before `allow_deletions`. Both are set; only one gets to speak. If `main`
ever stops being the default branch, that probe stops proving what it appears to.
