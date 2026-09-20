/**
 * The server-side release runner: one shot, on the VPS, outside the three
 * Coolify applications.
 *
 * It does not run in the GitHub runner. A controller inside `commerce` would be
 * replaced by the deploy it is driving; a controller inside the workflow job
 * would be a process whose survival depends on a network it cannot influence,
 * holding the only handle on a closed sales gate. This one lives beside the
 * database and the envelope directory, and the workflow's whole job is to start
 * it and wait for its exit.
 *
 *   observe            read both layers and the readiness evidence; mutates nothing
 *   deploy  <file>     run the release for the candidate in that JSON file
 *   resume  <session>  take over a session whose lease expired and report the plan
 *   rollback <session> restore the pre-deploy vector for a same-lineage deploy
 *
 * Exit codes are the contract the workflow reads:
 *   0   succeeded, or observe/resume completed
 *   10  safe aborted - production untouched, sales open
 *   11  rolled back - production restored, sales open
 *   12  recovery required - sales REMAIN CLOSED, an operator must decide
 *   20  refused before any mutation (configuration, lock, unwired port)
 *   130 interrupted; the session and the gate are left exactly as they were
 */
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import type { ReleaseCandidate, ReleaseClass } from "../../commerce/src/release/candidate";
import { loadProductionReleaseConfig } from "../../commerce/src/release/production-config";
import { buildProductionRelease, holdSalesOnSignal, type ProductionRelease } from "../../commerce/src/release/production-runner";

const RELEASE_CLASSES: readonly ReleaseClass[] = ["LAUNCH_BASELINE", "ROLLING_COMPATIBLE", "MAINTENANCE_REQUIRED"];
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

/**
 * The candidate is read as one fact from one file.
 *
 * Nothing here is defaulted or inferred. A candidate missing its release class
 * must not become a rolling deploy because rolling is the cheaper branch, and a
 * candidate missing its expectation must not become one that readiness cannot
 * refuse.
 */
const readCandidate = (path: string): ReleaseCandidate => {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`RELEASE_CANDIDATE_UNREADABLE: ${path}: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  const expectation = (parsed.expectation ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof parsed.id !== "string" || !parsed.id.trim()) problems.push("id");
  if (typeof parsed.sha !== "string" || !SHA.test(parsed.sha)) problems.push("sha");
  if (!RELEASE_CLASSES.includes(parsed.releaseClass as ReleaseClass)) problems.push("releaseClass");
  if (typeof expectation.schemaInventory !== "string" || !expectation.schemaInventory.trim()) problems.push("expectation.schemaInventory");
  if (typeof expectation.legalVersion !== "string" || !expectation.legalVersion.trim()) problems.push("expectation.legalVersion");
  if (typeof expectation.legalManifestSha256 !== "string" || !SHA256.test(expectation.legalManifestSha256)) problems.push("expectation.legalManifestSha256");
  if (problems.length) throw new Error(`RELEASE_CANDIDATE_INVALID: ${problems.join(", ")}`);
  return {
    id: parsed.id as string,
    sha: parsed.sha as string,
    releaseClass: parsed.releaseClass as ReleaseClass,
    expectation: {
      schemaInventory: expectation.schemaInventory as string,
      legalVersion: expectation.legalVersion as string,
      legalManifestSha256: expectation.legalManifestSha256 as string,
    },
  };
};

const EXIT_BY_OUTCOME: Record<string, number> = { SUCCEEDED: 0, SAFE_ABORTED: 10, ROLLED_BACK: 11, RECOVERY_REQUIRED: 12 };

const say = (payload: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(payload)}\n`);

