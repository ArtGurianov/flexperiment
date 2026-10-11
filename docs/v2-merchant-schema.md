# Flexperiment v2 merchant schema

This document is the normative storage contract for the Flexperiment v2
merchant database. The database is created from
the ordered migrations under `commerce-v2/migrations`; it is a new lineage and is never
applied to the frozen v1 database.

## Authority boundary

Flexperiment stores its own customers, catalogue projection, prices, sale
policy, orders, fulfilment, entitlements, playback state and audit evidence.
Refref owns payment and refund execution. Flexperiment stores only identifiers,
idempotency keys and the latest observed Refref projection needed to reconcile
its own obligations. Provider credentials and provider-native payment state do
not belong in this database.

Payload's editorial SQLite database is separate. It stores drafts, published
content, media metadata, versions and Payload jobs. Neither database attaches
the other, and neither schema contains tables owned by the other service.

## Public origin boundary

The four public authorities are configured independently: `PLATFORM_ORIGIN`
for the course storefront, `LAB_ORIGIN` for the LAB storefront,
`ADMIN_ORIGIN` for Control Room and `API_ORIGIN` for the commerce API. A
production commerce process refuses to start unless all four are explicit
HTTPS origins without credentials, paths, queries or fragments. The older
generic public-origin and provider-return variables are not v2 authorities.

Authentication and checkout carry `COURSES` or `LAB` as signed state. That
storefront selects the active legal release, the public magic-link host and the
payment return host; it is checked again against the purchased offer before an
order can be confirmed. Admin links and platform metadata use their own named
origins and cannot select a customer storefront.

## Identity and migration

`schema_identity.lineage` is exactly `flexperiment-v2`. A v1 database, a
foreign database or an unrecognised non-empty SQLite file is refused before a
migration is applied. A fresh empty database is bootstrapped transactionally.
The first baseline and its migration-ledger row either both commit or neither
does.

## Owned records

- Better Auth owns `user`, `session`, `account` and `verification`.
- `customers` is independent of Better Auth. `auth_user_id` is nullable and
  unique; `email_normalized` is unique, allowing a verified account to bind to
  an existing LAB guest without creating another customer.
- `products` owns product kind, FREE/PAID access and audited withdrawal.
  `offers` owns live price and `sale_mode` (`CLOSED`, `ACCEPTANCE_ONLY`,
  `PUBLIC`). One product has one current offer, enforced by the database. The
  sole `COURSE_BUNDLE` product is `bundle:all-courses`; its fulfilment stores a
  durable `ALL_COURSES` entitlement instead of expanding today's catalogue.
  The product aggregate has a
  monotonic `version`; Control Room creates with expected version zero and
  every edit or withdrawal compares and advances that version, so stale
  browser commands fail without overwriting a newer decision. A product's
  identity (kind, course or occurrence, offer ref) is fixed at creation and
  guarded by triggers; only access model, price, sale mode and allowlist are
  editable. Public selling additionally requires a matching active
  `sales_activation` record, re-checked with the live payment mode at checkout
  preview and confirmation. An activation must cite the acceptance evidence
  for its kind — ART-240 for courses and the bundle, ART-243 for LAB — which
  the command and a schema trigger both enforce.
- `merchant_promotion` contains only merchant promotion authority: a normalized
  reserved-prefix code, discount rule, optional eligible offer and active
  window. It has no partner, referral, attribution or reward fields. The
  configured prefix is required in production. A code in that namespace is
  either resolved locally or rejected locally and is never forwarded to
  Refref; codes outside the namespace are passed to Refref as `checkoutCode`.
  Promotion edits use the same expected-version rule.
- `checkout_quotes` durably holds the customer-bound referral resolution while
  the customer reviews catalogue price, merchant discount, Refref discount,
  checkout-code outcome and final price. The Refref line amount is the amount
  after the merchant discount. No order or
  immutable checkout snapshot exists at this stage. Confirmation revalidates
  the live offer, merchant promotion and active legal release, consumes the quote once, and only
  then creates `orders`, `order_lines` and `checkout_attempts`.
