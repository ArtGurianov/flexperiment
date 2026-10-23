# Flexperiment v2 merchant schema

> **Activation evidence correction (2026-10-12):** Migration `0016_online_course_activation_fence.sql` forbids treating ART-240 as COURSE_BUNDLE acceptance. The relevant schema trigger is the authority; a course's successful production acceptance does not authorize selling the bundle.

> **Fiscal policy qualification (ART-233):** Policies are offer-specific and immutable once created, with lifecycle `DRAFT → QUALIFIED → RETIRED` (at most one qualified policy per offer). Checkout freezes the qualified policy per order line and refuses missing/DRAFT policies; qualification requires an audited legal-basis reference and evidence digest. `REFREF_RECEIPT_PAYMENT_METHOD` has been retired and must not be configured. Course, bundle and LAB fiscal semantics are not interchangeable. ART-231 and ART-234 supply outstanding legal authority; code completion does not qualify an actual sale.


This document is the normative storage contract for the Flexperiment v2
merchant database. The database is created from
the ordered migrations under `commerce-v2/migrations`; it is a new lineage and is never
applied to the frozen v1 database.

## Immutable migration journal (ART-316)

`commerce-v2/migrations/migration.lock` is an ordered, complete SHA-256 manifest
of the exact SQL bytes. Append the next numbered SQL file and its digest
together; never change, rename, remove or reorder a committed migration or
its lock entry. Calculate a new digest with `shasum -a 256 <file>`. Validate
with `pnpm commerce-v2:check-migrations` from the repository root, using full
Git history (`git fetch --unshallow` if the checkout is shallow). CI rejects
changes against every reachable historical SQL/lock revision, including a
joint SQL/lock rewrite, deletion/restoration and drift on a merged branch.

Startup, the migration CLI and direct application verify the complete bundle
and the applied journal before running pending SQL. `schema_migrations`
retains `version` and `applied_at` and adds a non-null lowercase `sha256`.
Applied rows must form an exact prefix of the locked files; unknown versions,
gaps and mismatched hashes stop startup before traffic or external work.
All migration SQL and journal writes run in one immediate transaction.

The first run on a supported pre-digest database upgrades only its journal,
preserving application rows, versions and original timestamps. The legacy
allowance is sealed to the 0001–0032 chain at `dc351af2` by a code-pinned chain
digest; later migrations cannot receive legacy backfilled hashes. A changed
bundle or invalid legacy journal is refused without a partial upgrade. If
pending SQL fails, the journal upgrade rolls back too. Take the normal
independently recoverable backup before an authorized host installation; a
refusal calls for investigation and recovery, never editing the stored hash,
deleting journal rows or resetting data. The old version-only ledger cannot
prove past SQL bytes retrospectively; the upgrade trusts its valid version
identities within the sealed deployment chain. See the
[design](plans/2026-10-20-migration-integrity-design.md).

Retention and isolated erasure restore keep their exact legacy fingerprint
allowlists and also admit the matching 0025–0032 schemas with the hashed
journal. The current 0032 fingerprint with that journal is
`60b856fcbe80f36cb32737d850b6fc75356b365e5806d622912e7ec3bfbd53e9`.
Only deployment bookkeeping changes; no subject-data classification changes.
Historical release controllers retain their own pinned source/schema and
must not be retargeted implicitly to this schema.

## Authority boundary

Flexperiment stores its own customers, catalogue projection, prices, sale
policy, orders, fulfilment, entitlements, playback state and audit evidence.
Refref owns payment and refund execution. Flexperiment stores only identifiers,
idempotency keys and the latest observed Refref projection needed to reconcile
its own obligations. Provider credentials and provider-native payment state do
not belong in this database.

Current source uses Commerce-owned editorial drafts and immutable published
version snapshots, introduced by migration 0026. Control Room publishes directly
into the existing `catalog_*_projection` tables in one local transaction.
ART-331/335 removed the live manifest lease, legacy writer routes and Payload
readers; ART-337 records the closed-canary cut. That evidence does not authorize
public launch. The separate Payload SQLite and manifest path were historical
pre-cutover authorities; their retained archives are not active writers.
See the [publication protocol](course-publication-protocol.md).

