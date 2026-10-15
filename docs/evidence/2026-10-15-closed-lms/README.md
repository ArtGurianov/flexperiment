# Closed canary LMS execution — 15 October 2026

Result: **CLOSED_LMS_FUNCTIONAL_PASS**. Extended provider/production security qualification remains open; no blanket production or full security PASS.

Scope: ART-334 / ART-336 / ART-36 / ART-338 / ART-351. Owner autonomous canary GO. This record separates actual browser/provider/host evidence from isolated regression tests. Production, V1, Refref, Mikluha, public payments, public registration, marketing and F9 remain outside the execution.

## Installed release

| Role | Application source | Registry manifest digest |
| --- | --- | --- |
| Commerce | `e81b93004feab9f90f6b8e4a84049c80afde2a40` | `sha256:834281c34fa237658dd1d71dd9a159a8a554e6e0eb96f0de72e4a721e4f91bea` |
| Platform | `2cb47c46ee3cca50546d327ae57245c85235c153` | `sha256:379f43ad63f624ec2b4e83078688b9a9f3170f85e86c3aeb165cb649aab22ee3` |
| Admin | `08523bdf38eeddf5e745ce04d05e1f980a7ced93` | `sha256:85eadc71e50fdab0bc4d154a242a46188bd85bbe7f0edfed516f8863eb14dc77` |

Commerce PR230 handles the provider's documented `type=vod` callback, retaining the legacy video form. PR228's bounded erasure-reader recovery/diagnostics and operation-start fence checks are installed. Admission remains fail-closed and cannot auto-reopen after authority failure. Platform PR232/233 replace the discarded PR231 in-place SDK update: the actual SDK timed out, so no intermediate PR231/232 image was deployed. A fresh authorized player retains the latest same-video position and active-play intent; expiry independently removes an old player even if grant transport hangs.

Exact merged Platform source CI38745296708 passed `test` and `docker-build`. The first Docker job failed before assertions when the isolated upstream fixture failed to start in45seconds; one failed-job rerun passed. No branch-policy or CI override was used.

## Actual browser and provider checks

- Control Room editor: actual keyboard Lexical changes, draft revisions2/3, published version4 on the150-second fixture; private SSR/API shows the saved marker, public lesson content omits it.
- Real owner CAPTCHA, delivered email, magic-link session and required consent. Marketing consent remains false. No session was fabricated. Anonymous playback401; pre-consent playback403 CONSENT_REQUIRED/no token.
- Real browser Tus of original owner tour and a derived150-second fixture. Regional HTTPS Tus OPTIONS/HEAD/PATCH succeeded; persisted READY sessions and active binding/duration independently read back. Old PROCESSING session was continued, not erased or needlessly reuploaded.
- FREE, manual zero-value PAID entitlement and explicit preview: actual Kinescope license200, matching DRM_ALLOWED audit and completed four-second playback.
- Revocation and atomic withdrawal: new grant403 and an unused, unexpired genuine prior grant produces actual provider license403 plus current-policy DRM_DENIED. Expired and absent tokens produce actual license403/no playback.
- Wrong-video callback403 is an operator-origin negative check, not mislabeled provider traffic.
- UNLISTED active entitlement: authoritative public course/lesson404; private read200/no-store. Explicit relist restored listing. Public HTML/APIs omit private Kinescope IDs and signed tokens; authenticated viewers necessarily receive their video ID.
- Long playback renewal:33 foreground samples over165seconds, a fresh iframe at normal grant renewal, exactly one initial Play click, no ERROR/DENIED and playback observed at121.46seconds after the old token's lifetime. Four actual license responses were200. The replacement rebuffered briefly; gapless playback is not claimed.
- Resume: seek/play/Pause saved50seconds in SQLite; the normal authenticated grant returned resumeAt50/no-store; full reload restored a paused150-second player at50seconds.
- Active manual-entitlement revocation: new grant immediately403/no token. The already playing iframe continued using its existing license until the next ordinary grant refresh, then was removed and the page showed DENIED. First denied observation was64.953seconds after revoke (five-second sampling), not an instant cached-license revocation guarantee. Manual owned access was then restored through the normal admin API with a new zero-value test order.
- One intermediate page initialization failed before any license request or playback. No revocation was performed on that failed precondition. Grant200 and provider HTML/JS200 were observed; the cause of initialization failure is unproven. A bounded normal page reload succeeded; the failed attempt is preserved separately, not erased or relabeled PASS.

