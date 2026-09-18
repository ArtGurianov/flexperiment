import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { genericProductionDeployBoundary, releaseSemanticsCategories } from "../src/generic-production-deploy-boundary";

const Q6 = "fa3b4aa5651956bb0a35f7a843e95423f057824b";
const Q7 = "ce66d23fdcea5fc84018be43cf428270ea889ee8";
const Q7_TREE = "1cbcce745d176dc0d15eb0811a34791e58ad9cdc";
const RELEASE = `deploy-${Q7}`;
const ACTIVATION = `agent-referrals-activation-${Q7}`;
const PUBLICATION = "refs/heads/runtime/agent-referrals-activation-http-schema-1";
const CERTIFICATE = `.release/controlled-candidates/agent-referrals-activation-${Q6}/certificate.json`;
const publication = readFileSync(".github/workflows/controlled-agent-referrals-q7-candidate.yml", "utf8");
const deploy = readFileSync(".github/workflows/controlled-agent-referrals-q7-deploy.yml", "utf8");
const activation = readFileSync(".github/workflows/controlled-agent-referrals-q7-activation.yml", "utf8");
const promotion = `${readFileSync(".github/workflows/controlled-runtime-candidate-promotion.yml", "utf8")}\n${readFileSync(".github/actions/controlled-runtime-candidate-promotion/action.yml", "utf8")}`;
const verifier = readFileSync("scripts/release/assert-agent-referrals-q6-activation-evidence.sh", "utf8");
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();

const manualOnly = (source: string) => {
  const trigger = source.slice(source.indexOf("\non:\n"), source.indexOf("\npermissions:"));
  expect(trigger).toContain("workflow_dispatch:");
  for (const automatic of ["push:", "schedule:", "workflow_run:"]) expect(trigger).not.toContain(automatic);
  expect(source).toContain("environment: production");
  expect(source).toContain("group: flexperiment-production-controlled-cutover");
  expect(source).toContain("persist-credentials: false");
};

const assertSemantics = (paths: string[]) => {
  const directory = mkdtempSync(join(tmpdir(), "q7-release-semantics-"));
  const file = join(directory, "paths.bin");
  writeFileSync(file, paths.join("\0"));
  try {
    execFileSync("node", ["--import", "tsx", "commerce/src/assert-release-semantics-cutover-boundary.ts", file], { stdio: "pipe" });
    return true;
  } catch { return false; } finally { rmSync(directory, { recursive: true, force: true }); }
};