## Migration 0026 schema and recovery review (ART-332)

The final P1 merchant DDL is migration `0026_course_editorial_publication.sql`.
The reviewed `sqlite_master` SHA-256 is
`c99f9ed0db449a2c13f2e51fa3b28a1ba44e367dd263185c99eddfec8c2d3b39`.
Both offline retention and erasure restore also accept the prior 0001–0025
fingerprint, `158654c61bd97be4dbcab4348651722fe105587f6ff202ad4db821512774e030`,
for a reviewed older backup. Any other merchant DDL is refused by both paths.
These fingerprints do not apply to the independent `erasure-fence.sqlite`.

| 0026 surface | Data and identity classification | Recovery and deletion behavior |
| --- | --- | --- |
| `catalog_course_projection` editorial columns and section/lesson titles, slugs, Lexical and SEO JSON | Operator-authored catalogue content and access policy; no customer identity or customer FK. Text may contain incidental personal data and needs editorial review if reported. | Published graph remains in the merchant snapshot. Customer erasure does not delete the shared course or change its visibility. |
| `course_editorial_drafts` | Unpublished content plus `actor`, an operator identifier; no customer FK. | Preserved by merchant backup. Customer erasure does not rewrite drafts; operator/content retention is a separate decision. |
| `course_editorial_versions` | Immutable historical published graph, content hash, publication time and operator `actor`; course FK only. | Preserved with the exact SHA-256 preimage. Restored versions cannot be silently rewritten or deleted. |
| `course_editorial_publish_commands` | Idempotency key, request/result JSON and timestamp; course FK only. | Preserved so an old publish command cannot execute again after restore. |
| Existing `lesson_video_bindings`, product, grant and audit tables | Video ID belongs to the course; customer grants and access history retain their existing subject links. Publication audit stores operator identity and version/hash evidence. | Video binding survives customer erasure. Subject-linked facts follow the established erasure fence and restore suppression; financial/audit uncertainty still stops restore. |

The isolated recovery tests take an online SQLite snapshot with uncheckpointed
WAL, encrypt it, read back the restored editorial draft, published graph,
versions, binding and migration ledger, then independently apply a newer erasure
tombstone to an older snapshot. They verify that erased customer credentials and
access history stay removed while shared course content and the video binding
survive. These are source and isolated restore proofs, not canary installation,
live point-in-time recovery, archive deletion or runtime admission. The prior
Payload ciphertext archive remains separately retained pending its own review.

## Public origin boundary

The four public authorities are configured independently: `PLATFORM_ORIGIN`
for the course storefront, `LAB_ORIGIN` for the LAB storefront,
`ADMIN_ORIGIN` for Control Room and `API_ORIGIN` for the commerce API. A
production commerce process refuses to start unless all four are explicit
HTTPS origins without credentials, paths, queries or fragments. The older
generic public-origin and provider-return variables are not v2 authorities.