- `orders` and `order_lines` freeze the confirmed live offer, legal release and
  checkout snapshot used for a purchase. The order JSON is the exact closed
  `refref.shared-checkout-snapshot/1` structure produced by the merchant-side
  builder; its `snapshot_hash` is the lowercase SHA-256 portion of the
  `refref-jcs-1:<hex>` digest sent unchanged with that structure to Refref.
  Each paid line separately preserves catalogue price, merchant discount,
  post-promotion merchant amount, final amount, promotion evidence, fiscal
  item, legal release ref/hash and (for LAB) the occurrence ref and service
  times. Refref's accepted projection must return the same namespaced digest
  before it may advance the local order. `checkout_attempts` projects that
  protocol without becoming payment authority.
- `course_entitlements` is append-only grant evidence per order line. Revoking
  one line never revokes a separate COURSE or ALL_COURSES grant.
- `course_access_starts` records the first successful playback grant backed by
  a paid entitlement. A refund request freezes that fact together with product
  kind, line amount and order time; it does not infer eligibility from it.
- `refund_requests`, `refund_decisions` and `refund_executions` separate the
  customer request, Flexperiment's operator decision and Refref's external
  effect. Approval requires an amount, policy basis, rationale and actor. The
  removed direct-order refund route cannot bypass that decision. An ambiguous
  submission remains `PROCESSING` under one idempotency key and is reconciled,
  never submitted again by the caller. Entitlement revocation happens only
  when successful refunds cover that order line; a partial refund preserves
  the grant, and another ALL_COURSES grant remains independent.
- `control_room_admin_sessions` contains short-lived, revocable server-side
  sessions for the v2 operator surface. The browser receives only a signed,
  HttpOnly, Secure, SameSite=Strict cookie; the admin password stays an
  environment-owned scrypt verifier. `control_room_login_rate_limits` makes
  throttling durable across process restarts, and `control_room_audit_log`
  records authenticated commands with the server-derived operator identity.
- Control Room operational views expose only typed projections: auth-email
  delivery metadata (never its encrypted payload), campaign counts, actionable
  checkout/refund/access/email incidents and a merged merchant/session audit
  chronology. They do not mutate or reinterpret provider authority.
- Control Room reads are explicit typed projections over merchant-owned data:
  catalogue, orders, customers, entitlements, cities, LAB occurrences,
  refunds, attention and Refref integration health. They do not expose generic
  database rows or accept browser-supplied actor identities. Internal service
  reads continue to require the service token; browser reads and commands use
  the Control Room session and same-origin checks.
- `catalog_*_projection` is the atomically applied, full-state content manifest.
  Course versions only move forward. Section visibility participates in a
  lesson's effective visibility.
- `access_overrides` records restrictive intent. PENDING overrides remain
  enforced until commerce resolves them to FINALIZED, SUPERSEDED or
  RELEASED_ROLLED_BACK with the required proof.
  Manifest-finalized outcomes record the resolving version and hash; rollback
  release instead records the process epoch, deadline and transaction-ended
  proof as JSON because no resolving manifest exists in that case.
- `lesson_video_bindings`, `video_upload_sessions` and
  `kinescope_webhook_events` keep video identifiers private.
- `playback_grant_rate_limits` durably caps grant minting per customer and
  minute. `playback_access_events` records grant, DRM callback, rate-limit and
  invalid-token outcomes without storing the signed token; Control Room shows
  the rolling 24-hour outcome counts so abnormal access is visible.
- Protected playback uses a short-lived HS256 JWT bound to one customer and
  one active Kinescope video. Kinescope calls
  `POST /v1/kinescope/drm/authorize` with Basic authentication; commerce
  validates signature, issuer, audience, expiry and video binding, then
  re-evaluates the current access policy. A token cannot be replayed for a
  different video, and a withdrawal or revocation takes effect at the DRM
  callback even while an already minted token has time remaining.
- `lesson_resume_positions` uses `(customer_id, lesson_ref)` as its identity;
  updates are accepted only when their client ordering tuple is newer.
- Campaign creation is keyed by the author's stable idempotency key and freezes
  the published course/version, lesson selection and recipient rows. Author
  confirmation only queues the campaign; a leased commerce worker dispatches
  it asynchronously. Recipients are unique per `(campaign_id, customer_id)`
  and carry a stable provider idempotency key across an explicit failed retry.
  Consent and suppression are still re-checked immediately before each send.
  Production confirmation and dispatch remain disabled unless
  `MARKETING_BROADCASTS_ENABLED=true`; that switch is gated by ART-232 and the
  Notisend account review.
