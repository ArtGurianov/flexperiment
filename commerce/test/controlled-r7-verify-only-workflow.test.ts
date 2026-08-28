import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/controlled-r7-verify-only.yml", "utf8");

const EXPECTED_R7 = "5ec1eadab4373fb1309dd1d323d88bf12f564220";
const EXPECTED_OWNER = "deploy-aa492d5a6361c8d43f8cbb2a4e3b245611f4f76b";
const EXPECTED_MIGRATION = "0036_tochka_provider_error_evidence.sql";
const EXPECTED_PROMO_RELEASE_ID = "promo-codes-v0:b01f217ffd2a798fd32aa3d88e125a2e460bd39f";
const EXPECTED_PROMO_SOURCE = "97678cc19d2549146b0d4999466a4cded9320208";
const EXPECTED_STATE_HASH = "2a81cf2ec0eab1f9806d4aedb627c0df98ff125aabbd76ea8faa4b37cc997962";

describe("controlled R7 verify-only workflow", () => {
  it("is manual-only, purely read-only, with contents: read and no Coolify secrets", () => {
    const onBlock = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\npermissions:"));
    expect(onBlock).not.toContain("push:");
    expect(onBlock).toContain("workflow_dispatch:");
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).not.toContain("COOLIFY_TOKEN");
    expect(workflow).not.toContain("COOLIFY_COMMERCE_DEPLOY_WEBHOOK_URL");
    expect(workflow).not.toContain("COOLIFY_FRONTEND_DEPLOY_WEBHOOK_URL");
    expect(workflow).not.toContain("COOLIFY_ADMIN_DEPLOY_WEBHOOK_URL");
    expect(workflow).not.toContain("controlled-coolify-deploy.sh");
  });

  it("never mutates any ref and never calls a release-control mutation endpoint", () => {
    expect(workflow).not.toContain("set-production-deploy-ref.sh");
    expect(workflow).not.toContain("git push");
    expect(workflow).not.toContain("/v1/internal/release-control/acquire");
    expect(workflow).not.toContain("/v1/internal/release-control/pause");
    expect(workflow).not.toContain("/v1/internal/release-control/expectations");
    expect(workflow).not.toContain("/v1/internal/release-control/reopen");
    expect(workflow).not.toContain("release-control/candidates/acquire");
    expect(workflow).not.toContain("release-control/candidates/complete");
  });

  it("never references the R5/0036 compatibility projection - it must consume R7's own real, unmodified evidence", () => {
    // Per explicit instruction: no compatibility projection is permitted in
    // verify-only. If R7's own parser cannot consume R7's own real
    // evidence, R7 is defective, and this workflow must fail, not bridge it.
    expect(workflow).not.toContain("derive-r5-migration-compat-evidence");
    expect(workflow).not.toContain("r5-compat");
    expect(workflow).not.toContain("-r5-compat.json");
    expect(workflow).not.toMatch(/status.*compat/i);
  });

  it("hard-binds runtime-candidate and production-deploy to exact R7, and the owner/migration/Promo identities", () => {
    expect(workflow).toContain(`EXPECTED_RUNTIME_CANDIDATE: "${EXPECTED_R7}"`);
    expect(workflow).toContain(`EXPECTED_PRODUCTION_DEPLOY: "${EXPECTED_R7}"`);
    expect(workflow).toContain(`EXPECTED_OWNER_RELEASE_ID: "${EXPECTED_OWNER}"`);
    expect(workflow).toContain(`EXPECTED_MIGRATION: "${EXPECTED_MIGRATION}"`);
    expect(workflow).toContain(`EXPECTED_PROMO_RELEASE_ID: "${EXPECTED_PROMO_RELEASE_ID}"`);
    expect(workflow).toContain(`EXPECTED_PROMO_SOURCE_COMMIT: "${EXPECTED_PROMO_SOURCE}"`);
    expect(workflow).toContain(`EXPECTED_PROMO_STATE_HASH: "${EXPECTED_STATE_HASH}"`);
  });

  it("asserts controller identity, confirmation phrase, and both refs before polling", () => {
    const checkout = workflow.indexOf("uses: actions/checkout@v4");
    const controllerGuard = workflow.indexOf("Assert this controller is exact, current main");
    const confirmGuard = workflow.indexOf("Assert confirmation phrase");
    const refsGuard = workflow.indexOf("Assert runtime-candidate and production-deploy are already exact R7");
    const poll = workflow.indexOf("Poll until Commerce/worker/frontend/admin converge on exact R7 while still paused");
    expect(controllerGuard).toBeGreaterThan(checkout);
    expect(controllerGuard).toBeLessThan(confirmGuard);
    expect(confirmGuard).toBeLessThan(refsGuard);
    expect(refsGuard).toBeLessThan(poll);
    expect(workflow).toContain("VERIFY_CONTROLLER_MAIN_MOVED");
    expect(workflow).toContain("VERIFY_CONFIRM_PHRASE_MISMATCH");
  });

  it("materializes an exact-R7 detached worktree once, before the poll loop, with its own frozen install", () => {
    const step = workflow.indexOf("Materialize exact R7 once for runtime-pinned readiness parsing");
    const nextStep = workflow.indexOf("Poll until Commerce/worker/frontend/admin converge on exact R7 while still paused");
    expect(step).toBeGreaterThan(-1);
    expect(nextStep).toBeGreaterThan(step);
    const section = workflow.slice(step, nextStep);
    expect(section).toContain('git worktree add --detach "$RUNTIME_ASSERT_DIR" "$EXPECTED_PRODUCTION_DEPLOY"');
    expect(section).toContain('[[ "$(git -C "$RUNTIME_ASSERT_DIR" rev-parse HEAD)" == "$EXPECTED_PRODUCTION_DEPLOY" ]]');
    expect(section).toContain("RUNTIME_ASSERT_WORKTREE_WRONG_SHA");
    expect(section).toContain('(cd "$RUNTIME_ASSERT_DIR" && pnpm install --frozen-lockfile --ignore-scripts)');
    expect(workflow).not.toContain('pnpm install --frozen-lockfile)');
    expect(section).toContain('RUNTIME_ASSERT_DIR="$RUNNER_TEMP/r7-readiness-runtime"');
    expect(section).toContain('echo "RUNTIME_ASSERT_DIR=$RUNTIME_ASSERT_DIR" >> "$GITHUB_ENV"');
    expect(workflow).not.toMatch(/RUNTIME_ASSERT_DIR:\s*\$\{\{\s*runner\./);
    expect(workflow.match(/git worktree add --detach/g)).toHaveLength(1);
  });

  it("polls with a bounded, short budget for observable surface convergence only - no readiness parser inside the loop", () => {
    expect(workflow).toContain('POLL_ATTEMPTS: "18"');
    expect(workflow).toContain('POLL_SECONDS: "10"');
    const poll = workflow.indexOf("Poll until Commerce/worker/frontend/admin converge on exact R7 while still paused");
    const readinessStep = workflow.indexOf("Run the exact-R7 pinned readiness parser exactly once, now that surfaces have converged");
    const section = workflow.slice(poll, readinessStep);
    expect(section).toContain('for attempt in $(seq 1 "$POLL_ATTEMPTS"); do');
    expect(section).toContain("VERIFY_RUNTIME_NOT_CONVERGED_YET");
    // The readiness parser must not be invoked anywhere inside the poll loop
    // - it moved to its own step, run exactly once after convergence.
    expect(section).not.toContain("assert-generic-production-deploy-ready.ts");
    expect(section).not.toContain("RUNTIME_ASSERT_DIR");
    expect(section).not.toContain("git worktree add");
    expect(section).not.toContain("pnpm install");
    // The retryable convergence predicate covers the observable surfaces.
    expect(section).toContain(".runtime.source_commit == $source and");
    expect(section).toContain(".runtime.worker_source_commit == $source");
    expect(section).toContain('.source_commit == $sha\' frontend.json');
    expect(section).toContain('.source_commit == $sha\' admin.json');
    expect(section).toContain(".ok == true' health.json");
    expect(section).toContain(".ok == true' ready.json");
  });

  it("treats an authority mismatch as fatal and immediate, never as a retryable not-converged-yet condition", () => {
    const poll = workflow.indexOf("Poll until Commerce/worker/frontend/admin converge on exact R7 while still paused");
    const readinessStep = workflow.indexOf("Run the exact-R7 pinned readiness parser exactly once, now that surfaces have converged");
    const section = workflow.slice(poll, readinessStep);
    // The authority check (paused/owner/mode/expected) uses `||` to a
    // distinct fatal exit, not `&&` chained into the retry condition -
    // a wrong owner/mode/expected/paused-state can never be fixed by
    // waiting longer, so it must not be reported as non-convergence.
    const authorityCheckIndex = section.indexOf(".sales_paused == true and");
    const authorityExitIndex = section.indexOf("VERIFY_AUTHORITY_UNEXPECTED_STATE");
    // The loop now has two distinct VERIFY_RUNTIME_NOT_CONVERGED_YET exit
    // points (status-fetch-retry exhaustion, then surface-convergence
    // exhaustion) - the authority exit must precede the final one, i.e. the
    // surface-convergence loop's own exhaustion marker, which is what it
    // must never be confused with.
    const finalConvergenceLoopIndex = section.lastIndexOf("VERIFY_RUNTIME_NOT_CONVERGED_YET");
    expect(authorityCheckIndex).toBeGreaterThan(-1);
    expect(authorityExitIndex).toBeGreaterThan(authorityCheckIndex);
    expect(authorityExitIndex).toBeLessThan(finalConvergenceLoopIndex);
    expect(section).toContain('status.json >/dev/null || { cat status.json >&2; echo "VERIFY_AUTHORITY_UNEXPECTED_STATE" >&2; exit 1; }');
  });

  it("asserts authority unconditionally on status.json before any frontend/admin/health/ready fetch - never nested inside their outer condition", () => {
    // Regression test for the masking bug found in the first fix attempt
    // (commit a2a34b1): there, the authority assertion lived inside the
    // same outer `if status && frontend && admin && health && ready; then`
    // as the surface fetches, so a genuine authority violation could be
    // hidden behind an unrelated, unlucky transient frontend/admin/health/
    // ready failure in the same iteration, surfacing only as
    // VERIFY_RUNTIME_NOT_CONVERGED_YET after the loop exhausted. The status
    // fetch must be its own independently retryable operation, and once it
    // succeeds, authority must be evaluated before - not conditional on -
    // any of the other fetches.
    const poll = workflow.indexOf("Poll until Commerce/worker/frontend/admin converge on exact R7 while still paused");
    const readinessStep = workflow.indexOf("Run the exact-R7 pinned readiness parser exactly once, now that surfaces have converged");
    const section = workflow.slice(poll, readinessStep);
    const statusFetchIndex = section.indexOf('curl --silent --show-error --connect-timeout "$POLL_CONNECT_TIMEOUT" --max-time "$POLL_MAX_TIME" --output status.json --write-out \'%{http_code}\'');
    const authorityCheckIndex = section.indexOf(".sales_paused == true and");
    const frontendFetchIndex = section.indexOf('get "$PUBLIC_FRONTEND_URL/release.json" > frontend.json');
    expect(statusFetchIndex).toBeGreaterThan(-1);
    expect(authorityCheckIndex).toBeGreaterThan(statusFetchIndex);
    expect(frontendFetchIndex).toBeGreaterThan(authorityCheckIndex);
    // The status fetch is a standalone, negated, independently retryable
    // check with its own `continue` - not the first clause of a multi-line
    // `&&` chain that also fetches frontend/admin/health/ready.
    expect(section).toContain("if ! status_http=\"$(curl --silent --show-error --connect-timeout \"$POLL_CONNECT_TIMEOUT\" --max-time \"$POLL_MAX_TIME\" --output status.json --write-out '%{http_code}'");
    const statusFailureBranch = section.slice(statusFetchIndex, authorityCheckIndex);
    expect(statusFailureBranch).toContain("continue");
    expect(statusFailureBranch).not.toContain("get \"$PUBLIC_FRONTEND_URL/release.json\"");
  });

  it("classifies status HTTP errors as fatal, distinct from transport failures and from surface non-convergence", () => {
    // Regression test for the second-round blocker: `--fail-with-body`
    // treats any non-2xx HTTP response the same as a connection/timeout
    // failure, so a revoked token, broken route, or other deterministic
    // status-endpoint failure (401/403/404/500/...) could still exhaust the
    // loop and emit the genuine-convergence-delay marker. The status fetch
    // must capture the HTTP code explicitly and treat anything but 200 as
    // fatal - never folded into either the transport-retry path or the
    // surface-convergence retry path.
    const poll = workflow.indexOf("Poll until Commerce/worker/frontend/admin converge on exact R7 while still paused");
    const readinessStep = workflow.indexOf("Run the exact-R7 pinned readiness parser exactly once, now that surfaces have converged");
    const section = workflow.slice(poll, readinessStep);
    // The status fetch uses a bare curl (no --fail-with-body) so a non-2xx
    // response does not itself fail the command - only a genuine transport
    // error does.
    expect(section).toContain("status_http=\"$(curl --silent --show-error --connect-timeout \"$POLL_CONNECT_TIMEOUT\" --max-time \"$POLL_MAX_TIME\" --output status.json --write-out '%{http_code}' -H \"Authorization: Bearer $COMMERCE_RELEASE_CONTROL_TOKEN\" \"$PUBLIC_API_URL/v1/internal/release-control/status\")");
    expect(section).not.toMatch(/curl --fail-with-body[^\n]*\/v1\/internal\/release-control\/status/);
    const httpCheckIndex = section.indexOf('[[ "$status_http" == "200" ]]');
    const fatalHttpExitIndex = section.indexOf("VERIFY_STATUS_UNEXPECTED_HTTP");
    const authorityCheckIndex = section.indexOf(".sales_paused == true and");
    const finalConvergenceLoopIndex = section.lastIndexOf("VERIFY_RUNTIME_NOT_CONVERGED_YET");
    expect(httpCheckIndex).toBeGreaterThan(-1);
    expect(fatalHttpExitIndex).toBeGreaterThan(httpCheckIndex);
    expect(fatalHttpExitIndex).toBeLessThan(authorityCheckIndex);
    expect(fatalHttpExitIndex).toBeLessThan(finalConvergenceLoopIndex);
    expect(section).toContain('[[ "$status_http" == "200" ]] || { cat status.json >&2; echo "VERIFY_STATUS_UNEXPECTED_HTTP=$status_http" >&2; exit 1; }');
    // A non-200 HTTP status must not be reachable from the retryable
    // transport-failure branch (it only fires when curl itself fails).
    const transportFailureBranch = section.slice(section.indexOf("if ! status_http="), httpCheckIndex);
    expect(transportFailureBranch).not.toContain("VERIFY_STATUS_UNEXPECTED_HTTP");
  });

  it("runs the readiness parser exactly once, after the convergence loop, never re-entering it on failure", () => {
    const poll = workflow.indexOf("Poll until Commerce/worker/frontend/admin converge on exact R7 while still paused");
    const readinessStep = workflow.indexOf("Run the exact-R7 pinned readiness parser exactly once, now that surfaces have converged");
    const checkoutProof = workflow.indexOf("Prove public checkout is paused, not corrupt");
    expect(readinessStep).toBeGreaterThan(poll);
    expect(checkoutProof).toBeGreaterThan(readinessStep);
    const section = workflow.slice(readinessStep, checkoutProof);
    // release.json is now built with the same shape as the already-proven
    // submit workflow's request construction: legal_hashes explicitly
    // pulled from runtime.legal_hashes, never copied verbatim from
    // status.json's own `.expected` (which never carries legal_hashes -
    // this was exactly the run-33143519915 defect).
    expect(section).toContain("legal_hashes: $s.runtime.legal_hashes");
    expect(section).not.toContain("expected: .expected");
    expect(section).not.toMatch(/\{\s*release_id:\s*\.owner_release_id,\s*mode:\s*\.owner_mode,\s*expected:\s*\.expected\s*\}/);
    expect(section).toContain('(cd "$RUNTIME_ASSERT_DIR" && node --import tsx commerce/src/assert-generic-production-deploy-ready.ts "$GITHUB_WORKSPACE/status.json" "$GITHUB_WORKSPACE/release.json" paused)');
    // Runs exactly once - no loop, no retry, no sleep, no attempt counter.
    expect(section).not.toContain("for attempt in");
    expect(section).not.toContain("sleep ");
    expect(section).not.toContain("VERIFY_RUNTIME_NOT_CONVERGED_YET");
    expect(section).not.toContain("git worktree add");
    expect(section).not.toContain("pnpm install");
    // Only one readiness-parser invocation exists anywhere in the workflow.
    expect(workflow.match(/node --import tsx commerce\/src\/assert-generic-production-deploy-ready\.ts/g)).toHaveLength(1);
  });

  it("proves candidates/head is a clean 200 with the exact historical Promo head - this is exactly what R6 fixes, carried forward into R7", () => {
    const readinessStep = workflow.indexOf("Run the exact-R7 pinned readiness parser exactly once, now that surfaces have converged");
    const step = workflow.indexOf("Prove candidates/head is now a clean 200 with the exact historical Promo head");
    expect(step).toBeGreaterThan(readinessStep);
    const section = workflow.slice(step);
    expect(section).toContain('"$PUBLIC_API_URL/v1/admin/release-control/candidates/head"');
    expect(section).toContain(".head.release_id == $release_id and");
    expect(section).toContain('.head.phase == "COMPLETE" and');
    expect(section).toContain(".state_hash == $hash");
  });

  it("takes one final fresh authority snapshot as the last executable step, after every incident proof, and never reopens", () => {
    const providerStep = workflow.indexOf("Prove provider readiness is read-only healthy");
    const finalStep = workflow.indexOf("Final authority snapshot remains exact R7 and paused");
    expect(finalStep).toBeGreaterThan(providerStep);
    const afterFinalStep = workflow.slice(finalStep + "Final authority snapshot remains exact R7 and paused".length);
    expect(afterFinalStep).not.toMatch(/\n {6}- name:/);
    const section = workflow.slice(finalStep);
    expect(section).toContain('final_candidate_sha="$(git rev-parse origin/runtime-candidate)"');
    expect(section).toContain("FINAL_RUNTIME_CANDIDATE_UNEXPECTED_SHA");
    expect(section).toContain('final_production_deploy_sha="$(scripts/read-production-deploy-ref.sh)"');
    expect(section).toContain("FINAL_PRODUCTION_DEPLOY_UNEXPECTED_SHA");
    expect(section).toContain("FINAL_GENERIC_GATE_UNEXPECTED_STATE");
    expect(section).toContain("FINAL_PROMO_HEAD_CHANGED");
    expect(workflow).not.toContain("/v1/internal/release-control/reopen");
    expect(workflow).toContain("No reopen step exists in this workflow");
  });

  it("uses the shared production concurrency group, same as every other controller", () => {
    expect(workflow).toContain("group: flexperiment-production-controlled-cutover");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("environment: production");
  });

  it("runs every ref/status policy check from the controller's single checkout - only the runtime readiness parser uses the pinned R7 worktree", () => {
    const checkoutSteps = [...workflow.matchAll(/uses:\s*actions\/checkout@/g)];
    expect(checkoutSteps).toHaveLength(1);
    expect(workflow).toContain("ref: ${{ github.sha }}");
    expect(workflow.match(/git worktree add --detach/g)).toHaveLength(1);
  });

  it("never invokes the readiness parser as a bare command against main's own checkout, anywhere in the workflow", () => {
    const bareInvocations = [...workflow.matchAll(/^\s*node --import tsx commerce\/src\/assert-generic-production-deploy-ready\.ts/gm)];
    expect(bareInvocations).toHaveLength(0);
    const pinnedInvocations = [...workflow.matchAll(/\(cd "\$RUNTIME_ASSERT_DIR" && node --import tsx commerce\/src\/assert-generic-production-deploy-ready\.ts/g)];
    expect(pinnedInvocations).toHaveLength(1);
  });
});
