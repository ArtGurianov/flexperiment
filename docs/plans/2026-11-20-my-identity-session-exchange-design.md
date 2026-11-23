# FLEX-120 / FLEX-121 — MY identity, session audiences and the LMS session exchange

**Status:** security/API contract for technical review. **No code, no migration, no deployment.**
Implementation starts only after the coordinator's review of this document (FLEX-120 first,
then FLEX-121, same branch).

**Tracker:** Plane `art-workspace` / `FLEX`: FLEX-120 (MY sign-in by e-mail code), FLEX-121
(open a protected lesson from my without a second e-mail). Owner decision 2026-11-18 in FLEX-17
(variant B: single sign-in on my). Related: FLEX-123 (limited profile view and Navbar logout),
FLEX-125 (single account legal edition for my), FLEX-127 (return contract, free enrolment,
old `/account` links), FLEX-128 (Stage A magic link, owned by A), FLEX-16 / FLEX-41 (Stage A
acceptance, unchanged by this contract).

**Base:** `main` `be55bb755100535fd2af5f2a407b1be0199e2c40`. Coordination package: Plane page
`fb8cf731-2ade-4eb7-a33b-32c42bf24129`. DDL reservation: `0038` (provisional).

**Pinned dependency:** `better-auth` **1.7.6** (exact pin in root `package.json`). Every statement
about Better Auth below was read from the installed `dist/` of that version, not from current docs.

Machine-readable fixtures: [`fixtures/my-identity/`](fixtures/my-identity/). They are the review
surface for the exact values in this document; when the two disagree, the fixtures are wrong and
the review must say so.

---

## 1. Surfaces, origins and the trusted host

| Surface | Origin (production) | Env | Reached through | Purpose |
| --- | --- | --- | --- | --- |
| `MY` | `https://my.flexperiment.ru` | `MY_ORIGIN` (new, optional until cutover) | `apps/my` same-origin `/v1/*` proxy | OTP sign-in, central MY session, checkout, refunds, orders, profile, consents |
| `LMS` | `https://flexperiment.ru` | `PLATFORM_ORIGIN` | `apps/platform` `/v1/*` proxy + `/auth/lms/*` route handlers | Lessons, player, progress, library, free enrolment; **derived** LMS session only |
| `LAB` | `LAB_ORIGIN` | unchanged | LAB nginx | Unchanged by this contract (LAB sign-in moves to my in FLEX-122/123) |

1. Commerce is reachable only from the internal network. The surface is derived **only** from
   `x-forwarded-host` (or `host`) that the surface proxy sets itself after deleting every
   client-supplied `host`, `forwarded`, `x-forwarded-*` and `x-real-ip` header. This is the existing
   `proxyCommerce` discipline; `apps/my` must reproduce it exactly (fixture `surfaces.json`).
2. The surface is never taken from a body, query, cookie or `Origin`. `Origin` is an *additional*
   exact-match check on state-changing routes (§6), never the source of the surface.
3. The host check complements, and never replaces, the session audience check (§3). A valid
   proxy forwarding a stolen credential to the wrong surface is refused by audience.
4. `MY_ORIGIN` joins `loadCommerceOrigins` as an optional origin with the same parsing rules.
   Missing `MY_ORIGIN` ⇒ the MY surface does not exist (all MY routes 404) and
   `MY_IDENTITY_MODE` must be `off`; Commerce refuses to start with `MY_IDENTITY_MODE=on` and no
   `MY_ORIGIN`, or with `MY_ORIGIN` equal to any other origin. Better Auth `trustedOrigins` gains
   `MY_ORIGIN` only when it is configured.
5. **Same-site invariant.** The exchange state cookie is `SameSite=Lax` and still reaches the
   cross-origin `POST /auth/lms/redeem` sent from my. That works **only** because `MY_ORIGIN` and
   `PLATFORM_ORIGIN` are same-site: same scheme and the same registrable domain (eTLD+1, e.g.
   `my.flexperiment.ru` / `flexperiment.ru`, canary `canary-my.flexperiment.ru` /
   `canary-platform.flexperiment.ru`). With `MY_IDENTITY_MODE=on` Commerce refuses to start
   (`MY_ORIGIN_NOT_SAME_SITE`) unless both origins use the same scheme and their hosts have the
   same last two DNS labels (or both are `localhost` in development). Commerce ships no Public
   Suffix List. The two-label rule is correct for `.ru`, which is a single-label public suffix.
   A deployment under a multi-label public suffix (such as `co.uk`) must not enable mode `on`
   without revisiting this check. A config test pins the accepted and refused pairs (fixture
   `surfaces.json` → `sameSite`).

### Cutover mode

`MY_IDENTITY_MODE=off|on` (Commerce env, default `off`).

| | `off` (today, Stage A) | `on` (after owner GO for the switch) |
| --- | --- | --- |
| MY surface | 404 | live |
| LMS accepts | legacy Better Auth session (`audience IS NULL`) | **only** derived LMS sessions |
| LAB accepts | legacy Better Auth session | legacy until FLEX-122/123 move LAB to my |
| `POST /v1/auth/sign-in/magic-link` | Stage A behaviour (FLEX-128) | `410 MAGIC_LINK_RETIRED` on LMS |
| Legacy `/account` | Stage A cabinet | migration per §9 |

Stage A sessions keep working in the original contour until the switch. After the switch a legacy
session is never promoted to MY and never used to derive an LMS session; the user is offered
"Войти через my", keeping the former target (§9).

---