Each storefront origin has its own arrival endpoint (ART-378): platform
`/arrive` (Next.js route handler) and LAB `/arrive` (nginx location) forward to
Commerce `GET /v1/browser-context/arrive`, which is not reachable through either
public `/v1/*` allowlist. Commerce takes the storefront from the forwarding host,
never from a parameter, captures the `arrival` proof server-side, reuses or
creates the context, sets its cookie and answers 303 to the `to` path on the
same origin, with no Refref call before the response. The claim runs after the
response under the process lifecycle (tracked, drained on SIGTERM), at most
500 ms per attempt, and again after every later same-context `/v1` request and
platform page view (Next.js `proxy.ts` → `POST /v1/browser-context/touch`),
single-flight and at most every 2 s per proof, until the claim window closes.
Buy (`/v1/checkout/preview`) first refuses an offer of another storefront than the
forwarding host's (409 `CHECKOUT_STOREFRONT_MISMATCH`), then spends at most 1,500 ms on exchange/readback, then
freezes `storefrontOrigin`, `browserContextId` and `deliveryDegraded`
(`TIMEOUT`, `FAILED` or `EXPIRED` when any proof of the context is unconfirmed)
into the intent; a repeat of the intent sends what it froze. The whole feature
is off unless `BROWSER_CONTEXT_ENABLED=true`; the claim client needs
`REFREF_VNEXT_API_BASE_URL`, without which a captured proof is `FAILED`.

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
  editable. Selling any paid offer, `PUBLIC` or `ACCEPTANCE_ONLY`, additionally
  requires its storefront (`COURSES`, `LAB`) to be OPEN on the owner's
  storefront switch (ART-319, migration 0035): a root-owned host file mounted
  read-only into Commerce beside the owner's append-only journal (also
  read-only), both written only by the owner over SSH
  (`scripts/v2/storefront-switch.py`, [runbook](storefront-switch-runbook.md)).
  It is re-read with the live payment mode at every checkout step; missing,
  invalid, writable, not what the journal last recorded, or stale means CLOSED.
  A `COURSE_BUNDLE` never becomes `PUBLIC` (no acceptance qualifies it; the
  migration 0016 fence). The former `sales_activation` table is immutable
  history: triggers refuse every insert, update and delete, and no row
  authorizes anything; isolated restore (ART-313) consults it only on
  databases older than 0035.
- `storefront_switch_observations` (migration 0035) records each switch
  generation the runtime has read, with its document digest, append-only. It
  opens nothing; it lets the runtime refuse a file restored to an older
  generation or a generation reused for other content, across restarts.
- `lab_occurrences` (migration 0029, ART-199) has a lifecycle, not a sales
  status: `SCHEDULED` or terminal `CANCELLED`; in progress and finished are
  derived from `starts_at`/`ends_at`. Selling is the offer's `sale_mode` alone.
  Visibility (`LISTED`/`UNLISTED`) only controls the public catalogue. Each
  occurrence declares its venue as `CONFIRMED` (name, address, and whether the
  catalogue may show them) or `TO_BE_ANNOUNCED` (disclosure text and an
  announcement deadline before the start); a legacy row without a venue is
  never listed or sold. `capacity` and `admin_reserved_seats` bound customer
  seats: a seat stays committed until its order reaches a final outcome
  (expired, declined, refunded), so no clock frees an uncertain payment.
  Checkout admits a LAB offer only while its occurrence is scheduled, not
  started, has a declared venue and a free seat, and re-reads the seat count in
  the transaction that creates the order. Once a seat is committed, schedule
  and venue changes and cancellation are refused here and belong to the
  move/cancel workflow (ART-203). Every change advances `version` and writes an
  immutable `lab_occurrence_revisions` row; customer-facing changes also
  advance `material_revision`. City slugs and an occurrence's ref and city are
  immutable.
- LAB occurrence CRUD (ART-341) is a Control Room session command set:
  `POST /v1/admin/v2/cities`, `PATCH /v1/admin/v2/cities/:slug` (title only),
  `POST /v1/admin/v2/lab/occurrences`, `PATCH .../:occurrenceRef`
  (`expectedVersion`, patch, reason), `POST .../:occurrenceRef/cancel`
  (`expectedVersion`, reason) and `PUT .../:occurrenceRef/offer`
  (price, sale mode, purpose, allowlist, `expectedProductVersion`). The actor
  is always the session admin. The offer command takes no product or offer
  ref: identity follows the occurrence (one product and one offer per
  occurrence, `LAB_OCCURRENCE_OFFER_EXISTS` for a second), and the rest is
  `configureProduct`, so the LAB activation gate keeps LAB sales `CLOSED`
  until ART-243. Malformed input answers 422, a missing subject 404, a stale
  version, sold seats, cancellation or identity 409; unrecognised errors are
  reported as HTTP 500 with the route's fallback code and a redacted
  operational signal.