- Legal releases are activated by an audited internal command. Stage A refuses
  a manifest without privacy, personal-data, account-terms and marketing
  documents; Stage B additionally requires the course offer, receipt-contact,
  fiscal-item and refund-terms documents. The stored manifest digest is the
  immutable evidence bound into checkout snapshots.

## Closed normal-canary deployment (ART-179 / ART-166 / ART-165)

The independent `deploy-commerce-v2.yml` workflow defaults to the existing
foundation qualification. Its explicit `normal-canary` mode deploys only the
isolated commerce canary, never production. Candidate configuration is staged
without restarting the running foundation instance; secrets are runtime-only
and `COMMERCE_V2_FOUNDATION_MODE=false` must be explicitly staged before that
mode is consumed. Exact-main CI, separate preserved volumes, disabled payments,
disabled marketing, read-only Refref readiness and no provider credentials remain
mandatory. A read-only online encrypted backup precedes replacement. The
production configuration (including secret continuity), identity, container
start and mounted volumes are compared by an owner-side aggregate fingerprint.
This transition does not repeat the already accepted restart/redeploy proof.

Canary origins are `https://canary-platform.flexperiment.ru`,
`https://canary-lab.flexperiment.ru`, `https://canary-admin.flexperiment.ru` and
`https://canary-api.flexperiment.ru`. No production frontend substitutes for a
missing canary service. The controller retains the no-domain/no-public-routing
guard: DNS/TLS and a protected proxy need independent qualification before any
route is made usable. Staged origins do not publish a route.

`API_ONLY` deployment evidence is **not** `V2_NORMAL_CANARY_PASS`: actual email
delivery, frontend magic-link proxying, host-only secure cookies, logout and
revocation must be verified later. Do not activate synthetic legal releases or
invent course records to unblock it. ART-232 owns approved Stage A texts;
ART-169 owns catalogue seed/data. Production stays foundation-only and external
failure alert delivery remains an ART-41/F9 blocker.

## Seed boundary

`commerce-v2/launch/catalog.json` is deterministic input for a fresh database.
It creates reference cities and the closed all-courses offer. Course and LAB
records can be added to that file only after their stable public references are
known. The seed is write-once by digest: retrying the identical input succeeds,
while trying a different catalogue against an already seeded database fails.

## Stage A admission and course authoring

Stage A is the free-course launch phase, not a special course implementation.
Any real course manually authored in Payload can qualify the first user journey;
neither its title/slug nor a prescribed lesson count/duration is a release gate.
The first course is an ART-169 editorial milestone, not mandatory seed data.
Payload's immutable-ref hooks assign actual course/section/lesson identities.
Proposed durations are not processed video metadata; real Kinescope uploads,
bindings and metadata are required. Test-generated refs/DBs never become launch data.

An authenticated author creates ordinary drafts through the existing collection
access and hooks. Draft/unlisted content must remain invisible publicly, refs
immutable, relations valid and failed transactions atomic. Closed canary editorial
hooks still reject mutation, including Local API calls. No automatic import,
publication, jobs, email or provider effects may bypass that boundary.

After separate content/media admission, use the existing processed video binding
and Payload publish → immutable manifest → Commerce acknowledgement pipeline.
Verify actual version/hash and independent read-back. Drafts cannot build a
published manifest; unknown/unprocessed videos cannot be invented in seeds.
The CMS commercial control reads/writes canonical Commerce products/offers with
author authority, same-origin checks, CAS, idempotency and independent GET
reconciliation. Saving editorial content is not a hidden commercial POST.
FREE requires zero price and nonfinancial enrollment, never a fake zero-price
order; retained FREE access survives FREE→PAID without overriding restrictive
access checks. PAID freezes canonical Commerce checkout data and requires separate
sales/payment admission. Keep PAYMENT_MODE=disabled and marketing broadcasts off.

ART-179 acceptance must distinguish isolated tests from actual delivery/browser/video:

