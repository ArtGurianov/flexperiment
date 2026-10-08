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

## Seed boundary

`commerce-v2/launch/catalog.json` is deterministic input for a fresh database.
It creates reference cities and the closed all-courses offer. Course and LAB
records can be added to that file only after their stable public references are
known. The seed is write-once by digest: retrying the identical input succeeds,
while trying a different catalogue against an already seeded database fails.
