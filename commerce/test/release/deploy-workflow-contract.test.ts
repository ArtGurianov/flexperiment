import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { PRODUCTION_RELEASE_ENVIRONMENT_VARIABLES } from "../../src/release/production-config";

/**
 * Properties, not text. The old suite asserted that workflow files contained
 * particular shell snippets, which made it a second copy of the YAML that broke
 * on every reformat and proved nothing about behaviour. These properties are the
 * ones whose absence is a production incident rather than a diff.
 */
type Workflow = {
  on: Record<string, unknown> & { workflow_dispatch?: { inputs?: Record<string, { type?: string; options?: string[]; default?: string }> } };
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs: Record<string, { environment?: string; steps?: { run?: string; uses?: string; env?: Record<string, string> }[] }>;
};

const workflow = (name: string) => parse(readFileSync(`.github/workflows/${name}`, "utf8")) as Workflow;
const inputsOf = (name: string) => workflow(name).on.workflow_dispatch?.inputs ?? {};
const scriptOf = (name: string) =>
  Object.values(workflow(name).jobs).flatMap((job) => job.steps ?? []).map((step) => step.run ?? "").join("\n");

const deployments = ["deploy-production.yml", "release-candidate.yml"] as const;
const runnerWrapper = () => {
  const document = readFileSync("docs/release/DEPLOYMENT_INVARIANTS.md", "utf8");
  const match = document.match(/```sh\n# \/usr\/local\/bin\/flexperiment-release[^\n]*\n([\s\S]*?)```/);
  if (!match) throw new Error("RELEASE_RUNNER_WRAPPER_DOCUMENTATION_MISSING");
  return match[1];
};

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
    //
    // Asserted as the rule rather than as a list of names, because the list was
    // the thing that failed when a `command` input was added - and a verb is
    // not a second way to name a release.
    const inputs = Object.keys(inputsOf("deploy-production.yml"));
    expect(inputs).toContain("candidate");
    expect(inputs.filter((name) => /sha|commit|ref|branch|release[_-]?class|rolling|fence|sales/i.test(name))).toEqual([]);
  });

  it("gives each command the argument it means, rather than one input for all of them", () => {
    // One input carrying either a candidate or a session depending on the verb
    // is how a rollback ends up pointed at a candidate file.
    const inputs = inputsOf("deploy-production.yml");
    expect(Object.keys(inputs)).toEqual(["command", "candidate", "session"]);
    expect(inputs.command.options).toEqual(["observe", "deploy", "verify", "resume", "rollback"]);
    expect(inputs.command.default).toBe("observe");
  });

  it("keeps the deploy out of the GitHub runner entirely", () => {
    // The controller must outlive the containers it replaces and must not
    // depend on a network it cannot influence. A job that ran the orchestration
    // here would hold the only handle on a closed sales gate.
    const steps = Object.values(workflow("deploy-production.yml").jobs).flatMap((job) => job.steps ?? []);
    const scripts = steps.map((step) => step.run ?? "").join("\n");
    expect(scripts).not.toMatch(/tsx\s+scripts\/release\/cutover-runner\.ts/);
    expect(scripts).toMatch(/\bssh\b/);
    // Host keys are pinned. An unknown host at this moment is an unknown
    // machine being handed production.
    expect(scripts).toMatch(/StrictHostKeyChecking=yes/);
    expect(scripts).not.toMatch(/StrictHostKeyChecking=(no|accept-new)/);
  });

  it("reads the operator handoff as neither success nor failure", () => {
    // 13 means prepared, fenced and nothing spent. A job that retried it would
    // re-enter a cutover a person is in the middle of; one that failed it would
    // report a broken release that is merely waiting.
    const scripts = Object.values(workflow("deploy-production.yml").jobs)
      .flatMap((job) => job.steps ?? []).map((step) => step.run ?? "").join("\n");
    expect(scripts).toContain("13)");
    expect(scripts).toMatch(/13\).*AWAITING OPERATOR/);
  });

  it("does not swallow the runner's exit code", () => {
    // 12 means production needs a decision a workflow must not make. A run that
    // reported success there would leave sales closed and nobody looking.
    const scripts = Object.values(workflow("deploy-production.yml").jobs)
      .flatMap((job) => job.steps ?? []).map((step) => step.run ?? "").join("\n");
    expect(scripts).toMatch(/exit "\$status"/);
  });

  it("publishes candidates from exactly one operator input", () => {
    const inputs = inputsOf("release-candidate.yml");
    expect(Object.keys(inputs)).toEqual(["candidate_sha"]);
    expect(inputs).not.toHaveProperty("release_class");
  });

  it("classifies publication as maintenance-required, never the retired launch baseline, without dispatch input", () => {
    const publication = Object.values(workflow("release-candidate.yml").jobs).flatMap((job) => job.steps ?? [])
      .find((step) => (step.run ?? "").includes("publish-candidate"));
    expect(publication?.env?.RELEASE_CLASS).toBe("MAINTENANCE_REQUIRED");
    expect(publication?.env?.RELEASE_CLASS).not.toContain("inputs.release_class");
  });

  it("publishes the candidate on the release host, from the commit's own tree", () => {
    // A candidate assembled in the CI job and copied over would be an
    // expectation that job asserted, not one the tree has. The publication runs
    // where the deploy will later read it, through the same entry point.
    const script = scriptOf("release-candidate.yml");
    expect(script).toMatch(/\bssh\b/);
    expect(script).toContain("flexperiment-release publish-candidate");
    expect(script).toMatch(/StrictHostKeyChecking=yes/);
    // Publication deploys nothing, so the job never invokes the deploy verb.
    expect(script).not.toContain("flexperiment-release deploy");
  });

  it("gives no operator a way to choose the deploy mode", () => {
    // Closing sales is a consequence of how a candidate was classified, never a
    // dispatch-time preference. An input that could name a mode would let an
    // operator skip the maintenance fence on a schema-incompatible release.
    for (const name of deployments) {
      for (const [id, input] of Object.entries(inputsOf(name))) {
        expect(id).not.toBe("mode");
        expect(id).not.toBe("target_sha");
        expect(id).not.toBe("release_class");
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

  it("binds a candidate to the current tip of main", () => {
    // Forward admission deploys only main's exact tip, so an ancestor would be
    // a candidate nothing may deploy.
    const script = scriptOf("release-candidate.yml");
    expect(script).not.toContain("LAUNCH_BASELINE");
    expect(script).toContain("git rev-parse origin/main");
    expect(script).toContain("CANDIDATE_MUST_BE_MAIN_HEAD");
  });

  it("exports the entire production runner configuration contract", () => {
    // `set -a` around the source is intentionally stronger than a second list
    // of names in documentation: every required future configuration input,
    // including credentials, reaches the child process without inventing a
    // placeholder or a default. The actual required-name list remains the
    // only enumerated contract.
    const wrapper = runnerWrapper();
    expect(PRODUCTION_RELEASE_ENVIRONMENT_VARIABLES.length).toBeGreaterThan(0);
    expect(wrapper).toMatch(/set -a\s*\n\. \/etc\/flexperiment\/release-runner\.env\s*# root:root, 0600\s*\nset \+a/);
    expect(wrapper).toContain('exec pnpm --dir /srv/flexperiment release:runner "$@"');
    for (const variable of PRODUCTION_RELEASE_ENVIRONMENT_VARIABLES) {
      expect(wrapper).not.toMatch(new RegExp(`(?:${variable})=`));
    }
  });

  it("runs the suite for pull requests, main integration and manual dispatch only", () => {
    // Asserted as the parsed trigger set rather than as the file's text: the
    // property is which events run the suite, and a whitespace snapshot breaks
    // on reformatting while missing a trigger added in a different style.
    const test = workflow("test.yml");
    expect(Object.keys(test.on).sort()).toEqual(["pull_request", "push", "workflow_dispatch"]);
    expect((test.on as { push?: { branches?: string[] } }).push?.branches).toEqual(["main"]);
  });

  it("keeps the required status check named `test`", () => {
    // Branch protection points at this job id by name; renaming it silently
    // removes the only gate between a pull request and main.
    expect(Object.keys(workflow("test.yml").jobs)).toContain("test");
  });
});
