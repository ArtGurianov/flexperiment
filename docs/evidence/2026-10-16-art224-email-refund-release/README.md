# ART-224 — common email refund flow installed

**ART224_COMMON_EMAIL_REFUND_FLOW_PASS.** Closed V2 canary only. No new payment
or bank refund was executed. ART-39/83/338 remain completed; public F9 remains
closed and LAB V1 remains retired. This supersedes the preparation-only status
in the [earlier checkpoint](../2026-10-16-art224-email-refund-preparation/README.md).

## Exact installed application and controller identities

All four immutable artifacts use application source
`80a11bde55c38973bcde99b4a92ee9e09c5dc6ad`, whose own merged-source
[CI38905982778](https://github.com/ArtGurianov/flexperiment/actions/runs/38905982778)
passed test/docker-build. Each private registry artifact was independently pulled
on the VPS and checked against native identity, registry config and RootFS.

| Role | Installed immutable reference |
| --- | --- |
| commerce | `ghcr.io/artgurianov/flexperiment-commerce-v2@sha256:c928ef2a9e33e2e2bcb7e646e89fe8b239489395539d9eb9094350a683433e4c` |
| platform | `ghcr.io/artgurianov/flexperiment-platform-v2@sha256:9c7fee07994457e7b9dd4ac8345e54addd39c91c45e45f49a05bba546e972655` |
| admin | `ghcr.io/artgurianov/flexperiment-admin-v2@sha256:b5c1fe054a736628a9496eaef30d7ee56708bfa57f0d51c8243de7d763945b5e` |
| lab | `ghcr.io/artgurianov/flexperiment-lab-v2@sha256:8b3e50921a56ec3299b262b740216018ed324d06de1e2e54a6c22aaf8393b19b` |

The existing three-role host controller remains SHA-256
`cd58ad2589332606302616fbd272eab8cd5ddea1bcaea885301640632e970c85`.
The existing Coolify LAB application consumes raw Compose from controller Git
`cac23aeae4dd86269f8a5b3796ae7668ed7459d6`, independently green
[CI38919493784](https://github.com/ArtGurianov/flexperiment/actions/runs/38919493784).
[PR248](https://github.com/ArtGurianov/flexperiment/pull/248) merged as
`25433307cc701608f9219afc525a87a6dff2a067`. Its controller/configuration commit
is not substituted for the application source baked into the images. The
merged documentation/controller commit also passed its own
[CI38921323870](https://github.com/ArtGurianov/flexperiment/actions/runs/38921323870).
The pinned controller branch `codex/art224-refund-release` is retained for
Coolify Git retrieval; do not delete it before an admitted replacement reference.

LAB uses only the existing private canary network, no host mount, published port,
public domain or provider credentials. Commerce was not joined to the shared
Coolify network, and Coolify's proxy was not joined to the canary network.
The old unhealthy LAB instance was stopped by the existing application's native
deployment. Private HTTPS returns200 and actual Commerce readiness is healthy;
the refund contact is present in served LAB HTML and the installed Platform
client artifact. This is not a new browser qualification or public LAB launch.

Admin needed an admitted runtime configuration correction on the same image:
supply the stable upstream to the native entrypoint, render the existing host
configuration as a template into tmpfs, and retain the image's own startup/proxy
files. Both its baked build identity and public release identity were separately
copied/read back. The controller's artifact receipt records the actual public
release identity it checks. No entrypoint override, image substitution, credential
rotation or Commerce/Platform restart was used for this correction.

## Legal and mail facts

The owner confirmed receipt of the test email and reply from refunds@ and REG.RU
as provider. This is owner-attested two-way delivery, not independent mailbox
access. The owner explicitly waived exact email time/headers/Message-ID for this
acceptance. No fabricated mail header or provider delivery log is claimed.

The owner separately approved exact review.5, package SHA-256
`fdaf8244877f888167447afbcc145185e5cced47885d06c3789939eefd09750d`.
All eight texts passed closed HTTPS/hash read-back and host/method isolation.
The normal fenced internal API activated version
`2026-10-16.closed-paid-test.review.5`, manifest SHA-256
`5541c0ccd0da1772d6cdc28fb9d45dc382d631ed667e2f8e070574502d7b8d33`.
Review.3/review.4/Stage A URLs remain available; exact review.4 files and historical
purchase/consent/fiscal evidence remain unchanged. No new buyer consent, owner
fiscal decision or qualified policy was manufactured. This contact revision
covers the closed Test Course, not a paid LAB offer or the public catalogue.

The single process is email to refunds@ → operator verification/registration in
Admin → separate decision → separately authorized execution on the original
payment rail. Registration alone never sends bank funds. Matching the sender
string alone does not prove ownership. The compatible customer request API still
creates only cases; neither buyer UI exposes automatic financial self-service.

## Accepted nonfinancial acceptance

Live inventory contains three fulfilled zero-value fixtures and the one already
fully refunded100-kopeck order. No suitable positive paid order exists. The owner
accepted the following split instead of another real payment:

- Actual owner-attested nonfinancial email, followed by authenticated Admin's
  live duplicate-registration diagnostic on the refunded purchase. Result409
  `REFUND_REQUEST_NOT_AVAILABLE`; no new case, decision or execution. The
  diagnostic clock value was explicitly labelled as test metadata, rejected
  before persistence, and is not evidence of the email's actual receipt time.
- An independently restored copy, with explicit synthetic course and LAB orders,
  exercised actual candidate application Admin login/API: registration201,
  identical replay200, changed-evidence409 and a separate approval200. Evidence
  and authenticated operator audit persisted and survived database reopen.
  No payment rail, provider credentials, network, host mount or published port;
  no bank execution endpoint was invoked. Original historical rows remained
  unchanged; the disposable container/database were removed.

This proves the accepted API/process boundaries. It does not claim another real
LAB purchase/refund, independent mail-header verification or a newly completed
buyer/Admin browser E2E.

## Recovery and final independent read-back

Fresh encrypted preinstall and postinstall copies each passed provider GET/hash,
independent Mac age decryption, SQLite integrity/FK/schema27 verification. The
candidate Commerce image also passed copied-fence admission: copied OPEN alone
was refused before fresh remote ledger read, restored sessions invalidated, and
no live fence or copied credential retained by the isolated test.

Final installed data ciphertext SHA-256:
`fd841a42393512a94cc0db7f07937d58dbc6466b9f8670c0601da1bf5b5df364`.
Final actual configuration escrow ciphertext SHA-256:
`14cd307642e8d11d709096f8f3eaba1e50545f2ebc77a6c3264d51a998dc85cd`.
Both final copies were retrieved from the provider and independently recovered
off-host. Actual role env/config, unchanged recovery secrets, historical fiscal
evidence, exact legal bytes and LAB deployment metadata were recovered without
logging secret values. Persistent owner custody was independently read back;
temporary decrypted SQLite copies were removed. The private age identity stays
separate from the VPS and encrypted archives.

Final runtime read-back: all four source/image identities healthy, schema27,
SQLite device/inode and financial rows preserved, fence OPEN/sequence1/no leases,
Refref READY at its prior source, four external403 guards and legacy root410.
All paid offers CLOSED. Backup/freshness timers are active and the source-bound
backup is FRESH. No new order, financial operation, erasure-fence reset or V1
reactivation occurred. Private receipts retain detailed operational identities;
no customer/payment identifiers or secrets are published here.