| Gate | Required evidence and negative controls |
| --- | --- |
| Legal admission (ART-232) | Four exact approved documents, active release/version/hash; owner approval does not activate a release. Absent/stale release refuses registration before customer/email creation. Supplier applicability is not inferred from approval. |
| Initiation and authenticated choice | Separate unchecked required PD/account terms, optional unchecked marketing. Missing/false/nonboolean required choices refuse before CAPTCHA/DB/email. Verified email alone does not upgrade UNVERIFIED_INTENT. New authenticated events bind account, storefront and exact release; guest/foreign Origin/stale hash/foreign actor fail, idempotent replay creates no duplicate. |
| Protected access | Server-side required-consent gate must be qualified, independently of React. Unverified/unconfirmed accounts cannot bypass it through historical entitlements or FREE enrollment. Scope between COURSES/LAB must be explicit before marketing activation. |
| Email and CAPTCHA | Actual NotiSend receipt, not API acceptance or configured status; valid server-side CAPTCHA and refusal of invalid/expired tokens. Evidence never contains link/token/recipient secrets. |
| Browser/proxy/session | Intended isolated frontend, TLS/Host and same-origin auth, no production fallback. Secure/HttpOnly host-only cookies, no shared .flexperiment.ru Domain; appropriate SameSite, real reload/navigation persistence. Expired/replayed links and foreign callbacks refuse. |
| FREE/video/progress | Verified and properly confirmed account, approved FREE product and fresh published manifest; unknown/stale/unlisted/withdrawn lesson denies. Real protected Kinescope playback binds video/subject and rejects foreign/expired grants. Resume persists through navigation. |
| Logout/revocation | Logout and server revoke invalidate session access. Already issued video tokens remain bounded by short TTL; do not claim instantaneous player revocation. |
| No financial effects | Zero new orders/payment attempts/refunds/paid grants/provider calls during FREE E2E; checkout returns PAYMENTS_DISABLED, marketing broadcasts remain false. |
| Erasure and restore safety | Qualify deletion on request and an independent current suppression/erasure ledger. Restoring an older snapshot must not resurrect deleted accounts, old sessions or unsubscribed marketing; absent/stale ledger keeps admission closed. This mechanism is pending, not proved by legal prose or row deletion alone. |
| Operational preservation (ART-41) | Preserve backup timers/freshness and sanitized evidence; production alert delivery needs its own evidence. Canary alerts do not prove production alerts. Public registration, four HTTPS 403 guards, production changes and F9 require their own admission. |

Current engineering evidence is not live CMS authoring, legal activation or full
browser E2E. ART-169/179 remain open until their respective real-content and
functional checks pass. The course-specific preparation helper and permanent
first-course launch checklist are removed; historical legal drafts remain history,
not catalogue authority.

### Authenticated content admission (ART-179)

Engineering gate: Commerce checks current verified binding and required authenticated
PD/account-term events against the exact active COURSES release/hash before library,
playback/DRM and progress operations. Missing/malformed legal state fails closed.
Historical entitlement or retained FREE enrollment does not override this gate.
Account identity, legal confirmation, order history and logout remain accessible
for reconciliation and account rights; public catalogue metadata is unchanged.
Payload's entitled-content readers independently check Commerce consent status before
querying private editorial data. Client components are not access authority.

The account UI starts all choices unchecked, performs one explicit idempotent POST
and confirms admission with independent no-store GET. Lost response/failed read-back
keeps content closed and offers GET-only reconciliation, not an automatic POST retry.
GET may include a bounded `actionKey`: its session/customer/storefront-scoped
`action.outcome` distinguishes ABSENT from COMMITTED, including historical/stale
actions that do not currently satisfy admission. A missing/foreign/malformed proof
never enables retry. Only an ABSENT result permits an explicit fresh attempt with a
fresh key and newly unchecked choices. A rotated release remounts its documents and
choices; an old payload is never submitted for the new release.
The API requires `expectedActionSequence` from the consistent GET snapshot. In the
same immediate transaction as insertion, a new action must match the existing event
sequence; otherwise `CONSENT_STATE_STALE` refuses it without writing. This prevents a
late original POST and a fresh retry from both committing after an ABSENT snapshot.
Existing same-key/same-choice replay is still idempotent. No table or migration is
added. Definitive allowlisted pre-write/rollback refusals are distinguished from
ambiguous transport, unknown errors and unconfirmed writes; HTTP status alone is not
proof of absence. Even a definitive rejection refreshes the current action/release
before offering retry. No-write GET reconciliation never fabricates consent evidence.
Late results from an unmounted account/release form are discarded. Marketing is not
required to open a properly admitted FREE course.
Logout uses the existing Better Auth endpoint with independent session read-back;
purchase history and the owner-approved data-removal contact remain outside the gate.
The contact route is not a claim that automated erasure/restore suppression is complete.