const run = async (release: ProductionRelease, argv: readonly string[], ownerId: string): Promise<number> => {
  const [command, argument] = argv;
  switch (command) {
    case "observe": {
      const observation = await release.ports.topology.observe();
      const evidence = await release.ports.evidence.read();
      release.journal.record("observe", { observation });
      say({ command, observation, evidence, gate: release.authority.deploymentGate() });
      return 0;
    }
    case "deploy": {
      if (!argument) throw new Error("RELEASE_CANDIDATE_FILE_REQUIRED");
      const candidate = readCandidate(argument);
      release.journal.record("deploy.start", { candidate: candidate.id, sha: candidate.sha, releaseClass: candidate.releaseClass });
      const outcome = candidate.releaseClass === "ROLLING_COMPATIBLE"
        ? await release.orchestrator.runRolling({ ownerId, candidate })
        : await release.orchestrator.runMaintenanceCutover({ ownerId, candidate });
      release.journal.record("deploy.outcome", { kind: outcome.kind, session: outcome.session.id, state: outcome.session.state });
      say({ command, outcome: outcome.kind, session: outcome.session.id, code: "code" in outcome ? outcome.code : undefined });
      return EXIT_BY_OUTCOME[outcome.kind] ?? 20;
    }
    case "resume": {
      if (!argument) throw new Error("RELEASE_SESSION_REQUIRED");
      const { session, plan } = await release.orchestrator.resume(argument, ownerId);
      release.journal.record("resume", { session: session.id, state: session.state, plan: plan.kind });
      say({ command, session: session.id, state: session.state, plan });
      // A resumed session that needs a human decision is not a success, and the
      // workflow must not read it as one.
      return session.state === "RECOVERY_REQUIRED" ? 12 : 0;
    }
    case "rollback": {
      if (!argument) throw new Error("RELEASE_SESSION_REQUIRED");
      const outcome = await release.orchestrator.rollback(argument, ownerId);
      release.journal.record("rollback.outcome", { kind: outcome.kind, session: outcome.session.id });
      say({ command, outcome: outcome.kind, session: outcome.session.id });
      return EXIT_BY_OUTCOME[outcome.kind] ?? 20;
    }
    default:
      throw new Error(`RELEASE_COMMAND_UNKNOWN: ${String(command ?? "none")}`);
  }
};

/**
 * The one port with no production adapter, checked before the lock is taken.
 *
 * Certification is irreducibly attended - someone opens a mailbox and says the
 * ticket arrived - so its driver needs an HTTP client for the admin and public
 * surfaces and an operator at a terminal. Neither exists yet. The orchestrator
 * would refuse on its own first line anyway, but refusing here means a dispatch
 * against production does not even open the database or take the lock.
 */
const assertCutoverExecutable = (candidate: ReleaseCandidate) => {
  if (candidate.releaseClass === "ROLLING_COMPATIBLE") return;
  throw new Error("RELEASE_PRODUCTION_ADAPTERS_UNAVAILABLE: the certification driver has no production adapter, so a "
    + "maintenance cutover cannot be executed; the ordering is proved in commerce/test/release/orchestrator.test.ts and "
    + "the composition root in commerce/test/release/production-runner.test.ts.");
};

const main = async (): Promise<number> => {
  // Read before anything is built, so a configuration problem is a plain named
  // refusal rather than a stack trace out of an adapter constructor.
  const config = loadProductionReleaseConfig();
  const [command, argument] = process.argv.slice(2);
  if (command === "deploy" && argument) assertCutoverExecutable(readCandidate(argument));
  const ownerId = (process.env.FLEXPERIMENT_RELEASE_OWNER ?? `${hostname()}:${process.pid}`).trim();
  const release = buildProductionRelease(config);
  holdSalesOnSignal(release);
  try {
    return await run(release, process.argv.slice(2), ownerId);
  } finally {
    release.close();
  }
};

void main().then(
  (code) => { process.exitCode = code; },
  (error: unknown) => {
    // Never the token, never a full authenticated URL: this text reaches CI
    // logs and tickets.
    process.stderr.write(`${error instanceof Error ? error.message : "UNKNOWN_RELEASE_FAILURE"}\n`);
    process.exitCode = 20;
  },
);