## 2. Identity: one account, one confirmed `customer_id`

* One Better Auth `user` per normalized e-mail, bound 1:1 to `customers.auth_user_id` by the
  existing `bindVerifiedAuthUser` hook. MY, LMS and LAB share that `customer_id`; nothing in this
  contract creates a second identity store.
* A `customer_id` counts as **confirmed** only when resolved from a live MY session (or a live LMS
  session whose parent MY session is live) **and** `customers.auth_user_id = session.user_id`
  **and** `user.email_verified = 1` **and** `lower(trim(user.email)) = customers.email_normalized`.
  Any mismatch ⇒ `ACCOUNT_BINDING_MISMATCH`, no data, session not extended.
* Repeated sign-in with the same e-mail reuses the existing confirmed `customer_id`. An unbound
  `customers` row created by an earlier intent (checkout, Stage A initiation) is bound on first
  verified sign-in, exactly as today.
* Before successful verification the server creates **no** LAB order, seat hold or payment
  capability. A storefront-to-my hand-over may persist the chosen offer (checkout intent owned by
  C/D) before sign-in; it becomes actionable only under a MY session.

---

## 3. Session audiences

| Kind | Store | Credential | Cookie (exact) | Admitted on | Lifetime |
| --- | --- | --- | --- | --- | --- |
| `MY` | Better Auth `session` row with new column `audience='MY'` | Better Auth session token | Better Auth `__Secure-better-auth.session_token`, **host-only** on my (no `Domain`), `Path=/`, `HttpOnly`, `Secure`, `SameSite=Lax` | MY surface only | `expiresIn` 7 d, sliding `updateAge` 1 d; no cookie cache |
| `LMS` | Commerce table `lms_sessions` (not Better Auth) | 256-bit random token, SHA-256 at rest | `__Host-flx-lms`, `Path=/`, `HttpOnly`, `Secure`, `SameSite=Lax`, no `Domain`, `Max-Age` = remaining lifetime | LMS surface only | `min(parent MY expires_at, now + 12 h)`, never slid; renewal = new exchange |
| `LEGACY` | Better Auth `session` with `audience IS NULL` | Better Auth token | existing, host-only on flexperiment.ru / LAB | LMS and LAB while mode `off`; LAB until FLEX-122/123 | existing |

Rules (all authoritative in Commerce, independent of any proxy):

1. **One resolver.** `resolveSession(headers)` (new `my-session.ts`) returns
   `{surface, kind, customerId, sessionId}` or `null`. `authenticateCustomer(headers)` in `auth.ts`
   keeps its signature and returns a `customerId` **only** when `kind` is admitted on `surface`
   by the table above. Every existing protected route therefore inherits the audience check
   without per-route edits.
2. **Route-group guard.** In mode `on`, routes that belong to one surface refuse the other
   surface even with a valid credential of the right kind (fixture `route-audience.json`):
   checkout, refunds, order history, MY profile and MY consents are MY-only; lessons, playback,
   resume, course library and the LMS exchange/sign-out are LMS-only. Refusal:
   `403 SESSION_AUDIENCE_FORBIDDEN`, no body data, `Cache-Control: no-store`.
3. **MY sessions are created only on MY.** A Better Auth `session.create.before` hook stamps
   `audience='MY'` when the request surface is MY and refuses creation otherwise in mode `on`
   (fallback if the 1.7.6 hook context lacks the request: the OTP verify wrapper stamps the
   surface in `AsyncLocalStorage`; the hook fails closed without it). The column is `input:false`.
4. **LMS credentials cannot reach MY.** An LMS token is not a Better Auth token, so
   `auth.api.getSession` never accepts it; a Better Auth token presented on LMS is ignored in
   mode `on`. Tested both ways and through a valid proxy (§10).
5. **LMS validity is evaluated on every request** by one SQL join: LMS row unexpired, parent
   `session` row exists, `audience='MY'`, parent unexpired, binding of §2 holds,
   `lms_sessions.customer_id` equals the parent's customer. A stale binding never extends access.
6. Credentials are never logged; diagnostics carry only codes. E-mail, OTP, exchange code,
   state and tokens never enter URLs (except the non-secret exchange id), logs, analytics or
   `Referer`.

---

## 4. OTP sign-in on my (FLEX-120)

### Mechanism

Better Auth 1.7.6 `emailOTP` plugin, configured:
`otpLength: 6`, `expiresIn: 600`, `allowedAttempts: 5`, `storeOTP: "hashed"`,
`resendStrategy: "rotate"`, `disableSignUp: false` (first sign-in creates the account, see notice),
`sendVerificationOTP` → Commerce delivery (below). Only the `sign-in` type is reachable; the
plugin's `/email-otp/*` paths other than send/sign-in, `/sign-in/email-otp` with any other type,
and every other Better Auth sign-in path are blocked on MY by the Commerce router.

Browser-facing Commerce routes (MY surface only, `Origin` must equal `MY_ORIGIN`):

| Route | Body | Success | Notes |
| --- | --- | --- | --- |
| `POST /v1/my/otp/send` | `{email, captchaToken, personalDataConsent, accountTermsAccepted, marketingConsent?, …document versions/hashes, next?}` | `202 {status:"CODE_SENT_IF_ALLOWED", resendAfterSeconds:60}` | Identical response for new, existing, erased-fenced and per-e-mail-throttled addresses |
| `POST /v1/my/otp/verify` | `{email, otp, next?}` | `200 {accountCreated:boolean, next}` + MY cookie | `accountCreated` revealed only after proof of mailbox |
| `GET /v1/my/session` | — | `200 {signedIn, emailMasked?, consentRequired?}` | Navbar/background; never redirects |
| `POST /v1/my/sign-out` | — | `204` + cookie cleared | §8 |

