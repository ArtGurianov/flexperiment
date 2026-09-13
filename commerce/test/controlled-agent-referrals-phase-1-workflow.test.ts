import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

const WORKFLOW = ".github/workflows/controlled-agent-referrals-phase-1-deploy.yml";
const source = readFileSync(WORKFLOW, "utf8");
const RUNBOOK = readFileSync("docs/release/AGENT_REFERRALS_PHASE_1_RUNBOOK.md", "utf8");

const BASE = "2ae6a351669d2cc9d8cd42cf92d50436d64d08cd";
const TARGET = "1d7310883f4822945725a6ba95d7ff37a470f502";
const TARGET_TREE = "b53cdd72fdae633ad26ea5871d7b7b4f4d440342";
const RANGE = "b4e350f4ba6ecbaf110461dd5356c2293b3e5c2b 64b1c598f1525f7eece32f49cfc63146a2892067 1d7310883f4822945725a6ba95d7ff37a470f502";
const MIGRATION_SHA256 = "c8f711ace8ebf169fb492aa4b3cd5c745f98a8ed9be03ff1cf76d1ef6a184637";

const stepAt = (name: string) => source.indexOf(`      - name: ${name}`);

/**
 * Read from the workflow rather than injected by the test: otherwise the
 * harness could supply 75 while the controller declared something weaker, and
 * the executed proof would be about the harness instead of the controller.
 */
const declaredRetryableExit = (): string => {
  const match = /^ {6}READINESS_EXIT_CONVERGENCE: "(\d+)"$/m.exec(source);
  expect(match, "the controller must declare its retryable exit code").not.toBeNull();
  return match![1];
};

/** The literal shell of one step, dedented, so it can be executed as written. */
const stepBody = (name: string): string => {
  const start = stepAt(name);
  expect(start, `step not found: ${name}`).toBeGreaterThan(-1);
  const rest = source.slice(start);
  const end = rest.indexOf("\n      - name: ", 1);
  const block = end === -1 ? rest : rest.slice(0, end);
  const run = block.indexOf("        run: |\n");
  expect(run, `step has no run block: ${name}`).toBeGreaterThan(-1);
  return block.slice(run + "        run: |\n".length).split("\n").map((line) => line.replace(/^ {10}/, "")).join("\n");
};

