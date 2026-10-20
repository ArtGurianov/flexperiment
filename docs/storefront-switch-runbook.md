# Storefront switch: first sale, emergency stop and recovery (ART-319)

The storefront switch is the one operator control over **new paid money** in Flexperiment, one
state per storefront: `COURSES` (online courses and the bundle) and `LAB` (master classes). It is
both the first-sale gate and the emergency stop, and it replaces `sales_activation` (design
[2026-10-18 §1](plans/2026-10-18-commercial-admission-lab-editions-design.md)).

| | |
|---|---|
| Authority | `<root>/switch/switch.json` and its append-only journal `<root>/journal/journal.jsonl` on the VPS, `<root>` = `/var/lib/flexperiment-sales-canary` or `/var/lib/flexperiment-sales-production` |
| Only writer | the owner, as root over SSH: `scripts/v2/storefront-switch.py` |
| In Commerce | `<root>/switch` bind-mounted **read-only** at `/etc/flexperiment-sales`, `<root>/journal` at `/etc/flexperiment-sales-journal`; the runtime user can write neither |
| Fail closed | missing, unreadable, invalid, writable, not the journal's last record, wrong scope, older generation, reused generation: CLOSED |
| Read-back | `storefront-switch.py status --container …` (host and runtime view), `/readyz` `capabilities.salesSwitch` |

## What it is not

- Not `PAYMENT_MODE=disabled`. That is environment configuration and needs a redeploy; it also
  stops refunds' rail. The switch needs no deploy and never touches refunds.
- Not an offer's `sale_mode`, and not Control Room "Pause all". Those are ordinary commercial
  edits by a Control Room session: closing an offer stops **new quotes** but lets an issued quote
  be confirmed within its deadlines. The switch is independent of the Control Room session and of
  the merchant database, and it ends issued quotes (below).
- Not the LAB occurrence lifecycle. A cancelled occurrence is a LAB fact, not a stop.
- Not a defence against code already running inside Commerce. The read-only mount stops the
  Commerce process from rewriting the switch, but compromised Commerce code can skip its own
  check. The control outside Commerce for that case is Refref's operator payment stop
  (ART-303, Refref `ops/runbooks/stop-sales.md`); until it exists that residual risk is the
  owner's accepted same-process risk.

## What a stop does, and what it never does

Commerce reads the file on every admission, never from a cache. While a storefront is CLOSED:

| Checkpoint | Refusal |
|---|---|
| new quote (`POST /v1/checkout/preview`) | `409 SALES_STOPPED`, nothing written, Refref not called |
| repeat preview of an issued quote | `409 SALES_STOPPED` |
| confirmation, before and inside the order transaction | `409 SALES_STOPPED`, no order |
| after the order commit, just before the provider call | the attempt ends `DECLINED` (`PAYMENT_INITIATION_STOPPED`, `externalAttemptAbsent`), order `CANCELLED`, nothing sent |
| recovery of an unanswered create | fresh synchronous admission before each attempt/session POST, after every awaited read-back; while stopped, read-back only: no identical create, no payment session; it stays unanswered and resumes identically after a reopen |
| Control Room: set an offer `PUBLIC` | refused while the storefront is CLOSED; closing is always possible |

It applies to every paid offer of the storefront, `PUBLIC` and `ACCEPTANCE_ONLY` alike.

It never stops: reconciliation of started payments, fulfilment and the entitlement of an accepted
payment (including one whose provider call was already in flight when the stop landed), its
fulfilment ACK, refunds and their reconciliation, the library, playback. Never stop Commerce, its
sweep or refunds to stop sales.

**A stop ends issued quotes.** Each quote records the opening it was issued under
(`checkout_quotes.storefront_open_since`). A stop followed by a reopen is a new opening, so quotes
from before the stop can never be confirmed; buyers start again. A transient read failure of the
same opening (for example an I/O error) refuses while it lasts but does not end the quote.

The buyer sees only `SALES_STOPPED`. The operator diagnostic is one redacted log line per refusal:
`{"event":"SALES_STOP_REFUSAL","storefront":…,"stage":…,"reason":…,"generation":…}` with
`stage` one of `NEW_QUOTE`, `ISSUED_QUOTE`, `CONFIRM`, `PAYMENT_INITIATION`, `PAYMENT_RECOVERY`,
`CONTROL_ROOM` and `reason` `CLOSED`, `REOPENED_SINCE_QUOTE` or why the switch could not be read
(`UNREADABLE`, `JOURNAL_MISMATCH`, `JOURNAL_INVALID`, `INVALID`, `SCOPE_MISMATCH`,
`GENERATION_REGRESSED`, `GENERATION_REUSED`, `SOURCE_NOT_CONFIGURED`, `OBSERVATION_FAILED`).

## The file

