# ART336/338 — two-image canary upgrade proposal

This is a historical exact-source proposal. For the next ordinary release
from current main, first satisfy [closed-canary release prerequisites](CLOSED_CANARY_RELEASE.md),
including target schema admission, storefront mounts, compatibility-helper
retirement and network receipt requalification. Its old schema/vector below
must not be reused as the current target contract.

**NOT EXECUTED / LIVE HOLD.** PR225/226 merge and artifact publication do not
authorize runtime changes. ART351's withdrawn restart/Mac experiment stays
withdrawn. Review this controller independently, then obtain one canary-only
execution GO for the bounded procedure below; no per-step confirmations needed.

## Exact target

Application source: `46305e7a422a8239def139dab6e2e28790de3c61`.
The controller SHA is the independently reviewed PR head; do not substitute it
for application source. Main/source CI run38674442557 passed test/docker-build.

The proposed vector is
[`closed-e2e-release.json`](../../deploy/v2/fast-cut/closed-e2e-release.json):

- Commerce: `ghcr.io/artgurianov/flexperiment-commerce-v2@sha256:444fbbef12c75bde4d45f9f0be0c7ac65114d2f01096fd36602ab578c811736d`
- Platform: `ghcr.io/artgurianov/flexperiment-platform-v2@sha256:653b11e4f307442563297de929614c9e33a5328e78877d2b735b693adcc5a119`
- Admin: retain the existing source085 image/container, no rebuild or replacement.

Mac registry readback verified manifest/config digest, linux/amd64, image ID,
RootFS and native source identity. Commerce image ID:
`sha256:7a730693d320c16a7ae90b63a67442f57147ad3de99520cdf56478cd87cb199b`.
Platform image ID:
`sha256:93af7ad193ca18c76f004fda0522a3d7dd05b3516f2d819698b5f0c06a3610d6`.
Encrypted image archives and descriptors are in the owner's retained candidate
evidence directory, referenced by ART338 comment6d5af4df-3a67-46c0-adf7-3a5c7b35c646.
Mac image tests are not live erasure admission or installed-image qualification.

## One fresh preflight, after execution GO

1. Identify only `/opt/flexperiment-fast-cut-canary` and its three exact
   containers, two existing named data/backup volumes, five erasure mounts and
   private network. Preserve current stack/config/helper/artifact-descriptor
   hashes privately. Verify Payload/legacy writers remain stopped, no queued
   deploys or pending operation, and all four external roots still403.
2. Read current SQLite with WAL-consistent online backup semantics: schema0026,
   integrity/FK, known synthetic course/legal rows only, no unknown new data,
   customers/orders or unfinished upload operations. Compare retained inventory
   and account for expected synthetic admin/audit records. Preserve current
   encrypted archive, remote SHA readback and qualified restore evidence.
3. Independently verify current signed remote ledger, sequence/head versus
   fence, installation/reader binding and keys. CLOSED is admissible only as the
   known starting recovery state, with owner absent and zero ACTIVE/UNKNOWN
   leases. Any unknown/ambiguous state means HOLD. Never manually OPEN the fence.
4. Pull only the two exact target references using the existing root GHCR
   login. Compare registry manifest/config, image IDs/RootFS, native identity and
   architecture with the retained descriptors on the actual VPS. Do not rebuild,
   substitute a tag, expose credentials or mount Docker config into an app.

## Bounded replacement and normal recovery

1. Isolate only the existing fast-cut canary backup/freshness timers. Let any
   active backup service finish before replacing its helper; uncertain transport
   is HOLD with GET-only reconciliation, not forced termination/retry. Record
   prior timer enabled/active states for restoration.
2. Stop Commerce once and verify absence of competing writers. Preserve the
   current SQLite lineage; no reset/import/backfill/old DB restore. Boot recovery
   can revoke restored sessions, so subsequent browser tests must log in normally.
3. Stage the reviewed helper file separately from application source. Preserve
   the former helper and do not replay `prepare`, replace the whole checkout,
   regenerate admin credentials or reactivate legal texts. Install the reviewed
   release JSON as root0600 under the existing root0700 private input directory.
   It is only an expected readback vector, never erasure admission authority.
4. Preserve the installed Compose file and change only Commerce/Platform image
   references and their source labels to the vector. Preserve all mounts,
   capabilities, private network/aliases, healthchecks and lack of public ports.
   Preserve the separately installed tester/DRM bridge and legal/TLS mounts.
5. In private raw env files change only Commerce/Platform SOURCE_COMMIT and
   Platform PLATFORM_EXPECTED_COMMERCE_SHA to the application source. Set the
   already owner-approved public widget key as SMARTCAPTCHA_CLIENT_KEY for
   Platform; preserve the corresponding server secret and every other secret,
   provider binding, erasure input and disabled payment/marketing setting.
   Keep admin-password and Admin image/config unchanged. Never print env/config.
6. Stage candidate Commerce/Platform readback descriptors as root0600
   `{commerce,platform}-artifact.json`, preserving predecessor descriptors.
   The helper format is `{imageId, rootfs, identity}`; copy nativeIdentity from
   the verified publication descriptor into identity without changing its
   contents. Preserve Admin's existing descriptor. Validate Compose quietly.
7. Perform one normal replacement/boot of Commerce using the exact digest,
   `--no-build --pull never --no-deps`, via the existing Compose project. Normal
   `prepareErasureRuntime` must verify current authority, replay required erasure
   and reopen admission itself. Do not change installation/journal/ledger/fence
   policy if this refuses the candidate. No preliminary old-runtime restart.
8. Only after Commerce is healthy/OPEN with matching sequence/head and no owner
   or leases, replace Platform once with its exact digest. Native Admin remains
   unchanged; its /readyz now reports the Commerce source through nginx.

## Independent post-readback and backups

Run the reviewed helper `check` and `smoke` only after the approved replacement.
Compare actual images/native identities/RootFS and env source expectations;
schema0026/integrity/FK, independent current ledger and OPEN/drained admission;
ten retired routes404 and normal operator login/read/logout; all four outside
roots403. No wider ingress/DNS/Kinescope/provider changes.

Run the reviewed helper `backup`: it requires the new Commerce source in the
native encrypted archive filename and records that source in backup status.
Require independent remote GET/hash, off-host decryption, SQLite restore and
normal copied-fence boot in the exact candidate image, including suppression of
the previously erased synthetic identity. Preserve every predecessor archive.
An old-source SUCCESS status is intentionally insufficient after release switch.

Restore only the prior approved backup/freshness timer schedule after this proof;
require enabled/active/waiting, future trigger and fresh source-matching status.
Do not claim a new calendar-run proof until it actually happens. Existing timer
unit files/transport namespace/retention are unchanged. Keep the read-only health
monitor and record the new role identities; it must not auto-restart anything.

Any uncertain mutation, failed boot/backup, CLOSED recurrence, identity/data drift
or unknown lease means HOLD: stop dependent live tests, retain receipts and the
current DB. No automatic repeat, manual OPEN or old DB restoration. A successful
candidate install does not establish ART351's production resilience acceptance.

## Then: separately bounded real LMS test

After successful installation/recovery, use the original ART336/36/338 browser
scenario: real operator upload tour.mp4 through Tus → READY/private binding →
genuine CAPTCHA/magic-link/consent → normal Commerce grant/drmauthtoken → real
Kinescope-origin callback/license/playback → deny/revoke/expiry/resume evidence.
Stop immediately on CLOSED. Provider changes, outage experiments and public F9
are not part of this upgrade GO. No hand-minted session, consent or playback JWT.