- `offers.price_kopecks` is the only current price. The public LAB catalogue
  (and so the V2 page and its Offer JSON-LD, rendered client-side from that
  response) and every new quote read it live; an issued quote and an order
  keep their frozen price. A quote response carries `priceNotice`:
  `CATALOG_PRICE_CHANGED_AFTER_QUOTE` when the live price moved after the quote,
  `PRICE_CHANGED_SINCE_DISPLAY` when the price the buyer's page sent as
  `displayedAmountKopecks` differs from the quote. The notice never changes the
  quote. Guest LAB checkout sends the displayed catalogue price and shows both
  notices before explicit payment confirmation, including on quote replay.
  Cancellation freezes even CLOSED offer terms in the shared product writer.
  The frozen V1 SEO snapshot is not touched (F9).
- `merchant_promotion` contains only merchant promotion authority: a normalized
  reserved-prefix code, discount rule, optional eligible offer and active
  window. It has no partner, referral, attribution or reward fields. The
  configured prefix is required in production. A code in that namespace is
  either resolved locally or rejected locally and is never forwarded to
  Refref; codes outside the namespace are passed to Refref as `checkoutCode`.
  Promotion edits use the same expected-version rule.
- `checkout_quotes` is the durable purchase intent (ART-373, migration 0030;
  the table keeps its name). Before Refref is first called it records the
  order and line ids (`order_public_id` = `merchantOrderRef`, immutable
  `line_ref`), the exact resolution request (`resolution_request_json`: the
  vNext `BrowserContextResolutionRequest` body — `merchantOrderRef`,
  `storefrontOrigin`, `browserContextId`, `currency`, `lines`, `checkoutCode`,
  `deliveryDegraded` — with no buyer identity; the RC.2 handoff token is a
  per-send credential and is not stored), a request fingerprint, the frozen
  line, pricing, promotion and legal release. Lifecycle: `DRAFT → RESOLVING →
  (CUSTOMER_ACTION_REQUIRED →) REVIEW → PAYMENT_CREATING → PENDING | UNCERTAIN
  → PAID | DECLINED | EXPIRED | REVIEW_REQUIRED`, and `REFUSED`/`EXPIRED`
  before any payment. A lost resolution answer is recovered by sending the
  identical frozen request again; a different request under the same key or
  order is 409. The customer reviews catalogue price, merchant discount,
  Refref discount, checkout-code outcome and final price; the Refref line
  amount is the amount after the merchant discount. The quote is valid until
  the earliest of 15 minutes from the intent, the LAB start, the end of an
  applied promotion and Refref's own deadline. Confirmation takes price, terms
  and line from the intent and never rebuilds them from the catalogue: a price
  change or an ordinary offer close does not end it; offer withdrawal, a legal
  release change, a storefront close (the owner's switch closed since the quote:
  `storefront_open_since` no longer the current opening, or payments off) and a
  frozen fiscal policy that is no longer qualified do. Final admission runs
  inside the same `BEGIN IMMEDIATE` transaction that creates `orders`,
  `order_lines` and `checkout_attempts` and consumes the intent once. Before
  any new intent or payment, open payments of the same customer and offer are
  read back by order; one still open refuses with
  `CHECKOUT_PAYMENT_IN_PROGRESS`, and a quote opened beside one that was paid
  meanwhile refuses with `CHECKOUT_ALREADY_PAID`. Triggers keep the frozen
  facts immutable and the lifecycle forward-only.
- `browser_contexts` and `browser_context_arrivals` (ART-378, migration 0034)
  hold the merchant side of browser-scoped attribution (refref docs/29 §2, §4,
  §6). A context is one browser on one storefront origin, named by an opaque
  256-bit ID in a host-scoped `__Host-` cookie (`__Host-flx-ctx-lms` on the
  platform origin, `__Host-flx-ctx-lab` on the LAB origin; HttpOnly, Secure,
  SameSite=Lax, Max-Age from `BROWSER_CONTEXT_*_MAX_AGE_SECONDS`). Status is
  `ACTIVE`, `ROTATED` (LMS account boundary: logout or account switch; its
  close is retried until Refref acknowledges it) or `CLOSED` (Refref closed it;
  the browser continues in a re-homed successor). An LMS context is bound to
  the first account seen in it so the next boundary rotates it; the binding
  never leaves Flexperiment and cascades on customer erasure. A LAB context has
  no account boundary. An arrival row keeps the raw proof only while `PENDING`
  and never past 30 minutes from capture (a merchant-local limit that ends at or after Refref's
  `issuedAt + 30 min` deadline); settled rows keep its SHA-256,
  state (`CONFIRMED`, `FAILED`, `EXPIRED`, `ABANDONED`) and the claim receipt.
  Contexts and their arrivals are deleted once their cookie lifetime has
  passed and no close is outstanding.