```json
{"schema":"flexperiment.storefront-switch/1","scope":"production","generation":7,
 "changedAt":"2026-10-20T09:00:00.000Z","changedBy":"art","reason":"…","evidenceIssue":"ART-319",
 "storefronts":{"COURSES":{"state":"OPEN","openSince":5},"LAB":{"state":"CLOSED"}}}
```

`generation` rises by one with every change; `openSince` is the generation at which the storefront
last opened. Directories `root:root 0555`, files `root:root 0444`, one link; the switch file at most
4 KiB. The tool first appends `{"generation","sha256","document"}` to the journal, then replaces the
switch file by an atomic rename. The directories, not the files, are mounted, so the container sees
each append and rename. The tool refuses to write a document the runtime would not accept, and it
never writes a generation that the journal or the current file has already named.

Three independent records keep an older state from coming back:

1. **The journal (host, monotonic).** Commerce admits the switch only while the journal's last
   complete record names exactly the switch file's sha256 and generation (a positive safe integer). A switch file put back from an older copy
   after a stop, or a journal put back without its switch file, reads `JOURNAL_MISMATCH`: CLOSED,
   even if Commerce was down during the stop and never saw it. A torn last append (crash) is not a
   record yet and is ignored; a damaged complete last record is `JOURNAL_INVALID`: CLOSED.
2. **Commerce's observations (merchant database).** Every generation Commerce reads goes into
   `storefront_switch_observations` (append-only). A file older than a generation already seen, or
   a seen generation with different content, is CLOSED. This catches both host paths restored
   together to a state older than one Commerce saw.
3. **The restore rule below**, for the one case neither record can see: both host paths restored
   together to a state that Commerce, also restored or never running, has not seen beyond.

None of them grants anything: deleting them, restoring an old database or restarting cannot open a
storefront; only a new write by the tool can.

## Install (once per environment, before the first image that reads the switch)

Owner authorization for the host change is required (`adman-vps-infrastructure` AGENTS.md).

```bash
sudo python3 scripts/v2/storefront-switch.py install --scope canary \
  --by art --reason "Install the storefront switch, both storefronts closed" --evidence ART-319
```

This creates `/var/lib/flexperiment-sales-canary/switch/switch.json` and
`/var/lib/flexperiment-sales-canary/journal/journal.jsonl` with both storefronts CLOSED. Then add
both read-only mounts to the Commerce container (canary: already in
`deploy/v2/fast-cut/compose.json`, with `create_host_path: false`, so a missing directory refuses
to start instead of creating an empty one; production: the same two binds as Coolify persistent
storage, read-only). Deploy, then:

```bash
sudo python3 scripts/v2/storefront-switch.py verify --scope canary --container flexperiment-fast-cut-canary-commerce
```

`verify` proves both mounts are read-only binds of exactly these directories, that the runtime user
(not root) gets an error for overwrite, append, create, rename, remove and chmod on the switch file
and the journal, and that the runtime reads the host's generation and digest. Keep its output in the issue as host-permission and
read-back evidence. A deployment is not that evidence.

Deploying an image with the switch **without** the mount closes every storefront, including a
closed paid test (`ACCEPTANCE_ONLY`). That is fail-closed by design; install first.

## Open a storefront (first sale, or resume)

```bash
sudo python3 scripts/v2/storefront-switch.py open --scope production --storefront COURSES \
  --container <commerce> --by art --reason "F10.3 first sales after ART-240 acceptance" --evidence ART-242
```

The tool refuses unless the current file is valid and the container's preflight
(`owner-cli storefront-switch preflight COURSES`) reports `ready`: `PAYMENT_MODE=refref`, an
active legal release for the storefront, and a qualified fiscal policy for every paid offer that is
not CLOSED. After writing it requires the runtime to read back the new generation and digest; if it
does not, the tool closes the storefront again at once and reports `SWITCH_OPEN_ROLLED_BACK`. The
evidence issue is a reference, not proof: Commerce re-checks every precondition on each admission.

Opening the switch opens nothing by itself: offers sell only where Control Room has set them
`PUBLIC` (or `ACCEPTANCE_ONLY` with an allowlist). A Control Room session cannot open the switch.

## Emergency stop

```bash
sudo python3 scripts/v2/storefront-switch.py close --scope production --storefront ALL \
  --by art --reason "Provider credential incident" --evidence ART-NNN [--container <commerce>]
```

- Works with Commerce down, unready, its database lost, its file damaged or deleted, and with a
  damaged journal: it never depends on parsing the journal. It creates or repairs both directories,
  skips damaged journal lines (reported as `journalProblems`), closes off a torn last append, moves a
  journal that is not a regular file aside (`journal.jsonl.damaged-<time>`, never deleted), and
  appends a whole new record with a generation above everything readable. With a damaged or missing
  switch file the other storefront is written CLOSED too.
