# Better Auth magic-link delivery

Better Auth 1.7.6 is already pinned, with the magic-link plugin, hashed tokens,
10-minute expiry, storefront binding, consent checks and an encrypted auth
outbox. No dependency upgrade or database migration is needed.

Use `AUTH_EMAIL_PROVIDER=notisend` with owner-installed `NOTISEND_API_KEY`,
`NOTISEND_FROM_EMAIL`, `NOTISEND_FROM_NAME`, `NOTISEND_REPLY_TO`. Confirm the
sender in NotiSend before enabling delivery. The plugin callback enqueues
encrypted evidence before calling the transport. A queued/sent/delivered
response with a valid message ID marks the existing
outbox SENT (accepted for sending, not proof of inbox delivery).

The fixed official NotiSend HTTPS endpoint (`POST /v1/email/messages`) receives
one transactional email, using Bearer authentication and `smtp_headers` for
Reply-To and an opaque correlation hash. That hash is NOT provider deduplication.
Only links to the configured COURSES/LAB origin and the Better Auth verification
path are accepted. Redirects are refused; the provider response is bounded;
errors expose only fixed enums. Transport uncertainty, HTTP 408/5xx, malformed
responses are ambiguous. A refusal, 429 or skipped/bounced recipient fails
without retry too. No automatic send retries or durable dedupe claim. The existing FAILED outbox state
retains the safe ambiguity code, not proof of nondelivery. New user requests
may create new links; old outbox rows are never automatically resubmitted.

The existing explicit HTTP relay remains compatible, but is unnecessary for
magic links. SMTP would introduce another credential set; keeping a separate
relay would introduce another runtime. Marketing remains disabled and its
existing relay requirement is unchanged. Frozen V1 retains its old provider
only until the separately admitted V2 cutover; this change does not rewrite
historical V1 email evidence or activate marketing.

Official API contract: https://notisend.ru/dev/email/api/ (checked 2026-10-10).

Reuse the V1 session secret/admin hash; map
`YANDEX_SMARTCAPTCHA_SERVER_KEY` to `SMARTCAPTCHA_SERVER_KEY`. New Better Auth,
outbox encryption, platform-service and unsubscribe secrets need private
custody. Runtime secrets must not be Docker build args. Do not copy banking
credentials or the old database.

Regression coverage belongs in `commerce-v2/test`, already included by Vitest
and the required GitHub test job. Prove the real Better Auth callback invokes
the transport, consent/link verification still work, accepted/refused/ambiguous
outbox behavior and no reflected secrets in stored errors. Provider acceptance
in synthetic tests is not an actual email delivery qualification.

Production rollout remains blocked until this reviewed code is merged and its
exact source passes CI. The current Coolify source pin is not changed by this
engineering implementation. No email is sent to real recipients during tests.
