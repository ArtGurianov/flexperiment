import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The authority boundary:
 *
 *   runtime-candidate has authority only BEFORE acquire.
 *   After acquire, the generation's recorded target_sha is the sole authority.
 *
 * A successful release is on its own enough to leave the pointer stale - the
 * state machine advances the generation and production-deploy while the ref
 * stays put. If any post-acquire step re-resolved the ref, that ordinary
 * staleness would strand an epoch already in flight and force a break-glass
 * repair to finish work that was never actually broken.
 *
 * Asserted structurally rather than by reading the controllers, so a future
 * refactor cannot reintroduce dual authority quietly.
 */

const directory = ".github/workflows";
const controllers = readdirSync(directory).filter((name) => name.startsWith("controlled-") && name.endsWith(".yml"));

type Step = { name: string; body: string };

/**
 * Segmented on the step boundary rather than YAML-parsed: no parser dependency
 * for a structural assertion, and it reads the file exactly as a reviewer does.
 */
const stepsOf = (file: string): Step[] => {
  const lines = readFileSync(`${directory}/${file}`, "utf8").split("\n");
  const steps: Step[] = [];
  for (const line of lines) {
    const start = /^\s{6}- name:\s*(.*)$/.exec(line);
    if (start) steps.push({ name: start[1].trim(), body: line });
    else if (steps.length) steps[steps.length - 1].body += `\n${line}`;
  }
  return steps;
};

const body = (step: Step) => step.body;

// Any act that takes durable release ownership. After one of these has run,
// the durable owner is authoritative and the pointer is free to move.
const ACQUIRES = /candidates\/acquire|release-control\/acquire|Acquire owner and pause/;
const READS_POINTER = /origin\/runtime-candidate|origin runtime-candidate|refs\/heads\/runtime-candidate/;

describe("runtime-candidate authority boundary", () => {
  it("covers every controller", () => {
    expect(controllers.length).toBeGreaterThan(10);
  });

  it.each(controllers)("%s never resolves runtime-candidate after acquire", (file) => {
    const steps = stepsOf(file);
    const acquireAt = steps.findIndex((step) => ACQUIRES.test(body(step)));
    if (acquireAt === -1) return; // Controller takes no durable ownership.

    const offenders = steps
      .map((step, index) => ({ index, name: step.name ?? `step ${index}`, reads: READS_POINTER.test(body(step)) }))
      .filter((step) => step.index > acquireAt && step.reads);

    expect(
      offenders.map((step) => step.name),
      `${file} re-resolves runtime-candidate after acquiring durable ownership. `
      + `Once a generation is acquired its recorded target_sha is the sole authority; `
      + `reading the mutable ref again lets ordinary pointer staleness strand an epoch in flight.`,
    ).toEqual([]);
  });

  /**
   * The repair controller's whole purpose is a diverged pointer, so it reads
   * the ref freely - but it must never take ownership, deploy, or touch
   * release-control state. Its blast radius is exactly one ref.
   */
  it("keeps break-glass repair scoped to the pointer alone", () => {
    const repair = readFileSync(`${directory}/controlled-runtime-candidate-repair.yml`, "utf8");
    expect(ACQUIRES.test(repair)).toBe(false);
    for (const forbidden of ["release-control/", "COOLIFY", "PRODUCTION_DEPLOY_REF_TOKEN"]) {
      expect(repair, `repair must not reference ${forbidden}`).not.toContain(forbidden);
    }
  });

  /**
   * Selection-time safety is a different property from in-flight authority and
   * survives de-authorization: a fresh acquire must still prove its target
   * descends from what production is actually running. The pointer proposing a
   * SHA is never on its own sufficient.
   */
  it("still proves a fresh target descends from production before acquiring it", () => {
    const deploy = readFileSync(`${directory}/controlled-production-deploy.yml`, "utf8");
    expect(deploy).toContain("candidate_is_descendant_of_production_deploy");
    expect(deploy).toContain("RUNTIME_CANDIDATE_NOT_DESCENDANT_OF_PRODUCTION_DEPLOY");
  });
});
