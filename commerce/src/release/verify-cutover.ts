import { runtimeIsTarget } from "./deploy-session";
import { SqliteCertificationRunStore } from "../certification/store-sqlite";
import { SqliteCatalogueMutationLedger } from "../certification/catalogue-authority-sqlite";
import { certificationRunId, effectiveCertificationRunId, retryRunId } from "../certification/no-effect-retry";
import { supersessionDefect } from "./supersession-safety";
import type { ProductionRelease } from "./production-runner";

/**
 * Whether a cutover actually finished, asked of production rather than of the
 * record that says it did.
 *
 * It exists because the runner's exit code proves only that a process ended.
 * `certify` can return SUCCEEDED and still leave something an operator has to
 * see: a surface that drifted after the last observation, a fixture that was
 * closed but not hidden, a refund that has not settled. This changes nothing -
 * it is the last read-only question of the release, and the only one whose
 * answer means the deployment is done.
 */

export type VerificationReport = {
  readonly complete: boolean;
  readonly session: string;
  readonly state: string;
  readonly failures: readonly string[];
  readonly checks: Readonly<Record<string, boolean>>;
};

export const verifyCutover = async (release: ProductionRelease, sessionId: string): Promise<VerificationReport> => {
  const session = release.sessions.read(sessionId);
  if (!session) throw new Error(`DEPLOY_SESSION_NOT_FOUND: ${sessionId}`);

  const checks: Record<string, boolean> = {};
  const failures: string[] = [];
  const check = (name: string, held: boolean, detail?: string) => {
    checks[name] = held;
    if (!held) failures.push(detail ? `${name}: ${detail}` : name);
  };

  check("session_succeeded", session.state === "SUCCEEDED", session.state);
  // Settling and reopening are one operation, so a closed gate here means the
  // release did not finish, whatever the session says.
  check("sales_gate_open", !release.authority.deploymentGate().closed);

  // Read now, not from the session's last recorded observation: a surface can
  // drift after the release settles, and this is the question that would catch
  // it.
  // The target is the current binding: a session carried forward finished at
  // the release it was carried to, not at its frozen original.
  const binding = release.sessions.binding(sessionId);
  try {
    const observed = await release.ports.topology.observe();
    check("runtime_converged", runtimeIsTarget(observed.runtime, binding.targetSha), JSON.stringify(observed.runtime));
    check("deploy_pointer_at_target", observed.controlPlane.productionDeployRefSha === binding.targetSha, observed.controlPlane.productionDeployRefSha);
  } catch (error) {
    check("runtime_converged", false, error instanceof Error ? error.message : "unreadable");
    check("deploy_pointer_at_target", false, "topology unreadable");
  }

  // Every target the session was carried away from, re-proved from what its
  // certification left behind rather than from the fact that admission once
  // allowed it: no money in motion, every fixture shut.
  const left = [session.targetSha, ...release.sessions.forwardTargets(sessionId).slice(0, -1).map((target) => target.targetSha)];
  if (binding.revision > 0) {
    left.forEach((sha, revision) => {
      const defect = supersessionDefect(release.database, sessionId, sha);
      check(`superseded_revision_${revision}_safe`, defect === undefined, defect);
    });
  }

  const admitted = await release.ports.evidence.read();
  check("schema_lineage_supported", admitted.schema.lineage === "SUPPORTED", admitted.schema.lineage);

  const runs = new SqliteCertificationRunStore(release.database);
  // The run that certified the release: the session's no-effect retry when it
  // has one, otherwise its first.
  const run = runs.load(effectiveCertificationRunId(release.database, sessionId));
  const retried = run?.runId === retryRunId(sessionId);
  if (retried) {
    // A retry is only ever legitimate over a first run that did nothing. Asked
    // again here, from what that run left behind, not from the retry's say-so.
    const first = new SqliteCatalogueMutationLedger(release.database, certificationRunId(sessionId));
    const firstOrders = release.database.prepare("SELECT COUNT(*) AS n FROM orders WHERE certification_run_id = ?")
      .get(certificationRunId(sessionId)) as { n: number };
    check("superseded_certification_had_no_effect", first.occurrenceId() === undefined && firstOrders.n === 0);
  }
  check("certification_complete", run?.phase === "COMPLETE", run?.phase ?? "no run");
  check("certification_not_failed", !run?.failure, run?.failure?.code);
  // Every external effect of the certification has a terminal record: the
  // payment, the refund and the three emails all reached a state the run was
  // allowed to finish on.
  check("certification_catalogue_clean", run?.direction === "CATALOGUE_CLEAN", run?.direction ?? "no run");

  if (run) {
    const ledger = new SqliteCatalogueMutationLedger(release.database, run.runId);
    const occurrenceId = ledger.occurrenceId();
    check("certification_fixture_recorded", occurrenceId !== undefined);
    if (occurrenceId) {
      const fixture = release.database.prepare("SELECT sales_status, visibility FROM occurrences WHERE id = ?")
        .get(occurrenceId) as { sales_status: string; visibility: string } | undefined;
      // Closed and hidden, read from the catalogue itself. The ledger says a
      // close was recorded; only the occurrence says it is shut.
      check("certification_fixture_closed", fixture?.sales_status === "CLOSED", fixture?.sales_status ?? "absent");
      check("certification_fixture_hidden", fixture?.visibility === "HIDDEN", fixture?.visibility ?? "absent");
    }
  }

  // Spent or retired, never still live: a capability that outlived its release
  // is a permission to buy behind a fence that is no longer there.
  const live = release.database.prepare(`SELECT COUNT(*) AS n FROM certification_capabilities
    WHERE deployment_session_id = ? AND consumed_at IS NULL AND retired_at IS NULL`).get(sessionId) as { n: number };
  check("no_live_capability", live.n === 0, `${live.n} still live`);

  return { complete: failures.length === 0, session: sessionId, state: session.state, failures, checks };
};
