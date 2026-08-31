# Epoch A terminal baseline

**Status: terminally complete. This record is evidence only and is not authorization for Epoch B.**

Epoch A (`epoch-a-dormant-notifications:80e152259628719af20d363a76ed6b991d67482a`) completed successfully in GitHub Actions run `33392383538` from controller `main` commit `15e3245ba5f1f7d32c45779341a423bac3591a83`.

## Immutable runtime identities

```text
Epoch A runtime R      = 80e152259628719af20d363a76ed6b991d67482a
R direct parent        = 0ddc33d0fd0077fe0ba238ec75ae4090fc38ac34
production-deploy      = 80e152259628719af20d363a76ed6b991d67482a
runtime-candidate      = 80e152259628719af20d363a76ed6b991d67482a
R tag ref              = refs/tags/epoch-a-runtime-r-80e152259628
R tag object           = 5b4a00791cd89c2773aebdcacde4b8dae5b95cb1
```

## Terminal authority state

Authenticated terminal proof from run `33392383538` established:

```text
Epoch A completion             = exact COMPLETE record and expectations
sales_paused                   = false
owner_release_id               = null
owner_mode                     = null
runtime / worker               = exact R
active legal version           = 2026-08-26.1
occurrence notification cap.   = dormant / false
outbox attempt authority       = ATTEMPT
email dispatch                 = open
outbox dispatch owner          = null
emergency sales latch          = unchanged
```

The `complete` run performed no candidate acquisition, no pointer CAS, and no deployment. It re-proved the paused exact-R state and compatibility evidence immediately before the controlled release-control reopen, then authenticated the terminal open state and exact completion expectations.

## Epoch B boundary

Epoch A completion is a prerequisite and evidence handoff only. It does **not** authorize legal publication, a new release owner, a new runtime candidate, a production pointer change, a deployment, notification activation, or an E2E notification send.

Before any Epoch B production action, a separately reviewed Epoch B design/controller must fail closed unless it proves at least:

- this exact Epoch A completion record;
- `production-deploy == R` and runtime/worker exact R;
- active legal release remains `2026-08-26.1` before Epoch B publication;
- notification capability remains dormant before the activation boundary;
- release owner is null and release sales gate is open at fresh acquisition;
- outbox authority remains `ATTEMPT`, dispatch is open, and dispatch owner is null;
- emergency authority has not been silently repurposed;
- any Epoch B runtime P is a single-parent direct child of exact R;
- legal publication of `2026-08-28.1`, P promotion/deployment, activation certification, and final reopen are separately guarded and replay-safe.

Until that controller is reviewed and separately authorized, **Epoch B is NO-GO**.
