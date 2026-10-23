# ART-398 → ART-379 source qualification — 23 October 2026

Base: Flexperiment `c8bad757c9daa04385f9cf5e95bf6e07b185080a`. ART-398 was committed first as `e8604fb1`, then explicitly rebased against current `origin/main` before ART-379 started. One agent edited the shared checkout path serially. No merge or accepted PR is inferred from that rebase.

Contract authority: Linear ART-398/379 and their owner Wave 1 slot 2 comments; ART-394, ART-372/373/376/378 were read back as Done. Refref main `93b6a41fc42b4d616f381d65573e20fceaf79e78` supplies frozen input/1, payable/2, D231 and the vNext resolution OpenAPI. The vendored contract/oracle/vector provenance is recorded in `commerce-v2/src/refref-contract/README.md`.

## Implemented source boundaries

- ART-398: strict schema plus semantic/hash validation, merchant input durable before RPC, payable-bound acceptance/payment/fiscal/refund input, explicit LMS readiness independent of fiscal method, exact LAB end/timezone/schedule provenance. Independently supplied bank qualification is required before a v9 access grant. Its immutable audit snapshot and bank-operation binding are checked under the grant transaction. Portable vectors cover multi-line/quantity, mixed eligibility/latest anchor, zero eligible reward, replay, full/successive cancellation, preserved reward on partial cancellation, noneligible-only refund, bank/allocation mismatch and D1.2 threshold. The underlying oracle has no financial side effects.
- ART-379: direct vNext resolution of the frozen B1 request with by-order readback after ambiguity; exact order/origin/context/hash/line/total/degradation checks. No new browser handoff. Final price/code feedback and documents precede deliberate acceptance/payment. LMS and LAB keep independent profile opt-in and storefront stop gates. Reload retains submitted promo and replay keys and re-reads the server quote; it does not retain acceptance. Historical persisted RC.2 intents and signed payment return remain recoverable.
- New `REFREF_CHECKOUT_VNEXT_STOREFRONTS` configuration defaults to no admitted Refref profile. Configuring a profile never opens the owner storefront switch. There are no runtime/host configuration changes in this PR.

## Local validation

Local runtime: Node 26.5.1, pnpm 10.29.3. CI uses its own pinned Node environment; local results do not imply exact-head CI success.

| Check | Result |
| --- | --- |
| `COMMERCE_TEST_DB_SNAPSHOT=1 pnpm exec vitest run --project node --fileParallelism=false commerce-v2/test` | 70 files; 1274 passed, 1 skipped |
| `pnpm --filter @flexperiment/platform test` | 22 files; 170 passed |
| `pnpm exec vitest run --project jsdom apps/lab-v2/components/LabGuestCheckout.dom.test.tsx` | 8 passed |
| `pnpm exec tsc --noEmit` | PASS |
| `pnpm platform:typecheck` | PASS |
| `pnpm exec tsc -p apps/lab-v2/tsconfig.json --noEmit` | PASS |
| `pnpm lint` | PASS, 0 errors / 51 existing warnings |
| `pnpm commerce-v2:check-migrations` | PASS, 35 immutable migrations / 20 historical trees |
| `pnpm install --frozen-lockfile` | PASS |
| `git diff --check` | PASS |

The separate backend source E2E cases in `vnext-checkout.test.ts` exercise LMS Buy → documents → acceptance → one payment/entitlement and independent LAB guest preview/seat hold → acceptance → one payment/ticket, plus unknown-resolution recovery. They use the real vNext response consumer and a mock payment provider. Component DOM tests independently cover the buyer controls, promo feedback, reload and deliberate acceptance. No real-browser/provider E2E is claimed.

An early combined run hit the existing LAB concurrent SQLite-worker `SQLITE_BUSY` race; a standalone intent rerun and the final full serial-file run passed. Older expectations of the retired handoff entry were updated; regression tests still verify account-consent refusal, owned historic intent recovery, storefront mismatch and signed payment return.

