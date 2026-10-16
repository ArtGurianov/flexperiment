# ART-224 email refund release preparation

**PREPARED / MAILBOX FACTS PENDING / LEGAL DRAFT / NOT INSTALLED.**

This is preparation for the shared V2 process, not reopening ART-39, another
paid E2E, or another LAB V1 retirement audit. The owner accepted live rejection
of a duplicate request plus isolated positive acceptance instead of a new payment.

## Verified preparation

- Exact application source `80a11bde55c38973bcde99b4a92ee9e09c5dc6ad` has its
  own successful `test` and `docker-build` CI
  [38905982778](https://github.com/ArtGurianov/flexperiment/actions/runs/38905982778).
  PR #246's merged source `1294b4f` independently passed CI38900311658.
- All four Linux/amd64 images were built from that exact application source;
  the draft documentation PR is not substituted for it.
- Fresh encrypted SQLite backup: provider GET/hash and independent Mac
  decrypt/restore, integrity and foreign keys PASS, 27 migrations. Config
  escrow has separate provider GET/hash and independent off-host in-memory
  recovery, including actual role sources and the existing secret separation.
- The new Commerce image passed copied-fence recovery admission: copied OPEN
  was refused before fresh remote erasure-ledger verification; BOOT_RESTORE
  invalidated restored sessions. No live fence mutation, HTTP service, worker
  or financial client was started by that proof. Copied credentials were removed.
- Owner-held persistent ciphertext/receipt copies were independently read back;
  the recovery identity remains separate. Temporary restored plaintext was
  removed after verification.

## Isolated positive acceptance

A copy of that recovered database was used with explicitly synthetic course
and LAB orders. No real order was reset or reused as fulfilled. The candidate
image ran with network `none`, read-only rootfs, a disposable tmpfs, no host
mount, published port, payment rail, refund keys or production environment.

For both product kinds, actual application Admin login/session and routing gave
unauthenticated401, registration201, exact replay200, changed evidence409, and
a separate approval200. Intake evidence plus authenticated operator audit
survived database reopen. There were no new executions or historical-row
changes. The disposable container/database were removed.

The intake message reference in this isolated test is explicitly synthetic;
it is not proof that refunds@ received a real message. This is application API
acceptance, not a browser or bank test.

## Runtime and remaining admission

The final preparation read-back at14:04UTC retained the old installed source
vector, healthy canary check, fresh backup, three zero-value fulfilled fixtures
and the one already refunded 100-kopeck order. No eligible positive fulfilled
order exists. No deployment, legal activation, bank execution or Refref change
was performed during this preparation.

The owner directly confirmed creation of `refunds@flexperiment.ru` on16October.
This confirms the owner's setup statement; it does not claim an independent
delivery test. DNS points the domain's MX to REG.RU. Gmail returned
USER_NOT_LOGGED_IN; final forwarding/provider route, reply capability and actual
receipt/reply remain **not verified**. The owner was asked to send a clearly
nonfinancial test from the buyer email and reply from refunds@, then confirm
delivery and the actual provider. No bank operation is requested by that mail.

[Review.5](../../legal/closed-paid-test/2026-10-16-review-5/README.md) is a draft;
its initial 12-file inventory passes, package SHA-256
`5114b8afa11828a28cf5520ea910b7ed6c23c87cf5fc76793465f366a64c5ba9`.
Six legal texts change only version; the purchase/refund terms introduce the
refund contact/manual process. Review.4 is byte-for-byte unchanged. Final mail
facts may require a further draft delta before exact owner approval.

The existing LAB V2 frontend reports unhealthy on the shared Coolify network;
it requires a scoped, durable route to the existing private Commerce canary.
The proposed install packet must not expose Commerce to the shared network.
This baseline has been recorded; no network/destination change is applied.

Private registry receipts and the unapplied delta are retained in the owner
packet. Complete every role's target digest/RootFS/native identity read-back
before consumption. [Release admission](../../release/ART224_EMAIL_REFUND_RELEASE.md)
retains the mailbox, exact legal approval, fresh restore and installed read-back
requirements. ART-224 remains In Progress. Public F9 remains closed.