Marketing scope is a single voluntary **email** purpose only when source and target
storefront have identical admitted marketing document version and SHA-256. A positive
LAB action cannot grant a different COURSES purpose (or vice versa). A latest explicit
negative choice and one-click suppression deny globally; neither revives historical
grants. Source account/release/hash still must be current. No SMS/messenger consent
is inferred, and broadcasts remain disabled. Real browser/email/video admission,
live migration/deployment and legal activation are separate from this engineering delta.

### Personal-data inventory and erasure admission (ART-232 / ART-179 / ART-41)

Source inventory at #201 merge `180eb165…`, not a claim of live data counts or purge:

| Category / authority | Actual location / handling | Retention and deletion boundary |
| --- | --- | --- |
| Customer identity / Better Auth | Merchant `customers`, `user`, `session`, `account`; email/name, session token, IP/UA and possible provider credentials | Account/progress during requested platform use or verified deletion request. Tokens/sessions need separate expiry cleanup, not account-lifetime TTL. Authenticated admission must verify live binding; knowing email is insufficient. |
| Magic-link initiation | `verification` (Better Auth 1.7.6 hashed identifier, JSON email/name), `auth_email_outbox` (plaintext recipient, encrypted URL/email, status/error) | Link expiry 600s is implemented, deletion after expiry is not. Unverified intents cannot delete an existing verified account. No ambiguous mail replay. Payload/recipient/error retention needs explicit category policy and cleanup. |
| Consent and communication | `account_consents`, `marketing_consents`, authenticated actions/events, `email_suppressions`, campaign recipients | Immutable historical UPDATE is prohibited; deliberate FK-safe deletion is distinct. Minimal justified evidence/holds need basis and deadline, not a blanket invented duration. Independent suppression must outlive old snapshots. Latest refusal dominates. |
| FREE access and progress | `free_course_enrollments`, resume positions, grant rate limits, access starts and `playback_access_events` | Delete subject-linked nonfinancial facts on admitted erasure; telemetry has a separately configured age bound, not account duration. Restore must invalidate sessions/links before any serving. |
| Paid/immutable evidence | Orders/snapshots, quotes/attempts, refunds, paid entitlements | Do not rewrite canonical financial evidence or infer lawful holds. Stage A core refuses erasure admission when financial records exist; bounded classified retention is a separate Stage B requirement. |
| Generic technical/audit logs | Merchant `audit_log`/Control Room JSON, `last_error`, Node/Payload/Traefik/Docker/journald logs | Arbitrary JSON/errors cannot be assumed nonpersonal; log rotation/access and classified security holds still need runtime inventory. Core refuses subjects referenced in unclassified audit. Historical log deletion/absence of exposure is not claimed. |
| Editorial/admin identity | Separate Payload `users`, `users_sessions`, reset/login fields, job logs, locked documents; owner content/media/versions | CMS authors are not storefront customers. Do not delete operator/editorial credentials or owned video because a customer email matches. No customer profile is copied into the editorial course catalogue. Actual author/log retention needs separate qualification. |
| Kinescope/player/CAPTCHA | Private video bindings/upload sessions, webhook status hashes; DRM JWT `sub=customerId` and external player/CAPTCHA telemetry | Course videos belong to the author, not a customer's erasure scope. External telemetry/processor deletion requires account-specific discovery and confirmation; never claim upstream deletion from local SQLite purge. |
| Backups and offline copies | Independent Commerce/Platform SQLite online snapshots, age ciphertext on VPS + Cloud.ru; owner Mac restores/offline copies | Existing 7 local / 100 remote are counts, not age caps. Inventory all copies and qualified holds; configured age retention and owner/offline attestations remain pending. Deleting rows is not deletion of archived ciphertext, WAL or disk blocks. |
| Independent erasure/suppression journal | Owner-only store outside merchant/editorial/snapshot roots, HMAC pseudonyms, retained key generations, signed ordered chain | Pseudonyms are PD. Remote encrypted custody, independent current checkpoint authority, key escrow and its own bounded retention require operational admission. Do not put signing private keys in consumer/runtime. |

