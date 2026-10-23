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