All PAID access in this execution uses explicitly owned manual test entitlements: final inventory is one account, three zero-value manual orders, three READY upload sessions and three active bindings; integrity/FK/schema26 PASS. No payment provider charge occurred. The original FREE course remains usable; the separate withdrawal fixture remains withdrawn.

## Backup and erasure evidence

- Post-Commerce backup105717UTC: independent S3 GET, off-VPS decryption, schema26/integrity/FK and exact-installed-Commerce isolated restore/copy-fence boot PASS. Previously erased synthetic account removed; current owner and business projections/drafts/versions/uploads/bindings retained. No restored DB was copied over live data.
- Actual scheduled1215UTC backup succeeded; its encrypted hash is `416d9fabfd0879afe64737a18a66786c7461143a629446e182acb50e84ff8831`.
- Final post-test143857UTC archive: remote GET verified852,360bytes/SHA256 `1e2b9a35006a9e132ed9f1d6886a32f3cd202763b2244ede9b1f6bc51d40c2a2`. Off-VPS decryption and SQLite checks PASS; plaintext SHA256 `d4cc64ca0e6fa535eee852deaffc4902accbbbec3f197464b11cb05229f8be40`. Final exact-installed-image restore and copied-fence boot at14:43:26UTC PASS: newest signed remote ledger sequence1, schema0026 fingerprint unchanged, synthetic erased account1→0, current owner retained, business continuity including orders/entitlements/resume verified. Copied fence normal boot OPEN/no leases. Live data/fence never restored over.
- Signed ledger, installation binding, keys and live authority persisted. Live fence was not edited manually. Finite health/OPEN observation is not proof of a historical S3 root cause or production availability.

## Coverage boundaries

The25-hour/seven-day policy scenarios, duplicate/lost-ACK upload handling, replacement safety and concurrent erasure failure paths are deterministic isolated regressions, not elapsed live-canary days or injected faults against a shared production provider project. Resume reload/second-tab evidence must not be described as a separately authenticated second browser.

Kinescope bearer JWT carries customer/video/issuer/audience/expiry, not device/browser/origin binding. New-license refusal does not prove per-segment reauthorization or immediate invalidation of cached DRM licenses. Real shared-project backend5xx/timeout fault injection was not performed because production LAB videos share it. Referrer/domain restrictions and Safari/FairPlay remain unqualified. ART-36/production acceptance must retain these limits.

Signed CDN download credentials stripped from an authenticated API-provided URL yielded403. A700-byte provider metadata/CDN size discrepancy remains unexplained; no unsigned-download bypass or bit-for-bit source integrity PASS is inferred.

## Final runtime checks

Installed Compose, actual Docker image/config/RootFS, native identities and expected-upstream contract pass. Platform-only update preserved Commerce/Admin container IDs and Commerce environment; owner authentication remained valid. Ten retired service-token routes404; admin anonymous401, genuine admin login/read/logout, revoked-session401, static pages200 and partner404. External API/Platform/Admin/LAB root guards all403 on independent Mac HTTPS requests at14:41UTC. Regular backup/freshness timers remain active; no auto-restart loop.

## Evidence custody

Sanitized JSON, screenshots and receipts: `/Users/artguranov/.codex/artifacts/art-351/autonomous-20261015/`. Release and target receipts remain under their exact timestamped local/VPS directories. Private cookies, JWTs, credentials, signed URLs, raw provider bodies, email and plaintext SQLite are excluded from this document and tracker comments.

## Remaining qualification

ART-334 upload/binding and ART-336 real callback acceptance are complete. ART-338 has a functioning actual closed workflow, but its extended matrix and ART-36/ART-351 production gates remain explicitly open: fresh separately authenticated second browser was not run, wrong-customer enforcement is isolated-regression coverage, shared-provider backend5xx/timeout and browser/domain/CDM variants are unqualified. No availability/root-cause guarantee is inferred from the finite healthy run. No automatic restart is installed.

Source PRs: [230](https://github.com/ArtGurianov/flexperiment/pull/230), [232](https://github.com/ArtGurianov/flexperiment/pull/232), [233](https://github.com/ArtGurianov/flexperiment/pull/233). Exact merged-source CI: [38745296708](https://github.com/ArtGurianov/flexperiment/actions/runs/38745296708). Documentation commits are not automatically installed release sources.
