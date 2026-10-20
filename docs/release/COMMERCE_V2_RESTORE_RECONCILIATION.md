# ART-313 — reconcile an isolated merchant restore with Refref

Engineering recovery tool; production restore, runtime admission and sales reopening require a
separate explicit owner decision. This does not reduce SQLite RPO (ART-314). Follow
[COMMERCE_V2_BACKUPS.md](COMMERCE_V2_BACKUPS.md) to retrieve and independently verify the actual
uploaded ciphertext, decrypt in owner custody, and prove SQLite integrity and key escrow first.
Refref's own recovery contract is `refref/ops/runbooks/pitr-recovery.md`; finish its provider/secret
reconciliation before using it as current money authority.

## Establish the recovery boundary

1. Stop booking/new money at the merchant and every public checkout ingress. Stop runtime processes,
   reconciliation workers, scheduled jobs and email senders. Existing provider payment URLs may still
   settle: account for them in the independently reviewed Refref/provider tail and wait for a stable
   final outcome. Local `sale_mode=CLOSED` cannot cancel an already-created provider session.
2. Work on a detached independently retrieved SQLite snapshot on the owner machine, never the live
   `/var/lib/flexperiment-v2/commerce.sqlite` or a runtime volume. Keep both source and output offline
   from application processes; the operator process needs outbound **read-only** Refref and Cloud.ru
   custody access only. No runtime listener, mail, provider mutations or production mounts.
3. Record backup time T, incident/freeze time X, ciphertext SHA/read-back, decrypted SQLite SHA,
   environment, merchant ID, recovery source commit and independent inventory evidence. Refref's
   `merchant-orders/{orderPublicId}` lookup does **not** enumerate all orders. Obtain a complete
   merchant-scoped order/payment/refund inventory from independent Refref/provider records, covering
   all restored commercial orders and the entire post-backup tail through the stop boundary. Have
   the owner review its completeness. A list derived only from the restored SQLite is insufficient.
4. Reconcile missing merchant-owned evidence separately: post-T identities, legal/receipt acceptance,
   manual grants/revocations, editorial actions, LAB attendance, and operator refund decisions are
   not reconstructible from Refref money facts. Preserve independent merchant records. If any such
   record is lost or ambiguous, **no GO**. Entirely absent orders return
   `RESTORE_MERCHANT_TAIL_REQUIRED`; recover their original merchant records under separate reviewed
   recovery work and rerun from a new detached snapshot. Never invent consent, approval, attendance
   or an email/customer binding from a payment.

## Inventory and protected configuration

Use private files (`0600`, owned by the operator, no symlinks/hardlinks) and a new private output
directory (`0700`, canonical absolute path). The source SQLite also requires its exact canonical
absolute path (`realpath`): aliases through symlinked parents are refused before reading custody or
creating an output. Live-source exclusions, WAL/SHM checks, hashing and copying use the canonical
source; a symlink cannot disguise a runtime database as a detached backup.
Inventory is owner evidence, not proof of completeness created by this command.
`backupSha256` is the **decrypted detached SQLite's** SHA; preserve the
ciphertext hash separately. `sourceEvidenceSha256` binds the independently reviewed inventory
evidence, including the (T, X] comparison and merchant-owned recovery decisions.

Inventory format (all commercial orders; manual entitlement orders are excluded):

```json
{
  "version": 1,
  "scope": "canary",
  "merchantId": "<exact Refref merchant ID>",
  "backupSha256": "<64 lowercase hex>",
  "sourceEvidenceSha256": "<64 lowercase hex>",
  "completeThrough": "2026-10-20T08:00:00.000Z",
  "orders": [{
    "orderPublicId": "<immutable merchant public ID>",
    "snapshotHash": "refref-jcs-1:<64 lowercase hex>",
    "refundIds": ["<accepted canonical full Refund ID, if refunded>"]
  }]
}
```

Zero accepted refunds means `refundIds: []`. Exactly one full refund is supported, matching the
merchant's full-only rail. Partial refunds, multiple attempts, unfinalized payments, late money,
unknown/missing remote records and contradictory local financial decisions require manual review.
The sum of accepted refunds must match both the accepted payment's remaining refundable balance
and the order line's balance. A moved balance alone never revokes access.

Configuration format:

```json
{
  "version": 1,
  "isolation": "INDEPENDENT_RESTORE_RUNTIME_JOBS_MAIL_STOPPED",
  "sourceDatabase": "/private/owner/recovery/source/commerce.sqlite",
  "outputDirectory": "/private/owner/recovery/attempt-001",
  "inventoryFile": "/private/owner/recovery/evidence/inventory.json",
  "keysFile": "/private/owner/erasure/verification-keys.json",
  "erasureReadConfigFile": "/private/owner/erasure/library-read.json",
  "apiBaseUrl": "https://canary-api.refref.ru/v1-rc",
  "apiKeyFile": "/private/owner/refref/merchant-read-key"
}
```

Use the admitted URL/merchant credential for the chosen environment; no implicit credentials or
environment fallback. It needs `integrations:checkout`, `integrations:refund` and
`integrations:fulfillment` reads. Keep credentials out of argv, shell history, reports and commits.
The isolation field is the operator's explicit assertion; the tool cannot prove that a different
process/host is stopped. The CLI creates a **new** `reconciled.sqlite`, verifies the copied bytes,
and never modifies the source. Existing outputs are refused; use a new directory for each attempt.