- `orders` and `order_lines` freeze the confirmed live offer, legal release and
  checkout snapshot used for a purchase. The order JSON is the exact closed
  `refref.shared-checkout-snapshot/2` structure produced for new purchases by the merchant-side
  builder; its `snapshot_hash` is the lowercase SHA-256 portion of the
  `refref-jcs-1:<hex>` digest sent unchanged with that structure to Refref.
  Each paid line separately preserves catalogue price, merchant discount,
  post-promotion merchant amount, final amount, promotion evidence, fiscal
  item, legal release ref/hash and (for LAB) the occurrence ref, service
  times and the venue disclosure promised to the buyer. Refref's accepted projection must return the same namespaced digest
  before it may advance the local order. `checkout_attempts` projects that
  protocol without becoming payment authority.
  Frozen V1 snapshots remain readable for historical recovery; new issuance is
  V2. Neither shape yet implements the target v9 purchase manifest (ART-394); see
  [the contract status](refref-v9-contract-status.md).
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
- `catalog_*_projection` is the current published graph. The Commerce editorial writer marks its courses
  and commits draft revision CAS, published version CAS, graph, audit,
  idempotency result and immutable snapshot in one SQLite transaction. The former
  manifest writer route is removed; retained manifest evidence is historical. Previously
  published refs omitted from a new editorial draft remain unlisted instead of
  being deleted. Emergency unlist persists across ordinary editorial publishes;
  an audited CAS `relist` is required to release it, and withdrawal cannot be
  released through that command. Version `content_hash` is SHA-256 of the exact
  immutable `document_json` bytes, with the current projection carrying the
  latest digest. Course versions only move forward; section visibility
  participates in a lesson's effective visibility.
- Historical `access_overrides` recorded restrictive intent. In the former
  manifest protocol PENDING overrides remained enforced until resolved to
  FINALIZED, SUPERSEDED or RELEASED_ROLLED_BACK with the required proof.
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
Any real course manually authored in the Commerce V2 Control Room can qualify the first user journey;
neither its title/slug nor a prescribed lesson count/duration is a release gate.
The first course is an ART-169 editorial milestone, not mandatory seed data.
Commerce's editorial commands assign actual course/section/lesson identities.
Proposed durations are not processed video metadata; real Kinescope uploads,
bindings and metadata are required. Test-generated refs/DBs never become launch data.

An authenticated author creates ordinary drafts through the Control Room and
Commerce editorial API. Draft/unlisted content must remain invisible publicly, refs
immutable, relations valid and failed transactions atomic. Closed canary editorial
admission still rejects unauthorized mutation. No automatic import,
publication, jobs, email or provider effects may bypass that boundary.