- In force as soon as the command returns: the next admission reads it. `--container` only adds the
  runtime read-back to the output; a failed read-back never undoes a stop.
- Record the stop in an issue: time, cause, who, generation and digest from the output.
- Then follow Refref `ops/runbooks/stop-sales.md` if the cause is on the payment, provider or fiscal
  side; once ART-303 exists, set Refref's own stop as the second switch.

Check it held: the output's `storefronts`; `status --container <commerce>` shows the runtime at the
same generation (the confirmed stop time is that read-back); a test preview answers
`409 SALES_STOPPED`; reconciliation and refunds keep moving. New `checkout_attempts` after the
confirmed stop are expected only in two forms: `PAYMENT_INITIATION_STOPPED` (refused at the last
checkpoint, nothing sent), and attempts whose specific side-effect request was dispatched before
that stop. Correlate merchant order, checkout-attempt, payment-initiation and request/idempotency
identifiers with confirmed dispatch events or request traces and their send times. Check attempt
creation and payment-session creation separately. An old order or an in-flight read-back GET does
not prove the later POST was in flight. Confirmed pre-stop requests can complete at the provider
shortly after the stop and are reconciled and fulfilled normally. A confirmed post-stop dispatch
means the stop did not hold: stop again and escalate. Missing send-time or correlation evidence is
**investigation required**, never automatically expected in-flight; keep sales stopped and preserve
the evidence while reconciliation, accepted-payment fulfilment and refunds continue.

## Resume

Only the owner, only through `open` above, never a Control Room session, never a restart or a
database change. Before resuming:

1. The cause is understood or contained, written in the issue.
2. No started payment is unexplained: `reconciliation` has nothing unexplained left
   (`/v1/admin/v2/integration`, uncertain attempts), refunds in progress continue.
3. If the cause was Refref-side, Refref's stop-sales resume conditions hold.

Resuming is a new opening: quotes issued before the stop stay ended.

## Recovery

| Situation | What the runtime does | What to do |
|---|---|---|
| Reboot, mount not there (or container started without it) | CLOSED (`UNREADABLE`: no read-only mount at `/etc/flexperiment-sales`) | Fix the mount; `verify`. Do not create the directory inside the container. |
| File deleted, corrupted, permissions changed | CLOSED | `close --storefront ALL` (repairs), then `open` what should be open, with preflight. |
| Switch file restored without its journal, or the reverse (`JOURNAL_MISMATCH`; the tool's `status` shows `SWITCH_JOURNAL_MISMATCH`) | CLOSED | `close --storefront ALL` writes a new generation above both; `open` refuses until then. |
| Journal damaged (`JOURNAL_INVALID`, or `journalProblems` in the tool's output) | CLOSED | `close --storefront ALL` (it does not need the journal to parse), keep the damaged copy for the issue, then `open`. |
| `status` shows `GENERATION_REGRESSED` (both host paths restored to an older state Commerce had already passed) | CLOSED | Read the runtime's highest observed generation from `status --container`; `close --storefront ALL --min-generation <that>`; then `open`. |
| `GENERATION_REUSED` | CLOSED | Same as above. Never hand-edit the file. |
| Merchant database restored or replaced | the file still decides; observations restart from the restored set | `status --container` to read back; nothing reopens by itself. |
| Host restored from backup (`adman-vps-infrastructure` recovery) | CLOSED if either path is restored alone or Commerce saw a newer generation | **Mandatory, before any Commerce start:** `close --storefront ALL --min-generation <highest generation in any surviving journal, backup journal or Commerce observation>`. Never restore an OPEN state as the live switch; reopen with `open` (preflight and read-back) after the recovery checks and activation GO. |
| Container cannot read the file but the host can | CLOSED | Check mount source, `root 0555/0444`, scope; `verify`. |

A restore never opens sales by itself: the switch is not in the merchant database or its backups;
an OPEN file restored without its journal, or older than what the runtime saw, is refused; and the
mandatory first recovery step writes CLOSED above every generation still on record.

## Coordination

- **Refref (ART-303):** Refref's own operator payment stop is the control outside Commerce. Until it
  exists, Refref `ops/runbooks/stop-sales.md` stops Flexperiment sales through this switch.
- **Mikluha:** independent; its booking switch (`fn_set_sales_open`) is separate and not affected.
- **Stage B / F10 acceptance** (ART-240, ART-242, ART-243, ART-310): blocking acceptance includes
  this independent control: `verify` evidence on the target host, a stop refusing a new quote and
  an issued quote's confirmation, a reopen ending pre-stop quotes, and reconciliation and refunds
  continuing during a stop.
- **Custody:** the switch directory and journal are host state outside a container. Installing or
  changing the mount is `CUSTODY_IMPACT: YES` in `adman-vps-infrastructure` (no secret, no key; the
  restore rule above).