describe("controlled Agent Referrals Phase 1 deploy", () => {
  it("is manual-only and binds the reviewed candidate without deriving it", () => {
    expect(source).toContain("workflow_dispatch:");
    expect(source).not.toMatch(/^\s*push:/m);
    expect(source).toContain(`BASE_SHA: ${BASE}`);
    expect(source).toContain(`EXPECTED_TARGET_SHA: ${TARGET}`);
    expect(source).toContain('TARGET_SHA: ${{ inputs.target_sha }}');
    expect(source).toContain('[[ "$TARGET_SHA" == "$EXPECTED_TARGET_SHA" ]]');
    expect(source).toContain(`EXPECTED_TARGET_TREE: ${TARGET_TREE}`);
    expect(source).toContain('[[ "$TARGET_TREE" == "$EXPECTED_TARGET_TREE" ]]');
    expect(source).toContain('[[ "$(git rev-parse "${TARGET_SHA}^{tree}")" == "$TARGET_TREE" ]]');
    // Q2 is no longer BASE's direct child: a governed CONTROL_PLANE commit
    // landed between the candidate and its cutover, which is expected.
    expect(source).not.toContain('"${TARGET_SHA}^")" == "$BASE_SHA"');
    expect(source).not.toContain('TARGET_SHA="$(git rev-parse HEAD)"');
  });

  it("does not require the target to be main's tip, and claims no ancestry waiver", () => {
    // Q is an ancestor of main, not its tip. Requiring equality would force a
    // pointless re-cut every time governed CONTROL_PLANE work merges.
    expect(source).not.toContain('[[ "$TARGET_SHA" == "$(git rev-parse origin/main)" ]]');
    expect(source).toContain('git merge-base --is-ancestor "$TARGET_SHA" "$(git rev-parse origin/main)"');
    // Ordinary lineage: descent from BASE is asserted, never waived.
    expect(source).toContain('git merge-base --is-ancestor "$BASE_SHA" "$TARGET_SHA"');
    expect(source).toContain('git rev-list --min-parents=2 "$BASE_SHA".."$TARGET_SHA"');
    expect(source).toContain(".release/maintenance-only");
    // The range is asserted as an exact sequence. A count of 3 would admit any
    // three commits; only these three were reviewed.
    expect(source).toContain(`EXPECTED_RANGE: "${RANGE}"`);
    expect(source).toContain('[[ "$actual_range" == "$EXPECTED_RANGE" ]]');
    expect(source).toContain("PHASE_1_RANGE_NOT_REVIEWED_SEQUENCE");
    // ANCESTRY_BOUND, in the exact shape controller-not-older-than-target.test.ts requires.
    expect(source).toContain('git merge-base --is-ancestor "$TARGET_SHA" "$CONTROLLER_SHA" || { echo "PHASE_1_CONTROLLER_OLDER_THAN_TARGET" >&2; exit 1; }');
  });

  it("proves every excluded boundary class independently of the classifier's first verdict", () => {
    for (const code of [
      "PHASE_1_LEGAL_CHANGED",
      "PHASE_1_SURFACE_CONTRACT_CHANGED",
      "PHASE_1_COMPATIBILITY_CHANGED",
      "PHASE_1_RELEASE_SEMANTICS_CHANGED",
      "PHASE_1_BOUNDARY_NOT_SCHEMA",
      "PHASE_1_UNEXPECTED_SCHEMA_DELTA",
    ]) expect(source).toContain(code);
    expect(source).toContain('EXPECTED_MIGRATION: 0058_agents_legal_identity_cleanup.sql');
    // Naming the file is not enough: its bytes carry the in-transaction gates.
    expect(source).toContain(`EXPECTED_MIGRATION_SHA256: ${MIGRATION_SHA256}`);
    expect(source).toContain("PHASE_1_MIGRATION_BYTES_NOT_REVIEWED");
    expect(source).toContain(`printf 'A\\t%s\\n' "commerce/migrations/$EXPECTED_MIGRATION"`);
    // The applied set changes, so the expectation is computed from TARGET.
    expect(source).toContain('git ls-tree -r --name-only "$TARGET_SHA" -- commerce/migrations');
    expect(source).toContain("inventory-sha256:");
  });

  it("treats the operator gate inputs as provenance, never as the cutover authority", () => {
    const gates = stepBody("Require the Gate 1/2 preflight provenance");
    expect(gates).toContain("Provenance, not authority");
    expect(RUNBOOK).toContain("operator Gate 1/2 query        = required preflight provenance");
    expect(RUNBOOK).toContain("0058 in-transaction guards     = cutover authority");
    expect(RUNBOOK).toContain("## If a guard refuses");
  });

  it("refuses any gate evidence that is not a literal zero-row production proof", () => {
    expect(source).toContain("gate_shape='^rows=0;[^;]+;[^;]+$'");
    expect(source).toContain("PHASE_1_GATE_1_EVIDENCE_NOT_ZERO");
    expect(source).toContain("PHASE_1_GATE_2_EVIDENCE_NOT_ZERO");
    expect(source).toContain("PHASE_1_BASE_INTEGRITY_EVIDENCE_REQUIRED");
    // The controller must not contain a repair path for a failed gate.
    const gates = stepBody("Require the Gate 1/2 preflight provenance");
    expect(gates).not.toMatch(/UPDATE |INSERT |DELETE |backfill/i);
  });

  it("runs both gates before anything that can affect production", () => {
    const gates = stepAt("Require the Gate 1/2 preflight provenance");
    expect(gates).toBeGreaterThan(-1);
    for (const effect of [
      "Acquire owner",
      "Pause sales",
      "Rebind same-owner authority and guard production pointer CAS",
      "Deploy exact TARGET and prove readiness",
      "Reopen and prove terminal completion",
    ]) expect(stepAt(effect), `${effect} must follow the gates`).toBeGreaterThan(gates);
    // And before the boundary proof? No - static proofs come first by design.
    expect(gates).toBeGreaterThan(stepAt("Prove the crossed boundary is SCHEMA and exactly the Phase 1 migration"));
    expect(gates).toBeGreaterThan(stepAt("Bind the exact Phase 1 candidate"));
  });

  it("never reads the runtime-candidate pointer after acquiring the owner", () => {
    // The pointer is a proposal register: it may be read once, inside the
    // acquire step, and never again - after acquire the durable owner is
    // authoritative and the pointer is free to move.
    expect(stepBody("Acquire owner")).toContain("origin/runtime-candidate");
    expect(source.slice(stepAt("Pause sales"))).not.toContain("runtime-candidate");
  });

  it("publishes the same gate SQL the runbook and the gate test share", () => {
    expect(RUNBOOK).toContain("settlement_flow IS NOT 'AGENT_REFERRALS'");
    expect(RUNBOOK).toContain("pi.destroyed_at IS NULL");
    expect(RUNBOOK).toContain("rows=0;<UTC timestamp>;<immutable evidence reference>");
  });
});