After separate content/media admission, use the existing processed video binding
and atomic Commerce draft → published graph/version pipeline.
Verify actual version/hash and independent read-back. Drafts cannot become
public data; unknown/unprocessed videos cannot be invented in seeds.
Control Room reads/writes canonical Commerce products/offers with
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
| FREE/video/progress | Verified and properly confirmed account, approved FREE product and current Commerce-published graph; unknown/stale/unlisted/withdrawn lesson denies. Real protected Kinescope playback binds video/subject and rejects foreign/expired grants. Resume persists through navigation. |
| Logout/revocation | Logout and server revoke invalidate session access. Already issued video tokens remain bounded by short TTL; do not claim instantaneous player revocation. |
| No financial effects | Zero new orders/payment attempts/refunds/paid grants/provider calls during FREE E2E; checkout returns PAYMENTS_DISABLED, marketing broadcasts remain false. |
| Erasure and restore safety | Preserve qualified deletion/fencing and independent current suppression/erasure evidence. Restoring an older snapshot must not resurrect deleted accounts, old sessions or unsubscribed marketing; absent/stale ledger keeps admission closed. ART-351 records the accepted canary result and explicit owner limits; it is not a public launch or fresh recovery admission. |
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
The current Next storefront reads private content through Commerce APIs, which
enforce consent and entitlement before returning it. No Payload reader or Local
API is an alternate access path. Client components are not access authority.

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
| Browser contexts (ART-378) | `browser_contexts` (opaque ID, storefront origin, LMS account binding), `browser_context_arrivals` (raw arrival proof while pending, proof hash, claim receipt); the ID alone is sent to Refref, no account | Raw proof ≤ 30 minutes and cleared on settlement; rows deleted after the cookie lifetime; an LMS binding cascades on customer erasure. The frozen `browserContextId` in an intent follows `checkout_quotes`. |
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

Migration `0036_checkout_audit_indexes.sql` adds only nonunique indexes over existing audit action/subject and qualified provider-payment identity. It adds no subject fields, evidence stores or purge targets. Its exact schema digest is classified for isolated erasure restore and offline retention; unknown DDL remains refused. Existing evidence-preservation and runtime-admission rules are unchanged.

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

Immediate SQLite cleanup checks the full reviewed 0001–0026 DDL (or the
0001–0025 fingerprint when examining an older backup) and foreign keys,
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

## Manual entitlement operations (ART-181)

A manual course-access grant is modeled as a **zero-cost order** with its own audited provenance, and requires an active legal release when granted; it must not masquerade as a paid provider payment or bypass offer/legal authority. A manual revocation is permitted **only** for an access grant originally issued manually. Accepted purchased entitlements are managed through the payment/refund and withdrawal authorities instead. An ALL_COURSES grant includes future courses; delisting a course alone does not revoke an established entitlement.

Issued buyer quotes include the frozen LAB occurrence and venue for review, while the public catalogue
hides a non-public venue. Confirm rechecks cancellation, start and seat capacity under the order write
lock without rebuilding title or price. A definitive resolution refusal is replayed as HTTP 409.
RC.2 retries must carry the same handoff token (its digest participates in request identity; the raw
token is not persisted). An attempt-create 409/422 releases the intent only after Refref read-back
confirms no attempt; session refusals and inconclusive reads keep the payment fence.

## LAB guest tickets (ART-384; migration 0032)

`lab_guest_access` binds a SHA-256 capability digest to one prospective order and
customer, including order-scoped unverified-email consent evidence. Email reuse
never grants access to the customer's other orders. Existing verified-email
account binding retains the same customer and its LAB history.

`lab_tickets` has one row per accepted-paid LAB line. `qr_sha256` is distinct from
the order capability. `used_at`/`used_by` are committed together by a Control Room
operator for the matching occurrence; triggers reject rewriting the use record
or deleting a used row. Recovery/reissue only rotates credentials. A full refund
voids admission without deleting use evidence; a stale PAID readback cannot
resurrect an accepted refund.

`lab_ticket_recoveries` stores only single-use token digests, deadlines and replay
proof of the replacement order capability. Email requests do not rotate an active
QR. `lab_guest_rate_limits` holds hashed, short-lived abuse-limit buckets per trusted
source and (source, email); no anonymous caller can consume a global hard quota.
Guest payment admission/readback is also order-scoped: sharing an unverified
email does not block independent orders or signed-in purchases. Replay retains
one line/order/attempt, and seat capacity remains authoritative.
Isolated restore revokes all of these access credentials while retaining ticket
identity/use. Financial erasure holds and offline retention remain explicit.

The guest flow, API authority and qualification boundaries are described in
[the ART-384 design](plans/2026-10-19-lab-guest-checkout-design.md).
