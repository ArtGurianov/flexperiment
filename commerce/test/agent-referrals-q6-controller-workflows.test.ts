import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const Q5 = "b153ed226770a947cdbf9cd83e1a9c1181b7cf6f";
const Q6 = "fa3b4aa5651956bb0a35f7a843e95423f057824b";
const Q6_TREE = "0873139704a64c30bded58f10361c007473ac227";
const RELEASE_ID = `deploy-${Q6}`;
const ACTIVATION_ID = `agent-referrals-activation-${Q6}`;
const PUBLICATION_REF = "refs/heads/runtime/agent-referrals-activation-terminal-identity-1";
const certificate = ".release/controlled-candidates/agent-referrals-activation-b153ed226770a947cdbf9cd83e1a9c1181b7cf6f/certificate.json";
const publication = readFileSync(".github/workflows/controlled-agent-referrals-q6-candidate.yml", "utf8");
const deploy = readFileSync(".github/workflows/controlled-agent-referrals-q6-deploy.yml", "utf8");
const activation = readFileSync(".github/workflows/controlled-agent-referrals-activation.yml", "utf8");
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();

const manualOnly = (workflow: string) => {
  const trigger = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\npermissions:"));
  expect(trigger).toContain("workflow_dispatch:");
  for (const automatic of ["push:", "schedule:", "workflow_run:"]) expect(trigger).not.toContain(automatic);
  expect(workflow).toContain("environment: production");
  expect(workflow).toContain("group: flexperiment-production-controlled-cutover");
  expect(workflow).toContain("persist-credentials: false");
};