## Outstanding external qualification

Refref's published v9 contract explicitly has no served v9 endpoint. The purchase-manifest rail capability is opt-in source integration, tested with a supplied rail; the RC.2 transport refuses v9 payloads. ART-400/412 and the LMS/LAB production/provider acceptance issues remain separate. The current storefront purchases one offer per intent; multi-line conformance vectors do not introduce a basket UI. Merchant refunds remain full-only; no external partial-refund capability is inferred.

No deployed browser/Refref/bank E2E, production financial qualification, container builds or complete repository-wide test run was performed locally. GitHub CI is a separate exact-head check. No SSH, deployment, production migration/reset, real bank operation, credentials change, sales activation or PR merge occurred.

## Review follow-up to abb974a8 — terminal and delayed recovery

The supplied independent review identified three confirmed defects. All three are corrected in the follow-up commit:

- LMS resets the displayed quote, acceptance and saved preview/payment keys after an authoritative DECLINED/EXPIRED response, including replay of an old saved intent. A new purchase requires a new buyer action. PENDING/CREATE_UNKNOWN and unavailable outcomes retain the previous keys; CHECKOUT_QUOTE_UNAVAILABLE no longer silently clears them.
- Background reconciliation now selects a known remote v9 payable/2 attempt in REVIEW_REQUIRED specifically for PURCHASE_QUALIFICATION_UNVERIFIED. It passes no creation admission, preserves the frozen request/payable/payment identity, still refuses invalid qualification, and grants/ACKs once after valid delayed evidence arrives. Unrelated manual-review classes remain excluded.
- LAB's restored “Начать новый заказ” uses a same-origin capability-scoped restart command. Existing payment is read back without creation admission and must be definitively DECLINED/EXPIRED. If no payment exists, the no-payment check, old quote/hold retirement and durable LAB_CHECKOUT_RETIRED audit marker commit under the confirmation write lock; this also fences stale confirmation and delayed first preview. Old history remains accessible. The browser discards capability/keys only after successful retirement and can then choose a new promo. Unknown, paid or unavailable outcomes keep the old session.

Follow-up validation: all 70 Commerce V2 files (1284 passed, 1 skipped), all 22 Platform files (175 passed), LAB checkout DOM (11 passed), root/Platform/LAB V2 typechecks, full lint (0 errors / 51 existing warnings), migration integrity (35 unchanged migrations / 20 historical trees), runtime module import and diff check PASS. The new regressions cover declined/expired purchase → reload → new keys/payment; unresolved-key retention; missing and mismatched v9 evidence → delayed valid qualification without new create/recoverCreate; guest restart refusal for unresolved/paid/readback-failed payments; old-quote/delayed-preview fencing; and new promo/capability after successful restart.

These local checks do not establish green GitHub CI for the follow-up SHA. That is recorded on the PR/Linear after exact-head CI finishes. CUSTODY_IMPACT: NO — source changes only, no host mutation. Existing provider/deployment/financial acceptance boundaries remain unchanged; no merge or real payment is authorized by this fix.

The full LAB request path also requires exact `/v1/lab/guest/restart` admission in the frontend nginx template. The capability-route allowlist now includes that exact path, while refusing extra suffixes and the admin surface. Local isolated nginx/Traefik validation passed the existing 20-test proxy suite (one exported-bundle probe skipped in config-mounted mode), followed by three targeted checks including the new POST/body/capability-forwarding test. Source/source+email gates for guest start/recovery remain unchanged. No proxy was reloaded on a deployed host.

## Second review — candidates checked against 72bee0b8

