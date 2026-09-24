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
 *   prepare-bootstrap <candidate> <expires-at> [cutover-id]
 *                            durable legacy DB handoff; deploys nothing
 *   deploy  <candidate> [cutover-id]
 *                            run the release for that published candidate; a
 *                            LAUNCH_BASELINE must name the prepared cutover it
 *                            is adopting, because its predecessor is archived
 *   forward-deploy <session> <candidate>
 *                            carry an armed, stuck cutover session forward to a
 *                            newer MAINTENANCE_REQUIRED release; resumable
 *   certify <session>  the attended half: arm, buy, refund, shut the fixture
 *   verify  <session>  prove a finished cutover, changing nothing
 *   resume  <session>  take over a session whose lease expired and report the plan
 *   rollback <session> restore the pre-deploy vector; launch rollback resumes from its external receipt
 *   rollback-prepared <cutover-id>
 *                            restore the predecessor from a prepared cutover
 *                            that no session ever adopted
 *
 * Every state the runner can produce has exactly one recovery owner:
 *
 *   before the envelope is durable   prepare-bootstrap cleans up internally
 *   envelope durable, not adopted    rollback-prepared <cutover-id>
 *   adopted, session exists          rollback <session>
 *   external effects armed           forward-deploy <session> <candidate>
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
import { pathToFileURL } from "node:url";
import type { ReleaseClass } from "../../commerce/src/release/candidate";
import { loadCandidatePublicationConfig, loadProductionReleaseConfig, loadReadOnlyReleaseConfig } from "../../commerce/src/release/production-config";
import { buildCandidatePublisher, buildProductionRelease, buildReadOnlyRelease, holdSalesOnSignal, type ProductionRelease } from "../../commerce/src/release/production-runner";
import { deriveCandidate } from "../../commerce/src/release/candidate-publication";
import { verifyCutover } from "../../commerce/src/release/verify-cutover";

const RELEASE_CLASSES: readonly ReleaseClass[] = ["LAUNCH_BASELINE", "ROLLING_COMPATIBLE", "MAINTENANCE_REQUIRED"];

const EXIT_BY_OUTCOME: Record<string, number> = {
  SUCCEEDED: 0, SAFE_ABORTED: 10, ROLLED_BACK: 11, RECOVERY_REQUIRED: 12, AWAITING_OPERATOR: 13,
  // A forward revision whose certification run already exists: the same
  // handoff, found rather than made.
  ALREADY_AWAITING_OPERATOR: 13,
};

