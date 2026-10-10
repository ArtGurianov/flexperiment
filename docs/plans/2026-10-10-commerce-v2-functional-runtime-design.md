# Commerce V2: normal-runtime qualification before F9

Existing issues only: [ART-162](https://linear.app/art-gurianov/issue/ART-162)
(readiness), [ART-179](https://linear.app/art-gurianov/issue/ART-179) (Better Auth),
[ART-169](https://linear.app/art-gurianov/issue/ART-169) (seed),
[ART-224](https://linear.app/art-gurianov/issue/ART-224) (checkout),
[ART-41](https://linear.app/art-gurianov/issue/ART-41) (cutover).
[ART-165](https://linear.app/art-gurianov/issue/ART-165) is the separate
Next.js/Payload runtime, not the Commerce API.

## Smallest code change

Use the existing normal `server.ts`, real Better Auth and existing F7. Wire the
already-qualified read-only Refref ops probe into normal application readiness.
Do not introduce a second runtime or extend the restricted foundation server.
Production and a Refref rail require an explicit allowed readiness URL; a
configured staging URL is also probed. Local/test and unconfigured staging
image smoke may run without Refref, reporting `not_required`, not connectivity
qualification. Configuration is validated before opening the database.

`normal-runtime.test.ts` imports the actual server composition. Only the socket,
SQLite filename and external IO are replaced: a real migrated in-memory SQLite,
real seed, actual Hono routes, Better Auth and encrypted outbox are exercised.
Tests cover dependency loss, secret admission, service-token isolation, legal
consent, signed-in private account/order reads and payment-disabled refusal.
The existing Vitest glob and required `test` job include the suite. They are
engineering proof, not a real proxy/cookie, NotiSend inbox or live canary proof.

PR #180 independently supplies the real NotiSend transport. This change does
not copy or replace it; the synthetic legacy relay in this test stays valid
after #180 through its supported relay mode. No production email is sent.

## Verified operational blockers, 2026-10-10

Read-only owner API/runtime inventory against deployed source
`a0f0f696b8f6c7b030bc0301760d19b22c62b4c9`:

- Canary app `xzuy7pk5y6ywjr9kh6nsk5ap` and isolated production app
  `gzngatkipv7dv3rkpuaigjg5` remain foundation mode, payment disabled,
  marketing disabled, no domains/host ports or automatic deployment.
- Both SQLite databases have 22 applied migrations, but zero cities, products,
  offers, customers, orders, legal releases and projected courses. Foundation
  completion did not imply seed/content/auth qualification.
- Canary lacks explicit platform/LAB/admin/API origins and NotiSend settings.
  Both apps lack Better Auth secret/outbox key, SmartCaptcha server key,
  Control Room session secret/admin hash and campaign unsubscribe secret.
  Do not switch to normal mode until runtime-only private inputs are installed.
  Reuse existing approved custody; do not invent origins or publish legal facts.
- Production has runtime-only NotiSend API key; PR #180 is still open at
  `049ceb18609c183c68e75467b2c1d779643f0bb8`, exact-head test/docker-build green.
- No V2 systemd unit/timer is installed. Existing legacy
  `flexperiment-recovery-backup.service` last exited 1. Its presence and the
  successful manual V2 snapshot/restore are not regular V2 backup admission.
- The accepted catalogue seeds cities and a CLOSED bundle, not real courses.
  Complete stable course refs/content and the Stage A legal release separately.

No configuration, runtime, database, routing, banking or email mutation was
performed for this inventory. Foundation evidence remains accepted.

## Executable remaining path

1. Merge/release the reviewed NotiSend PR #180 and this readiness delta through
   ordinary exact-source CI/review. Prepare explicit canary origins and private
   runtime-only auth/Captcha/admin/email inputs. Preserve both SQLite volumes.
2. Qualify normal canary with `PAYMENT_MODE=disabled`, marketing disabled.
   Apply the approved V2 seed once (exact replay is NO_OP); publish actual
   Stage A legal evidence. Verify real proxy magic-link/cookie/revocation,
   `/v1/me` no-store, service-token authority, catalog/order APIs, paid checkout
   503 and zero payment attempts. No mock rail in the live canary.
3. Before replacing V1, install independent scheduled V2 backups using online
   SQLite snapshots, age encryption and off-VPS storage in Russia. Require
   separate canary/production namespaces, retained recovery keys, verified
   remote SHA-256, defined retention and failure/freshness alerting. Restore a
   scheduler-produced archive independently; a manual restore is not a timer
   proof. The foundation-only storage CLI is not a normal-runtime backup command.
4. Finish Next.js/Payload/LAB dependencies (ART-165 and existing F9 blockers),
   including separate editorial SQLite/backup, content/media/legal admission.
   Then take the final encrypted V1 archive and prove its off-VPS restoration
   (ART-235). Adopt the existing fresh V2 SQLite lineage rather than deleting
   the already-qualified volumes (ART-236); seed does not import V1 customers.
5. Qualify the full exact-source application set before public routing changes
   (ART-237/238). Execute ART-41 only once its real prerequisites pass. Retire
   V1 after V2 verification, retaining its final owner archive off VPS.
6. ART-12 / R10 and ART-240 then qualify one separately authorized controlled
   Tochka payment → real webhook → entitlement → full refund. Public sales
   remain closed; neither a free Stage A launch nor READY authorizes money.

No new issues, no F9 cutover or real financial operations in this PR. Keep code
completion and production qualification separate in Linear evidence.