| Candidate | Disposition and regression |
| --- | --- |
| 1. Course return uses reference instead of slug | Confirmed. Navigation reads `catalog_course_projection.slug`, falls back to `/courses`, and signs only explicit return fields. Source E2E publishes a course with a slug different from its reference and verifies the signed return. |
| 2. Back/reload redirects to bank automatically | Confirmed for LMS and LAB. Preview/restoration exposes an explicit HTTPS continue-payment link; it does not navigate. DOM tests restore PENDING/CUSTOMER_ACTION_REQUIRED/CREATE_UNKNOWN and preserve keys without a payment request. |
| 3. Stored preview refusal/promo mismatch traps LMS | Confirmed. Promo is frozen with the key. A server-confirmed pre-payment refusal or owned unconsumed mismatch returns `newIntentAllowed`; the buyer can then start again with a changed promo/new key. Consumed/unknown-payment mismatches never issue that signal. Reload/error regressions cover both cases. |
| 4. Second paid LAB ticket impossible | Confirmed. Capability-scoped restart accepts authoritative PAID readback as well as DECLINED/EXPIRED; old ticket/history remain intact. Unknown payments must first resolve, without creation admission. Tests purchase two distinct tickets and preserve old capability reads. |
| 5. Guest-start replay spends NAT/email quotas | Confirmed. Browser skips start with a saved order ID. Server validates same capability/email replay under the creation lock without charging creation quotas, even after they are exhausted; new/rotated credentials still consume the same source quotas. |
| 6. Deterministic vNext mismatch stays ambiguous | Confirmed. Semantic validation follows transport/readback handling. Wrong binding/line/totals becomes RailRefusalError, also after lost-ACK readback. Tests verify durable REFUSED, one resolution send, no attempt and released LAB hold. Structurally unreadable/lost responses retain conservative ambiguity. |
| 7. Settle validation rolls back refusal | Confirmed. Prohibited vNext handoff and pure purchase schema/hash/binding/input errors persist REFUSED inside the transaction, then raise outside it. Repeated preview performs no RPC. |
| 8. Noncanonical timestamps bypass expiry | Not reproduced under the frozen contract: JSON Schema and oracle already require exact UTC milliseconds and reject offsets/other precision. Numeric/finite comparisons clarify the consumer's window check; tests retain strict format rejection and cover issuedAt/expiresAt boundaries. Vendor schema/oracle are unchanged. |
| 9. AJV recompiles fresh wrapper schemas | Confirmed. Validation uses the stable schema-reference string; AJV reuses its registered validator instead of caching a new wrapper per call. All portable consumer vectors remain covered. |
| 10. Unknown/foreign confirm quote returns 503 | Confirmed. Typed not-found errors and early guest ownership checking return identical redacted 404 responses. Tests assert no CHECKOUT_FAILURE signal for those cases. |

Minor comments: quote expiry/staleness now share the storage-safe reset helper; signed return omits `protocol`; audit lookups have two new nonunique indexes in append-only migration 0036. EXPLAIN QUERY PLAN regressions verify indexed searches. Existing 0001–0035 SQL bytes/lock entries stay unchanged. The new exact schema digest is classified for isolated restore/offline retention: indexes add no personal-data fields, stores or purge targets. Full legacy-upgrade and erasure regressions preserve their evidence checks. Route and domain consent guards are intentionally both retained: the early route guard prevents context exchange/signed-state work before consent and preserves the existing closed-test 403 contract; direct domain callers still require their guard.

The new corrections do not modify vendored contract artifacts or portable JSON fixtures. No live provider transport/E2E, merge, deployment, production migration, sales activation or payment operation is performed. CUSTODY_IMPACT: NO — source and isolated local test databases only.

Final local validation for the second review corrections: all 70 Commerce V2 files **1310 PASS, 1 SKIP**; all 22 Platform files **181 PASS**; LAB checkout DOM **15 PASS** (1506 PASS / 1 SKIP combined). Root/Platform/LAB V2 typechecks and full lint pass (0 errors / 51 existing warnings). Migration integrity passes with 36 files: 35 prior migrations unchanged plus the new index-only migration; legacy-upgrade, erasure restore/library, offline retention and reconciliation regressions pass in the full Commerce run. `git diff --check` passes. Exact-head GitHub CI for the new commit is recorded separately on the PR and Linear after publishing.