Send order (fail closed, nothing persisted before the first three pass):
`assertRegistrationChoices` → SmartCaptcha → per-IP limit → legal release check (FLEX-125
edition, exact versions and hashes) → erasure fence `assertIdentity` (failure answers the generic
202, sends nothing) → per-e-mail throttle → `getOrCreateCustomer` + `recordUnverifiedAccountIntent`
(unchanged semantics: an intent is never promoted automatically) → plugin send.

Account-creation notice: the send screen always states that an account will be created if none
exists and shows the single account legal edition of FLEX-125 in every entry point (Navbar, LMS
checkout, LAB checkout). After verification, required consents are recorded by the existing
authenticated-consent action (`/v1/me/consents` MY variant) when `consentRequired` is true;
marketing stays optional. Purchase acceptance evidence is stored separately per storefront Stage B
edition (C/D), not by this flow.

### Limits (fixture `otp.json`)

| Limit | Value | Store |
| --- | --- | --- |
| Code lifetime | 600 s | Better Auth `verification.expires_at` |
| Wrong attempts per code | 5, then code burned (`TOO_MANY_ATTEMPTS` → "request a new code") | plugin counter |
| Resend cooldown per e-mail | 60 s | `my_otp_outbox` |
| Codes per e-mail | 3 / 15 min, 10 / 24 h | `my_otp_outbox` |
| Send per IP | 5 / min | Better Auth rate limit (`customRules`) |
| Verify per IP | 10 / min | Better Auth rate limit |

Worst case online guessing per address ≤ 10 × 5 = 50 guesses / 24 h against 10⁶ codes.
**Invariant: one Commerce instance.** Better Auth's per-IP rate-limit store is in-process memory.
The guarantee relies on the release contract (E) running exactly one Commerce process per
environment. A restart resets only the per-IP layer; the per-e-mail layer (`my_otp_outbox`) is
durable. Before Commerce is scaled out, the per-IP layer must move to durable storage
(Better Auth `rateLimit.storage: "database"` or a Commerce table). Until then, scaling out is a
contract break, not a configuration change.

Expired or wrong code ⇒ `400 OTP_INVALID_OR_EXPIRED` (one code for both; no hint whether the
account exists) and the UI offers "Отправить код ещё раз" respecting the cooldown.

### Delivery

`sendVerificationOTP` reuses the configured mail transport (`auth-email-delivery.ts`). The
**code is never persisted outside Better Auth's hash**: Commerce records only a delivery fact
in `my_otp_outbox` (recipient, state, attempt count, sanitized error) for throttling and
Control Room e-mail operations. This differs deliberately from the magic-link outbox, which
stores an encrypted URL.

### Storage classification (why retention and erasure need a narrow extension)

`emailOTP` writes `verification(identifier='sign-in-otp-<normalized email>', value='<sha256 b64url>:<attempts>')`
(identifier storage is plain in our config). Current `pd-retention.ts` and `erasure-restore.ts`
require every `verification.value` to be JSON `{email}` and otherwise refuse the **whole** job
(`RETENTION_VERIFICATION_CLASSIFICATION_REQUIRED`, `ERASURE_VERIFICATION_UNCLASSIFIED`). The
implementation therefore requests (coordinator, shared files) one additional accepted shape:
identifier `^sign-in-otp-(.+)$` **and** value `^[A-Za-z0-9_-]{43}:\d{1,2}$`, subject e-mail taken
from the identifier. Any other non-JSON row keeps refusing.

---

## 5. Why not Better Auth `oneTimeToken` — comparison for the exchange

FLEX-121 requires comparing the plugin as a primitive with one-time records redeemed through a
supported storage mechanism. Read from 1.7.6 `dist/plugins/one-time-token/index.mjs` and
`dist/db/internal-adapter.mjs`:

| Criterion | A. `oneTimeToken` (hardened flags) | B. `internalAdapter` verification record | **C. Commerce-owned exchange + LMS session (chosen)** |
| --- | --- | --- | --- |
| What is stored | `verification.value` = **raw MY session token** (plaintext bearer credential at rest) | Our JSON value | SHA-256 of state and code; no MY token copied |
| Retention / erasure classification | Breaks both jobs on the first row (non-JSON value) | OK if value is `{email,…}` | New tables with FK cascades; classified in §7 |
| Atomic redemption | `consumeVerificationValue` is atomic for the row | Same | One `BEGIN IMMEDIATE` compare-and-set covering state, code, parent session, binding **and** LMS session insert |
| Expiry handling | Without `disableSetSessionCookie` sets the MY cookie **before** checking `expiresAt` | Caller's code | Checked inside the transaction before any write |
| Browser binding / audience / return path | None; would live in a second store, not in the same transaction | Same | Columns of the same row |
| Resulting LMS credential | Would be a Better Auth session ⇒ `getSession` accepts it on MY unless every route re-checks | Same if `createSession` is used | Not a Better Auth session ⇒ structurally unusable on MY |
| Exposed surface | `/one-time-token/verify` on the public `/v1/auth/*` router must be blocked; `hooks.after` matcher runs on every auth request | `$context.internalAdapter` is an internal API with no stability promise | Commerce routes only; Better Auth used through `auth.api.getSession` and its own session table schema (ours since migration 0001) |
| Revocation | Must be implemented separately | Separately | `ON DELETE CASCADE` from `session` |