The historical `OWNER_APPROVAL.md` 24h/30d matrix is a target proposal, not an active
universal/legal TTL. Current account/progress owner decision does not authorize
indefinite outbox, telemetry or archive retention. This inventory does not change
approved legal text bytes/hashes or assert processor-contract deletion success.

First engineering slice: `erasure-ledger.ts` and `erasure-restore.ts` qualify a real
independent local journal and old SQLite restore. Hash-chain/signature, complete head,
scope, nonce-bound fresh checkpoint, key-generation fingerprint and short-lived
immutable capability are verified before the atomic subject purge. Missing/stale/
unverifiable state, unknown FKs, financial/audit uncertainty or binding drift → HOLD.
Same-email new accounts are not erased by old identity tombstones; marketing remains
suppressed until a separately qualified explicit reinstatement policy.

This is NOT production/runtime erasure readiness. Before live use, separately qualify:

1. Authenticated deletion admission outside the content-consent gate; email requests
   to art@flexperiment.ru create a pending verification case, never erase by sender.
2. Admission immediately denies access/marketing, revokes sessions/links and prevents
   queued mail; independent remote append/verified acknowledgement precedes erasure.
   Crash/timeout between either boundary stays CLOSED and reconciles without blind replay.
3. Runtime boot and every side-effect boundary require current ledger/fencing. An
   isolated purge result returns `runtimeAdmission: PENDING`, not permission to serve.
4. Category cleanup/holds, processor tasks and offline copy retention have verifiable
   outcomes. Contract uncertainty or HTTP acceptance is not provider-deletion PASS.
5. Private-canary migration/admission plan covers0023–0025 and subsequent erasure
   schema, preserving qualified volumes/backups; full CMS/email/browser/video E2E follows.

No live schema, service, backup scheduler, provider request or public gate is changed
by the first slice. Its regressions run in the existing CI node-project glob.

### Category retention engine: offline engineering, not active policy

`commerce-v2/src/pd-retention.ts` is deliberately not wired into startup, jobs or a
CLI. `STOPPED_OFFLINE` is a caller prerequisite, not a database proof that external
writers/provider sends have stopped. Exact reviewed policy bytes and their source
reference are hashed separately; there are no invented/default legal TTLs.

| Category | Bounded cleanup and preservation |
| --- | --- |
| Expired credentials | Only expired sessions/recognized magic-link verifications beyond explicit grace; current credentials and independently justified subject holds survive. Numeric SQLite epoch milliseconds, `.0` text and validated UTC/offset timestamps are supported; unknown shape/date refuses atomically. |
| Auth outbox | Only sufficiently old last-update and expired-link age, while all senders are stopped. Does not retry an ambiguous send. Recipient/user/customer holds apply, including unbound auth users. |
| Playback telemetry | Explicit category age with subject holds, not account lifetime. Course progress is not classified as anonymous telemetry. |
| Unverified intent | Old customer and old UNVERIFIED_INTENT facts, no matching auth user, link, outbox, order, grant, quote, authenticated action, recipient, progress or audit reference. Legacy/qualified consent history is not guessed away. |
| Backup archives | Pure exact-object planning by scope, timestamp and SHA-256; retained current independently verified object, foreign scopes and per-object holds are not selected. No local/remote/offline deletion is installed. |

Immediate SQLite cleanup checks the full canonical 0001–0025 DDL and foreign keys,
with bounded batches. Unknown table/column/trigger semantics, expired/unbounded
holds, malformed policy or unclassified data fail closed without partial deletes.
Holds carry explicit category/subject, allowlisted justification, evidence hash,
reviewer reference and finite reviewed expiry. Those fields alone are not proof of
legal approval or authenticated reviewer authority; installation admission remains
pending. Active accounts, verified consent history, email suppressions and financial
facts are preserved. `secure_delete` does not purge historical WAL/archive contents.

Current evidence is isolated regressions only. Exact owner-approved category policy,
complete copy inventory, erasure request admission, independent latest ledger,
restore/send fencing and processor deletion coordination still need their own
qualification. Existing backup infrastructure, schedules, runtime policy, legal
bytes and production are not changed by adding this library.
