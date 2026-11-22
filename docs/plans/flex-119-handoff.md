# FLEX-119 handoff (branch `claude/flex-119-native-payments`, PR #289)

Contract: [2026-11-20-native-payment-refund-contract.md](2026-11-20-native-payment-refund-contract.md)
(accepted). Owner profiles: `docs/v2-merchant-schema.md` → "Native launch and fiscal profiles" (#294).

## Done after b0d15ce4 (all pushed)

- `44580dd` fix: native create/refund replay is bounded to one per drive, shared with nested sends.
  Before this, a provider that kept losing answers before committing made one drive recurse
  forever (OOM). `startNativePayment` refuses before writing any row when the storefront for the
  order kind is closed (`NATIVE_PAYMENT_INITIATION_STOPPED`).
- merge of `main` 4ab62e8a (no rename, no rebase). The schema fingerprint is unchanged:
  `4be2beb7…` (main adds no migrations).
- `5095f01` tests:
  - LAB zero side effects at COURSES=OPEN, LAB=CLOSED, native: API preview refused; confirm of a
    pre-close quote refused; the ledger refuses a LAB order. Zero orders, `native_payments`,
    `fiscal_events`, tickets and provider calls.
  - "confirmed payment, grant fails → the sweep completes the grant, one debit".
- `883cb7a` `lib/lab-v2-contract.ts`: `native` added to the paymentMode enum, plus a test that the
  catalogue is served under native while LAB sales stay refused.
- Earlier (`d81cb4d`): app dispatch for refund execute and `/v1/checkout/:id`. NATIVE orders go to
  the ledger; RC.2 orders and non-native modes keep the original path (tests on both contours).
  DTO `control-room-contracts` paymentMode += `native` (`3932a1b`).

Last full Commerce V2 run (on b0d15ce4): 70 files / 1346 PASS. Since then, only targeted runs:
native-payments 22, native-payment-integration 20, contract 87, all PASS; `tsc` clean.
Run tests with `--maxWorkers=1`: the container memory limit kills parallel workers.

## Remaining

1. **Profile Точка эквайринг + «Точка Чеки»** (owner v4.8 item 2):
   - Add `native-payment-profiles.ts` with profile ids (`tochka-acquiring/1`, `tochka-cheki/1`,
     later `ferma/1`) and capabilities. Точка Чеки: fiscalizationMode PROVIDER,
     `finalSettlementWithoutPayment:false`, `refundReceipt:true`; course FULL_PAYMENT.
   - `NATIVE_PROVIDER=tochka` must refuse to start until real API/keys are qualified. No network,
     no invented endpoints.
   - **Per-order profile** (owner text): each order keeps the execution and fiscal profile chosen
     at purchase. 0036 bytes are CI-protected, so this needs a NEW migration (0037 in the branch):
     ALTER `native_payments` ADD `execution_profile`, `fiscal_profile`. Register the DDL with the
     coordinator, recompute both fingerprints (own entry), and update the docs section.
   - Test: on Точка Чеки, LAB FINAL_SETTLEMENT stays fail-closed.
2. **Contract text vs owner (#294):**
   - LAB settlement is explicitly initiated by a Control Room operator after the workshop
     (admission = SERVICE_RENDERED fact + operator command).
   - Ferma cutover: exactly one issuer per fiscal event, earlier orders keep their profile.
   - Update §6/§7 of the contract; do not edit the Authority boundary section.
3. **D (#292):**
   - Wire `labRouteContour`/`labRailContour` into server deps from `contourOfOrder` once D's deps
     exist (D rebases on C).
   - Compare D's `service-rendered.ts` API (`serviceRenderedFact`, `listServiceRenderedFacts`,
     `labOccurrenceCancellationState`, `closingEligibility`) with `ServiceRenditionReader` in
     `fiscal-port.ts`, and send the differences to the coordinator.
4. **FLEX-122 R1–R3** (after 1–2):
   - R1: preview documents and `kind`/`offerRef` for any paid purchase (LAB acceptance with D).
   - R2: native confirm `returnPath` regex `^/checkout/[A-Za-z0-9_-]{16,64}$` → `successUrl` on
     MY, `paymentUrl` in the response.
   - R3: `GET /v1/checkout/:id` additively returns the §8 DTO plus `kind` (platform/lab-v2
     responses not broken).
5. Update the PR #289 body (head SHA, checks) and send the coordinator the new HEAD with evidence.

## Known issues / notes

- `apps/lab-v2/components/LabV2Client.tsx` shows a buy button when `paymentMode !== "disabled"`;
  under native with LAB CLOSED it would render enabled (the server refuses with zero side effects).
  This is UI in D/F's area: report it, don't edit.
- In native mode `server.ts` builds no RC.2 rail, so historical RC.2 read-back/refund in a native
  runtime fails closed (409). It needs an owner decision to keep the RC.2 rail as a
  historical-only executor.
- Fake-provider PASS is not bank or fiscal acceptance (FLEX-82, owner GO are separate).
  CUSTODY_IMPACT: NO.
