# Controlled production deployment and special cutovers

The manual [controlled-production-deploy.yml](../.github/workflows/controlled-production-deploy.yml) dispatch is the routine controlled production deploy; a push to `main` never deploys. It freezes the live legal and migration baseline, acquires the durable owner, pauses new registrations, deploys the exact runtime-candidate SHA, proves all public and internal surfaces, then guardedly reopens registrations. A failed post-pause run is fail-closed: registrations stay paused for recovery by the same release ID.

The historical booking-time age-band and legal release `2026-08-25.1` is handled by the separate manual [controlled-age-band-cutover.yml](../.github/workflows/controlled-age-band-cutover.yml). That state machine is only for a future approved schema or legal promotion; routine pushes must never publish legal content or create a promotion commit.

## Deployment architecture found

Verified production topology is three independent manual-deploy Coolify resources: `https://flexperiment.ru` is the static frontend, `https://admin.flexperiment.ru` is the static admin, and `https://api.flexperiment.ru` is the shared Commerce/Worker Compose resource with one persistent SQLite volume. The browser intentionally calls the API cross-origin; Commerce CORS is restricted to the frontend origin.

Every release deploy invokes all three authenticated Coolify deploy webhooks with a Deploy-scoped `COOLIFY_TOKEN`. Webhook acceptance is only enqueue acknowledgement. Commerce/Worker runtime evidence, frontend `/release.json`, admin `/release.json`, health endpoints and the API legal-config remain authoritative deployment proof. All three Coolify resources must use `production-deploy` as their Git source branch; `main` remains the development and source-of-truth branch and is never itself a Coolify deploy trigger.

## Routine deploy safety contract

The generic workflow rejects any candidate that changes `commerce/migrations`, `commerce/legal`, or `public/legal`; those changes require an explicitly approved manual controlled cutover. Before acquiring the owner, it also verifies that the production database migration inventory equals the immutable production source commit, and that the current canonical legal manifest matches live durable legal evidence. This prevents a candidate from changing the expected baseline and the object being checked in the same run.

After a new Coolify dispatch, the generic workflow gives all three resources a 60-second settling window before it starts readiness polling. A recovery run that has already reached `VERIFY_AND_REOPEN` skips that delay. Polling is then bounded to 30 attempts with a 10-second interval and 3/7-second connect/total request timeouts. Each attempt uses a fresh temporary directory; a response is consumed only after its fetch and JSON-object validation succeed. Normal intermediate lag is logged as `SURFACES_CONVERGING` with its precise code. On final failure the workflow prints the last safe observed source/worker/legal state and gate diagnostic, never a bearer token or response body.

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
2. After the owner has paused new orders, the workflow advances the guarded `production-deploy` ref to the candidate SHA with an ordinary non-force push. The three Coolify webhooks deploy that configured ref. Bounded polling requires exact Commerce and worker SHA, a fresh worker heartbeat and successful sweep, migrations `0031`, `0032`, `0033` and `0034`, frontend/admin descriptors with the candidate SHA and age-band contracts, ready internal status and old active legal `2026-08-23.2`.
3. The owner publishes the shipped `2026-08-25.1` draft once. SQLite writes `legal_releases.effective_at`; the returned value is authoritative. Replays reconcile the existing release rather than creating another.
4. The workflow generates the promotion artifact and performs a normal guarded fast-forward push directly to `main`. It refuses any unrelated `main` advancement, or reuses only an exact existing promotion with the same timestamp, hashes and allowed source diff. It updates the durable expected SHA under the same paused owner, advances `production-deploy` to that promotion SHA, triggers all three webhooks and waits for the promotion SHA.
5. It verifies all four hashes, current legal copies, active release, required migration and non-mutating DOB rejection. Only then does the owner issue CAS reopen.

`main` is the protected source ref; `production-deploy` is the only Coolify deployment ref. A fresh workflow dispatch refuses to acquire or pause unless the supplied 40-character `target_sha` exactly equals `origin/main`. Once a durable owner exists, only a retry for that same release may advance `production-deploy`; it may recover its exact target even if `main` has advanced. A different release is blocked before the deployment ref is changed. There is no release branch and no post-cutover synchronization step.

