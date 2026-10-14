# ART-337 stopped-resource and timer repair design

Owner scope: ART-337_RECOVERY_REPAIR_PREP. Engineering only; live execution HOLD.
Continue existing UUID irskrskdhh2addt3xbkpbnrr and exact fsynced creation
intent/outcome. Source remains085, journalv2/schema26 and all recovery custody
are preserved. The only accepted initial deviation is auto-deploy true;
previews false, env/mounts empty, runtime stopped and queue empty are mandatory.

## Decisions

Use explicit one-shot settings PATCH after readonly reconciliation. Preserve
an independent successful readback receipt before provisioning. Do not replay
creation or infer success from a lost response. Repeat current settings/
topology/isolation around later privileged writes.

Pin installed canary timer/helper contracts. Check jobs, PIDs/cgroups, orphan
helpers and failure handlers along with DB writers. Disable only the two canary
timer instances, stop drained services, preserve pre-stop evidence and shared
files. An in-flight backup remains HOLD; do not kill an uncertain operation.
Fresh readonly reports bind completed isolation without changing its history.

After installed artifact/readiness qualification and backup lookup adoption,
run a new actual scheduled backup. Off-VPS independent decrypt/restore/copied
fence boot and current remote bytes qualify one timer-restoration operation.
Activation and final readback are separate; OnBootSec work is observed and the
latest archive must bind its own independent proof.

## Verification and authority

Execute literal captured4.4.6 database defaults/request cleanup/creation/PATCH
in PHP replay. Inject resource changes, lost replies, settings flips, unknown
jobs/leases/source/ledger/proofs and filesystem faults. Actual systemd runs
only on random disposable CI-VM proof units with synthetic local effects; no
installed VPS units or provider data are used. Real Python3.10 and exact-head
CI remain mandatory. The existing local registry/Compose/runtime proof must
exercise the true creation default followed by the separate settings PATCH.

New independent review and owner execution GO are required on the final SHA.
The previous c73 GO cannot authorize these new operations. See the canonical
immutable recovery runbook for commands and proof contracts.
