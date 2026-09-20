import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Properties, not text. The old suite asserted that workflow files contained
 * particular shell snippets, which made it a second copy of the YAML that broke
 * on every reformat and proved nothing about behaviour. These four properties
 * are the ones whose absence is a production incident rather than a diff.
 */
const workflow = (name: string) => parse(readFileSync(`.github/workflows/${name}`, "utf8")) as {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs: Record<string, { environment?: string; steps?: { run?: string; uses?: string }[] }>;
};

const deployments = ["deploy-production.yml", "release-candidate.yml"] as const;

describe("production workflow contract", () => {
  it.each(deployments)("%s runs only behind the production environment gate", (name) => {
    const parsed = workflow(name);
    for (const job of Object.values(parsed.jobs)) expect(job.environment).toBe("production");
  });

  it.each(deployments)("%s is dispatch-only and never triggered by a push", (name) => {
    const parsed = workflow(name);
    expect(Object.keys(parsed.on)).toEqual(["workflow_dispatch"]);
  });

  it.each(deployments)("%s serialises and must not be cancelled mid-flight", (name) => {
    const parsed = workflow(name);
    // A cancelled deploy is exactly how production is left half-switched, which
    // is the state the whole recovery contract exists to avoid creating.
    expect(parsed.concurrency?.group).toBeTruthy();
    expect(parsed.concurrency?.["cancel-in-progress"]).toBe(false);
  });

  it.each(deployments)("%s binds to an exact commit that is already on main", (name) => {
    const steps = Object.values(workflow(name).jobs).flatMap((job) => job.steps ?? []);
    const binding = steps.map((step) => step.run ?? "").join("\n");
    expect(binding).toMatch(/\^\[a-f0-9\]\{40\}\$/);
    expect(binding).toContain("git merge-base --is-ancestor");
  });

  it.each(deployments)("%s never interpolates an input into a shell script", (name) => {
    // A `${{ }}` expression is substituted into the script text before bash
    // runs it, so a crafted dispatch input escapes its own quoting however it
    // is quoted. Inputs reach the shell through `env` or not at all.
    const steps = Object.values(workflow(name).jobs).flatMap((job) => job.steps ?? []);
    for (const step of steps) expect(step.run ?? "").not.toMatch(/\$\{\{\s*(inputs|github\.event)\./);
  });

  it("keeps the required status check named `test`", () => {
    // Branch protection points at this job id by name; renaming it silently
    // removes the only gate between a pull request and main.
    expect(Object.keys(workflow("test.yml").jobs)).toContain("test");
  });
});