Any timeout, deployment mismatch, legal mismatch, missing timestamp, contract failure, owner mismatch or failed promotion exits non-zero and leaves new sales paused. There is no cleanup reopen. The workflow never performs the separate real ₽1 payment/refund/email certification.

## Required one-time setup

1. Create and verify the compatible Phase 0 deployment while sales are open.
2. Disable direct Coolify Git auto-deploy for all relevant production resources.
3. Create a GitHub production environment with approval protection and add `COMMERCE_RELEASE_CONTROL_TOKEN`, `COOLIFY_TOKEN`, `COOLIFY_COMMERCE_DEPLOY_WEBHOOK_URL`, `COOLIFY_FRONTEND_DEPLOY_WEBHOOK_URL` and `COOLIFY_ADMIN_DEPLOY_WEBHOOK_URL` as secrets. `COOLIFY_TOKEN` has Deploy permission only. Never store values in source.
4. Create remote `production-deploy` at the observed production SHA, then configure Commerce/Worker, frontend and admin to use that branch as their Git source. Keep `main` as the source branch for development and disable direct Git auto-deploy everywhere. The controlled workflows are the only writers of `production-deploy`; they use a normal non-force push and re-read the remote ref before invoking Coolify.
5. Add non-secret variables `PUBLIC_FRONTEND_URL=https://flexperiment.ru` and `PUBLIC_API_URL=https://api.flexperiment.ru`. Configure frontend as the Git-based Dockerfile resource `Dockerfile.frontend` and admin as `Dockerfile.admin`. On both static resources, enable **Include Source Commit in Build** so Coolify supplies the checked-out commit as the Docker `SOURCE_COMMIT` build argument; do not define a separate pinned build variable with that name. The Dockerfiles immediately promote it to the build environment, and their descriptor writers reject a missing or malformed value before Next exports the static site. A runtime-only `SOURCE_COMMIT` is insufficient: nginx serves files already created at image-build time. Commerce and Worker receive the same exact value at runtime.
6. Keep every resource on manual deploy only. Give the generic workflow repository write permission solely for guarded `production-deploy` updates; the age-band workflow also needs it for its guarded promotion fast-forward to `main`. Neither push may trigger another deploy path or recursive workflow.

## Recovery

## Sales-status and notification cutover

This change is a two-epoch manual cutover. Epoch A deploys migrations 0037 and
0038 plus the dormant public/admin contracts through the candidate mechanism;
after certification the operator latches the independent emergency gate before
completing the candidate. Epoch B publishes and promotes legal release
`2026-08-28.1` as a direct child of the runtime source, verifies the active
capability, then releases the deployment gate. The workflow must never clear
the emergency gate: an operator clears it only after end-to-end notification
verification. Classify either owner from durable release-control status before
any recovery; `main` and `HEAD` are not recovery evidence.

For a paused or incomplete generic controlled deployment, use the
[generic deployment recovery runbook](runbooks/GENERIC_DEPLOY_RECOVERY.md).
It is authoritative for durable-state classification and recovery; do not
improvise from the historical sequence below.

A failure before successful `acquire` has made no gate mutation: registrations remain open and a corrected commit may be pushed normally. A failure after `pause` is different: keep registrations paused, inspect authenticated `GET /v1/internal/release-control/status`, and rerun the workflow for the same `deploy-<SHA>` owner. A newer `main` SHA must not take the owner or move `production-deploy` while recovery is pending. Do not manually reopen to recover a failed deploy.

If Coolify configuration or a webhook enqueue is the failing proof, repair that deployment configuration first and then rerun the same release. If runtime, frontend/admin descriptor, legal or worker evidence fails, repair the exact candidate deployment and rerun the same release; do not replace the durable expected baseline. Publication may be repeated only when it reports the same version/manifest as active.

Emergency reopening is deliberately a guarded internal `reopen` request with the original owner and exact expected SHA, migration, legal version and hashes. If any fact is unknown, keep sales paused and repair deployment or legal state first.
