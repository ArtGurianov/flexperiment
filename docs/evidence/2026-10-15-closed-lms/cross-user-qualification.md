# ART-338 — two-account isolation and MVP qualification

Result: first-party isolation and provider claim/video negatives verified. Chrome is the owner-accepted browser scope for this closed LMS qualification. Intact bearer transfer is an explicitly accepted MVP limit, with further protection retained in ART-36. This is not production security or paid-checkout acceptance.

## Actual independently authenticated browsers

Two separate real Chrome profiles used separate owner-controlled email logins, cookies and customers. No session/cookie was copied or fabricated. Account B completed the required consents and held its own FREE grant; account A held the manual zero-value PAID entitlement. No provider charge occurred.

| Case | Observed result |
| --- | --- |
| B requests A's paid lesson normally |403 NOT_FOR_SALE; no token/video ID; no-store |
| B spoofs A's customerId in body, query and header |403; no grant; authenticated identity retained |
| B supplies A's DRM bearer to the first-party playback endpoint |403; no new grant for B |
| B reads A's private course/lesson |404/no-store; private body marker absent |
| B's account library |Own FREE course present; A's paid course absent |
| B's normal FREE grant, actual provider player |Two license200 responses; four-second clip reached ended |
| B's valid FREE token used for A's different paid video |Actual Kinescope license403; DRM error; no playable video |
| A token with subject changed to B without re-signing |Actual Kinescope license403; DRM error; no playable video |
| A's intact, fresh PAID bearer replayed in B's browser |Two actual license200 responses; playing at18.56s |

The last case is a measured limitation, not a denied request. The callback authorizes the signed subject/video and current entitlement; the token is not browser/device-bound. On15October2026 the owner accepted this limit for MVP and retained anti-transfer work in ART-36. TTL is120seconds for a new license request; it does not bound the lifetime of an already issued DRM license or buffered segments. First-party authorization does not accept a foreign customer identifier or DRM bearer as a substitute for B's real session.

Initial test-harness attempts failed to initialize or lost a temporary embed host during the account page's React update; neither produced a provider verdict. The temporary host was moved outside the React-owned main element. The successful own-FREE positive control preceded the negative cases, and the temporary test player was removed afterwards. No application or shared Kinescope project setting was changed for these probes.

## Resume ownership repair

P0 source review found that PUT and beacon POST resume handlers spread untrusted JSON after the authenticated customer and route lesson. PR235 constructs the storage input explicitly. Both regression cases failed before the fix (foreign progress88→17) and passed afterwards; all53 affected HTTP/consent/access/token tests passed. The previous live handler was not exploited against either account's progress.

Reviewed head `9b16fd25d03f62f4a6f0ed9dfe2ccb2d48791f91` passed test and docker-build; PR235 merged as `0d7dee0c8352dfb6cc1ea8ca7850b5d03fa18309`. Exact merged-source [CI38764019867](https://github.com/ArtGurianov/flexperiment/actions/runs/38764019867) passed both checks. The same published immutable Commerce image passed114 packaged HTTP/token/erasure tests and the full foundation smoke. A first local boot failed with Docker Desktop ENOSPC; removing three exact unused Platform cache records enabled the same digest to pass, without rebuild or repush. The retained log and receipt preserve this failure separately.

## Installed repair and recovery

Commerce source `0d7dee0c8352dfb6cc1ea8ca7850b5d03fa18309` is installed at manifest `sha256:650ec79b0f8c5eb0f89bb2e93ed674e5548cc54daf10a57a204ff125342566ab`. Platform retains source `2cb47c46ee3cca50546d327ae57245c85235c153` and its image, with only its expected-Commerce SHA updated; Admin source/image/container remain085. Registry manifest/config/RootFS/native identities were independently read back on the VPS. Normal startup retained live data, verified the current signed ledger and admitted OPEN/sequence1/owner null/leases0. Fresh-process runtime read-back and internal smoke passed; no repeated Commerce boot or erasure bypass.

Before/after encrypted snapshots have identical business-table hashes across course projections/drafts/versions, upload/bindings, orders/lines, entitlements and resume. Two customers/accounts, three zero-value manual orders and three READY bindings remain. Normal BOOT_RESTORE cleared both previous sessions; both real Chrome profiles now report anonymous200 and playback401. Authenticated resume was not retested in those revoked sessions; both ownership regressions ran in the exact installed image.

The post-source backup is856472bytes, encrypted SHA256 `a5995eb8cb67a14c05b567c754cfe3c48f54ffd93410050c0313f90c5442c411`. Independent S3 GET, complete Mac read-back, off-host decryption and SQLite schema26/integrity/FK passed. Exact-image isolated restore suppressed the previously erased synthetic account1→0 and retained both current accounts/business data; copied-fence normal boot was OPEN/no leases. Live data/fence were never replaced with a restored copy. Backup/freshness timers returned to their prior enabled/active schedule; no new calendar-run claim is inferred from this manual backup.

After the owner's VPN update, ordinary SSH downloaded the earlier encrypted archive with a resumed tail, matching all856472bytes/SHA256. Uninterrupted SCP/direct reads timed out; this is recorded as a Mac/VPS transport observation, separately from successful provider S3 GET and the unexplained historical S3 incidents. TLS/SSH verification was not weakened. Fresh VPS loopback requests to all four public HTTPS listeners returned403 with certificate verification. Direct Mac requests after the VPN change failed before HTTP with TLS EOF/SSL_ERROR_SYSCALL; a new independent direct-external403 result is not claimed. The private browser TLS route remained usable. This transport observation is separate from the accepted cross-account/provider evidence and production security gates.

## Accepted scope and retained gates

The owner accepted existing Chrome evidence as sufficient for ART-338. Safari/FairPlay becomes a launch requirement only if that browser enters the supported set. The earlier measured active-view revocation at the next normal refresh (first DENIED sample64.953seconds after revoke) remains the documented MVP policy; immediate cached-license revocation is not promised.

ART-36 retains browser/device transfer protection, allowed domains/referrers, segment/CDM boundaries, and a real transient Kinescope failure qualification that does not affect the shared production LAB project. ART-351 retains the unexplained historical S3 failures and production resilience/SLO/recovery acceptance, separately from successful current canary restores. ART-36, ART-351 and F9/ART-240 remain separate public-launch gates. The700-byte metadata/CDN discrepancy is a separate diagnostic follow-up. Real paid checkout is still untested: all PAID entitlements used manual zero-value orders.

Evidence: [sanitized receipts](isolation-receipts.json). Historical full workflow and installed vector: [execution record](README.md). Private cookies, JWTs, email addresses, credentials and plaintext backups are excluded.