const say = (payload: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(payload)}\n`);

export const runCutoverCommand = async (release: ProductionRelease, argv: readonly string[], ownerId: string): Promise<number> => {
  const [command, argument] = argv;
  switch (command) {
    case "prepare-bootstrap": {
      if (!argument || !argv[2]) throw new Error("BOOTSTRAP_PREPARATION_ARGUMENTS_REQUIRED");
      const candidate = release.candidates.get(argument);
      if (!candidate) throw new Error(`RELEASE_CANDIDATE_NOT_PUBLISHED: ${argument}`);
      if (candidate.releaseClass !== "LAUNCH_BASELINE") throw new Error("BOOTSTRAP_PREPARATION_REQUIRES_LAUNCH_BASELINE");
      if (!release.bootstrapPreparation) throw new Error("BOOTSTRAP_PREPARATION_PREDECESSOR_UNAVAILABLE");
      await release.launchBaselineAdmission.admit(candidate);
      const prepared = await release.bootstrapPreparation.prepare({
        targetSha: candidate.sha, expiresAt: argv[2]!, cutoverId: argv[3],
      });
      release.journal.record("bootstrap.prepared", { cutoverId: prepared.envelope.cutoverId, target: candidate.sha, resumed: prepared.alreadyPrepared });
      say({ command, cutoverId: prepared.envelope.cutoverId, target: candidate.sha, resumed: prepared.alreadyPrepared });
      return 0;
    }
    case "deploy": {
      if (!argument) throw new Error("RELEASE_CANDIDATE_REQUIRED");
      // Resolved out of the write-once store by its commit. A deploy cannot be
      // handed a candidate body: that would be a second way to say what is
      // being released, and the two could disagree.
      const candidate = release.candidates.get(argument);
      if (!candidate) throw new Error(`RELEASE_CANDIDATE_NOT_PUBLISHED: ${argument}`);
      // A launch baseline is always the second half of a prepared handoff:
      // nothing else creates the launch database, and by the time this runs the
      // predecessor it would otherwise read has already been archived. So the
      // cutover id is required rather than optional, and naming it is how the
      // deploy says which prepared handoff it is finishing.
      const adoptedCutoverId = candidate.releaseClass === "LAUNCH_BASELINE" ? argv[2] : undefined;
      if (candidate.releaseClass === "LAUNCH_BASELINE") {
        // Admission first, and deliberately: whether this artifact is still the
        // launch baseline does not depend on what else the command was given,
        // and a stale candidate must be refused on its own terms.
        await release.launchBaselineAdmission.admit(candidate);
        if (!adoptedCutoverId) throw new Error("LAUNCH_DEPLOY_REQUIRES_PREPARED_CUTOVER");
      }
      release.journal.record("deploy.start", { candidate: candidate.id, sha: candidate.sha, releaseClass: candidate.releaseClass, cutoverId: adoptedCutoverId });
      const outcome = candidate.releaseClass === "ROLLING_COMPATIBLE"
        ? await release.orchestrator.runRolling({ ownerId, candidate })
        : await release.orchestrator.runMaintenanceCutover({ ownerId, candidate, adoptedCutoverId });
      release.journal.record("deploy.outcome", { kind: outcome.kind, session: outcome.session.id, state: outcome.session.state });
      say({ command, outcome: outcome.kind, session: outcome.session.id, code: "code" in outcome ? outcome.code : undefined });
      // Handing control to a person: this process is done with the session, and
      // `certify` arrives as a separate SSH invocation with its own owner id.
      // Holding the lease here would make the attended half unable to arm
      // without impersonating a process that has already exited.
      if (outcome.kind === "AWAITING_OPERATOR") release.sessions.yieldLease(outcome.session.id, ownerId);
      return EXIT_BY_OUTCOME[outcome.kind] ?? 20;
    }
    case "forward-deploy": {
      if (!argument || !argv[2]) throw new Error("FORWARD_DEPLOY_ARGUMENTS_REQUIRED");
      release.journal.record("forward-deploy.start", { session: argument, candidate: argv[2] });
      const outcome = await release.forwardDeploy.run(argument, argv[2], ownerId);
      release.journal.record("forward-deploy.outcome", { kind: outcome.kind, session: outcome.session.id, state: outcome.session.state });
      say({ command, outcome: outcome.kind, session: outcome.session.id, code: "code" in outcome ? outcome.code : undefined });
      // Handed to the attended `certify`, a separate process with its own
      // owner: this one stands down rather than leave it waiting out a lease.
      if (outcome.kind === "AWAITING_OPERATOR" || outcome.kind === "ALREADY_AWAITING_OPERATOR" || outcome.kind === "RECOVERY_REQUIRED") {
        release.sessions.yieldLease(outcome.session.id, ownerId);
      }
      return EXIT_BY_OUTCOME[outcome.kind] ?? 20;
    }
    case "certify": {
      // The attended half. Attendance is proved inside `preflight`, before
      // anything can be armed, so an unattended dispatch costs a refusal while
      // the old lineage is still a legal destination.
      if (!argument) throw new Error("RELEASE_SESSION_REQUIRED");
      const session = release.sessions.read(argument);
      if (!session) throw new Error(`DEPLOY_SESSION_NOT_FOUND: ${argument}`);
      // The release the session is deploying now: its latest forward revision,
      // or its own target when it has none.
      const binding = release.sessions.binding(argument);
      const candidate = release.candidates.get(binding.candidateId ?? "");
      if (!candidate) throw new Error(`RELEASE_CANDIDATE_NOT_PUBLISHED: ${binding.candidateId ?? "none"}`);
      const driver = release.certificationFor(candidate);
      // A first certification that failed before doing anything gets exactly
      // one retry (see `no-effect-retry.ts`). Decided before the session is
      // claimed, because it never touches the session: it only reads it, and
      // a refusal - the first capability not yet expired - leaves nothing
      // changed at all. A first run that did something is INELIGIBLE and goes
      // on to the ordinary path below, which reconciles it.
      const retry = driver.retryAfterNoEffectFailure(argument);
      if (retry.kind !== "NOT_FAILED") release.journal.record("certify.retry", { session: argument, ...retry });
      // The deploy that produced this session has exited and stood down. This
      // is a different process with its own owner id, so it claims the session
      // before arming anything. A lease somebody is still holding is refused,
      // never taken: standing down is the holder's to do.
      if (session.ownerId !== ownerId) {
        try {
          release.sessions.takeOverExpiredLease(argument, ownerId);
        } catch (error) {
          throw new Error(`DEPLOY_SESSION_HELD_BY_ANOTHER_RUNNER: ${argument} is held by ${session.ownerId} (${error instanceof Error ? error.message : "unknown"})`);
        }
      }
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
      if (session.state !== "RECOVERY_REQUIRED") return 0;
      // This process took the lease to read that state and is now exiting. The
      // rollback it just told the operator to run should not have to wait out a
      // term nobody is using, with production fenced throughout.
      release.sessions.yieldLease(session.id, ownerId);
      return 12;
    }
    case "rollback-prepared": {
      // The other half of the recovery split. `rollback` speaks for a successor
      // session; this speaks for a prepared cutover that never became one, and
      // the two may never address the same handoff.
      if (!argument) throw new Error("RELEASE_CUTOVER_REQUIRED");
      if (!release.bootstrapRollback) throw new Error("PREPARED_ROLLBACK_PREDECESSOR_UNAVAILABLE");
      try {
        const receipt = await release.bootstrapRollback.rollbackPrepared(argument);
        release.journal.record("prepared-rollback.outcome", { cutoverId: argument, rollback: receipt.intent.rollbackId, stage: receipt.stage });
        say({ command, outcome: "ROLLED_BACK", cutoverId: argument, rollback: receipt.intent.rollbackId });
        return 11;
      } catch (error) {
        // Before durable intent exists this is an ordinary pre-mutation
        // refusal; after it, production is mid-restore and only an operator
        // decides what happens next.
        if (!release.bootstrapRollback.isPreparedStarted(argument)) throw error;
        release.journal.record("prepared-rollback.recovery-required", {
          cutoverId: argument,
          code: error instanceof Error ? error.message.split(":")[0] : "UNKNOWN_RELEASE_FAILURE",
        });
        say({ command, outcome: "RECOVERY_REQUIRED", cutoverId: argument });
        return 12;
      }
    }
    case "rollback": {
      if (!argument) throw new Error("RELEASE_SESSION_REQUIRED");
      // The restored predecessor may not contain the successor's release tables
      // at all. An external receipt must therefore be consulted before any
      // attempt to read that now-noncanonical session row.
      const startedCrossLineage = release.bootstrapRollback?.isStarted(argument) ?? false;
      const session = startedCrossLineage ? undefined : release.sessions.read(argument);
      const crossLineage = release.bootstrapRollback
        && (startedCrossLineage || Boolean(session?.adoptedCutoverId));
      if (crossLineage) {
        try {
          const receipt = await release.bootstrapRollback!.rollback(argument, ownerId);
          release.journal.record("bootstrap-rollback.outcome", { session: argument, rollback: receipt.intent.rollbackId, stage: receipt.stage });
          say({ command, outcome: "ROLLED_BACK", session: argument, rollback: receipt.intent.rollbackId });
          return 11;
        } catch (error) {
          if (!release.bootstrapRollback!.isStarted(argument)) throw error;
          release.journal.record("bootstrap-rollback.recovery-required", {
            session: argument,
            code: error instanceof Error ? error.message.split(":")[0] : "UNKNOWN_RELEASE_FAILURE",
          });
          say({ command, outcome: "RECOVERY_REQUIRED", session: argument });
          return 12;
        }
      }
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

export const main = async (): Promise<number> => {
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
    return await runCutoverCommand(release, process.argv.slice(2), ownerId);
  } finally {
    release.close();
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      // Never the token, never a full authenticated URL: this text reaches CI
      // logs and tickets.
      process.stderr.write(`${error instanceof Error ? error.message : "UNKNOWN_RELEASE_FAILURE"}\n`);
      process.exitCode = 20;
    },
  );
}
