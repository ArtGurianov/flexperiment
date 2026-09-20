import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Properties, not text. The old suite asserted that workflow files contained
 * particular shell snippets, which made it a second copy of the YAML that broke
 * on every reformat and proved nothing about behaviour. These properties are the
 * ones whose absence is a production incident rather than a diff.
 */
type Workflow = {
  on: { workflow_dispatch?: { inputs?: Record<string, { type?: string; options?: string[] }> } };
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs: Record<string, { environment?: string; steps?: { run?: string; uses?: string }[] }>;
};

const workflow = (name: string) => parse(readFileSync(`.github/workflows/${name}`, "utf8")) as Workflow;
const inputsOf = (name: string) => workflow(name).on.workflow_dispatch?.inputs ?? {};
const scriptOf = (name: string) =>
  Object.values(workflow(name).jobs).flatMap((job) => job.steps ?? []).map((step) => step.run ?? "").join("\n");

const deployments = ["deploy-production.yml", "release-candidate.yml"] as const;

describe("production workflow contract", () => {
  it.each(deployments)("%s runs only behind the production environment gate", (name) => {
    for (const job of Object.values(workflow(name).jobs)) expect(job.environment).toBe("production");
  });

  it.each(deployments)("%s is dispatch-only and never triggered by a push", (name) => {
    expect(Object.keys(workflow(name).on)).toEqual(["workflow_dispatch"]);
  });

  it.each(deployments)("%s serialises and must not be cancelled mid-flight", (name) => {
    // A cancelled deploy is exactly how production is left half-switched, which
    // is the state the whole recovery contract exists to avoid creating.
    expect(workflow(name).concurrency?.group).toBeTruthy();
    expect(workflow(name).concurrency?.["cancel-in-progress"]).toBe(false);
  });

  it.each(deployments)("%s never interpolates an input into a shell script", (name) => {
    // A `${{ }}` expression is substituted into the script text before bash
    // runs it, so a crafted dispatch input escapes its own quoting however it
    // is quoted. Inputs reach the shell through `env` or not at all.
    const steps = Object.values(workflow(name).jobs).flatMap((job) => job.steps ?? []);
    for (const step of steps) expect(step.run ?? "").not.toMatch(/\$\{\{\s*(inputs|github\.event)\./);
  });

  it("deploys a candidate identity and nothing else", () => {
    // A deploy that could still be handed a commit would be a second way to say
    // what is being released, and the two could disagree. The commit, the class
    // and the readiness expectation all travel inside the candidate.
    expect(Object.keys(inputsOf("deploy-production.yml"))).toEqual(["candidate"]);
  });

  it("gives no operator a way to choose the deploy mode", () => {
    // Closing sales is a consequence of how a candidate was classified, never a
    // dispatch-time preference. An input that could name a mode would let an
    // operator skip the maintenance fence on a schema-incompatible release.
    for (const name of deployments) {
      for (const [id, input] of Object.entries(inputsOf(name))) {
        expect(id).not.toBe("mode");
        expect(id).not.toBe("target_sha");
        expect(input.options ?? []).not.toContain("ROLLING_SAFE");
        expect(input.options ?? []).not.toContain("MAINTENANCE_CUTOVER");
      }
    }
  });

  it("publishes a candidate only from an exact commit that is already on main", () => {
    const script = scriptOf("release-candidate.yml");
    expect(script).toMatch(/\^\[a-f0-9\]\{40\}\$/);
    expect(script).toContain("git merge-base --is-ancestor");
  });

  it("requires CI green on the candidate commit itself, not on an ancestor", () => {
    // Being descended from a green commit is a different claim. The candidate's
    // own tree is what gets deployed, so the check runs must be its own, which
    // means asking GitHub for the check runs of that exact sha.
    const candidate = workflow("release-candidate.yml");
    const script = scriptOf("release-candidate.yml");
    expect(script).toContain("/check-runs");
    expect(script).toContain("${CANDIDATE_SHA}");
    for (const check of ["test", "docker-build"]) expect(script).toContain(check);
    expect(script).toContain("success");
    expect(candidate.permissions?.checks).toBe("read");
  });

  it("binds a launch baseline to the current tip of main", () => {
    // The launch cutover destroys the predecessor database. Publishing an
    // ancestor as the baseline would silently deploy a tree that main has
    // already moved past, with no way back to the commits in between.
    const script = scriptOf("release-candidate.yml");
    expect(script).toContain("LAUNCH_BASELINE");
    expect(script).toContain("git rev-parse origin/main");
    expect(script).toContain("LAUNCH_BASELINE_MUST_BE_MAIN_HEAD");
  });

  it("keeps the required status check named `test`", () => {
    // Branch protection points at this job id by name; renaming it silently
    // removes the only gate between a pull request and main.
    expect(Object.keys(workflow("test.yml").jobs)).toContain("test");
  });
});
