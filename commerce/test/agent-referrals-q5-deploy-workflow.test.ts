import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const Q4 = "e0cf268496660dade2db3fa43b189682d059c25c";
const Q5 = "b153ed226770a947cdbf9cd83e1a9c1181b7cf6f";
const Q5_TREE = "4b8a9b16299e4f57add486453e51f9855ac7df93";
const workflow = readFileSync(".github/workflows/controlled-agent-referrals-q5-deploy.yml", "utf8");

describe("Agent Referrals Q5 reconstruction-bound deployment controller", () => {
  it("is manual, production-gated, serialized, and cannot activate the feature", () => {
    const trigger = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\npermissions:"));
    expect(trigger).toContain("workflow_dispatch:");
    for (const automatic of ["push:", "schedule:", "workflow_run:"]) expect(trigger).not.toContain(automatic);
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("group: flexperiment-production-controlled-cutover");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).not.toContain("/agent-referrals/activate");
    expect(workflow).not.toContain("complete-rolling");
  });

  it("positively reconstructs exact Q5 from the exact controller certificate", () => {
    for (const value of [Q4, Q5, Q5_TREE]) expect(workflow).toContain(value);
    expect(workflow).toContain('git show "$GITHUB_SHA:.release/controlled-candidates/agent-referrals-activation-$BASE_SHA/certificate.json" > candidate-certificate.json');
    expect(workflow).toContain('SOURCE_MAIN_SHA="$(jq -er \'.source_main_sha\' candidate-certificate.json)"');
    expect(workflow).toContain('git merge-base --is-ancestor "$SOURCE_MAIN_SHA" "$GITHUB_SHA"');
    expect(workflow).toContain(".base_sha == $base");
    expect(workflow).toContain('controlled-candidate-verify.ts candidate-certificate.json "$GITHUB_SHA"');
    expect(workflow).toContain('[[ "$RECONSTRUCTED_SHA" == "$TARGET_SHA" ]]');
    expect(workflow).toContain('"$(git rev-parse "${RECONSTRUCTED_SHA}^")" == "$BASE_SHA"');
    expect(workflow).toContain('"$(git rev-parse "${RECONSTRUCTED_SHA}^{tree}")" == "$TARGET_TREE"');
    expect(workflow).toContain("diff certified-manifest.txt actual-changed-paths.txt");
  });

  it("uses generic admission but no generic ancestry exemption", () => {
    expect(workflow).toContain("pnpm commerce:production-deploy:assert-boundary q5-boundary-paths.bin");
    expect(workflow).not.toContain('merge-base --is-ancestor "$TARGET_SHA" "$CONTROLLER_SHA"');
    for (const forbidden of ["commerce/migrations/", "public/legal/", "commerce/legal/", "\\.github/workflows/"]) expect(workflow).toContain(forbidden);
  });

  it("admits the actual certified Q4 to Q5 range through the existing generic boundary", () => {
    const paths = execFileSync("git", ["diff", "--name-only", "-z", Q4, Q5], { encoding: "buffer" });
    const input = join(mkdtempSync(join(tmpdir(), "q5-boundary-")), "paths.bin");
    writeFileSync(input, paths);
    expect(() => execFileSync("node", ["--import", "tsx", "commerce/src/assert-generic-production-deploy-boundary.ts", input], { stdio: "pipe" })).not.toThrow();
  });

  it("seals ordinary authority immediately before acquire and leases only from Q4", () => {
    for (const input of ["expected_candidate_sha", "expected_controller_sha", "expected_controller_tree", "expected_production_deploy_sha"]) expect(workflow).toContain(input);
    const acquire = workflow.slice(workflow.indexOf("- name: Acquire Q5 owner"), workflow.indexOf("- name: Prove public checkout pause"));
    for (const assertion of ["CONTROLLER_SHA" , "INPUT_EXPECTED_CONTROLLER_TREE", "origin/main", "origin/runtime-candidate", "read-production-deploy-ref.sh"]) expect(acquire).toContain(assertion);
    expect(acquire.indexOf("read-production-deploy-ref.sh")).toBeLessThan(acquire.indexOf('/v1/internal/release-control/acquire'));
    expect(workflow).toContain('scripts/set-production-deploy-ref.sh "$TARGET_SHA" "$INPUT_EXPECTED_PRODUCTION_DEPLOY_SHA"');
  });

  it("derives mandatory readiness inputs and reproves all terminal surfaces", () => {
    expect(workflow).toContain('git show "$TARGET_SHA:release-surface-contract.json"');
    for (const value of ["CHECKOUT_CONTRACT_VERSION", "ADMIN_CONTRACT_VERSION", "POLL_ATTEMPTS", "POLL_SECONDS"]) expect(workflow).toContain(value);
    expect(workflow.indexOf("Materialize exact Q5 surface-contract readiness inputs")).toBeLessThan(workflow.indexOf("controlled-production-readiness.sh"));
    for (const value of ["terminal-status.json", "terminal-completion.json", "terminal-legal.json", "$PUBLIC_FRONTEND_URL/release.json", "$ADMIN_RELEASE_URL", "$PUBLIC_API_URL/healthz", "$PUBLIC_API_URL/readyz"]) expect(workflow).toContain(value);
  });

  it("keeps same-owner recovery reachable without rereading movable runtime-candidate", () => {
    expect(workflow).toContain("DEPLOYMENT_STATE=OWNED_PRE_CAS");
    expect(workflow).toContain("DEPLOYMENT_STATE=OWNED_NEEDS_DEPLOY");
    expect(workflow).toContain("DEPLOYMENT_STATE=OWNED_CONVERGED");
    const cas = workflow.slice(workflow.indexOf("- name: Rebind same-owner authority"), workflow.indexOf("- name: Deploy exact Q5"));
    expect(cas).not.toContain("runtime-candidate");
    expect(cas).toContain("CONTROLLER_SHA");
    const deploy = workflow.slice(workflow.indexOf("- name: Deploy exact Q5"), workflow.indexOf("- name: Prove already-converged Q5"));
    expect(deploy).toContain("OWNED_NEEDS_DEPLOY");
    expect(deploy).not.toContain("OWNED_CONVERGED");
    expect(workflow).toContain('.runtime.source_commit == $target and .runtime.worker_source_commit == $target');
  });

  it("binds the full frozen owner expectation at classification and immediately before continuation", () => {
    const projection = '.expected == ($request[0].expected | del(.legal_hashes))';
    expect(workflow.match(/\.expected == \(\$request\[0\]\.expected \| del\(\.legal_hashes\)\)/g)).toHaveLength(2);
    expect(workflow).toContain(projection);
    const rebind = workflow.slice(workflow.indexOf("- name: Rebind same-owner authority"), workflow.indexOf("- name: Deploy exact Q5"));
    expect(rebind).toContain('api "$PUBLIC_API_URL/v1/internal/release-control/status" > status-before-consequence.json');
    expect(rebind).toContain("AGENT_REFERRALS_Q5_HELD_OWNER_CHANGED");
    expect(rebind.indexOf("status-before-consequence.json")).toBeLessThan(rebind.indexOf("set-production-deploy-ref.sh"));
  });
});
