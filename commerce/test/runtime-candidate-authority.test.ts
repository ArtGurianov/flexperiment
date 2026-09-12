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
   * The CROSS-RUN half of the same authority boundary, and the reason the
   * step-order test above is necessary but not sufficient.
   *
   * That test reads order inside ONE run: no step after the acquire step may
   * re-resolve the pointer. A rerun, though, starts again at step one with
   * ownership ALREADY held from a previous run - the exact shape produced by a
   * response lost between acquire and pause. An unguarded pointer read sitting
   * textually BEFORE the acquire step satisfies the order test and still
   * executes while owned; if an ordinary promotion moved the ref in the
   * meantime it refuses the very epoch it was invoked to finish, and the
   * epoch is stranded with global sales still paused.
   *
   * So in any controller that models resumption of an owned epoch, every
   * runtime-candidate read must be unreachable once ownership is held: guarded
   * by the classified state, admitted only for FRESH, and never for an OWNED_
   * state. Selection-time safety belongs to the fresh path alone.
   *
   * Scoped to controllers that actually classify owned resumption, because the
   * property is meaningless without it - a controller with no resumable owned
   * state has no run that begins already owned.
   */
  const resumableOwnedControllers = controllers.filter((file) =>
    /DEPLOYMENT_STATE=OWNED/.test(readFileSync(`${directory}/${file}`, "utf8")));

  it("covers every controller that models owned resumption", () => {
    expect(resumableOwnedControllers.length).toBeGreaterThanOrEqual(5);
  });

  it.each(resumableOwnedControllers)("%s never resolves runtime-candidate in a resumed, already-owned run", (file) => {
    const guardOf = (step: Step): string | undefined => /^\s{8}if:\s*(.*)$/m.exec(step.body)?.[1]?.trim();

    const offenders = stepsOf(file)
      .filter((step) => READS_POINTER.test(body(step)))
      .filter((step) => {
        const guard = guardOf(step);
        // Unguarded, or guarded by something that does not exclude every
        // owned state, means the read can happen in a resumed run.
        return !guard || !/\bFRESH\b/.test(guard) || /OWNED_/.test(guard);
      })
      .map((step) => `${step.name} [if: ${guardOf(step) ?? "none"}]`);

    expect(
      offenders,
      `${file} can resolve runtime-candidate in a run that already holds durable ownership. `
      + `A rerun after a lost acquire response would then be refused for a pointer that legitimately `
      + `moved on, stranding the epoch it was invoked to finish. Guard the read on the FRESH state.`,
    ).toEqual([]);
  });

  /**
   * The break-glass repair controller was removed once the ordinary path could
   * replace a stale pointer. Its only unique capability was relaxing the
   * current-pointer assertions, and those no longer exist; keeping a second
   * privileged implementation of the same operation would be pure attack
   * surface. See DEPLOYMENT_INVARIANTS: the root cause was eliminated rather
   * than the recovery automated.
   */
  it("has no break-glass repair controller to fall back to", () => {
    expect(controllers).not.toContain("controlled-runtime-candidate-repair.yml");
    const promotion = readFileSync(`${directory}/controlled-runtime-candidate-promotion.yml`, "utf8");
    expect(promotion).not.toContain("RUNTIME_CANDIDATE_REPAIR_NOT_DIVERGED");
    expect(promotion).not.toContain("repair_diverged_candidate");
  });

  /**
   * Selection-time safety is a different property from in-flight authority and
   * survives de-authorization: a fresh acquire must still prove its target
   * descends from what production is actually running. The pointer proposing a
   * SHA is never on its own sufficient.
   */
  it("still proves a fresh target descends from production before acquiring it", () => {
    const deploy = `${readFileSync(`${directory}/controlled-production-deploy.yml`, "utf8")}\n${readFileSync(".github/actions/controlled-production-deploy/action.yml", "utf8")}`;
    expect(deploy).toContain("candidate_is_descendant_of_production_deploy");
    expect(deploy).toContain("RUNTIME_CANDIDATE_NOT_DESCENDANT_OF_PRODUCTION_DEPLOY");
  });
});
