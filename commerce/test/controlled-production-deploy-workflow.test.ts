import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/controlled-production-deploy.yml", "utf8");
const deployHelper = readFileSync("scripts/controlled-coolify-deploy.sh", "utf8");

describe("generic controlled production deploy workflow", () => {
  it("deploys only from workflow_dispatch on main, never from a push to main or any branch", () => {
    const onBlock = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\npermissions:"));
    expect(onBlock).not.toContain("push:");
    expect(onBlock).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("paths:");
    expect(workflow).toContain("workflow_dispatch:\n    inputs:\n      target_sha:");
    expect(workflow).toContain("expected_candidate_sha:");
    expect(workflow).toContain("group: flexperiment-production-controlled-cutover");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain('echo "TARGET_SHA=$target_sha"');
    expect(workflow).toContain('echo "RELEASE_ID=deploy-$target_sha"');
    expect(workflow).toContain('} >> "$GITHUB_ENV"');
    expect(workflow).toContain('mode: "CONTROLLED_CUTOVER"');
    expect(workflow).not.toContain('mode: "ROLLING"');
  });

  it("never resolves the deployment candidate from this controller's own commit", () => {
    expect(workflow).toContain("CONTROLLER_SHA: ${{ github.sha }}");
    expect(workflow).toContain("MUST NEVER be used as the deployment");
    expect(workflow).not.toContain('target_sha="$GITHUB_SHA"');
    expect(workflow).not.toContain('target_sha="$CONTROLLER_SHA"');
    expect(workflow).not.toContain("SOURCE_COMMIT=$CONTROLLER_SHA");
    expect(workflow).not.toContain('scripts/controlled-coolify-deploy.sh "$CONTROLLER_SHA"');
    expect(workflow).not.toContain('scripts/set-production-deploy-ref.sh "$CONTROLLER_SHA"');
  });

  it("refuses to run as a controller unless dispatched from exact, current main", () => {
    const checkout = workflow.indexOf("uses: actions/checkout@v4");
    const controllerGuard = workflow.indexOf("Assert this controller is exact, current main");
    const readPointer = workflow.indexOf("Read current production-deploy pointer");
    expect(controllerGuard).toBeGreaterThan(checkout);
    expect(controllerGuard).toBeLessThan(readPointer);
    // Dispatched from a non-main ref: rejected before any candidate
    // inspection or production API call.
    expect(workflow).toContain('[[ "$GITHUB_REF" == "refs/heads/main" ]]');
    expect(workflow).toContain("DEPLOY_CONTROLLER_NOT_MAIN");
    // Dispatched from main, but main has since advanced past this run's
    // pinned commit: rejected too - the controller itself must stay fresh,
    // mirroring the runtime-candidate freshness rule in the other direction.
    expect(workflow).toContain("git fetch --no-tags origin refs/heads/main:refs/remotes/origin/main");
    expect(workflow).toContain('[[ "$CONTROLLER_SHA" == "$(git rev-parse origin/main)" ]]');
    expect(workflow).toContain("DEPLOY_CONTROLLER_MAIN_MOVED");
  });

  it("resolves an ordinary deploy's candidate from the runtime-candidate ref, with an optional defensive check", () => {
    expect(workflow).toContain('if [[ -n "$INPUT_TARGET_SHA" ]]; then');
    expect(workflow).toContain("recovery_mode=1");
    expect(workflow).toContain("git fetch --no-tags origin runtime-candidate");
    expect(workflow).toContain('target_sha="$(git rev-parse origin/runtime-candidate)"');
    expect(workflow).toContain("recovery_mode=0");
    expect(workflow).toContain('if [[ -n "$INPUT_EXPECTED_CANDIDATE_SHA" ]]; then');
    expect(workflow).toContain("RUNTIME_CANDIDATE_UNEXPECTED_SHA");
  });

  it("requires a strictly linear runtime range with no merge commits, in addition to no maintenance commits", () => {
    expect(workflow).toContain("merge_commits_in_range");
    expect(workflow).toContain("RUNTIME_CANDIDATE_NOT_LINEAR");
    const topology = workflow.indexOf("Assert runtime-candidate topology");
    const noMaintenance = workflow.indexOf("RUNTIME_CANDIDATE_CONTAINS_MAINTENANCE_COMMIT");
    const noMerge = workflow.indexOf("RUNTIME_CANDIDATE_NOT_LINEAR");
    expect(noMaintenance).toBeGreaterThan(topology);
    expect(noMerge).toBeGreaterThan(noMaintenance);
  });

  it("rechecks runtime-candidate freshness right before the first durable mutation, not after", () => {
    const preflight = workflow.indexOf("Preflight immutable generic-deploy boundaries");
    const recheck = workflow.indexOf("Reconfirm runtime-candidate has not moved since preflight");
    const acquire = workflow.indexOf("Acquire owner and pause registrations");
    const setRef = workflow.indexOf("Set guarded production deployment ref");
    expect(recheck).toBeGreaterThan(preflight);
    expect(recheck).toBeLessThan(acquire);
    expect(workflow).toContain("if: env.RECOVERY_MODE == '0' && env.DEPLOY_ACTION != 'RELEASE_ALREADY_COMPLETE' && env.REUSING_PAUSED_OWNER != '1'");
    expect(workflow).toContain('current_candidate_sha="$(git rev-parse origin/runtime-candidate)"');
    expect(workflow).toContain("RUNTIME_CANDIDATE_MOVED_SINCE_PREFLIGHT");
    // Only one freshness recheck for the candidate - it does not repeat
    // after the first mutation, since the durable owner becomes
    // authoritative at that point.
    const firstOccurrence = workflow.indexOf("RUNTIME_CANDIDATE_MOVED_SINCE_PREFLIGHT");
    expect(firstOccurrence).toBeGreaterThan(-1);
    expect(workflow.indexOf("RUNTIME_CANDIDATE_MOVED_SINCE_PREFLIGHT", firstOccurrence + 1)).toBe(-1);
    expect(setRef).toBeGreaterThan(acquire);
  });

  it("runs every policy/boundary script from the controller's own checkout, never the candidate's tree", () => {
    const checkoutSteps = [...workflow.matchAll(/uses:\s*actions\/checkout@/g)];
    expect(checkoutSteps).toHaveLength(1);
    expect(workflow).toContain("ref: ${{ github.sha }}");
    expect(workflow).not.toMatch(/git checkout ["']?\$TARGET_SHA["']?/);
    expect(workflow).not.toMatch(/git checkout ["']?\$CANDIDATE_SHA["']?/);
    // The candidate SHA is touched only through read-only object reads.
    expect(workflow).toContain('git show "$target_sha:release-surface-contract.json"');
    expect(workflow).toContain('git show "$target_sha:commerce/legal/production-manifest.json"');
    expect(workflow).toContain('git cat-file -e "$target_sha^{commit}"');
    expect(workflow).toContain('git diff --name-only -z "$production_source" "$TARGET_SHA"');
    expect(workflow).toContain('git ls-tree -r --name-only "$production_source"');
    // Policy scripts referenced at literal controller-relative paths, never
    // a path derived from the candidate SHA or a second worktree.
    expect(workflow).toContain("scripts/read-production-deploy-ref.sh");
    expect(workflow).toContain("scripts/inspect-runtime-candidate-topology.sh");
    expect(workflow).toContain("scripts/set-production-deploy-ref.sh");
    expect(workflow).not.toMatch(/\$TARGET_SHA\/scripts/);
    expect(workflow).not.toContain("candidate/scripts/");
  });

  it("pins every runtime-semantic readiness parser to the exact target without running lifecycle scripts", () => {
    const materialize = workflow.indexOf("Materialize exact runtime readiness parser");
    const preflight = workflow.indexOf("Preflight immutable generic-deploy boundaries");
    expect(materialize).toBeGreaterThan(workflow.indexOf("pnpm install --frozen-lockfile"));
    expect(materialize).toBeLessThan(preflight);
    expect(workflow).toContain('RUNTIME_ASSERT_DIR="$RUNNER_TEMP/generic-runtime-readiness"');
    expect(workflow).toContain('git worktree add --detach "$RUNTIME_ASSERT_DIR" "$TARGET_SHA"');
    expect(workflow).toContain('[[ "$(git -C "$RUNTIME_ASSERT_DIR" rev-parse HEAD)" == "$TARGET_SHA" ]]');
    expect(workflow).toContain("RUNTIME_ASSERT_WORKTREE_WRONG_SHA");
    expect(workflow).toContain('(cd "$RUNTIME_ASSERT_DIR" && pnpm install --frozen-lockfile --ignore-scripts)');
    expect(workflow).toContain('echo "RUNTIME_ASSERT_DIR=$RUNTIME_ASSERT_DIR" >> "$GITHUB_ENV"');
    expect(workflow).toContain('RUNTIME_ASSERT_DIR="$RUNTIME_ASSERT_DIR" scripts/controlled-production-readiness.sh release.json');
    const bareParsers = [...workflow.matchAll(/^\s*node --import tsx commerce\/src\/assert-generic-production-deploy-ready\.ts/gm)];
    expect(bareParsers).toHaveLength(0);
    const pinnedParsers = [...workflow.matchAll(/\(cd "\$RUNTIME_ASSERT_DIR" && node --import tsx commerce\/src\/assert-generic-production-deploy-ready\.ts/g)];
    expect(pinnedParsers).toHaveLength(2);
  });

  it("resolves an explicit runtime-candidate authority instead of implying main is always the deploy target", () => {
    const readPointer = workflow.indexOf("Read current production-deploy pointer");
    const resolveTarget = workflow.indexOf("Resolve controller and immutable deployment target");
    const topology = workflow.indexOf("Assert runtime-candidate topology");
    const reconfirm = workflow.indexOf("Reconfirm production-deploy has not moved since preflight");
    const setRef = workflow.indexOf("Set guarded production deployment ref");
    expect(readPointer).toBeGreaterThan(-1);
    expect(readPointer).toBeLessThan(resolveTarget);
    expect(workflow).toContain('production_deploy_sha="$(scripts/read-production-deploy-ref.sh)"');
    expect(workflow).toContain('echo "PRODUCTION_DEPLOY_SHA=$production_deploy_sha" >> "$GITHUB_ENV"');
    expect(topology).toBeGreaterThan(resolveTarget);
    expect(workflow).toContain("if: env.RECOVERY_MODE == '0'");
    expect(workflow).toContain('scripts/inspect-runtime-candidate-topology.sh --production-deploy "$PRODUCTION_DEPLOY_SHA" --candidate "$TARGET_SHA"');
    expect(workflow).toContain("RUNTIME_CANDIDATE_NOT_DESCENDANT_OF_PRODUCTION_DEPLOY");
    expect(workflow).toContain("RUNTIME_CANDIDATE_CONTAINS_MAINTENANCE_COMMIT");
    expect(reconfirm).toBeGreaterThan(workflow.indexOf("Reconcile paused deployment"));
    expect(reconfirm).toBeLessThan(setRef);
    expect(workflow).toContain('current_production_deploy_sha="$(scripts/read-production-deploy-ref.sh)"');
    expect(workflow).toContain("PRODUCTION_DEPLOY_MOVED_SINCE_PREFLIGHT");
  });

  it("binds surface proofs to the exact candidate contract identifiers", () => {
    expect(workflow).toContain("release-surface-contract.json");
    expect(workflow).toContain('git show "$target_sha:release-surface-contract.json" > "$candidate_contract_path"');
    expect(workflow).toContain('"$CANDIDATE_CONTRACT_PATH"');
    expect(workflow).toContain("CHECKOUT_CONTRACT_VERSION=$checkout_contract_version");
    expect(workflow).toContain("ADMIN_CONTRACT_VERSION=$admin_contract_version");
    expect(workflow).toContain('.checkout_contract_version == $contract');
    expect(workflow).toContain('.admin_contract_version == $contract');
    expect(workflow).not.toContain('.checkout_contract_version == "age-band-v1"');
    expect(workflow).not.toContain('.admin_contract_version == "age-band-v1"');
  });

  it("evaluates every protected boundary before it can acquire or pause registrations", () => {
    const preflight = workflow.indexOf("Preflight immutable generic-deploy boundaries");
    const acquire = workflow.indexOf("Acquire owner and pause registrations");
    expect(preflight).toBeGreaterThan(-1);
    expect(acquire).toBeGreaterThan(preflight);
    expect(workflow).toContain('git diff --name-only -z "$production_source" "$TARGET_SHA" -- commerce/migrations commerce/legal public/legal release-surface-contract.json');
    expect(workflow).toContain("commerce:production-deploy:assert-boundary generic-deploy-boundary-paths.bin");
    expect(workflow).toContain('commerce/legal public/legal release-surface-contract.json');
    expect(workflow).not.toContain("GENERIC_DEPLOY_REQUIRES_CONTROLLED_LEGAL_CUTOVER");
  });

  it("freezes release expectations from durable production evidence, never candidate helper code", () => {
    expect(workflow).toContain(".runtime as $runtime");
    expect(workflow).toContain('.expected.migration | select(type == "string" and test("^[0-9]{4}_.+\\\\.sql$"))');
    expect(workflow).toContain("migration: $migration");
    expect(workflow).toContain("' durable-before.json > release.json");
    expect(workflow).toContain("GENERIC_DEPLOY_PRODUCTION_BASELINE_INVALID");
    expect(workflow).not.toContain('migration_expectation="inventory-sha256:');
    expect(workflow).not.toContain('migration: "inventory-sha256:');
    expect(workflow).not.toContain("commerce:production-deploy:payload");
    expect(workflow).toContain('git show "$target_sha:commerce/legal/production-manifest.json" > "$candidate_manifest_path"');
    expect(workflow).toContain('"$CANDIDATE_MANIFEST_PATH" >/dev/null || { echo "GENERIC_DEPLOY_LEGAL_CANONICAL_MANIFEST_MISMATCH"');
  });

  it("keeps the runtime migration inventory equal to the deployed source before acquire", () => {
    const sourceInventory = workflow.indexOf('git ls-tree -r --name-only "$production_source" -- commerce/migrations');
    const inventoryMismatch = workflow.indexOf("GENERIC_DEPLOY_PRODUCTION_MIGRATION_INVENTORY_MISMATCH");
    const releaseRequest = workflow.indexOf("' durable-before.json > release.json");
    expect(sourceInventory).toBeGreaterThan(workflow.indexOf("commerce:production-deploy:assert-boundary generic-deploy-boundary-paths.bin"));
    expect(inventoryMismatch).toBeGreaterThan(sourceInventory);
    expect(inventoryMismatch).toBeLessThan(releaseRequest);
    expect(workflow).toContain('[[ "$migration_inventory" == "$source_migration_inventory" ]]');
  });

  it("accepts the top-level document hashes in the canonical candidate manifest", () => {
    const manifestPath = "commerce/legal/production-manifest.json";
    const candidate = JSON.parse(readFileSync(manifestPath, "utf8")) as { version: string; documents: Record<string, { sha256: string }> };
    const expected = {
      legal_version: candidate.version,
      legal_hashes: Object.fromEntries(Object.entries(candidate.documents).map(([name, document]) => [name, document.sha256])),
    };
    const filter = `
      . as $candidate | $expected as $expected |
      $candidate.version == $expected.legal_version and
      {
        PUBLIC_OFFER: $candidate.documents.PUBLIC_OFFER.sha256,
        PRIVACY_POLICY: $candidate.documents.PRIVACY_POLICY.sha256,
        PD_CONSENT: $candidate.documents.PD_CONSENT.sha256,
        CHECKOUT_DISCLOSURE: $candidate.documents.CHECKOUT_DISCLOSURE.sha256
      } == $expected.legal_hashes
    `;
    const result = spawnSync("jq", ["-e", "--argjson", "expected", JSON.stringify(expected), filter, manifestPath], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(workflow).toContain("$candidate.documents.PUBLIC_OFFER.sha256");
    expect(workflow).not.toContain("$candidate.manifest.documents.PUBLIC_OFFER.sha256");
  });

  it("validates each preflight JSON input before parsing or slurping it", () => {
    const statusFetch = workflow.indexOf('release-control/status" > durable-before.json');
    const statusValidation = workflow.indexOf("validate_json durable-before.json DURABLE_BEFORE");
    const completionFetch = workflow.indexOf('completion/$RELEASE_ID" > completion.json');
    const completionValidation = workflow.indexOf("validate_json completion.json COMPLETION");
    const releaseWrite = workflow.indexOf("' durable-before.json > release.json");
    const releaseValidation = workflow.indexOf("validate_json release.json RELEASE_REQUEST");
    const manifestValidation = workflow.indexOf("validate_json \"$CANDIDATE_MANIFEST_PATH\" CANDIDATE_LEGAL_MANIFEST");
    expect(workflow).toContain('${label}_INVALID_JSON');
    expect(workflow).toContain("printf '%s_PREFIX_HEX=' \"$label\"");
    expect(statusValidation).toBeGreaterThan(statusFetch);
    expect(completionValidation).toBeGreaterThan(completionFetch);
    expect(releaseValidation).toBeGreaterThan(releaseWrite);
    expect(manifestValidation).toBeGreaterThan(releaseValidation);
    expect(manifestValidation).toBeLessThan(workflow.indexOf('jq -e --slurpfile request release.json --arg source_sha'));
  });

  it("keeps reconciliation output off the pnpm lifecycle stdout channel", () => {
    const preflightReconcile = workflow.indexOf("pnpm exec tsx commerce/src/reconcile-generic-production-deploy.ts durable-before.json completion.json release.json > reconciliation.json");
    const preflightValidation = workflow.indexOf("validate_json reconciliation.json RECONCILIATION");
    const pausedReconcile = workflow.indexOf("pnpm exec tsx commerce/src/reconcile-generic-production-deploy.ts status.json completion.json release.json > reconciliation.json");
    const pausedValidation = workflow.indexOf('jq -e \'type == "object"\' reconciliation.json >/dev/null || { echo "RECONCILIATION_INVALID_JSON"');
    expect(workflow).not.toContain("pnpm commerce:production-deploy:reconcile");
    expect(preflightValidation).toBeGreaterThan(preflightReconcile);
    expect(pausedValidation).toBeGreaterThan(pausedReconcile);
  });

  it("uses a candidate-bound durable owner without legal promotion or CI writes", () => {
    expect(workflow).toContain('"$owner" == "$RELEASE_ID"');
    expect(workflow).toContain("GENERIC_DEPLOY_BLOCKED_BY_RELEASE_OWNER");
    expect(workflow).toContain("GENERIC_DEPLOY_OWNER_EXPECTATIONS_MISMATCH");
    expect(workflow).toContain('scripts/controlled-coolify-deploy.sh "$TARGET_SHA"');
    expect(workflow).toContain("completion/$RELEASE_ID");
    expect(workflow).toContain('"$PUBLIC_FRONTEND_URL/release.json"');
    expect(workflow).toContain('"$ADMIN_RELEASE_URL"');
    expect(workflow).toContain('"$PUBLIC_API_URL/v1/public/legal-config"');
    expect(workflow).not.toContain("PUBLISH_LEGAL");
    expect(workflow).not.toContain("CREATE_PROMOTION");
    expect(workflow).not.toContain("legal-publish");
    expect(workflow).not.toContain("git push");
    expect(workflow).toContain('scripts/set-production-deploy-ref.sh "$TARGET_SHA"');
    expect(deployHelper).toContain("only an enqueue acknowledgement");
  });

  it("proves the public pause before deploy and rechecks every surface after reopening", () => {
    const pause = workflow.indexOf("Prove public checkout pause before deployment");
    const deploy = workflow.indexOf("Deploy exact production candidate");
    const reopen = workflow.indexOf('"$PUBLIC_API_URL/v1/internal/release-control/reopen"');
    const finalProof = workflow.indexOf("Verify post-reopen completion and all production surfaces");
    expect(pause).toBeGreaterThan(workflow.indexOf("Acquire owner and pause registrations"));
    expect(pause).toBeLessThan(deploy);
    expect(workflow).toContain('"$PUBLIC_API_URL/v1/public/checkouts"');
    expect(workflow).toContain('"$pause_status" == "503"');
    expect(workflow).toContain("SALES_TEMPORARILY_PAUSED");
    expect(finalProof).toBeGreaterThan(reopen);
    const finalProofSource = workflow.slice(finalProof);
    expect(finalProofSource).toContain('"$PUBLIC_FRONTEND_URL/release.json"');
    expect(finalProofSource).toContain('"$ADMIN_RELEASE_URL"');
    expect(finalProofSource).toContain('"$PUBLIC_API_URL/v1/public/legal-config"');
    expect(finalProofSource).toContain('"$PUBLIC_API_URL/healthz"');
    expect(finalProofSource).toContain('"$PUBLIC_API_URL/readyz"');
  });

  it("waits for a newly dispatched Coolify deployment, then uses bounded fresh polling before reopening", () => {
    const readiness = workflow.indexOf('scripts/controlled-production-readiness.sh release.json');
    const reopen = workflow.indexOf('"$PUBLIC_API_URL/v1/internal/release-control/reopen"');
    const dispatch = workflow.indexOf("COOLIFY_DEPLOY_DISPATCHED=1");
    const settlingDelay = workflow.indexOf('sleep "$INITIAL_READINESS_DELAY_SECONDS"');
    expect(workflow).toContain('POLL_CONNECT_TIMEOUT: "3"');
    expect(workflow).toContain('POLL_MAX_TIME: "7"');
    expect(workflow).toContain('INITIAL_READINESS_DELAY_SECONDS: "60"');
    expect(workflow).toContain("timeout-minutes: 12");
    expect(workflow).not.toContain("pnpm commerce:production-deploy:assert-ready");
    expect(dispatch).toBeGreaterThan(workflow.indexOf("Deploy exact production candidate"));
    expect(settlingDelay).toBeGreaterThan(dispatch);
    expect(workflow).toContain('[[ "${COOLIFY_DEPLOY_DISPATCHED:-0}" == "1" ]]');
    expect(readiness).toBeGreaterThan(workflow.indexOf("Prove all surfaces and guarded reopen"));
    expect(readiness).toBeGreaterThan(settlingDelay);
    expect(readiness).toBeLessThan(reopen);
  });

  it("allows only the durable owner to recover after runtime-candidate advances", () => {
    const status = workflow.indexOf('release-control/status" > durable-before.json');
    const owner = workflow.indexOf("owner=\"$(jq -r '.owner_release_id // empty' durable-before.json)\"");
    const freshCandidate = workflow.indexOf("GENERIC_DEPLOY_TARGET_IS_NOT_RUNTIME_CANDIDATE_HEAD");
    const ref = workflow.indexOf("Set guarded production deployment ref");
    const deploy = workflow.indexOf("Deploy exact production candidate");
    expect(status).toBeGreaterThan(-1);
    expect(owner).toBeGreaterThan(status);
    expect(freshCandidate).toBeGreaterThan(owner);
    expect(ref).toBeGreaterThan(workflow.indexOf("Reconcile paused deployment"));
    expect(ref).toBeLessThan(deploy);
    expect(workflow).toContain('[[ -z "$owner" || "$owner" == "$RELEASE_ID" ]]');
    expect(workflow).toContain('if ! jq -e \'.complete\' completion.json >/dev/null && [[ -z "$owner" ]]; then');
  });

  it("limits manual dispatch to an exact already-paused same-owner recovery", () => {
    const dispatch = workflow.indexOf("workflow_dispatch:");
    const stateGuard = workflow.indexOf("GENERIC_DEPLOY_MANUAL_RECOVERY_STATE_INVALID");
    const acquire = workflow.indexOf("Acquire owner and pause registrations");
    const setter = workflow.indexOf('scripts/set-production-deploy-ref.sh "$TARGET_SHA"');
    const deploy = workflow.indexOf("Deploy exact production candidate");
    const reopen = workflow.indexOf('"$PUBLIC_API_URL/v1/internal/release-control/reopen"');
    expect(dispatch).toBeGreaterThan(-1);
    expect(workflow).toContain('if [[ -n "$INPUT_TARGET_SHA" ]]; then');
    expect(workflow).toContain('[[ "$INPUT_TARGET_SHA" =~ ^[0-9A-Fa-f]{40}$ ]]');
    expect(workflow).toContain('target_sha="${INPUT_TARGET_SHA,,}"');
    expect(workflow).toContain('git fetch --no-tags origin "$target_sha"');
    expect(workflow).toContain('git cat-file -e "$target_sha^{commit}"');
    expect(workflow).toContain('.owner_release_id == $release_id and');
    expect(workflow).toContain('.owner_mode == "CONTROLLED_CUTOVER" and');
    expect(workflow).toContain('.expected.source_commit == $source_commit');
    expect(workflow).toContain(".complete == false");
    expect(stateGuard).toBeGreaterThan(dispatch);
    expect(workflow).toContain("env.REUSING_PAUSED_OWNER != '1'");
    expect(setter).toBeGreaterThan(acquire);
    expect(deploy).toBeGreaterThan(setter);
    expect(reopen).toBeGreaterThan(deploy);
    expect(workflow).not.toContain("/expectations");
  });

  it("reuses an already paused same-owner release without replaying acquire or pause", () => {
    const reuse = workflow.indexOf("REUSING_PAUSED_OWNER=1");
    const acquire = workflow.indexOf("Acquire owner and pause registrations");
    const pausedReconcile = workflow.indexOf("Reconcile paused deployment");
    expect(reuse).toBeGreaterThan(-1);
    expect(reuse).toBeLessThan(acquire);
    expect(workflow).toContain('.sales_paused == true and');
    expect(workflow).toContain('.owner_mode == "CONTROLLED_CUTOVER" and');
    expect(workflow).toContain('.expected.source_commit == $source');
    expect(workflow).toContain("env.REUSING_PAUSED_OWNER != '1'");
    expect(pausedReconcile).toBeGreaterThan(acquire);
  });
});
