# Commerce Phase 0 provider execution

Status: adapter and fixture gate complete; production provider probes pending in
the deployment runtime. This report contains configuration names and redacted
shapes only. It contains no credentials, identifiers, customer addresses, or
ticket capabilities.

## 1. Confirmed contracts implemented

- Tochka production base: `https://enter.tochka.com/uapi`; sandbox base:
  `https://enter.tochka.com/sandbox/v2`.
- Payment creation: `POST /acquiring/v1.0/payments_with_receipt`, bearer JWT,
  body wrapper `Data`, and response `Data.operationId` plus
  `Data.paymentLink`.
- Payment reconciliation: `GET /acquiring/v1.0/payments/{operationId}`.
- Refund: `POST /acquiring/v1.0/payments/{operationId}/refund`, body wrapper
  `Data`, and payment-operation `Order` history for reconciliation.
- Unisender Go: `POST /ru/transactional/api/v1/email/send.json`, `X-API-KEY`,
  code-rendered body, `message.idempotence_key`, and accepted `job_id`.

## 2. Runtime configuration names

`TOCHKA_API_BASE_URL`, `TOCHKA_JWT`, `TOCHKA_CLIENT_ID` (production only),
`TOCHKA_CUSTOMER_CODE`, `TOCHKA_MERCHANT_ID`, `TOCHKA_TAX_SYSTEM_CODE`,
`TOCHKA_VAT_TYPE`, `UNISENDER_GO_API_KEY`, `UNISENDER_GO_FROM_EMAIL`,
`UNISENDER_GO_FROM_NAME`, and `UNISENDER_GO_REPLY_TO_EMAIL`.

The frozen fiscal values are `usn_income` and `none`. All values are read only
at runtime; `.env.example` uses placeholders only. Tochka sandbox uses its
documented fixed JWT, customer code, and merchant ID; it has no sandbox
`client_id`, so `TOCHKA_CLIENT_ID` is optional only for the sandbox URL.

## 3. Redacted Tochka command fixture

```json
{
  "Data": {
    "customerCode": "<runtime>",
    "merchantId": "<runtime>",
    "amount": 123.45,
    "purpose": "Оплата участия в мастер-классе ФЛЭКСПЕРИМЕНТ",
    "redirectUrl": "https://flexperiment.ru/payment/success?order=<status>",
    "failRedirectUrl": "https://flexperiment.ru/payment/success?order=<status>",
    "paymentMode": ["card", "sbp"],
    "preAuthorization": false,
    "ttl": 20,
    "paymentLinkId": "<persistent-payment-id>",
    "taxSystemCode": "usn_income",
    "Client": { "email": "<frozen-order-email>" },
    "Items": [{
      "name": "Участие в мастер-классе ФЛЭКСПЕРИМЕНТ — <city>, <date>",
      "amount": 123.45,
      "quantity": 1,
      "vatType": "none",
      "paymentMethod": "full_payment",
      "paymentObject": "service"
    }]
  }
}
```

Money stays as integer kopecks until this adapter edge. The command excludes
supplier, saved-card, consumer, recurring, and two-stage-payment fields. The
purpose and receipt item are immutable order snapshots, so an occurrence edit
cannot change a later provider command.

## 4. Payment ambiguity and webhook fixtures

- Request start is persisted before HTTP dispatch; no SQLite write transaction
  is held during HTTP.
- Lost create response => `CREATE_UNKNOWN` and `GET` reconciliation; never a
  second create-link command.
- Endpoint: `POST /v1/webhooks/tochka`, `Content-Type: text/plain`, raw RS256
  JWT. The verifier fetches the public JWK, caches it for six hours, and
  refreshes it once on verification failure to support rotation.
- Required signed fields: `webhookType`, `status`, `paymentType`, `operationId`,
  `paymentLinkId`, `customerCode`, `merchantId`, and decimal-string `amount`.
  Only `acquiringInternetPayment`, `APPROVED`, and card/SBP with all identifiers
  and amount matching the persisted order can confirm payment. Mismatches are
  stored as quarantined provider events and drift review work.

## 5. Refund result

The existing durable refund state machine is used. A submission response is
not blindly retried: it moves to reconciliation, which queries the source
payment's `Order` history for a matching refund reference and amount. A lost
submission response becomes `SUBMIT_UNKNOWN`; it remains reconciliation work,
not another refund command.

## 6. Redacted Unisender fixture and callback handling

```json
{
  "message": {
    "recipients": [{ "email": "<frozen-recipient>", "metadata": { "outbox_id": "<outbox-id>" } }],
    "global_metadata": { "outbox_id": "<outbox-id>" },
    "body": { "html": "<code-rendered>", "plaintext": "<code-rendered>" },
    "subject": "<code-rendered>",
    "from_email": "<runtime>",
    "from_name": "<runtime>",
    "reply_to": "<runtime>",
    "template_engine": "none",
    "idempotence_key": "<stable-outbox-key-max-64>"
  }
}
```

The outbox key is stable per row. A duplicate rejection applies only during the
documented one-minute window; it is not exact-once delivery. The application
does not invent an unsupported lookup by idempotence key or metadata. A send
with a lost response stays `SEND_UNKNOWN`; an existing `job_id` is never
resent automatically.

`POST /v1/webhooks/unisender` verifies Unisender Go's documented raw-body MD5
integrity value before parsing its `events_by_user[].events[]` envelope. It
processes correlated `outbox_id` metadata on `transactional_email_status`
events for accepted, sent, delivered, soft bounce, hard bounce, and spam.
It de-duplicates the canonical event data and does not log raw payloads.

## 7. Validation performed

- `pnpm exec tsc --noEmit` — passed.
- `pnpm test` — passed: 3 files, 12 tests.
- `pnpm lint` — passed.
- `COMMERCE_DATABASE_PATH=/private/tmp/flexperiment-commerce-phase0.sqlite pnpm commerce:migrate` — passed, including the provider and legal-evidence migrations through `0005_provider_webhook_evidence.sql`.
- `pnpm exec next build --webpack` — passed.

Fixture tests assert the Tochka command and receipt profile, kopeck conversion,
Unisender metadata/idempotence/template contract, and RS256 verification with
a generated public JWK.

## 8. Live-probe gate and open provider question

The current local shell had none of the provider runtime variables injected, so
no authenticated provider call was attempted and no configuration value was
read or emitted. The provisioned Coolify/deployment runtime must run the
following once its secrets are mounted:

1. Create and pay a production 1-RUB receipt link, then verify its receipt and
   signed `acquiringInternetPayment` callback.
2. Issue and reconcile a refund for that payment through the same state
   machine.
3. Send one Unisender Go transactional message and observe each configured
   callback status.
4. Ask Unisender support whether a supported lookup exists for an accepted send
   after a response loss using either `idempotence_key` or `global_metadata`.
   Until documented and tested, `SEND_UNKNOWN` remains ambiguous.
