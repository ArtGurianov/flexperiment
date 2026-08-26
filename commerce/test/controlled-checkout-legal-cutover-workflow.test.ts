import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/controlled-checkout-legal-cutover.yml", "utf8");

describe("controlled anonymous checkout legal cutover workflow", () => {
  it("is a manual candidate-pinned workflow under the shared production lock", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("target_sha:");
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
    expect(workflow).toContain('"$TARGET_SHA" "$PREVIOUS_LEGAL_VERSION" > reconciliation.json');
    expect(workflow).toContain("CHECKOUT_LEGAL_CUTOVER_BLOCKED_BY_RELEASE_OWNER");
  });

  it("proves the public pause before candidate deployment and legal publication", () => {
    const pauseProof = workflow.indexOf("Prove public checkout pause before deployment");
    const candidateDeploy = workflow.indexOf("Deploy candidate to Commerce Worker Frontend and Admin");
    const publish = workflow.indexOf("Publish candidate legal release");
    expect(pauseProof).toBeGreaterThan(workflow.indexOf("Acquire owner and pause registrations"));
    expect(pauseProof).toBeLessThan(candidateDeploy);
    expect(workflow).toContain("SALES_TEMPORARILY_PAUSED");
    expect(workflow).toContain('scripts/controlled-production-readiness.sh release.json candidate-pre-publication');
    expect(publish).toBeGreaterThan(workflow.indexOf("Prove candidate before legal publication"));
    expect(workflow).toContain("PREVIOUS_LEGAL_VERSION: 2026-08-25.1");
    expect(workflow).toContain("CANDIDATE_LEGAL_VERSION: 2026-08-26.1");
  });

  it("creates a guarded immutable promotion, deploys it, then reopens only after fresh evidence", () => {
    const promotion = workflow.indexOf("Create or recover immutable legal promotion artifact");
    const deploy = workflow.indexOf("Deploy promotion artifact to Commerce Worker Frontend and Admin");
    const reopen = workflow.indexOf('release-control/reopen" > reopened.json');
    const finalProof = workflow.indexOf("Verify durable completion and every post-reopen surface");
    expect(workflow).toContain("git push origin HEAD:refs/heads/main");
    expect(workflow).toContain("CHECKOUT_LEGAL_CUTOVER_PROMOTION_SCOPE_INVALID");
    expect(workflow).toContain('scripts/set-production-deploy-ref.sh "$PROMOTION_SHA"');
    expect(workflow).toContain('TARGET_SHA="$PROMOTION_SHA" scripts/controlled-production-readiness.sh promotion-release.json promotion');
    expect(deploy).toBeGreaterThan(promotion);
    expect(reopen).toBeGreaterThan(deploy);
    expect(finalProof).toBeGreaterThan(reopen);
  });
});
