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
 *   observe                  read both layers and the readiness evidence; mutates nothing
 *   publish-candidate <sha> <class>
 *                            derive and publish a candidate; deploys nothing
 *   deploy  <candidate>      run the release for that published candidate
 *   certify <session>  the attended half: arm, buy, refund, shut the fixture
 *   verify  <session>  prove a finished cutover, changing nothing
 *   resume  <session>  take over a session whose lease expired and report the plan
 *   rollback <session> restore the pre-deploy vector for a same-lineage deploy
 *
 * Exit codes are the contract the workflow reads:
 *   0   succeeded, or observe/verify/resume completed
 *   13  awaiting operator - prepared, fenced, nothing spent, a person must certify
 *   10  safe aborted - production untouched, sales open
 *   11  rolled back - production restored, sales open
 *   12  recovery required - sales REMAIN CLOSED, an operator must decide
 *   20  refused before any mutation (configuration, lock, unwired port)
 *   130 interrupted; the session and the gate are left exactly as they were
 */
import { hostname } from "node:os";
import type { ReleaseClass } from "../../commerce/src/release/candidate";
import { loadCandidatePublicationConfig, loadProductionReleaseConfig, loadReadOnlyReleaseConfig } from "../../commerce/src/release/production-config";
import { buildCandidatePublisher, buildProductionRelease, buildReadOnlyRelease, holdSalesOnSignal, type ProductionRelease } from "../../commerce/src/release/production-runner";
import { deriveCandidate } from "../../commerce/src/release/candidate-publication";
import { verifyCutover } from "../../commerce/src/release/verify-cutover";

const RELEASE_CLASSES: readonly ReleaseClass[] = ["LAUNCH_BASELINE", "ROLLING_COMPATIBLE", "MAINTENANCE_REQUIRED"];

const EXIT_BY_OUTCOME: Record<string, number> = {
  SUCCEEDED: 0, SAFE_ABORTED: 10, ROLLED_BACK: 11, RECOVERY_REQUIRED: 12, AWAITING_OPERATOR: 13,
};

const say = (payload: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(payload)}\n`);

const run = async (release: ProductionRelease, argv: readonly string[], ownerId: string): Promise<number> => {
  const [command, argument] = argv;
  switch (command) {
    case "deploy": {
      if (!argument) throw new Error("RELEASE_CANDIDATE_REQUIRED");
      // Resolved out of the write-once store by its commit. A deploy cannot be
      // handed a candidate body: that would be a second way to say what is
      // being released, and the two could disagree.
      const candidate = release.candidates.get(argument);
      if (!candidate) throw new Error(`RELEASE_CANDIDATE_NOT_PUBLISHED: ${argument}`);
      release.journal.record("deploy.start", { candidate: candidate.id, sha: candidate.sha, releaseClass: candidate.releaseClass });
      const outcome = candidate.releaseClass === "ROLLING_COMPATIBLE"
        ? await release.orchestrator.runRolling({ ownerId, candidate })
        : await release.orchestrator.runMaintenanceCutover({ ownerId, candidate });
      release.journal.record("deploy.outcome", { kind: outcome.kind, session: outcome.session.id, state: outcome.session.state });
      say({ command, outcome: outcome.kind, session: outcome.session.id, code: "code" in outcome ? outcome.code : undefined });
      return EXIT_BY_OUTCOME[outcome.kind] ?? 20;
    }
    case "certify": {
      // The attended half. It refuses before the composition root is built
      // when nobody is watching, so an unattended dispatch costs a refusal
      // while the old lineage is still a legal destination.
      if (!argument) throw new Error("RELEASE_SESSION_REQUIRED");
      const session = release.sessions.read(argument);
      if (!session) throw new Error(`DEPLOY_SESSION_NOT_FOUND: ${argument}`);
      const candidate = release.candidates.get(session.candidateId ?? "");
      if (!candidate) throw new Error(`RELEASE_CANDIDATE_NOT_PUBLISHED: ${session.candidateId ?? "none"}`);
      const driver = release.certificationFor(candidate);
      const capability = driver.recoverCapability(argument);
      if (!capability) throw new Error("CERTIFICATION_CAPABILITY_UNRECOVERABLE");

      release.journal.record("certify.start", { session: argument, run: capability.runId, phase: driver.phase(argument) });
      const outcome = await release.orchestrator.certifyAndComplete(argument, { ownerId, candidate, sessionId: argument }, capability);
      release.journal.record("certify.outcome", { kind: outcome.kind, session: outcome.session.id, state: outcome.session.state });
      say({ command, outcome: outcome.kind, session: outcome.session.id, code: "code" in outcome ? outcome.code : undefined });
      return EXIT_BY_OUTCOME[outcome.kind] ?? 20;
    }
    case "verify": {
      if (!argument) throw new Error("RELEASE_SESSION_REQUIRED");
      const report = await verifyCutover(release, argument);
      release.journal.record("verify", { session: argument, complete: report.complete, failures: report.failures });
      say({ command, ...report });
      // A cutover that does not verify is not a finished deployment, and this
      // is the only thing that proves one did.
      return report.complete ? 0 : 12;
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
 * Looking at production is a different program from changing it.
 *
 * It builds the read-only composition, which has no lock, no journal, no
 * Coolify client, no write credential and no orchestrator. That is the whole
 * safety argument: `observe` cannot deploy because nothing it holds can, not
 * because a branch above declined to.
 */
/**
 * Publishing a candidate deploys nothing, and the composition is why: a tree
 * reader and a write-once directory, no database and no credential that could
 * change production. The expectation is derived from the commit's own tree, so
 * a candidate cannot claim one its tree does not have.
 */
const publishCandidate = async (sha: string, named: string | undefined): Promise<number> => {
  const releaseClass = (named ?? "").trim() as ReleaseClass;
  if (!RELEASE_CLASSES.includes(releaseClass)) throw new Error(`RELEASE_CLASS_INVALID: ${releaseClass || "absent"}`);
  const publisher = buildCandidatePublisher(loadCandidatePublicationConfig());
  await publisher.fetch(sha);
  const derived = await deriveCandidate(publisher.tree, { sha, releaseClass });
  const { candidate, republished } = publisher.candidates.publish(derived);
  say({ command: "publish-candidate", candidate: candidate.id, releaseClass: candidate.releaseClass, republished, expectation: candidate.expectation });
  return 0;
};

const observe = async (): Promise<number> => {
  const release = buildReadOnlyRelease(loadReadOnlyReleaseConfig());
  try {
    say({ command: "observe", observation: await release.topology.observe(), evidence: await release.evidence.read() });
    return 0;
  } finally {
    release.close();
  }
};

const main = async (): Promise<number> => {
  const [command, argument] = process.argv.slice(2);
  if (command === "observe") return observe();
  if (command === "publish-candidate") {
    if (!argument) throw new Error("RELEASE_CANDIDATE_SHA_REQUIRED");
    return publishCandidate(argument, process.argv[4]);
  }
  // Read before anything is built, so a configuration problem is a plain named
  // refusal rather than a stack trace out of an adapter constructor.
  const config = loadProductionReleaseConfig();

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