describe("Agent Referrals Q6 controller capabilities", () => {
  it("reconstructs the exact one-file Q6 candidate from this controller tree", () => {
    const reconstructed = execFileSync("node", ["--import", "tsx", "commerce/src/controlled-candidate-verify.ts", certificate, git("rev-parse", "HEAD")], { encoding: "utf8" }).trim();
    expect(reconstructed).toBe(Q6);
    expect(git("rev-parse", `${Q6}^`)).toBe(Q5);
    expect(git("rev-parse", `${Q6}^{tree}`)).toBe(Q6_TREE);
    expect(git("diff", "--name-only", Q5, Q6)).toBe("commerce/src/agent-referrals-activation-readiness.ts");
  });

  it("makes publication immutable, sealed, and limited to its single Q6 ref", () => {
    manualOnly(publication);
    for (const value of [Q5, Q6, Q6_TREE, PUBLICATION_REF, "expected_controller_sha", "expected_controller_tree", "expected_target_sha"]) expect(publication).toContain(value);
    expect(publication).toContain('git show "$GITHUB_SHA:.release/controlled-candidates/agent-referrals-activation-$BASE_SHA/certificate.json" > candidate-certificate.json');
    expect(publication).toContain('git merge-base --is-ancestor "$SOURCE_MAIN_SHA" "$GITHUB_SHA"');
    expect(publication).toContain('[[ "$RECONSTRUCTED_SHA" == "$Q6_SHA" && "$RECONSTRUCTED_SHA" == "$TARGET_SHA" ]]');
    expect(publication).toContain('--force-with-lease="${PUBLISH_REF}:"');
    expect(publication).toContain("AGENT_REFERRALS_Q6_PUBLICATION_REF_ALREADY_DIFFERENT_SHA");
    expect(publication).toContain("AGENT_REFERRALS_Q6_PUBLICATION_SAME_SHA_REPLAY");
    expect(publication).toContain("AGENT_REFERRALS_Q5_CANDIDATE_REF_TOKEN");
    expect(publication).not.toContain("/agent-referrals/activate");
    expect(publication).not.toContain("set-production-deploy-ref.sh");
    const mutation = publication.slice(publication.indexOf("Create or reconcile"), publication.indexOf("Read back immutable"));
    for (const binding of ["EXPECTED_CONTROLLER_SHA", "EXPECTED_CONTROLLER_TREE", "origin/main", "OBSERVED_PRODUCTION", "OBSERVED_CANDIDATE", "OBSERVED_Q5"]) expect(mutation).toContain(binding);
    expect(mutation.indexOf("origin/main")).toBeLessThan(mutation.indexOf("git push"));
  });

  it("registers a Q5-to-Q6 reconstruction-bound deploy without weakening generic deploy", () => {
    manualOnly(deploy);
    for (const value of [Q5, Q6, Q6_TREE, RELEASE_ID, "expected_published_ref"]) expect(deploy).toContain(value);
    expect(deploy).toContain('git show "$GITHUB_SHA:.release/controlled-candidates/agent-referrals-activation-$BASE_SHA/certificate.json" > candidate-certificate.json');
    expect(deploy).toContain('git merge-base --is-ancestor "$SOURCE_MAIN_SHA" "$GITHUB_SHA"');
    expect(deploy).toContain('[[ "$RECONSTRUCTED_SHA" == "$TARGET_SHA"');
    expect(deploy).toContain("pnpm commerce:production-deploy:assert-boundary q6-boundary-paths.bin");
    expect(deploy).not.toContain('merge-base --is-ancestor "$TARGET_SHA" "$CONTROLLER_SHA"');
    expect(deploy).toContain('scripts/set-production-deploy-ref.sh "$TARGET_SHA" "$INPUT_EXPECTED_PRODUCTION_DEPLOY_SHA"');
    expect(deploy).toContain("DEPLOYMENT_STATE=OWNED_NEEDS_DEPLOY");
    expect(deploy).toContain("DEPLOYMENT_STATE=OWNED_CONVERGED");
    expect(deploy).toContain("AGENT_REFERRALS_Q6_HELD_OWNER_CHANGED");
    expect(deploy).toContain('.expected == ($request[0].expected | del(.legal_hashes))');
    expect(deploy).toContain("AGENT_REFERRALS_Q6_ACTIVATION_STATE_UNEXPECTED");
    expect(deploy).not.toContain("/agent-referrals/activate");
    const rebind = deploy.slice(deploy.indexOf("Rebind same-owner authority"), deploy.indexOf("Deploy exact Q6"));
    expect(rebind).toContain("status-before-consequence.json");
    expect(rebind).toContain("activation-before-consequence.json");
    expect(rebind).not.toContain("runtime-candidate");
    expect(rebind.indexOf("status-before-consequence.json")).toBeLessThan(rebind.indexOf("set-production-deploy-ref.sh"));
  });

  it("uses one activation POST at most and always reconciles exact Q6 evidence", () => {
    manualOnly(activation);
    for (const value of [Q6, RELEASE_ID, ACTIVATION_ID, "expected_q6_publication_ref", "expected_feature_revision"]) expect(activation).toContain(value);
    expect(activation).toContain("ACTIVATION_MODE=FRESH");
    expect(activation).toContain("ACTIVATION_MODE=EXACT_REPLAY");
    expect(activation).toContain("if: env.ACTIVATION_MODE == 'FRESH'");
    expect(activation.match(/-X POST --data-binary @activation-request\.json/g)).toHaveLength(1);
    expect(activation).toContain("AGENT_REFERRALS_ACTIVATION_OUTCOME_UNKNOWN");
    expect(activation).toContain("/agent-referrals/activation-state");
    expect(activation).not.toContain("agent-referrals-q4-dormant-");
    expect(activation).not.toContain("git push");
    expect(activation).not.toContain("set-production-deploy-ref.sh");
    expect(activation).not.toContain("/reopen");
    expect(activation).not.toContain("/complete");
    const post = activation.slice(activation.indexOf("Rebind authority"), activation.indexOf("Reconcile exact Q6"));
    for (const binding of ["EXPECTED_CONTROLLER_SHA", "EXPECTED_CONTROLLER_TREE", "origin/main", "origin/runtime-candidate", "completion-before-post.json", "activation-before-post.json"]) expect(post).toContain(binding);
    expect(post.indexOf("activation-before-post.json")).toBeLessThan(post.indexOf("git fetch --no-tags origin refs/heads/main:refs/remotes/origin/main runtime-candidate"));
    expect(post.lastIndexOf("git fetch --no-tags origin refs/heads/main:refs/remotes/origin/main runtime-candidate")).toBeLessThan(post.indexOf("-X POST"));
  });
});
