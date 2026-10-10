# Commerce V2 deployment foundation

Owner-approved F3 scope. This is not the destructive F9 cutover, R10 merchant
conformance, a payment authorization or email/sales activation.

## Independent lifecycle

The dedicated workflow admits main's exact SHA with its own successful `test`
and `docker-build` checks. It deploys canary, qualifies it, then repeats admission
and deploys isolated production. Dedicated V2 refs use compare-and-set; no V1
ref/controller, domain, service, DB or secret changes. Coolify owns lifecycle.
The control API token remains in owner storage on the VPS, never in the runtime.
Missing owner token/app configuration stops deployment, not engineering work.

Coolify queue creation uses POST `/deploy?uuid=<known-app>&force=false`, only
after the existing isolation check. GET is not a fallback and failures do not
trigger a second request. The owner boundary regression checks both targets,
the exact method/scope and private queue journal. After a refused attempt,
reconcile the saved pin/env and queue before resuming with the new admitted
main SHA; a saved source pin alone is not deployment evidence.

## Restricted foundation boot

`COMMERCE_V2_FOUNDATION_MODE=true` boots the real Commerce V2 app and schema,
but exposes only GET `/identity` and `/readyz`. Every other route fails closed.
It constructs no F7 rail, auth/email sender, Kinescope client or external worker.
`PAYMENT_MODE=disabled` and `MARKETING_BROADCASTS_ENABLED=false` are mandatory.
This explicitly restricted profile makes foundation independent of NotiSend
PR #180. It is not a fake email relay or a claim of merchant checkout readiness.
Ordinary startup remains unchanged and retains its existing secret requirements.
Leaving foundation requires a separately qualified full application configuration.

The baked identity file is required. Readiness checks the actual SQLite lineage
and ledger plus a bounded, non-redirecting, unauthenticated GET to the appropriate
Refref ops `/readyz`. No merchant/bank API calls or credentials are used. Failure,
malformed/oversized responses or a negative dependency check produce HTTP 503.
A runtime-only service token is mandatory, even though internal routes remain
closed in this phase; no development secret fallback in deployed foundation.

Coolify's HTTP healthcheck is GET `/readyz`, port 3002, expected HTTP 200.
The runtime image includes `curl`, which Coolify invokes inside the container.
The existing actual-image CI gate verifies curl against `/identity` and verifies
that curl fails with HTTP error exit 22 when Refref is unavailable (HTTP 503).
Readiness is not replaced with an always-successful probe. Do not disable the
healthcheck to recover a deployment rejected because curl was absent.

## Persistence and recovery

Each app has unique data and backup volumes. A technical marker is committed
to SQLite before restart and redeploy, then independently read afterward. Online
SQLite backup, not a raw copy of a live WAL database, produces an age-encrypted
snapshot in the app's separate backup volume. Temporary plaintext is owner-only
and removed on success or failure. Per-environment recipient/path configuration
is required. Ciphertext must also be exported to owner recovery storage; a local
backup volume alone is not disaster recovery. Restore is independently tested.

Production promotion requires canary identity, readiness, persistence and backup
proofs for the exact source. Errors stop the sequence, leave payment disabled,
and never automatically revert migrations or retry uncertain deployments. F3
issues remain open where full platform/admin/LAB/live acceptance is incomplete.

## Owner configuration and supported execution

`/root/flexperiment-v2-owner/deploy-config.json` (root, 0600) maps exactly two
app UUIDs: `apps.canary` and `apps.production`. The Coolify API credential stays
in `/root/flexperiment-v2-owner/coolify-api.token` (root, 0600); no runtime or
workflow receives its value. The owner RPC only permits those app identities,
source pin changes, Coolify lifecycle operations, storage proofs and safe reads.
Existing NotiSend configuration is preserved but inactive in foundation mode.

Both apps require runtime variables below. Only `SOURCE_COMMIT` is also a build
variable; its value is set by the admitted exact-source controller.

| Variable | Canary | Production |
| --- | --- | --- |
| `NODE_ENV` | `production` | `production` |
| `DEPLOY_ENV` | `staging` | `production` |
| `COMMERCE_V2_ENVIRONMENT` | `canary` | `production` |
| `COMMERCE_V2_FOUNDATION_MODE` | `true` | `true` |
| `PAYMENT_MODE` | `disabled` | `disabled` |
| `MARKETING_BROADCASTS_ENABLED` | `false` | `false` |
| `KINESCOPE_DELIVERY_MODE` | `open` | `open` |
| `PORT` | `3002` | `3002` |
| `MERCHANT_PROMOTION_PREFIX` | `FX-` | `FX-` |
| `REFREF_READINESS_URL` | `https://canary-ops.refref.ru/readyz` | `https://ops.refref.ru/readyz` |
| `COMMERCE_V2_DATABASE_PATH` | `/var/lib/flexperiment-v2/commerce.sqlite` | same container path, different volume |
| `COMMERCE_V2_BACKUP_PATH` | `/var/lib/flexperiment-v2-backups` | same container path, different volume |
| `COMMERCE_V2_BACKUP_AGE_RECIPIENT` | approved public Flexperiment recovery recipient | approved public Flexperiment recovery recipient |
| `PLATFORM_SERVICE_TOKEN` | independent private owner token, runtime only | independent private owner token, runtime only |

No domain or host-port mapping, auto-deploy or preview deployment. Two named
volumes per app, prefixed by that app's UUID; no shared V1 volume or host bind.
Do not install bank/merchant API credentials for foundation.

The manual GitHub workflow needs existing owner SSH transport in environment
`production`: `RELEASE_RUNNER_HOST`, `RELEASE_RUNNER_SSH_KEY`, and
`RELEASE_RUNNER_KNOWN_HOSTS`. Missing transport stops before deployment. These
secrets were not present at initial inventory; defining a workflow does not
claim they have been installed. Never export the GitHub Coolify secret.

The same controller can run locally with the already approved owner SSH alias
(without copying a private key into GitHub). Stage the exact committed helper
at `/root/flexperiment-v2-owner/controllers/<SOURCE_SHA>/owner-rpc.py`, then run
from a clean checkout of that source:

```zsh
export V2_SOURCE_SHA="$(git rev-parse HEAD)"
export V2_OWNER_HOST=flexperiment-vps
export V2_RPC_SHA256="$(shasum -a 256 scripts/v2/owner-rpc.py | cut -d ' ' -f 1)"
export GITHUB_REPOSITORY=ArtGurianov/flexperiment
GH_TOKEN="$(gh auth token)" node scripts/v2/deploy-cli.mjs
```

This is not an admission bypass: the controller still requires the exact live
main head and its successful CI, performs only dedicated V2 ref CAS, and stops
on ambiguous lifecycle or transport errors. Do not use it for a PR head.
Archived ciphertext and safe per-environment proof are saved under the owner
root's `backups/` and `evidence/` directories. This PR does not install backup
timers or claim an off-site disaster-recovery proof; preserve/export ciphertext
to independent owner recovery storage before relying on it for recovery.