Decision: **C**. Better Auth stays the authority for OTP and the MY session; Commerce owns the
exchange and the derived LMS session in its own SQLite transaction. The only Better Auth
dependency beyond public API is reading the `session` table we already define (columns
`id, token, expires_at, user_id`, plus the new `audience`), which is pinned by migrations and the
exact `better-auth` version.

### Review criteria for the chosen mechanism (must hold before FLEX-121 is accepted)

1. **Atomic redemption:** exactly one concurrent redeem of an `ISSUED` exchange succeeds; the
   loser sees `EXCHANGE_CLOSED` and no LMS row is created (parallel test on one DB file).
2. **No partial state:** a failure at any step after the status check rolls back the LMS insert
   and records `FAILED` in a separate write; no LMS row exists without a `REDEEMED` exchange
   (`lms_sessions.exchange_id` is `NOT NULL UNIQUE`).
3. **Isolation:** an LMS token on MY, a MY token on LMS (mode `on`), a legacy token on LMS
   (mode `on`) and both kinds on the wrong route group are refused by Commerce directly and
   through each valid proxy.
4. **Revocation:** deleting the parent `session` row (sign-out on my, LMS Navbar sign-out,
   erasure, restore, expiry clean-up) leaves no usable LMS session or open exchange.
5. **No secret at rest or in transit beyond need:** state, code and LMS token stored only as
   SHA-256; code only in a POST body; never in query, `Referer`, logs or analytics.

---

## 6. LMS session exchange (FLEX-121)

### States

`STARTED → ISSUED → REDEEMED`, with `ISSUED → ISSUED` (re-issue rotates the code), and terminal
`FAILED` / `CANCELED`. Expired rows are treated as closed without a write. Fixture
`exchange.json` lists every transition and refusal.

### Flow