Erasure files use the existing `erasure-library-read.ts` configuration and
`erasure-runtime.ts:readErasureVerificationKeys` formats. Keep the reader configuration/bundle outside
both the source and output directories. Use the independently current Cloud.ru custody reader with
version-history checks, all required subject-key generations and read-only credentials. A cached
checkpoint, empty fabricated ledger, restored watermark or missing key is never a substitute.

## Execute and independently read back

From the reviewed recovery checkout, with its lockfile dependencies installed:

```sh
node --import tsx commerce-v2/src/restore-reconciliation-cli.ts --config /private/owner/recovery/config.json
node --import tsx commerce-v2/src/restore-reconciliation-cli.ts --verify /private/owner/recovery/attempt-001/reconciliation.json
```

The command refuses unreviewed schemas/triggers before any write. On a reviewed schema it
closes every offer and revokes every sales activation in the isolated copy
(also the old LAB sales gate on reviewed pre-0029 schemas). These closures persist on later refusal.
It then applies current erasure/suppression before reading money; financial/audit erasure holds
remain closed. It invalidates restored sessions, links and LAB capabilities through the existing
erasure restore implementation. It does not migrate the database or install/start a service.

It reads the complete merchant-order attempt, accepted Refund IDs and **separate fulfillment GET**
twice, with no cache or redirects. RC.2 merchant-order `fulfillment: null` is not fulfillment proof.
Refref receives no create, payment-session, refund, cancel or fulfillment-ACK mutation. Moving remote
facts, a changed erasure head or local concurrent writes refuse the entire financial repair.

On stable evidence it atomically repairs purchase grants / full-refund revocations, order/attempt
projections and matching existing approved refund executions. Accepted facts have deterministic audit
IDs: replay cannot create a second money event or entitlement. An accepted refund whose local request
was wholly lost is retained as an external accepted fact; the command never fabricates an approval.
An existing conflicting/open approval requires review. Refunded access stays revoked on replay.
Manual grants, manual revocations, legal/marketing consent and editorial history remain local authority.
Used LAB tickets are never reset. Current independent erasure suppression takes precedence over
restored marketing consent. An operational `DELIVERED` ACK cannot stand in for a local grant; a
`READY` ACK stays pending for the normal idempotent sweep after separate runtime admission.

Both local order and checkout-attempt transition allowlists must admit the verified remote outcome.
`CANCELLED`/`DECLINED` may only replay cancellation, `EXPIRED` may only replay expiry, and `REFUNDED`
may only replay a full refund. A local paid/refund-pending witness cannot become unpaid. A local
partial-refund attempt requires manual review on this full-only rail. Contradictions return
`RESTORE_LOCAL_MONEY_AHEAD` before any money fact, entitlement, order or attempt projection is written;
sales remain closed. Matching terminal outcomes remain idempotent.

Success writes private `reconciliation.json`, with inventory, stable remote, erasure and logical
database hashes; state is `RECONCILED_CLOSED`, `ownerGo=REQUIRED`, `runtimeAdmission=PENDING`.
`--verify` reopens SQLite read-only, checks report self-hash, all logical tables/schema, integrity,
FKs and closed sales. It proves local read-back only; it does not refresh external evidence.
On failure retain the source, closed isolated output and safe error code privately. Do not reuse an
old success report for a failed attempt. No CLI result activates sales or records owner GO.

## Negative drills and owner GO record

Before any GO, on disposable independent copies and synthetic/controlled Refref fixtures, run:

```sh
pnpm exec vitest run --project node commerce-v2/test/restore-reconciliation.test.ts commerce-v2/test/restore-reconciliation-cli.test.ts commerce-v2/test/erasure-restore.test.ts
```

Require: repeated payment/refund recovery produces one accepted fact and one grant/revocation;
refunded access is denied while a separate manual grant remains valid; replayed suppression precedes
money reads; source backup is unchanged; no outgoing write methods; and every wrong snapshot, amount,
order, attempt, refund, missing inventory record, unknown schema, changing read-back, stale/unavailable
erasure proof or tampered report fails closed with no partial money/access commit. Test missing key,
custody outage and financial erasure holds as independent erasure cases. Record exact recovery commit,
test output and artifact SHA; local fixture PASS is not real-cloud or provider qualification.

Only after the actual environment's independent restore, current Refref/provider tail comparison,
fresh erasure read, deterministic reopened SQLite read-back, negative drills and merchant-owned tail
review all pass may the owner write a separate private decision record:

```json
{
  "decision": "GO",
  "scope": "<canary or production>",
  "owner": "<actual decision maker>",
  "decidedAt": "<actual UTC instant>",
  "recoveryCommit": "<40 hex>",
  "reportSha256": "<reconciliation report digest>",
  "readbackEvidenceSha256": "<independent actual-environment read-back evidence>",
  "negativeTestsEvidenceSha256": "<exact-commit test/drill evidence>",
  "merchantTailEvidenceSha256": "<consent/manual/editorial/attendance/approval completeness review>"
}
```

An unresolved gap is `HOLD`, never a GO with caveats. This record approves only the reviewed recovered
state. Follow the existing deployment and erasure-fence admission runbooks to install it under separate
authorization, with the independent ledger applied again before traffic/jobs/mail. Keep payment mode
disabled and sales closed until separately approved sales activation; neither a PR nor this command
authorizes F9, cutover or paid reopening. Recheck external facts if the freeze boundary moved.