/**
 * The retry boundary is executed, not read. The real step body is extracted
 * from the workflow and run with fake scripts on PATH, so what is proved is
 * the controller's behaviour for each readiness exit code - not its wording.
 */
describe("Phase 1 readiness retry boundary (executed)", () => {
  const temporary: string[] = [];
  afterEach(() => { while (temporary.length) rmSync(temporary.pop()!, { recursive: true, force: true }); });

  const runDeployStep = ({ readinessExit, deploymentState = "FRESH" }: { readinessExit: number; deploymentState?: string; pollAttempts?: string }) => {
    const directory = mkdtempSync(join(tmpdir(), "flexperiment-phase1-retry-"));
    temporary.push(directory);
    const scripts = join(directory, "scripts");
    mkdirSync(scripts);
    const deployLog = join(directory, "deploy.log");
    const readinessLog = join(directory, "readiness.log");
    writeFileSync(deployLog, ""); writeFileSync(readinessLog, "");
    writeFileSync(join(scripts, "controlled-coolify-deploy.sh"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$1" >> "${deployLog}"\nexit 0\n`);
    writeFileSync(join(scripts, "controlled-production-readiness.sh"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$1" >> "${readinessLog}"\nexit ${readinessExit}\n`);
    chmodSync(join(scripts, "controlled-coolify-deploy.sh"), 0o755);
    chmodSync(join(scripts, "controlled-production-readiness.sh"), 0o755);
    writeFileSync(join(directory, "release.json"), "{}");
    const body = join(directory, "step.sh");
    writeFileSync(body, stepBody("Deploy exact TARGET and prove readiness"));
    const result = spawnSync("bash", [body], {
      cwd: directory, encoding: "utf8",
      env: { ...process.env, DEPLOYMENT_STATE: deploymentState, TARGET_SHA: TARGET, READINESS_EXIT_CONVERGENCE: declaredRetryableExit() },
    });
    const lines = (path: string) => readFileSync(path, "utf8").split("\n").filter(Boolean);
    const deployed = lines(deployLog);
    return { result, deploys: deployed.length, deployedShas: deployed, readinessRuns: lines(readinessLog).length };
  };

  it("admits on 0 with a single deployment and no retry", () => {
    const { result, deploys, readinessRuns } = runDeployStep({ readinessExit: 0 });
    expect(result.status, result.stderr).toBe(0);
    expect(deploys).toBe(1);
    expect(readinessRuns).toBe(1);
  });

  it("declares EX_TEMPFAIL, not a code shell can produce by accident", () => {
    expect(declaredRetryableExit(), "1 is what `set -e` yields for any unexpected failure").toBe("75");
  });

  it("retries exactly once on 75, the only retryable code", () => {
    const { result, deploys, readinessRuns } = runDeployStep({ readinessExit: 75 });
    // The fake never converges, so the retried readiness also fails: what is
    // being proved is that the retry path was reached, exactly once.
    expect(deploys, "initial deployment plus one retry").toBe(2);
    expect(readinessRuns).toBe(2);
    expect(result.status).not.toBe(0);
  });

  it.each([1, 2, 3, 42])("treats exit %i as terminal and never re-fires a deployment", (code) => {
    const { result, deploys, readinessRuns } = runDeployStep({ readinessExit: code });
    expect(deploys, `exit ${code} must not authorise a second deployment`).toBe(1);
    expect(readinessRuns).toBe(1);
    expect(result.status).toBe(code);
    expect(result.stderr).toContain(`PHASE_1_READINESS_TERMINAL: exit ${code}`);
  });

  /**
   * A candidate refused by 0058's own Gate 1/2 guards cannot boot, so it looks
   * exactly like a surface that never converged and comes back as 75. That is
   * deliberate: 75 means "deployment failed to converge" and nothing else.
   * What must never follow is a schema-failure branch, a waiver, or an
   * automatic redeploy of BASE - recovery is a separate controlled act.
   */
  it("gives a gate-refused candidate no special path: one bounded retry of TARGET, never BASE", () => {
    const { result, deploys, deployedShas, readinessRuns } = runDeployStep({ readinessExit: 75, pollAttempts: "5" });
    expect(deploys, "initial deployment plus exactly one bounded retry").toBe(2);
    expect(readinessRuns).toBe(2);
    // Every deployment this controller can fire names TARGET. BASE never appears.
    expect(new Set(deployedShas)).toEqual(new Set([TARGET]));
    expect(deployedShas).not.toContain(BASE);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("PHASE_1_CANDIDATE_NOT_CONVERGED_AFTER_ONE_RETRY");
  });

  it("has no schema-failure branch, waiver input, or BASE redeploy anywhere in the controller", () => {
    expect(source).not.toContain('controlled-coolify-deploy.sh "$BASE_SHA"');
    expect(source).not.toMatch(/PHASE_1_GATE_[12]_[A-Z_]*(WAIVE|OVERRIDE|SKIP|FORCE)/);
    expect(source).not.toMatch(/inputs\.[a-z_]*(waiver|override|force|skip)/);
    // The controller cannot observe *why* a candidate failed to converge, and
    // must not pretend otherwise by branching on migration or gate codes.
    const deploy = stepBody("Deploy exact TARGET and prove readiness");
    expect(deploy).not.toMatch(/PHASE_1_GATE_|LEGACY_SETTLEMENTS_PRESENT|UNBOUND_LEGACY_AGENT|MIGRATION_/);
  });

  it("fires no initial deployment for an already-converged owner, and still retries only on 75", () => {
    const converged = runDeployStep({ readinessExit: 0, deploymentState: "OWNED_CONVERGED" });
    expect(converged.deploys, "a converged runtime is not redeployed").toBe(0);
    expect(converged.result.status).toBe(0);

    const stale = runDeployStep({ readinessExit: 75, deploymentState: "OWNED_CONVERGED" });
    expect(stale.deploys, "one repair deployment once surfaces never converged").toBe(1);

    const refused = runDeployStep({ readinessExit: 3, deploymentState: "OWNED_CONVERGED" });
    expect(refused.deploys, "a refused admission never redeploys").toBe(0);
    expect(refused.result.status).toBe(3);
  });
});