describe("Agent Referrals Q7 controller capabilities", () => {
  it("reconstructs the exact one-file detached Q7 candidate", () => {
    const reconstructed = execFileSync("node", ["--import", "tsx", "commerce/src/controlled-candidate-verify.ts", CERTIFICATE, git("rev-parse", "HEAD")], { encoding: "utf8" }).trim();
    expect(reconstructed).toBe(Q7);
    expect(git("rev-parse", `${Q7}^`)).toBe(Q6);
    expect(git("rev-parse", `${Q7}^{tree}`)).toBe(Q7_TREE);
    expect(git("diff", "--name-only", Q6, Q7)).toBe("commerce/src/release-control-schema.ts");
  });

  it("publishes Q7 only by sealed create-only reconstruction", () => {
    manualOnly(publication);
    for (const value of [Q6, Q7, Q7_TREE, PUBLICATION, "expected_controller_sha", "expected_controller_tree", "expected_target_sha"]) expect(publication).toContain(value);
    expect(publication).toContain(`git show "$GITHUB_SHA:.release/controlled-candidates/agent-referrals-activation-$BASE_SHA/certificate.json"`);
    expect(publication).toContain('git merge-base --is-ancestor "$SOURCE_MAIN_SHA" "$GITHUB_SHA"');
    expect(publication).toContain('[[ "$RECONSTRUCTED_SHA" == "$TARGET_SHA"');
    expect(publication).toContain('--force-with-lease="${PUBLISH_REF}:"');
    expect(publication).toContain("AGENT_REFERRALS_Q7_PUBLICATION_SAME_SHA_REPLAY");
    expect(publication).toContain("AGENT_REFERRALS_Q7_PUBLICATION_REF_ALREADY_DIFFERENT_SHA");
    expect(publication).toContain("refs/heads/runtime/agent-referrals-activation-terminal-identity-1");
    expect(publication).toContain("origin/main");
    expect(publication).not.toContain("/agent-referrals/activate");
    expect(publication).not.toContain("set-production-deploy-ref.sh");
    expect(publication).toContain("agent-referrals-q4-dormant-[a-f0-9]{40}");
    expect(publication).toContain("deploy-[a-f0-9]{40}");
  });

  it("keeps generic promotion unchanged and topology-compatible with Q6 to Q7", () => {
    expect(git("merge-base", "--is-ancestor", Q6, Q7)).toBe("");
    expect(promotion).toContain('git merge-base --is-ancestor "$actual_production_deploy" "$INPUT_TARGET_SHA"');
    expect(promotion).toContain('git ls-remote --exit-code origin "$INPUT_EXPECTED_PUBLISHED_REF"');
    expect(promotion).not.toContain("agent-referrals-activation-http-schema-1");
    expect(promotion).not.toContain("q7");
  });

  it("admits exactly Q7's RELEASE_CONTROL semantics while generic production deploy refuses it", () => {
    const delta = ["commerce/src/release-control-schema.ts"];
    expect(genericProductionDeployBoundary(delta)).toBe("RELEASE_SEMANTICS");
    expect(releaseSemanticsCategories(delta)).toEqual(["RELEASE_CONTROL"]);
    expect(assertSemantics(delta)).toBe(true);
    expect(assertSemantics(["commerce/src/release-control-schema.ts", "commerce/src/crypto.ts"])).toBe(false);
    expect(assertSemantics(["commerce/src/release-control-schema.ts", "commerce/migrations/0050_forbidden.sql"])).toBe(false);
    expect(assertSemantics(["commerce/src/release-control-schema.ts", "public/legal/privacy-policy.md"])).toBe(false);
    expect(assertSemantics(["commerce/src/release-control-schema.ts", "release-surface-contract.json"])).toBe(false);
  });

  it("deploys only through exact Q7 reconstruction-bound RELEASE_CONTROL authority", () => {
    manualOnly(deploy);
    for (const value of [Q6, Q7, Q7_TREE, RELEASE, PUBLICATION, "expected_candidate_sha", "expected_controller_sha", "expected_controller_tree", "expected_production_deploy_sha"]) expect(deploy).toContain(value);
    expect(deploy).toContain("pnpm commerce:release-semantics-cutover:assert-boundary q7-boundary-paths.bin");
    expect(deploy).not.toContain("commerce:production-deploy:assert-boundary");
    expect(deploy).not.toContain('merge-base --is-ancestor "$TARGET_SHA" "$CONTROLLER_SHA"');
    expect(deploy).toContain("q6-completion.json");
    expect(deploy).toContain("AGENT_REFERRALS_Q7_Q6_TERMINAL_UNPROVEN");
    expect(deploy).toContain('.runtime.source_commit == $source and .runtime.worker_source_commit == $source');
    expect(deploy).toContain("DEPLOYMENT_STATE=OWNED_NEEDS_DEPLOY");
    expect(deploy).toContain("DEPLOYMENT_STATE=OWNED_CONVERGED");
    expect(deploy).toContain('.expected == ($request[0].expected | del(.legal_hashes))');
    expect(deploy).toContain('scripts/set-production-deploy-ref.sh "$TARGET_SHA" "$INPUT_EXPECTED_PRODUCTION_DEPLOY_SHA"');
    expect(deploy).toContain("AGENT_REFERRALS_Q7_ACTIVATION_EVIDENCE_UNEXPECTED");
    expect(deploy).not.toContain("/agent-referrals/activate");
    expect(deploy).toContain('"$PUBLIC_API_URL/healthz"');
    expect(deploy).toContain('"$PUBLIC_API_URL/readyz"');
    for (const prerequisite of ["POLL_ATTEMPTS: \"30\"", "POLL_SECONDS: \"10\"", "CHECKOUT_CONTRACT_VERSION=", "ADMIN_CONTRACT_VERSION="]) expect(deploy).toContain(prerequisite);
    const readinessInputs = deploy.indexOf("Materialize exact Q7 surface-contract readiness inputs");
    const firstReadiness = deploy.indexOf("scripts/controlled-production-readiness.sh");
    expect(readinessInputs).toBeGreaterThan(-1);
    expect(readinessInputs).toBeLessThan(firstReadiness);
    const rebind = deploy.slice(deploy.indexOf("Rebind same-owner authority"), deploy.indexOf("Deploy exact Q7"));
    expect(rebind).toContain("status-before-consequence.json");
    expect(rebind).not.toContain("runtime-candidate");
    expect(rebind.indexOf("status-before-consequence.json")).toBeLessThan(rebind.indexOf("set-production-deploy-ref.sh"));
  });

  it("issues one Q7 activation POST at most and reconciles authoritative ACTIVE, NO_COMMIT, or anomaly evidence", () => {
    manualOnly(activation);
    for (const value of [Q7, RELEASE, ACTIVATION, PUBLICATION, "expected_feature_revision"]) expect(activation).toContain(value);
    expect(activation.match(/-X POST --data-binary @activation-request\.json/g)).toHaveLength(1);
    expect(activation).toContain("AGENT_REFERRALS_Q7_ACTIVATION_REFUSED_CODE=");
    expect(activation).toContain("AGENT_REFERRALS_Q7_ACTIVATION_NO_COMMIT");
    expect(activation).toContain("AGENT_REFERRALS_Q7_ACTIVATION_RECONCILIATION_ANOMALY");
    expect(activation).toContain("AGENT_REFERRALS_Q7_ACTIVATION_RECONCILED_ACTIVE");
    expect(activation).toContain("ACTIVATION_MODE=EXACT_REPLAY");
    expect(activation).toContain("completion-after.json");
    expect(activation).not.toContain("agent-referrals-q4-dormant-");
    expect(activation).not.toContain("git push");
    expect(activation).not.toContain("/reopen");
    expect(activation).not.toContain("/complete");
    expect(verifier).not.toContain(Q6);
    expect(verifier).toContain("activation_id");
    expect(verifier).toContain("terminal_release_id");
    expect(verifier).toContain("otp_delivery_provider");
  });
});