1. **Start (LMS, buyer's browser).** A protected lesson page or an explicit enrol action finds no
   valid LMS session and navigates the same tab to `GET /auth/lms/start?next=<path>` (platform
   route handler, A). Public pages and the Navbar background check never start an exchange.
   The handler calls Commerce `POST /v1/lms/exchange/start {next}` (LMS surface). Commerce
   validates `next` (§7 return targets), creates `session_exchanges` with a 128-bit id `tx`,
   `state = 256-bit random`, `state_sha256`, `return_path`, `expires_at = now + 600 s`.
   Response sets a **per-exchange** state cookie `__Host-flx-lms-x-<tx>=<state>` (`Path=/`,
   `HttpOnly`, `Secure`, `SameSite=Lax`, `Max-Age=600`, no `Domain`) and
   `303 Location: <MY_ORIGIN>/continue?tx=<tx>`.
   **Concurrent exchanges in one browser:** each start gets its own cookie, so two tabs opening
   protected lessons at nearly the same moment each finish their own exchange. A forced
   cross-site start also cannot overwrite the victim's state; it only adds a cookie. At most
   **3** state cookies are kept. When a start would make a fourth, the start response expires
   the cookie of the oldest presented exchange (by `created_at`, unknown ids first) with
   `Max-Age=0`. An attacker who forces starts can therefore make the victim's in-flight exchange
   fail the state check. Under the burn rule below that costs only a retry, never a burned
   exchange or access to another account. The cookie header stays bounded (3 × ~90 bytes).
   Anti-loop: if the browser presents any state cookie whose exchange ended `FAILED`/`CANCELED`
   less than 30 s ago, start answers `409 EXCHANGE_RECENTLY_FAILED` and the LMS shows a manual
   "Попробовать снова" button instead of redirecting.
2. **Continue (my).** `apps/my` `/continue?tx=` (server component) reads
   `GET /v1/my/exchange/:tx` → `{status, target:{surface:"LMS", path}}`. Without a MY session it
   renders the OTP sign-in and returns to `/continue?tx=` after verify (local my path). With a
   live MY session no OTP is requested.
3. **Issue (my).** `POST /v1/my/exchange/:tx/issue` (`Origin` = `MY_ORIGIN`, MY session). In one
   transaction: exchange `STARTED`/`ISSUED` and unexpired; bind `my_session_id`, `customer_id`
   (confirmed per §2); new 256-bit `code`, `code_sha256`, `code_expires_at = now + 60 s`;
   status `ISSUED`. Re-issue (page reload, or another account signed in on my) rotates code and
   binding; the previous code dies. Response `{code, redeemUrl:"<PLATFORM_ORIGIN>/auth/lms/redeem"}`
   goes only to the my server, which renders an auto-submitting `<form method="post">` with
   `tx` and `code`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`,
   CSP `form-action <PLATFORM_ORIGIN>`. A "Отмена" control posts `/v1/my/exchange/:tx/cancel`
   (→ `CANCELED`) and links to the public course page, never back to the start URL.
4. **Redeem (LMS).** Platform route handler `POST /auth/lms/redeem` (form) forwards to Commerce
   `POST /v1/lms/exchange/redeem {tx, code}` with the browser's cookies and `Origin`. Commerce
   requires LMS surface and `Origin` = `MY_ORIGIN` exactly (the form posts from my), then in one
   `BEGIN IMMEDIATE` transaction:
   1. exchange exists, `status='ISSUED'`, `expires_at > now`, `code_expires_at > now`;
   2. `sha256(__Host-flx-lms-x-<tx>)` = `state_sha256` and `sha256(code)` = `code_sha256` (constant time);
   3. parent `session` row exists, `audience='MY'`, unexpired; binding of §2 holds for
      `customer_id`;
   4. `UPDATE … SET status='REDEEMED' … WHERE id=? AND status='ISSUED'` changes exactly 1 row;
   5. delete the LMS row of the presented `__Host-flx-lms` (account switch in this browser);
   6. insert `lms_sessions` (`expires_at = min(parent.expires_at, now + 12 h)`).
   **What burns an exchange.** `tx` is not a secret: it appears in the `/continue?tx=` URL and in
   history, and outside a browser `Origin` can be forged. So:
   * The state cookie `__Host-flx-lms-x-<tx>` is missing or does not match ⇒ refusal
     (`EXCHANGE_STATE_MISSING` / `EXCHANGE_STATE_MISMATCH`) **without any status change**. The code
     is written to the diagnostics log (code only, no ids or secrets). Per-IP redeem limit: 20 per
     minute.
   * The state matches but the code is wrong or expired, or the check gives
     `PARENT_SESSION_INVALID` / `ACCOUNT_BINDING_MISMATCH` ⇒ the row becomes `FAILED` with that
     code (burned; a code is single-use even when wrong). Only the holder of the browser state
     can trigger this.
   * Exchange not `ISSUED` or expired ⇒ `EXCHANGE_CLOSED` / `EXCHANGE_EXPIRED`, no write.

   Response on success: LMS cookie set, that exchange's state cookie cleared (`Max-Age=0`), `303 Location: <return_path>` (relative, same LMS origin). On failure:
   `303` to `/auth/lms/failed?reason=<code>` (no secrets), which renders a manual retry; no
   automatic redirect.
5. **Entitlement** is not decided by the exchange. The lesson route keeps checking the current
   entitlement and required consents (A's FLEX-128 code), so access right after payment and
   denial after refund follow the existing playback checks.

Code transport: POST body only (preferred by the card). The fragment variant is not used.

### LMS sign-out

`POST /v1/lms/sign-out` (LMS, `Origin` = `PLATFORM_ORIGIN`): resolves the LMS session, deletes its
**parent MY session** (FLEX-121 policy and FLEX-123 Navbar "Выйти"), which cascades to every
derived LMS session and every open exchange of that MY session; clears `__Host-flx-lms`; rotates
the LMS browser context (existing `rotateOnLogout`). The separate server-side revocation of one
LMS session (`revokeLmsSession(id)`) exists as an internal function for isolation qualification
and Control Room, not as a browser route.

---

## 7. Return targets, origins and old links

Exact allowlists (fixture `return-targets.json`, regexes are normative):

| Where | Accepted | Refused |
| --- | --- | --- |
| LMS `next` / `return_path` | `^/courses/[a-z0-9-]{1,80}(/lessons/[a-z0-9-]{1,120})?$` and `^/account$` (cabinet landing on LMS until FLEX-127 decides) | anything with scheme, `//`, `\`, `%2f`/`%5c` (any case), `..`, query, fragment, control chars, `/auth/*`, `/v1/*`, `/arrive`, > 256 chars |
| my `next` after OTP | `^/$`, `^/continue\?tx=[A-Za-z0-9_-]{22}$`, `^/orders$`, `^/profile$`, `^/courses$`, `^/tickets$` (FLEX-123), `^/checkout/[A-Za-z0-9_-]{12,100}$` (C/D intent ids) | same refusals; any absolute URL |
| Exchange redirect from my | always `PLATFORM_ORIGIN + /auth/lms/redeem` (constant, not data) | — |
| Redeem result | `return_path` stored at start, relative | never an absolute URL |

Invalid `next` is not an error page: it is replaced by the surface default (`/` on my, the
course page or `/` on LMS). Commerce validates on write (start) **and** the platform handler
re-validates on read; both use the same exported validator.

Exact origins for `Origin` checks: MY routes `MY_ORIGIN`; redeem `MY_ORIGIN`; LMS sign-out
`PLATFORM_ORIGIN`. Absent `Origin` on these state-changing routes is refused
(`403 ORIGIN_REQUIRED`). **Exception:** exchange start is a top-level GET navigation whose
Commerce call is made server-to-server by the platform handler, so it carries no browser
`Origin`. A cross-site forced start is harmless by construction: it only sets a state cookie in
the victim's own browser, and the victim can only ever redeem a code issued to the victim's own
MY session into an allowlisted path. Login CSRF in the other direction (victim redeems the
attacker's code) fails because the victim lacks the attacker's state cookie and because redeem
requires `Origin` = `MY_ORIGIN`.

Same-origin proxies send no `Access-Control-*` headers; a `Set-Cookie` with `Domain` from Commerce
is refused by the proxy (existing canary rule, extended to production for `apps/my` and the
`/auth/lms/*` handlers).

---

## 8. Revocation and expiry (acceptance policy)

| Event | Effect |
| --- | --- |
| Sign-out on my | Better Auth deletes the `session` row ⇒ cascade deletes its LMS sessions and exchanges |
| "Выйти" in LMS Navbar | §6 LMS sign-out (deletes parent MY session) |
| Another account signs in on my | The verify wrapper deletes the previously presented MY session row before setting the new cookie ⇒ cascade; LMS cookie in that browser points to a deleted row ⇒ next protected access starts a fresh exchange for the new account |
| MY session expiry | LMS join fails immediately (parent `expires_at`); retention deletes rows after grace |
| LMS session expiry (12 h cap) | Protected access restarts the exchange; no OTP while MY is live |
| Erasure | `DELETE "user"` cascades `session` ⇒ LMS and exchanges; `customers` FK cascades too |
| Restore | Every credential is invalidated (existing rule) plus explicit delete of `session_exchanges` and `lms_sessions` |

Required consents missing ⇒ protected LMS routes answer `CONSENT_REQUIRED` as today; the exchange
itself still issues so the user can complete consent on my.

---

## 9. Contract to FLEX-127 (old `/account` links, free enrolment)

Fixture `legacy-links.json`. In mode `on`:

* `GET /account?next=<p>` on flexperiment.ru: if `p` passes the LMS validator ⇒
  `303 /auth/lms/start?next=<p>`; otherwise ⇒ `303 <MY_ORIGIN>/` (cabinet on my).
* `GET /account` without `next` ⇒ `303 <MY_ORIGIN>/`.
* Stage A magic-link URLs (`/v1/auth/magic-link/verify?...`) ⇒ `410 MAGIC_LINK_RETIRED` with a
  page offering "Войти через my" that starts the exchange for the preserved local `callbackURL`
  if it validates.
* A legacy LMS session is ignored; protected access starts the exchange; the `customer_id` is
  the same after OTP because the e-mail binding is unchanged.
* This section is the **return and link-migration contract handed to FLEX-127**. B does not
  implement the `/account` switch: it belongs to FLEX-127 after Stage A. In `apps/platform`, B
  adds only the exchange handlers `/auth/lms/start` and `/auth/lms/redeem` (the "exchange
  receiver") and the `lms` root in `commerce-proxy.ts`, both behind `MY_IDENTITY_MODE`.
* Free enrolment uses the same exchange with `next` = the course page and the explicit enrol
  action on return (FLEX-127 owns the action and its acceptance).

Mode `off`: unchanged Stage A behaviour (FLEX-128 acceptance, no payment effects).

---

## 10. Profile reads (input to FLEX-123)

| Route | Surface | Fields (closed set) |
| --- | --- | --- |
| `GET /v1/my/profile` | MY | `email`, `displayName`, `createdAt`, `consentRequired`, `marketing` (per-document status after the FLEX-125 decision) |
| `GET /v1/me` | LMS (mode `on`) | `signedIn`, `displayName`, `emailMasked` (`a***@d***.ru`), `entitlements[{scope,courseRef}]` |
| `GET /v1/me` | LAB | unchanged until FLEX-123 |

No customer id, auth user id, session id or full e-mail on LMS/LAB. FLEX-123 may narrow further.

---

## 11. Migration 0038 (provisional) — registration preview

To be registered with the coordinator **before** integration with the exact SQL, both schema
fingerprints (retention and erasure allowlists) and the isolated restore proof.

```sql
ALTER TABLE "session" ADD COLUMN audience TEXT CHECK (audience IS NULL OR audience = 'MY');

CREATE TABLE my_otp_outbox (
  id TEXT PRIMARY KEY,
  recipient_normalized TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PENDING','SENT','FAILED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 240),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX my_otp_outbox_recipient ON my_otp_outbox(recipient_normalized, created_at);

CREATE TABLE session_exchanges (
  id TEXT PRIMARY KEY CHECK (length(id) = 22),
  audience TEXT NOT NULL CHECK (audience = 'LMS'),
  return_path TEXT NOT NULL CHECK (length(return_path) BETWEEN 1 AND 256),
  state_sha256 TEXT NOT NULL CHECK (length(state_sha256) = 64),
  status TEXT NOT NULL CHECK (status IN ('STARTED','ISSUED','REDEEMED','FAILED','CANCELED')),
  my_session_id TEXT REFERENCES "session"(id) ON DELETE CASCADE,
  customer_id TEXT REFERENCES customers(id) ON DELETE CASCADE,
  code_sha256 TEXT UNIQUE CHECK (code_sha256 IS NULL OR length(code_sha256) = 64),
  code_expires_at TEXT,
  failure_code TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  issued_at TEXT,
  closed_at TEXT,
  CHECK (status NOT IN ('ISSUED','REDEEMED') OR (my_session_id IS NOT NULL AND customer_id IS NOT NULL
    AND code_sha256 IS NOT NULL AND code_expires_at IS NOT NULL AND issued_at IS NOT NULL)),
  CHECK (status <> 'FAILED' OR failure_code IS NOT NULL)
);
CREATE INDEX session_exchanges_my_session ON session_exchanges(my_session_id);
CREATE INDEX session_exchanges_expiry ON session_exchanges(expires_at);

CREATE TABLE lms_sessions (
  id TEXT PRIMARY KEY,
  token_sha256 TEXT NOT NULL UNIQUE CHECK (length(token_sha256) = 64),
  parent_session_id TEXT NOT NULL REFERENCES "session"(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  exchange_id TEXT NOT NULL UNIQUE REFERENCES session_exchanges(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX lms_sessions_parent ON lms_sessions(parent_session_id);
CREATE INDEX lms_sessions_expiry ON lms_sessions(expires_at);
```

### `session.audience`: default, existing rows, adapter impact

* **DDL:** `ALTER TABLE "session" ADD COLUMN audience TEXT CHECK (audience IS NULL OR audience = 'MY')`.
  SQLite adds a nullable column with a constant `NULL` default in place, so the table is not
  rebuilt and existing rows and indexes are untouched. There is no `DEFAULT` clause, so the value
  is `NULL`.
* **Existing rows:** every Stage A session (and every session created while the mode is `off`)
  keeps `audience IS NULL` and is classified `LEGACY`. No backfill. A `NULL` row is never
  promoted to `MY`: the only writer of `'MY'` is the session-create hook on the MY surface.
* **Better Auth adapter (1.7.6):** the Kysely/SQLite adapter reads and writes only the fields in
  its schema (`db/schema.mjs` merges `session.additionalFields`). Declared as
  `session.additionalFields.audience = { type: "string", required: false, input: false }`, the
  adapter inserts the hook-stamped value and returns it from `getSession`. `input:false` means
  no client body can set it. Without the declaration the adapter ignores the column and inserts
  `NULL` (fail-closed: such a session is `LEGACY`, never `MY`). `/v1/auth/get-session` echoes the
  field to the session's own browser, which is harmless because it is not a credential.
* **Mode `off` equivalence:** with `MY_IDENTITY_MODE=off` the hook writes nothing, every new
  session is `NULL` as today, and the audience-aware resolver returns exactly what
  `authenticateCustomer` returns today on LMS and LAB. The resolver switch lands as a **separate
  commit** with an equivalence test over all `/v1/me*`, lessons, checkout and refunds routes,
  A's new `POST /v1/me/free-enrollments` included, run after rebasing on A.

| Surface | Classification | Retention | Erasure | Restore |
| --- | --- | --- | --- | --- |
| `session.audience` | credential metadata, no new identity | with `session` (existing `EXPIRED_CREDENTIALS`) | cascade from `user` | all sessions deleted (existing) |
| `my_otp_outbox` | e-mail address + delivery fact; no code | new rule: delete after `authOutboxMaxAgeSeconds` and ≥ 600 s, unless held (`AUTH_OUTBOX`, e-mail refs) | delete by e-mail | kept (no credential); erased e-mails re-applied by ledger |
| `session_exchanges` | credential hashes, customer FK, return path (no PD) | `EXPIRED_CREDENTIALS` after grace, refs = customer/user | cascade from `customers` / `session` | `DELETE` all |
| `lms_sessions` | credential hash, customer FK | `EXPIRED_CREDENTIALS` after grace | cascade | `DELETE` all |
| `verification` rows of `emailOTP` | e-mail in identifier, hashed code | extended classifier (§4) | extended classifier | all deleted (existing) |

`PRAGMA foreign_keys = ON` is already set by `openV2Database`; cascades are part of the proof.
Fingerprints are computed by `assertReviewedRestoreSchema`'s query on the final 0038 schema with
the hashed journal and added to both allowlists in the same PR that adds the SQL.

---

## 12. `apps/my` skeleton and Docker/CI contract (owned by B; E admits the image)

* Next.js `16.3.0` app in `apps/my` (workspace package `@flexperiment/my`), App Router, server
  components; local Next guides in `node_modules/next/dist/docs/` are read before writing it.
* Routes: `/` (cabinet), `/sign-in`, `/continue`, `/profile`, `/orders` (read-only list),
  `/healthz`, `/identity` (build identity like the other images), `/v1/[...path]` proxy with root
  allowlist `my`, `checkout`, `refunds`, `me`, `legal`, `email` — same header discipline as
  `proxyCommerce`, Domain cookies refused, `Access-Control-*` stripped, redirects must stay on
  `MY_ORIGIN`.
* No analytics, no third-party scripts, `Referrer-Policy: no-referrer` site-wide, CSP with
  `form-action 'self' <PLATFORM_ORIGIN>`, `frame-ancestors 'none'`.
* `Dockerfile.my`: multi-stage, `output: "standalone"`, non-root user, port `3003`, env
  `MY_ORIGIN`, `PLATFORM_ORIGIN`, `COMMERCE_INTERNAL_ORIGIN`, `SOURCE_COMMIT`; no secrets baked.
* CI: a separate `my` job in `.github/workflows/test.yml` (lint, typecheck, unit tests, `next
  build`, `docker build -f Dockerfile.my`) — added via the coordinator. Release/deploy workflows,
  Coolify and host routes are E's; `CUSTODY_IMPACT` for the image admission is E's PR.

---

## 13. Test plan (local) and what needs an admitted environment

Local (vitest, temp SQLite, fake mail transport, `MY_IDENTITY_MODE` both values):

* OTP: send generic response for new/existing/erased/throttled; cooldown; code expiry; 5 wrong
  attempts burn; replay of a used code; per-IP and per-e-mail limits; nothing persisted before
  CAPTCHA; no e-mail/code in captured logs.
* Audience: MY token on LMS routes, LMS token on MY routes, legacy token on LMS in mode `on`,
  each route group against the wrong surface — directly against the Hono app and through the
  platform and my proxy functions with forged `x-forwarded-host`/`forwarded` headers.
* Config: same-site check of `MY_ORIGIN` / `PLATFORM_ORIGIN` (fixture pairs).
* Exchange: two tabs in one browser completing concurrently; a 4th start evicts the oldest;
  missing/mismatched state leaves `ISSUED` intact and a later correct redeem succeeds;
  happy path; missing state cookie; other browser (different state); state mismatch;
  code replay; parallel double redeem; expired tx; expired code; wrong `Origin`; wrong surface;
  account switch between start and issue and between issue and redeem; MY sign-out before
  redeem; parent expiry after redeem; LMS sign-out revokes parent and siblings; invalid `next`
  values from the fixture.
* Schema: fingerprints for retention and erasure; isolated restore drops all credentials;
  restore of an older snapshot followed by the erasure ledger re-deletes `my_otp_outbox` rows of
  an erased address (explicit test);
  erasure cascades; retention classifier accepts OTP rows and still refuses unknown rows.

Requires an admitted environment (not claimed by local tests): real mail delivery and spam
placement, SmartCaptcha with real keys, host-only cookies and absence of CORS headers on the real
canary proxies, Kinescope protected playback right after payment and denial after refund, the
`apps/my` image in the release process (E).

---

## 14. Open conditions

1. **FLEX-125 legal edition for my (owner decision pending).** `legal_releases.storefront` is
   `CHECK IN ('COURSES','LAB')` (0001/0025/0030/0034), and authenticated consent binds to the
   `manifest_sha256` of a whole storefront release, so changing a purchase document resets
   account consent. E recommends **variant C** (`docs/legal/my-account/2026-11-21-legal-release-storefront.md`,
   #287): a separate, additive account edition. Until the owner decides, MY OTP send answers
   `LEGAL_RELEASE_NOT_FOUND` (`MY_ACCOUNT_LEGAL_STOREFRONT` unset), and tests use a fixture
   release. The sketch below shows the scope of C. **Conditional DDL, not implemented**; if chosen,
   it joins this migration (registry reservation B/0038) before integration.

   ```sql
   -- Account documents only: privacy, personal_data, account_terms, marketing_consent.
   CREATE TABLE account_legal_releases (
     id TEXT PRIMARY KEY,
     version TEXT NOT NULL UNIQUE,
     manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
     manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
     active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
     activated_at TEXT, actor TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
   );
   CREATE UNIQUE INDEX one_active_account_legal_release ON account_legal_releases(active) WHERE active = 1;
   -- Same evidence shape as 0025, bound to the account edition instead of a storefront release.
   CREATE TABLE account_consent_actions (
     id TEXT PRIMARY KEY,
     customer_id TEXT NOT NULL REFERENCES customers(id),
     auth_user_id TEXT NOT NULL REFERENCES "user"(id),
     account_release_id TEXT NOT NULL REFERENCES account_legal_releases(id),
     release_version TEXT NOT NULL,
     manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
     entry_point TEXT NOT NULL CHECK (entry_point IN ('MY_NAVBAR','LMS_CHECKOUT','LAB_CHECKOUT')),
     action_key TEXT NOT NULL,
     request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
     recorded_at TEXT NOT NULL CHECK (datetime(recorded_at) IS NOT NULL),
     UNIQUE (customer_id, action_key)
   );
   CREATE TABLE account_consent_events (
     sequence INTEGER PRIMARY KEY AUTOINCREMENT,
     action_id TEXT NOT NULL REFERENCES account_consent_actions(id) ON DELETE CASCADE,
     kind TEXT NOT NULL CHECK (kind IN ('personal_data','account_terms','marketing_consent')),
     granted INTEGER NOT NULL CHECK (granted IN (0,1)),
     document_version TEXT NOT NULL,
     document_sha256 TEXT NOT NULL CHECK (length(document_sha256) = 64),
     UNIQUE (action_id, kind)
   );
   -- Plus two BEFORE INSERT authority triggers mirroring 0025 (verified bound user, active account
   -- edition, exact document version/hash from its manifest; required kinds granted = 1).
   -- Storefront releases keep only purchase documents and name the account edition by id + sha256
   -- inside their manifest JSON; no existing table, CHECK or trigger changes.
   ```

   Classification if adopted: `account_legal_releases` holds operator-authored legal text (no subject
   data; kept by backup, never erased); `account_consent_*` hold subject-linked evidence, handled
   exactly like `authenticated_consent_*` in erasure (delete by customer) and retained by
   retention. 0025 events stay as history, read-only, and are never migrated into the new tables.
   Both fingerprints and the restore proof are recomputed for the combined schema.
2. **Shared files** (coordinator's integration order: after A's 0037; each PR recomputes both
   fingerprints on its own base, and a hash conflict is resolved only by recomputing):
   `pd-retention.ts`, `erasure-restore.ts` (B's own classification block: OTP verification rows,
   0038 tables, restore delete), `origins.ts` in commerce-v2 and `apps/platform/lib` (additive optional `MY_ORIGIN`;
   byte-for-byte unchanged behaviour in mode `off`), `app.ts`/`server.ts` (route registration, resolver
   wiring), `apps/platform` `/auth/lms/*` handlers and `/account` redirect (A), `commerce-proxy.ts`
   (root `lms`; mode-`on` narrowing of `checkout`/`refunds` on LMS), `package.json`/lockfile
   (workspace `apps/my`; on conflict the lockfile is regenerated after rebase, never merged by hand), `test.yml` job. Each goes to the coordinator as a concrete diff before
   editing.
3. **Better Auth hook context:** whether `session.create.before` sees the request in 1.7.6 is
   verified in the first implementation commit; the AsyncLocalStorage fallback is specified above.
4. **Owner policy decisions to confirm at acceptance** (FLEX-121/123): (a) "Выйти" in the LMS
   (or LAB) Navbar deletes the parent MY session, so signing out on the LMS **also signs the user
   out of my** and of every other derived LMS session; (b) another account signing in on my
   revokes the previous MY session in that browser; (c) the LMS session lifetime is 12 h, capped
   by the MY session. These are the card's stated policy; the owner confirms them explicitly
   during acceptance.
5. **Owner GO** is required for `MY_IDENTITY_MODE=on` in any environment, for the my DNS/route
   and for production; nothing here changes the host.
