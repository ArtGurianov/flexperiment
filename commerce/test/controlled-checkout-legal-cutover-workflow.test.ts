import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/controlled-checkout-legal-cutover.yml", "utf8");

describe("controlled anonymous checkout legal cutover workflow", () => {
  it("is a manual candidate-pinned workflow under the shared production lock", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("target_sha:");
    expect(workflow).toContain("repair_sha:");
    expect(workflow).toContain("EXPECTED_CANDIDATE_SHA: 25bb2f96f2f58018aea1747a1c57c62a2c54c145");
    expect(workflow).toContain("RELEASE_ID: checkout-legal-${{ inputs.target_sha }}");
    expect(workflow).toContain("group: flexperiment-production-controlled-cutover");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).not.toContain('checkout_contract_version == "age-band-v1"');
    expect(workflow).not.toContain('admin_contract_version == "age-band-v1"');
  });

  it("derives candidate contracts and legal expectations from the immutable target before acquire", () => {
    const preflight = workflow.indexOf("Build immutable candidate request and reconcile durable state");
    const acquire = workflow.indexOf("Acquire owner and pause registrations");
    expect(preflight).toBeGreaterThan(-1);
    expect(acquire).toBeGreaterThan(preflight);
    expect(workflow).toContain('git worktree add --detach "$candidate_root" "$TARGET_SHA"');
    expect(workflow).toContain('"$candidate_root/release-surface-contract.json"');
    expect(workflow).toContain("CANDIDATE_MANIFEST_PATH: commerce/legal/production-manifest.2026-08-26.1.draft.json");
    expect(workflow).toContain('COMMERCE_RELEASE_MANIFEST_PATH="$CANDIDATE_MANIFEST_PATH"');
    expect(workflow).toContain('"$ACTIVE_CANDIDATE_SHA" "$PREVIOUS_LEGAL_VERSION" > reconciliation.json');
    expect(workflow).toContain("decide-checkout-legal-cutover-recovery.ts");
    expect(workflow).toContain('validate_json recovery.json RECOVERY');
  });

  it("proves the public pause before candidate deployment and legal publication", () => {
    const pauseProof = workflow.indexOf("Prove public checkout pause before deployment");
    const candidateDeploy = workflow.indexOf("Deploy candidate to Commerce Worker Frontend and Admin");
    const publish = workflow.indexOf("Publish candidate legal release");
    expect(pauseProof).toBeGreaterThan(workflow.indexOf("Acquire owner and pause registrations"));
    expect(pauseProof).toBeLessThan(candidateDeploy);
    expect(workflow).toContain("SALES_TEMPORARILY_PAUSED");
    expect(workflow).toContain('TARGET_SHA="$ACTIVE_CANDIDATE_SHA" scripts/controlled-production-readiness.sh "$ACTIVE_REQUEST_PATH" candidate-pre-publication');
    expect(publish).toBeGreaterThan(workflow.indexOf("Prove candidate before legal publication"));
    expect(workflow).toContain("PREVIOUS_LEGAL_VERSION: 2026-08-25.1");
    expect(workflow).toContain("CANDIDATE_LEGAL_VERSION: 2026-08-26.1");
  });

  it("creates a guarded immutable promotion, deploys it, then reopens only after fresh evidence", () => {
    const promotion = workflow.indexOf("Create or recover immutable legal promotion artifact");
    const deploy = workflow.indexOf("Deploy promotion artifact to Commerce Worker Frontend and Admin");
    const reopen = workflow.indexOf('release-control/reopen" > reopened.json');
    const finalProof = workflow.indexOf("Verify durable completion and every post-reopen surface");
    expect(workflow).toContain('git push origin "HEAD:refs/heads/$promotion_ref"');
    expect(workflow).toContain("CHECKOUT_LEGAL_CUTOVER_PROMOTION_SCOPE_INVALID");
    expect(workflow).toContain("checkout-legal-cutover-recovery");
    expect(workflow).toContain('scripts/set-production-deploy-ref.sh "$PROMOTION_SHA"');
    expect(workflow).toContain('TARGET_SHA="$PROMOTION_SHA" scripts/controlled-production-readiness.sh promotion-release.json promotion');
    expect(deploy).toBeGreaterThan(promotion);
    expect(reopen).toBeGreaterThan(deploy);
    expect(finalProof).toBeGreaterThan(reopen);
  });

  it("reuses a durable promotion request without replaying candidate acquire, pause, or promotion creation", () => {
    expect(workflow).toContain("decide-checkout-legal-cutover-recovery.ts");
    expect(workflow).toContain("RESUMING_PROMOTION=1");
    expect(workflow).toContain("DURABLE_PROMOTION_REQUEST_MISMATCH");
    expect(workflow).toContain("DURABLE_PROMOTION_MANIFEST_MISMATCH");
    expect(workflow).toContain('if: env.TERMINAL_COMPLETE != \'1\' && env.RESUMING_PROMOTION != \'1\'');
    expect(workflow).toContain('pnpm exec tsx commerce/src/reconcile-cutover.ts status.json completion.json "$ACTIVE_REQUEST_PATH"');
    expect(workflow).toContain("env.CUTOVER_ACTION == 'DEPLOY_PROMOTION'");
  });

  it("adopts and resumes an exact same-owner pre-publication repair without replaying acquire or pause", () => {
    const pauseProof = workflow.indexOf("Prove public checkout pause before deployment");
    const adoption = workflow.indexOf("Adopt same-owner pre-publication repair expectations");
    const deploy = workflow.indexOf("Set guarded production deployment ref for candidate");
    expect(workflow).toContain("ADOPTING_PREPUBLICATION_REPAIR");
    expect(workflow).toContain("RESUMING_PREPUBLICATION_REPAIR");
    expect(workflow).toContain("REPAIRED_CANDIDATE");
    expect(workflow).toContain("assert-checkout-legal-cutover-repair-boundary.ts");
    expect(workflow).toContain("CHECKOUT_LEGAL_CUTOVER_REPAIR_REQUEST_MISMATCH");
    expect(workflow).toContain('if: env.TERMINAL_COMPLETE != \'1\' && env.RESUMING_PROMOTION != \'1\' && env.PREPUBLICATION_REPAIR != \'1\'');
    expect(workflow).toContain('api -X POST --data-binary @repair-release.json "$PUBLIC_API_URL/v1/internal/release-control/expectations"');
    expect(workflow).toContain('CONTROLLED_DEPLOY_SOURCE_REF="$ACTIVE_CANDIDATE_SOURCE_REF" scripts/set-production-deploy-ref.sh "$ACTIVE_CANDIDATE_SHA"');
    expect(adoption).toBeGreaterThan(pauseProof);
    expect(deploy).toBeGreaterThan(adoption);
  });

  it("keeps repair promotion on the recovery ref while ordinary cutovers retain main guards", () => {
    const candidate = "candidate";
    const mainFont = "main-font";
    const repair = "repair";
    const promotion = "promotion";
    const parent: Record<string, string | undefined> = {
      [mainFont]: candidate,
      [repair]: candidate,
      [promotion]: repair,
    };
    const isAncestor = (ancestor: string, descendant: string): boolean => {
      for (let current: string | undefined = descendant; current; current = parent[current]) if (current === ancestor) return true;
      return false;
    };

    expect(isAncestor(candidate, repair)).toBe(true);
    expect(isAncestor(repair, promotion)).toBe(true);
    expect(isAncestor(mainFont, promotion)).toBe(false);
    expect(workflow).toContain('if [[ "$RECOVERY_SOURCE_LANE" == 1 ]]; then');
    expect(workflow).toContain('git fetch --no-tags origin "$ACTIVE_CANDIDATE_SOURCE_REF"');
    expect(workflow).toContain('git diff --name-only "$ACTIVE_CANDIDATE_SHA..$promotion_base_sha" | grep -Ev \'^(certification\\.sh|commerce/legal/production-manifest\\.json|public/legal/.+)$\'');
    expect(workflow).toContain('git push origin "HEAD:refs/heads/$promotion_ref"');
    expect(workflow).toContain("CHECKOUT_LEGAL_CUTOVER_MAIN_AHEAD_OF_CANDIDATE");
    expect(workflow).toContain("CHECKOUT_LEGAL_CUTOVER_MAIN_DOES_NOT_CONTAIN_CANDIDATE");
  });
});
