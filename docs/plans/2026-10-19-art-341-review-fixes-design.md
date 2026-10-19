# ART-341: independent PR #265 review and fixes

Date: 2026-10-19. Original reviewed head: `87a19c45e4c6d05f5a4b28a97ff8f1f1c1133e2d`.
Original comparison base: `415919f9`. Integrated main: `dfc720fa187b4714ffa7e06e273ebcc60e2d1081`.

## Scope and decisions

Preserve occurrence/offer separation, optimistic versions, the single current
price in `offers.price_kopecks`, frozen quote/order amounts and existing payment
admission. No new sales activation, migration, custody change or V1 modification.

Main is merged into the PR branch with an ordinary merge commit. This combines
ART-341 with #264 guest checkout/tickets/check-in and #266 proxy provenance
admission without rewriting the PR's existing commits. Neither side of the
checkout or Control Room conflicts can replace the other wholesale.

The guest page passes its displayed amount through preview. The guest response
schema retains both authored price notices, and checkout renders them in a live
status beside the payment total before the existing explicit consent/confirm
step. Notices are advisory; quote persistence and idempotency remain unchanged.

Cancellation rejects all subsequent product configurations in the common writer,
including CLOSED offers. LAB command errors use explicit validation/not-found/
conflict sets. Unknown failures answer 500 with a route fallback code and log only
a fixed event/code/error-kind tuple. Runtime input checks reject malformed
allowlists, sale modes, city slugs, edit patches and cancellation versions.

## Disposition of the supplied draft review

| Finding | Independent result | Correction and regression evidence |
| --- | --- | --- |
| P1: integration conflict with #264 | Confirmed integration blocker; not itself proof that CRUD regressed checkout | Merge preserves guest checkout, recovery, consent/scope/admission, erasure fence and Control Room check-in; #266 is also retained |
| P1: guest checkout omits price notice | Confirmed, including Zod stripping the field | Card-to-preview DOM test, both notice variants with persisted session, real guest HTTP preview/replay/payment/ticket test |
| P2: CLOSED offer writable after cancellation | Confirmed | Common configureProduct guard; tests refuse PUBLIC and CLOSED term changes and direct writer invocation, preserving version/price/audit |
| P2: API errors misclassified | Confirmed | 422 for invalid purpose/allowlist/types, 404 for missing subject, 409 for authored state conflicts, redacted 500 for unknown DB failures with transaction rollback |

## Validation of the final code tree

- `pnpm test`: 273 files passed; 3460 tests passed, 6 skipped.
- `pnpm platform:test`: 21 files passed; 156 tests passed. This separate suite
  includes course checkout; the root suite does not include it.
- `pnpm exec tsc --noEmit`, `pnpm admin:typecheck`, `pnpm platform:typecheck`,
  `pnpm --filter @flexperiment/lab-v2 typecheck`: passed.
- ESLint over changed Commerce, contract, LAB, admin and course-checkout code and
  tests: passed with no errors or warnings. `git diff --check`: passed.
- Local Chrome with Next.js 16.3.0, the real Commerce V2 Hono app, an isolated
  in-memory migrated SQLite DB and MockPaymentRail: card displayed 2500 RUB;
  common-writer change to 3000 RUB before preview produced
  PRICE_CHANGED_SINCE_DISPLAY. A subsequent change to 3500 RUB and page reload
  replayed the same quote at 3000 RUB with CATALOG_PRICE_CHANGED_AFTER_QUOTE.
  Consent checkboxes gated confirmation, and explicit confirmation opened a
  VALID QR ticket. API tests independently assert the frozen order-line amount.
- Forced first-preview network failure in Chrome rendered an actionable alert;
  retry succeeded with the identical persisted guest session and preview/payment
  keys. Narrow viewport measured 500 CSS px (browser minimum); no horizontal
  overflow. The initial scenario also ran at the normal desktop viewport.

Browser checks used only loopback services and synthetic fixture approvals,
customer details and payments. Ticket recovery, one-use check-in and proxy
provenance regressions ran in the automated suite. Live provider payment,
production recovery/check-in, Safari, V1 export builds and hosted CI are not
qualified by these results. No merge, deployment or sales activation performed.
