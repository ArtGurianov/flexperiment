# Controlled production cutover

This is the only supported automation for the booking-time age-band and legal release `2026-08-25.1`. It is a release state machine, not a deployment hook. The workflow is [controlled-age-band-cutover.yml](../.github/workflows/controlled-age-band-cutover.yml).

## Deployment architecture found

The repository contains `Dockerfile.commerce` and `docker-compose.commerce.yml` only. It contains no GitHub workflow, Coolify resource definition, Coolify API configuration, webhook URL, or static-frontend deployment definition. Therefore it cannot prove the current production trigger chain. The workflow uses exactly one configured `COOLIFY_DEPLOY_WEBHOOK_URL`; a successful webhook response is deliberately not deployment proof. It polls the authenticated Commerce runtime for the expected `SOURCE_COMMIT`, migration and legal evidence.

Before use, disable direct Coolify Git auto-deploy for every production resource that can serve Commerce or the static frontend. Configure the one webhook secret to deploy the complete release set from the checked-out commit, not a branch head. The Compose runtime now receives `SOURCE_COMMIT`; Coolify must supply that exact value for every candidate and promotion deployment.

## Bootstrap is mandatory

The pre-age-band runtime has no global release gate. Its only sales switch is `occurrences.sales_status`; changing it is an occurrence business mutation and can create revisions, notices and refund rights. It must never be used as a deployment pause.

Prepare a separate, backward-compatible Phase 0 release by backporting infrastructure migrations `0032_release_sales_gate.sql` and `0033_runtime_release_evidence.sql`, `commerce/src/release-control.ts`, its internal API and `COMMERCE_RELEASE_CONTROL_TOKEN` configuration, Commerce/worker runtime evidence, and the checkout/context gate checks while preserving the prior DOB request schema and UI. Phase 0 keeps sales open and contains neither migration `0031`, age-band UI, nor the `2026-08-25.1` legal release. It must expose the complete release-control protocol shape, including `GET /completion/:releaseId` and all runtime evidence keys; unavailable facts are explicit `false` or `null`. This guarantees that a worker cannot start before the runtime-evidence table exists. Verify authenticated `GET /v1/internal/release-control/status` reports an unpaused gate before the current source is eligible for cutover.

## One-shot checkout contract assumption

`2026-08-25.1` is the first customer-facing checkout release. No pre-age-band customer order requires legacy DOB browser idempotency replay. Historical test and certification rows remain immutable audit data, but are not part of the customer replay contract; after reopen, checkout accepts only the age-band V2 contract. Before dispatching the workflow, an operator must record the timestamp and the result of `SELECT COUNT(*) FROM orders` in the release record, together with the classification that every returned row is non-customer certification/test data. This is a manual preflight fact, not a new workflow evidence field.

## Durable sales gate and ownership

`release_sales_gate` is a singleton SQLite row shared by Commerce and the worker volume. `release_sales_gate_events` records acquisition, pause and reopen. It is not stored in process memory and is independent of occurrences.

`acquire` gets the owner; `pause` is idempotent only for that same owner and expected release. All mutation endpoints require `Authorization: Bearer $COMMERCE_RELEASE_CONTROL_TOKEN`; the token is a dedicated CI secret, never an Admin cookie or password. The public checkout route checks the gate before parsing a new payload and the domain checks again inside its immediate transaction. Old DOB tabs therefore receive retryable `503 SALES_TEMPORARILY_PAUSED` before any order/payment side effect. Exact idempotency replays remain readable because they do not create a new order.

The gate affects no webhook, reconciliation, ticket, cancellation, refund, outbox or Event Dump path. A payment URL issued before pause can still become PAID and complete its normal booking/ticket/email flow.

## Controlled workflow state machine

1. GitHub concurrency serializes production runs; a durable owner acquires and pauses new orders.
2. The sole Coolify webhook deploys the candidate. Bounded polling requires exact Commerce and worker SHA, a fresh worker heartbeat and successful sweep, migrations `0031`, `0032`, `0033` and `0034`, ready internal status and old active legal `2026-08-23.2`.
3. The owner publishes the shipped `2026-08-25.1` draft once. SQLite writes `legal_releases.effective_at`; the returned value is authoritative. Replays reconcile the existing release rather than creating another.
4. The workflow generates and commits the promotion artifact: current legal copies, active manifest and certification defaults. It writes the commit to its immutable `releases/gha-<run_id>` branch, copies the SQLite timestamp exactly, updates the durable expected SHA under the same paused owner, triggers the same webhook and waits for that promotion SHA.
5. It verifies all four hashes, current legal copies, active release, required migration and non-mutating DOB rejection. Only then does the owner issue CAS reopen.

After a successful reopen, merge `releases/gha-<run_id>` into `main` before allowing any ordinary deployment from `main`. Confirm the resulting `main` contains the promoted manifest, all four current convenience copies and the updated certification defaults. Until that merge is complete, disable ordinary deploys: a stale `main` deploy would regress the public current legal copies even though immutable archived order evidence remains valid.

Any timeout, deployment mismatch, legal mismatch, missing timestamp, contract failure, owner mismatch or failed promotion exits non-zero and leaves new sales paused. There is no cleanup reopen. The workflow never performs the separate real ₽1 payment/refund/email certification.

## Required one-time setup

1. Create and verify the compatible Phase 0 deployment while sales are open.
2. Disable direct Coolify Git auto-deploy for all relevant production resources.
3. Create a GitHub production environment with approval protection and add `COMMERCE_INTERNAL_URL`, `COMMERCE_RELEASE_CONTROL_TOKEN` and `COOLIFY_DEPLOY_WEBHOOK_URL` as secrets. Never store values in source.
4. Make the webhook deploy Commerce, worker and static frontend from the exact commit; inject that commit as Commerce and worker `SOURCE_COMMIT`. The static build must run `SOURCE_COMMIT=<sha> pnpm release:static-descriptor`; configure `PUBLIC_RELEASE_URL` to that served frontend origin.
5. Give the workflow only the repository write permission required for its generated legal-promotion commit. Its push must not invoke another deployment path or a recursive workflow.

## Recovery

Use authenticated `GET /v1/internal/release-control/status` to inspect owner, pause state and runtime evidence. Retry read-only `verify` safely. Publication may be repeated only when it reports the same version/manifest as active. Resume the same release owner when possible. Do not manually reopen to recover a failed deploy.

Emergency reopening is deliberately a guarded internal `reopen` request with the original owner and exact expected SHA, migration, legal version and hashes. If any fact is unknown, keep sales paused and repair deployment or legal state first.
