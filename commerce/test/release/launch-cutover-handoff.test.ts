import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCutoverCommand } from "../../../scripts/release/cutover-runner";
import type { ReleaseCandidate } from "../../src/release/candidate";
import { FileReleaseCandidateStore } from "../../src/release/candidate-store";
import { createCutoverEnvelope, type CutoverEnvelope } from "../../src/release/cutover-envelope";
import { FileCutoverEnvelopeStore } from "../../src/release/cutover-envelope-file-store";
import { schemaInventoryExpectation } from "../../src/release/expectation";
import { canonicalLegalManifest, parseLegalManifest } from "../../src/legal-manifest";
import type { CertificationDriver } from "../../src/release/orchestrator";
import { PRODUCTION_CONVERGENCE, type ConvergencePolicy } from "../../src/release/convergence";
import { buildProductionRelease, type BuildOptions, type ProductionRelease } from "../../src/release/production-runner";
import { certificationRunId, retryRunId } from "../../src/certification/no-effect-retry";
import { SqliteCertificationRunStore } from "../../src/certification/store-sqlite";
import { verifyCutover } from "../../src/release/verify-cutover";
import { deriveCandidate, GitCommitTreeReader } from "../../src/release/candidate-publication";
import { defaultGit } from "../../src/release/deploy-ref";
import { revisionRunId } from "../../src/certification/no-effect-retry";
import { git, harness, recordInstance, type Harness } from "../support/production-runner-harness";

/**
 * The seam between the two halves of a launch cutover.
 *
 * `prepare-bootstrap` archives the predecessor and leaves the fresh launch
 * database standing in its place. Every test that came before this one proved
 * each half on its own: the preparation wrote a correct envelope, and
 * `adoptCutover` adopted one correctly when it was called. Nothing proved that
 * the CLI ever called it - and it did not. A launch `deploy` re-read a
 * predecessor that no longer existed and refused with
 * LAUNCH_CUTOVER_REQUIRES_PREDECESSOR_READER, after the outage had already
 * started and with no command able to finish or reverse it.
 *
 * So these drive `runCutoverCommand` against the real composition root, the
 * real orchestrator, the real session store and the real deploy ref. The one
 * substitution is the admission guard, which has its own suite and is proved
 * against production separately; substituting it here keeps the subject of
 * these tests the handoff rather than the guard.
 */

const NOW = new Date("2026-09-20T12:00:00.000Z");
const now = () => NOW;
const CUTOVER = "launch-cutover-test";
const OWNER = "runner-1";

let root: string;
let vps: Harness;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "launch-handoff-"));
  vps = await harness(root);
});
afterEach(async () => { await vps.close(); });

/**
 * The legal binding readiness insists on, published into the successor the way
 * a real cutover publishes it. Without it the deploy stalls short of the
 * handoff and the assertions below would be measuring the fixture.
 */
const publishLegalRelease = (): { version: string; manifestSha256: string } => {
  const raw = readFileSync("commerce/legal/production-manifest.json", "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  vps.db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES (?, ?, ?, ?, 1)")
    .run("legal-1", String(parsed.version), NOW.toISOString(), raw);
  const canonical = canonicalLegalManifest(parseLegalManifest(parsed));
  return { version: String(parsed.version), manifestSha256: createHash("sha256").update(canonical).digest("hex") };
};

/** Derived from the successor's own schema and legal binding, never asserted blind. */
const launchCandidate = (sha: string): ReleaseCandidate => {
  const legal = publishLegalRelease();
  const versions = (vps.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: string }[])
    .map((row) => row.version);
  return {
    id: sha,
    sha,
    releaseClass: "LAUNCH_BASELINE",
    expectation: {
      schemaInventory: schemaInventoryExpectation(versions),
      legalVersion: legal.version,
      legalManifestSha256: legal.manifestSha256,
    },
  };
};

const publish = (candidate: ReleaseCandidate) =>
  new FileReleaseCandidateStore(vps.config.candidateDirectory).publish(candidate);

const prepareEnvelope = (overrides: Partial<CutoverEnvelope> = {}): CutoverEnvelope => {
  const envelope = createCutoverEnvelope({
    cutoverId: CUTOVER,
    targetSha: vps.targetSha,
    mode: "MAINTENANCE_CUTOVER",
    preDeployTopology: {
      runtime: { frontend: vps.preSha, admin: vps.preSha, commerce: vps.preSha, worker: vps.preSha },
      controlPlane: { productionDeployRefSha: vps.preSha },
    },
    predecessorDatabase: { ref: join(root, "predecessor.sqlite"), sha256: "a".repeat(64) },
    createdAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 24 * 60 * 60_000).toISOString(),
    ...overrides,
  });
  new FileCutoverEnvelopeStore(vps.config.envelopeDirectory).write(envelope);
  // What preparation actually does: the control plane takes commerce down.
  vps.setApplicationStatus("exited:unhealthy");
  return envelope;
};

/** The successor is already serving the target: what a converged deploy looks like. */
const convergeOnTarget = () => {
  vps.serving.frontend = vps.targetSha;
  vps.serving.admin = vps.targetSha;
  vps.setApplicationStatus("running:healthy");
  recordInstance(vps.db, "COMMERCE", "api-1", vps.targetSha, NOW);
  recordInstance(vps.db, "WORKER", "worker-1", vps.targetSha, NOW, NOW.toISOString());
};

const certification = (): CertificationDriver => ({
  issueCapability: vi.fn(async (deploymentSessionId: string) => ({
    id: "capability-1",
    runId: "run-1",
    deploymentSessionId,
    releaseSha: vps.targetSha,
    maxAmountKopecks: 100,
    expiresAt: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
    nonceDigest: "3".repeat(64),
  })),
  preflight: vi.fn(async () => {}),
  certify: vi.fn(async () => {}),
} as unknown as CertificationDriver);

/**
 * The production root with production's convergence attempts but none of its
 * wall-clock time. Tests that never converge still walk the whole bounded wait,
 * so they prove it ends; they just do not spend two minutes proving it.
 */
const INSTANT: ConvergencePolicy = { ...PRODUCTION_CONVERGENCE, sleep: async () => {} };
const build = (config: Parameters<typeof buildProductionRelease>[0], options: BuildOptions = {}) =>
  buildProductionRelease(config, { convergence: INSTANT, ...options });

/**
 * The real root, with the admission guard replaced. Everything the handoff
 * actually runs through - orchestrator, adoption port, session store, deploy
 * ref, deployment driver - is the production wiring.
 */
const cli = (release: ProductionRelease): ProductionRelease =>
  ({ ...release, launchBaselineAdmission: { admit: vi.fn(async () => {}) } }) as ProductionRelease;

describe("the whole path production has to walk, through the real composition root", () => {
  /** The launch config: the cross-lineage engine is composed only with a predecessor. */
  const launchConfig = () => ({
    ...vps.config,
    predecessor: { expectedSha: vps.preSha, expectedLedgerLength: 61, commerceReadyUrl: "https://commerce.invalid/readyz" },
  });

  it("leaves nothing between a converged deploy and the human certification but the human", async () => {
    /**
     * Driven with the REAL certification wiring, not an injected driver.
     *
     * An adopted session used to be created without a `candidateId`. The schema
     * permits that - either a candidate or an adopted cutover satisfies it - and
     * every component test passed, but certification resolves its driver from
     * `session.candidateId`. So a cutover that had already converged and been
     * admitted by readiness failed at `issueCapability` with
     * RELEASE_CANDIDATE_NOT_PUBLISHED and went to recovery instead of to the
     * operator. Deterministic, and invisible until the seam ran.
     */
    prepareEnvelope();
    const candidate = launchCandidate(vps.targetSha);
    publish(candidate);
    convergeOnTarget();
    const release = build(launchConfig(), { now });
    try {
      // No injected certification driver, and no controlling terminal either -
      // which is the point: issuing a capability is not an attended operation
      // and must not require one.
      const code = await runCutoverCommand(cli(release), ["deploy", vps.targetSha, CUTOVER], OWNER);
      expect(code).toBe(13);

      const sessionId = release.authority.deploymentGate().deploymentSessionId!;
      const session = release.sessions.read(sessionId)!;
      // The session remembers which candidate it is for, recorded once at
      // acquisition and never restated.
      expect(session.candidateId).toBe(candidate.id);

      // A capability exists, bound to this session and this release.
      const capability = release.certificationFor(candidate).recoverCapability(sessionId)!;
      expect(capability).toBeDefined();
      expect(capability.deploymentSessionId).toBe(sessionId);
      expect(capability.releaseSha).toBe(candidate.sha);

      // And the cutover is still reversible with the gate shut: nothing has
      // been armed, because arming belongs to the attended half.
      expect(session.rollbackAuthority).toBe("OLD_LINEAGE_ALLOWED");
      expect(release.authority.deploymentGate().closed).toBe(true);
    } finally {
      release.close();
    }
  });

  /**
   * Attempt 4, 2026-09-23: Coolify reported commerce "finished", and 41 ms
   * later the one topology read found no WORKER heartbeat - the container had
   * been up for 1.7 s and had not got that far. Every step was correct and the
   * cutover still went to recovery, because "the deployment job finished" and
   * "the application can be observed" are different events.
   *
   * Each sleep below is one poll interval, and it is where the world moves on:
   * the fixture advances exactly as production did, a step behind Coolify.
   */
  const pollingWorld = (steps: readonly (() => void)[], options: { stepMs?: number } = {}) => {
    let clock = NOW.getTime();
    let slept = 0;
    const current = () => new Date(clock);
    const release = build(launchConfig(), {
      now: current,
      convergence: {
        ...PRODUCTION_CONVERGENCE,
        sleep: async () => {
          clock += options.stepMs ?? 0;
          steps[slept]?.();
          slept += 1;
        },
      },
    });
    return { release, slept: () => slept, current };
  };
  const heartbeat = (id: string, at: Date) =>
    vps.db.prepare("UPDATE runtime_instance_evidence SET heartbeat_at = ? WHERE instance_id = ?").run(at.toISOString(), id);
  const deployOutput = async (release: ProductionRelease) => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { written.push(String(chunk)); return true; });
    try {
      const code = await runCutoverCommand(cli(release), ["deploy", vps.targetSha, CUTOVER], OWNER);
      const line = written.map((entry) => JSON.parse(entry) as Record<string, unknown>).find((entry) => entry.command === "deploy");
      return { code, outcome: line?.outcome, reason: line?.code };
    } finally { spy.mockRestore(); }
  };

  it("waits for the worker and its first sweep instead of racing them, and hands over with 13", async () => {
    prepareEnvelope();
    publish(launchCandidate(vps.targetSha));
    // Coolify has finished: both descriptors and COMMERCE are on the target.
    // The worker has not recorded anything yet.
    vps.serving.frontend = vps.targetSha;
    vps.serving.admin = vps.targetSha;
    vps.setApplicationStatus("running:healthy");
    recordInstance(vps.db, "COMMERCE", "api-1", vps.targetSha, NOW);
    const { release, slept } = pollingWorld([
      // observe #2: a worker, but the old one - valid, and not the target yet.
      () => recordInstance(vps.db, "WORKER", "worker-old", vps.preSha, NOW, NOW.toISOString()),
      // observe #3: the new worker has replaced it; its first sweep is still running.
      () => {
        vps.db.prepare("DELETE FROM runtime_instance_evidence WHERE instance_id = 'worker-old'").run();
        recordInstance(vps.db, "WORKER", "worker-new", vps.targetSha, NOW);
      },
      // readiness #2: the sweep has completed.
      () => vps.db.prepare("UPDATE runtime_instance_evidence SET last_successful_sweep_at = ? WHERE instance_id = 'worker-new'")
        .run(NOW.toISOString()),
    ]);
    try {
      const result = await deployOutput(release);
      expect(result).toEqual({ code: 13, outcome: "AWAITING_OPERATOR", reason: undefined });
      // Two topology waits and one readiness wait, and not one more.
      expect(slept()).toBe(3);
      const session = release.sessions.read(release.authority.deploymentGate().deploymentSessionId!)!;
      expect(session.observedTopology?.runtime).toEqual({
        frontend: vps.targetSha, admin: vps.targetSha, commerce: vps.targetSha, worker: vps.targetSha,
      });
      expect(session.rollbackAuthority).toBe("OLD_LINEAGE_ALLOWED");
    } finally { release.close(); }
  });

  it("gives up on a worker that never appears at the deadline, as recovery that names the worker", async () => {
    prepareEnvelope();
    publish(launchCandidate(vps.targetSha));
    vps.serving.frontend = vps.targetSha;
    vps.serving.admin = vps.targetSha;
    vps.setApplicationStatus("running:healthy");
    recordInstance(vps.db, "COMMERCE", "api-1", vps.targetSha, NOW);
    // Thirty seconds a poll: the whole wait is twelve minutes, well past the
    // five-minute session lease. COMMERCE keeps heartbeating throughout, so the
    // only thing wrong is the worker - and the lease must not become a second
    // failure that hides it.
    const world = pollingWorld(Array.from({ length: 30 }, () => () => heartbeat("api-1", world.current())), { stepMs: 30_000 });
    try {
      const result = await deployOutput(world.release);
      expect(result.code).toBe(12);
      expect(result.outcome).toBe("RECOVERY_REQUIRED");
      expect(result.reason).toBe("TOPOLOGY_UNIT_NOT_RUNNING: WORKER");
      // Bounded: production's deadline over its interval, and then it stopped.
      expect(world.slept()).toBe(PRODUCTION_CONVERGENCE.deadlineMs / PRODUCTION_CONVERGENCE.intervalMs);
      const session = world.release.sessions.read(world.release.authority.deploymentGate().deploymentSessionId!)!;
      expect(session.state).toBe("RECOVERY_REQUIRED");
      expect(session.ownerId).toBe(OWNER);
    } finally { world.release.close(); }
  });

  it("does not wait on a descriptor that is malformed rather than late", async () => {
    prepareEnvelope();
    publish(launchCandidate(vps.targetSha));
    convergeOnTarget();
    // Not a commit at all. No amount of waiting turns this into one.
    vps.serving.frontend = "not-a-commit";
    const { release, slept } = pollingWorld([]);
    try {
      const result = await deployOutput(release);
      expect(result.code).toBe(12);
      expect(result.reason).toMatch(/^TOPOLOGY_SURFACE_COMMIT_INVALID: frontend/);
      expect(slept()).toBe(0);
    } finally { release.close(); }
  });

  it("hands a failed cutover to a different process, which rolls it back without impersonation", async () => {
    /**
     * The 2026-09-23 incident end to end, as one test.
     *
     * Process A adopts, moves the pointer, deploys, cannot observe COMMERCE and
     * exits 12. Process B is a different owner and must be able to roll back
     * immediately - the clock is deliberately NOT advanced, because waiting out
     * a lease that its holder has finished with means keeping production fenced
     * for no reason. Crash recovery still relies on ordinary expiry.
     */
    prepareEnvelope();
    publish(launchCandidate(vps.targetSha));
    // No convergence: COMMERCE never records evidence, so topology throws.
    const processA = build(launchConfig(), { now, certification: certification() });
    let sessionId = "";
    try {
      const code = await runCutoverCommand(cli(processA), ["deploy", vps.targetSha, CUTOVER], OWNER);
      expect(code).toBe(12);
      sessionId = processA.authority.deploymentGate().deploymentSessionId!;
      expect(processA.sessions.read(sessionId)?.state).toBe("RECOVERY_REQUIRED");
    } finally {
      processA.close();
    }

    // Process B: a different owner, no clock advance, no owner impersonation.
    // What is under test is the handoff - that ownership passes immediately
    // because process A stood down, rather than after the full lease term with
    // production fenced throughout. The physical restore that follows is proved
    // end to end in bootstrap-rollback-composition-root.
    const processB = build(launchConfig(), { now, certification: certification() });
    try {
      await expect(processB.bootstrapRollback!.rollback(sessionId, "a-different-runner"))
        .rejects.not.toThrow("DEPLOY_SESSION_NOT_OWNER");
      expect(processB.sessions.read(sessionId)?.ownerId).toBe("a-different-runner");
    } finally {
      processB.close();
    }
  });

  it("stands down after a convergence failure, not only after an unexpected one", async () => {
    // This arrives through `classify()`, not `recovery()`. Standing down lived
    // only in the latter, so a convergence or readiness failure left a live
    // lease behind and the next rollback waited out a term nobody was using.
    prepareEnvelope();
    publish(launchCandidate(vps.targetSha));
    // Partly converged: observable, but not the target.
    vps.serving.frontend = vps.targetSha;
    vps.serving.admin = vps.targetSha;
    recordInstance(vps.db, "COMMERCE", "api-1", vps.preSha, NOW);
    recordInstance(vps.db, "WORKER", "worker-1", vps.preSha, NOW, NOW.toISOString());

    const processA = build(launchConfig(), { now, certification: certification() });
    let sessionId = "";
    try {
      expect(await runCutoverCommand(cli(processA), ["deploy", vps.targetSha, CUTOVER], OWNER)).toBe(12);
      sessionId = processA.authority.deploymentGate().deploymentSessionId!;
    } finally { processA.close(); }

    const processB = build(launchConfig(), { now, certification: certification() });
    try {
      // No clock advance: the lease was stood down, not waited out.
      expect(() => processB.sessions.takeOverExpiredLease(sessionId, "a-different-runner")).not.toThrow();
      expect(processB.sessions.read(sessionId)?.ownerId).toBe("a-different-runner");
    } finally { processB.close(); }
  });

  it("stands down when resume hands a direction back to the operator", async () => {
    // `resume` takes the lease to read the state and then tells the operator to
    // roll back. Keeping the fresh lease it just granted itself would make that
    // rollback wait, with production fenced throughout.
    prepareEnvelope();
    publish(launchCandidate(vps.targetSha));
    const processA = build(launchConfig(), { now, certification: certification() });
    let sessionId = "";
    try {
      expect(await runCutoverCommand(cli(processA), ["deploy", vps.targetSha, CUTOVER], OWNER)).toBe(12);
      sessionId = processA.authority.deploymentGate().deploymentSessionId!;
    } finally { processA.close(); }

    const resumer = build(launchConfig(), { now, certification: certification() });
    try {
      expect(await runCutoverCommand(cli(resumer), ["resume", sessionId], "resuming-runner")).toBe(12);
    } finally { resumer.close(); }

    const processC = build(launchConfig(), { now, certification: certification() });
    try {
      expect(() => processC.sessions.takeOverExpiredLease(sessionId, "yet-another-runner")).not.toThrow();
    } finally { processC.close(); }
  });

  /**
   * Certification legitimately outlasts a lease term.
   *
   * A real payment, an email and a refund have timeouts of 30, 15 and 30
   * minutes, with a synchronous terminal read in the middle. The deploy session
   * lease is five. Nothing can renew it while the operator is doing what they
   * were asked to - the terminal read blocks the event loop - so the writes
   * that follow certification would be refused for a lease that lapsed during
   * the wait, on a release whose money has already moved.
   */
  const certifyingAfter = (elapsedMs: number, outcome: "succeeds" | "fails") => {
    let drift = 0;
    return build(launchConfig(), {
      now: () => new Date(NOW.getTime() + drift),
      certification: {
        issueCapability: vi.fn(),
        preflight: vi.fn(async () => {}),
        certify: vi.fn(async () => {
          // The operator paying, the email arriving, the refund settling.
          drift = elapsedMs;
          // The runtime keeps beating throughout; only the lease would lapse.
          const beat = new Date(NOW.getTime() + drift).toISOString();
          vps.db.prepare("UPDATE runtime_instance_evidence SET heartbeat_at = ?, last_successful_sweep_at = COALESCE(last_successful_sweep_at, ?)")
            .run(beat, beat);
          if (outcome === "fails") throw new Error("PAYMENT_PROVIDER_REJECTED");
        }),
      } as unknown as CertificationDriver,
    });
  };

  it.each([
    ["settles", "succeeds" as const, 0],
    ["reports recovery rather than a bare failure", "fails" as const, 12],
  ])("%s when certification outlasts the lease", async (_label, mode, expected) => {
    prepareEnvelope();
    const candidate = launchCandidate(vps.targetSha);
    publish(candidate);
    convergeOnTarget();

    const processA = build(launchConfig(), { now });
    let sessionId = "";
    try {
      expect(await runCutoverCommand(cli(processA), ["deploy", vps.targetSha, CUTOVER], "runner-a")).toBe(13);
      sessionId = processA.authority.deploymentGate().deploymentSessionId!;
    } finally { processA.close(); }

    // Six minutes: past the five-minute lease, and far short of a real payment.
    const built = certifyingAfter(6 * 60_000, mode);
    try {
      const code = await runCutoverCommand(cli(built), ["certify", sessionId], "runner-b");
      expect(code).toBe(expected);
      // Never a pre-mutation refusal: the money has already moved by here.
      expect(code).not.toBe(20);
    } finally { built.close(); }
  });

  it("carries attempt 5 forward through certify: refused while its capability lives, then certified on -a2", async () => {
    /**
     * 2026-09-23, attempt 5: `certify` armed the release, its first catalogue
     * command was refused, and the session was left armed, in recovery, with a
     * certification run that can never pass. This drives the way out through
     * the CLI and the real composition root, from a capability that `deploy`
     * really issued.
     */
    prepareEnvelope();
    const candidate = launchCandidate(vps.targetSha);
    publish(candidate);
    convergeOnTarget();
    const processA = build(launchConfig(), { now });
    let sessionId = "";
    try {
      expect(await runCutoverCommand(cli(processA), ["deploy", vps.targetSha, CUTOVER], "runner-a")).toBe(13);
      sessionId = processA.authority.deploymentGate().deploymentSessionId!;
    } finally { processA.close(); }

    // What attempt 5 left behind, through the same legal transitions.
    const armed = { kind: "CREATE_OCCURRENCE" as const, idempotencyKey: "k", draft: {
      startsAt: "2026-12-15T15:00:00.000Z", endsAt: "2026-12-15T18:00:00.000Z",
      venueDisclosureText: "Announced later", venueAnnounceBy: "2026-12-08T09:00:00.000Z", cityId: "city",
    } };
    const runs = new SqliteCertificationRunStore(vps.db);
    let first = runs.load(certificationRunId(sessionId))!;
    first = runs.update(first.runId, first.revision, { pendingCommand: armed });
    first = runs.update(first.runId, first.revision, {
      pendingCommand: null, direction: "CLEANUP_STARTED",
      supersededCommand: { command: armed, reason: "CLEANUP_SUPERSEDED_CATALOGUE_OPENING" },
    });
    runs.update(first.runId, first.revision, {
      direction: "CATALOGUE_CLEAN",
      failure: { outcome: "INCOMPLETE", code: "CERTIFICATION_CATALOGUE_COMMAND_FAILED (500)", recordedAt: NOW.toISOString() },
    });
    const attempt5 = build(launchConfig(), { now, certification: certification() });
    try {
      attempt5.sessions.takeOverExpiredLease(sessionId, "runner-b");
      attempt5.sessions.armExternalEffects(sessionId, "runner-b");
      attempt5.sessions.enterRecoveryRequired(sessionId, "runner-b");
      attempt5.sessions.yieldLease(sessionId, "runner-b");
    } finally { attempt5.close(); }

    const certified: string[] = [];
    const operatorAt = (at: Date) => build(launchConfig(), {
      now: () => at,
      certification: {
        issueCapability: vi.fn(),
        preflight: vi.fn(async () => {}),
        certify: vi.fn(async (capability: { runId: string }) => { certified.push(capability.runId); }),
      } as unknown as CertificationDriver,
    });

    // Ten minutes in: the first capability is live, and is not retired early.
    const early = operatorAt(new Date(NOW.getTime() + 10 * 60_000));
    try {
      await expect(runCutoverCommand(cli(early), ["certify", sessionId], "runner-c"))
        .rejects.toThrow("CERTIFICATION_RETRY_CAPABILITY_STILL_LIVE");
    } finally { early.close(); }
    expect(runs.load(retryRunId(sessionId))).toBeUndefined();
    expect(certified).toEqual([]);

    // Past its expiry. The runtime is still up and beating.
    const later = new Date(NOW.getTime() + 4 * 60 * 60_000 + 1_000);
    vps.db.prepare("UPDATE runtime_instance_evidence SET heartbeat_at = ?").run(later.toISOString());
    const late = operatorAt(later);
    try {
      expect(await runCutoverCommand(cli(late), ["certify", sessionId], "runner-c")).toBe(0);
      expect(certified).toEqual([retryRunId(sessionId)]);
      expect(late.sessions.read(sessionId)?.state).toBe("SUCCEEDED");
      expect(late.authority.deploymentGate().closed).toBe(false);

      // `verify` judges the run that certified, not the one that failed - and
      // re-proves from what the first left behind that it did nothing.
      const report = await verifyCutover(late, sessionId);
      expect(report.checks.superseded_certification_had_no_effect).toBe(true);
      expect(report.checks.certification_not_failed).toBe(true);
    } finally { late.close(); }
  });

  it("carries attempt 5's armed session forward to a newer release, and certifies it there", async () => {
    /**
     * The production situation of 2026-09-24, end to end through the CLI and
     * the real composition root: an armed session stuck on an uncertifiable
     * target, carried forward to a newer MAINTENANCE_REQUIRED release, then
     * certified and settled at that release.
     */
    prepareEnvelope();
    publish(launchCandidate(vps.targetSha));
    convergeOnTarget();
    const processA = build(launchConfig(), { now });
    let sessionId = "";
    try {
      expect(await runCutoverCommand(cli(processA), ["deploy", vps.targetSha, CUTOVER], "runner-a")).toBe(13);
      sessionId = processA.authority.deploymentGate().deploymentSessionId!;
    } finally { processA.close(); }

    // Attempt 5: armed, then its first command refused; the run failed clean.
    const runs = new SqliteCertificationRunStore(vps.db);
    let first = runs.load(certificationRunId(sessionId))!;
    first = runs.update(first.runId, first.revision, { direction: "CATALOGUE_CLEAN" });
    runs.update(first.runId, first.revision, { failure: { outcome: "INCOMPLETE", code: "CERTIFICATION_CATALOGUE_COMMAND_FAILED (500)", recordedAt: NOW.toISOString() } });
    const attempt5 = build(launchConfig(), { now, certification: certification() });
    try {
      attempt5.sessions.takeOverExpiredLease(sessionId, "runner-b");
      attempt5.sessions.armExternalEffects(sessionId, "runner-b");
      attempt5.sessions.enterRecoveryRequired(sessionId, "runner-b");
      attempt5.sessions.yieldLease(sessionId, "runner-b");
    } finally { attempt5.close(); }

    // The fixed release lands on main: the same migrations and legal manifest
    // the runtime already carries, on a commit descended from the target.
    const worktree = vps.config.deployRef.worktree;
    mkdirSync(join(worktree, "commerce/migrations"), { recursive: true });
    mkdirSync(join(worktree, "commerce/legal"), { recursive: true });
    for (const name of readdirSync("commerce/migrations").filter((file) => file.endsWith(".sql"))) {
      copyFileSync(join("commerce/migrations", name), join(worktree, "commerce/migrations", name));
    }
    copyFileSync("commerce/legal/production-manifest.json", join(worktree, "commerce/legal/production-manifest.json"));
    git(worktree, "add", "commerce");
    git(worktree, "commit", "-m", "fixed runtime");
    git(worktree, "push", "origin", "main");
    const forwardSha = git(worktree, "rev-parse", "HEAD");
    const forwardCandidate = await deriveCandidate(new GitCommitTreeReader(worktree, defaultGit), { sha: forwardSha, releaseClass: "MAINTENANCE_REQUIRED" });
    publish(forwardCandidate);

    const at = new Date(NOW.getTime() + 10 * 60_000);
    let switched = false;
    const forwardRoot = () => build(launchConfig(), {
      now: () => at,
      installedRunner: async () => ({ sha: forwardSha, tree: "t".repeat(40), candidateTree: "t".repeat(40), clean: true }),
      ciAttestation: { attest: async (sha) => JSON.stringify({ sha, checks: ["test", "docker-build"] }) },
      // The runtime switches a poll after Coolify finishes, as in production.
      convergence: { ...PRODUCTION_CONVERGENCE, sleep: async () => {
        if (switched) return;
        switched = true;
        vps.serving.frontend = forwardSha;
        vps.serving.admin = forwardSha;
        vps.db.prepare("DELETE FROM runtime_instance_evidence").run();
        recordInstance(vps.db, "COMMERCE", "api-2", forwardSha, at);
        recordInstance(vps.db, "WORKER", "worker-2", forwardSha, at, at.toISOString());
      } },
    });

    // An ordinary refusal before any write: an unpublished candidate. Nothing
    // moves.
    const early = forwardRoot();
    try {
      await expect(runCutoverCommand(cli(early), ["forward-deploy", sessionId, "f".repeat(40)], "runner-c"))
        .rejects.toThrow("RELEASE_CANDIDATE_NOT_PUBLISHED");
      expect(early.sessions.forwardTargets(sessionId)).toEqual([]);
      expect(await early.deployRef.read()).toBe(vps.targetSha);
    } finally { early.close(); }

    // Process A has exited after an ordinary refusal. Process B, at the same
    // instant, may claim the session: the refusal stood down its lease.
    const processB = forwardRoot();
    try {
      expect(() => processB.sessions.takeOverExpiredLease(sessionId, "runner-x")).not.toThrow();
      processB.sessions.yieldLease(sessionId, "runner-x");
    } finally { processB.close(); }

    // Still ten minutes in: attempt 5's capability is live for hours yet, and
    // is revoked with the revision instead of waited out.
    const attempt5Capability = (vps.db.prepare("SELECT id FROM certification_capabilities WHERE consumed_at IS NULL AND retired_at IS NULL").get() as { id: string }).id;
    const forward = forwardRoot();
    try {
      expect(await runCutoverCommand(cli(forward), ["forward-deploy", sessionId, forwardSha], "runner-c")).toBe(13);
      expect(forward.sessions.binding(sessionId)).toEqual({ revision: 1, targetSha: forwardSha, candidateId: forwardSha });
      expect(forward.sessions.read(sessionId)).toMatchObject({ targetSha: vps.targetSha, state: "RECOVERY_REQUIRED", rollbackAuthority: "NEW_LINEAGE_ONLY" });
      expect(await forward.deployRef.read()).toBe(forwardSha);
      // Its own certification run and capability; attempt 5's retired.
      expect(runs.load(revisionRunId(sessionId, 1))).toMatchObject({ releaseSha: forwardSha, phase: "NEW", failure: null });
      const live = vps.db.prepare("SELECT run_id, release_sha FROM certification_capabilities WHERE consumed_at IS NULL AND retired_at IS NULL").all();
      expect(live).toEqual([{ run_id: revisionRunId(sessionId, 1), release_sha: forwardSha }]);
      expect(vps.db.prepare("SELECT consumed_at, retirement_reason FROM certification_capabilities WHERE id = ?").get(attempt5Capability))
        .toEqual({ consumed_at: null, retirement_reason: "FORWARD_SUPERSESSION" });
      expect(forward.authority.deploymentGate()).toEqual({ closed: true, deploymentSessionId: sessionId });
    } finally { forward.close(); }

    // The attended half, at the release the session was carried to.
    const certified: string[] = [];
    const operator = build(launchConfig(), {
      now: () => at,
      certification: {
        issueCapability: vi.fn(),
        preflight: vi.fn(async () => {}),
        certify: vi.fn(async (capability: { runId: string }) => { certified.push(capability.runId); }),
      } as unknown as CertificationDriver,
    });
    try {
      expect(await runCutoverCommand(cli(operator), ["certify", sessionId], "runner-d")).toBe(0);
      expect(certified).toEqual([revisionRunId(sessionId, 1)]);
      expect(operator.sessions.read(sessionId)?.state).toBe("SUCCEEDED");
      expect(operator.authority.deploymentGate().closed).toBe(false);

      const report = await verifyCutover(operator, sessionId);
      expect(report.checks).toMatchObject({ runtime_converged: true, deploy_pointer_at_target: true, superseded_revision_0_safe: true });
    } finally { operator.close(); }
  });

  it("still makes a live lease wait, so a running holder is never evicted", async () => {
    // Standing down is the holder's to do. A session whose owner has not stood
    // down and whose lease has not lapsed belongs to that owner, and no other
    // process may take it - which is what keeps the stand-down above from
    // becoming a way to steal a session out from under a running deploy.
    const release = build(launchConfig(), { now, certification: certification() });
    try {
      const held = release.sessions.acquireFenced({
        ownerId: "a-running-deploy", mode: "MAINTENANCE_CUTOVER", targetSha: vps.targetSha,
        candidateId: vps.targetSha,
      }, {
        runtime: { frontend: vps.preSha, admin: vps.preSha, commerce: vps.preSha, worker: vps.preSha },
        controlPlane: { productionDeployRefSha: vps.preSha },
      });
      expect(() => release.sessions.takeOverExpiredLease(held.id, "someone-else"))
        .toThrow("DEPLOY_SESSION_LEASE_NOT_EXPIRED");
      expect(release.sessions.read(held.id)?.ownerId).toBe("a-running-deploy");
    } finally {
      release.close();
    }
  });

  it("hands the session from the deploy process to the attended one without impersonation", async () => {
    /**
     * The seam between `exit 13` and the human.
     *
     * The deploy runs as one SSH invocation and `certify` as another, each with
     * its own `hostname:pid` owner. Nothing carries an owner between them, and
     * `certify` never took over a lease - so arming refused with
     * DEPLOY_SESSION_NOT_OWNER, and because arming sat outside the try blocks
     * that refusal surfaced as exit 20 on a session that was already adopted,
     * deployed, capable and fenced.
     */
    prepareEnvelope();
    const candidate = launchCandidate(vps.targetSha);
    publish(candidate);
    convergeOnTarget();

    // Process A: the real certification wiring issues the capability.
    const processA = build(launchConfig(), { now });
    let sessionId = "";
    try {
      expect(await runCutoverCommand(cli(processA), ["deploy", vps.targetSha, CUTOVER], "runner-a")).toBe(13);
      sessionId = processA.authority.deploymentGate().deploymentSessionId!;
      expect(processA.certificationFor(candidate).recoverCapability(sessionId)).toBeDefined();
    } finally { processA.close(); }

    // Process B: a different owner, no clock advance, no owner impersonation.
    // The certification ports are substituted only past the lease/session/
    // capability seam - what is under test is that arming succeeds as owner B.
    const armed: string[] = [];
    const processB = build(launchConfig(), {
      now,
      certification: {
        issueCapability: vi.fn(),
        preflight: vi.fn(async () => {}),
        certify: vi.fn(async () => { armed.push("certified"); }),
      } as unknown as CertificationDriver,
    });
    try {
      const code = await runCutoverCommand(cli(processB), ["certify", sessionId], "runner-b");
      expect(code).not.toBe(20);
      expect(armed).toEqual(["certified"]);
      const session = processB.sessions.read(sessionId)!;
      expect(session.ownerId).toBe("runner-b");
      // Crossing the arming boundary is what makes the release irreversible.
      expect(session.rollbackAuthority).toBe("NEW_LINEAGE_ONLY");
    } finally { processB.close(); }
  });
});

describe("a prepared cutover has exactly two legal successors", () => {
  /**
   * The conceptual hole behind the 2026-09-23 outage, stated directly.
   *
   * `prepare-bootstrap` crosses a destructive boundary. Whatever happens next,
   * the operator must have somewhere to go: forward by adopting the handoff, or
   * back by restoring the predecessor from it. A state with neither is an
   * outage with no owner, which is exactly what shipped.
   */
  it("routes forward to deploy and back to rollback-prepared, and nowhere else", async () => {
    prepareEnvelope();
    publish(launchCandidate(vps.targetSha));
    convergeOnTarget();
    // The cross-lineage recovery engine is composed only where a predecessor is
    // configured, which is exactly the launch case this routing is about.
    const release = build({
      ...vps.config,
      predecessor: { expectedSha: vps.preSha, expectedLedgerLength: 61, commerceReadyUrl: "https://commerce.invalid/readyz" },
    }, { now, certification: certification() });
    try {
      const runner = cli(release);
      // Backward: the prepared cutover is addressable by its own id, with no
      // session in existence.
      expect(release.authority.deploymentGate().deploymentSessionId).toBeNull();
      expect(release.bootstrapRollback?.isPreparedStarted(CUTOVER)).toBe(false);

      // `rollback` speaks for a session, so it cannot reach a prepared cutover
      // by that name - which is why the second command has to exist.
      await expect(runCutoverCommand(runner, ["rollback", CUTOVER], OWNER)).rejects.toThrow();

      // Forward: the same handoff, adopted.
      await expect(runCutoverCommand(runner, ["deploy", vps.targetSha, CUTOVER], OWNER)).resolves.toBe(13);
      expect(release.envelopes.isConsumed(CUTOVER)).toBe(true);

      // And once adopted, the prepared route closes behind it: ownership has
      // moved to the session, and the two paths can never both be live.
      await expect(runCutoverCommand(runner, ["rollback-prepared", CUTOVER], OWNER))
        .rejects.toThrow("PREPARED_ROLLBACK_OWNED_BY_SUCCESSOR_SESSION");
    } finally {
      release.close();
    }
  });
});

describe("the launch cutover handoff is consumed by the deploy that follows it", () => {
  it("adopts the prepared envelope instead of re-reading an archived predecessor", async () => {
    // The regression. Before the adoption port existed this threw
    // LAUNCH_CUTOVER_REQUIRES_PREDECESSOR_READER, because the harness database
    // carries the launch lineage - exactly what prepare-bootstrap leaves behind.
    const envelope = prepareEnvelope();
    publish(launchCandidate(vps.targetSha));
    convergeOnTarget();
    const release = build(vps.config, { now, certification: certification() });
    try {
      const code = await runCutoverCommand(cli(release), ["deploy", vps.targetSha, CUTOVER], OWNER);
      expect(code).toBe(13);

      const sessionId = release.authority.deploymentGate().deploymentSessionId;
      expect(sessionId).toBeTruthy();
      expect(release.sessions.read(sessionId!)?.adoptedCutoverId).toBe(CUTOVER);
      // The filesystem half is marked only after the database committed, so a
      // consumed envelope is the proof the handoff completed in that order.
      expect(release.envelopes.isConsumed(envelope.cutoverId)).toBe(true);
    } finally {
      release.close();
    }
  });

  it("judges the release against the frozen snapshot, not a fresh read of the successor", async () => {
    prepareEnvelope();
    publish(launchCandidate(vps.targetSha));
    convergeOnTarget();
    const release = build(vps.config, { now, certification: certification() });
    try {
      await runCutoverCommand(cli(release), ["deploy", vps.targetSha, CUTOVER], OWNER);
      const sessionId = release.authority.deploymentGate().deploymentSessionId!;
      const session = release.sessions.read(sessionId)!;
      // The predecessor vector the envelope froze, not the target the runtime
      // is now serving. A rollback is judged against this.
      expect(session.preDeployTopology).toEqual({
        runtime: { frontend: vps.preSha, admin: vps.preSha, commerce: vps.preSha, worker: vps.preSha },
        controlPlane: { productionDeployRefSha: vps.preSha },
      });
      expect(session.adoptedCutoverId).toBe(CUTOVER);
    } finally {
      release.close();
    }
  });

  it("reports an unobservable runtime after adoption as recovery, never as a pre-mutation refusal", async () => {
    /**
     * The 2026-09-23 incident exactly. The envelope was consumed, the pointer
     * had moved and all three applications were deployed - and then the
     * successor could not be observed, the exception escaped the outcome
     * classifier, and the CLI reported 20: "refused before mutation". Acting on
     * that would have meant running rollback-prepared against an adopted
     * cutover.
     */
    prepareEnvelope();
    publish(launchCandidate(vps.targetSha));
    // Deliberately no convergence: COMMERCE never records instance evidence,
    // so the canonical topology reader throws.
    const release = build(vps.config, { now, certification: certification() });
    try {
      const code = await runCutoverCommand(cli(release), ["deploy", vps.targetSha, CUTOVER], OWNER);
      expect(code).toBe(12);
      expect(code).not.toBe(20);

      const sessionId = release.authority.deploymentGate().deploymentSessionId!;
      expect(sessionId).toBeTruthy();
      expect(release.sessions.read(sessionId)?.state).toBe("RECOVERY_REQUIRED");
      // The mutations that make 20 a lie really did happen.
      expect(release.envelopes.isConsumed(CUTOVER)).toBe(true);
    } finally {
      release.close();
    }
  });

  it("refuses a launch deploy that names no prepared cutover, before any mutation", async () => {
    prepareEnvelope();
    publish(launchCandidate(vps.targetSha));
    const release = build(vps.config, { now, certification: certification() });
    try {
      await expect(runCutoverCommand(cli(release), ["deploy", vps.targetSha], OWNER))
        .rejects.toThrow("LAUNCH_DEPLOY_REQUIRES_PREPARED_CUTOVER");
      expect(release.authority.deploymentGate().deploymentSessionId).toBeNull();
      expect(release.envelopes.isConsumed(CUTOVER)).toBe(false);
      expect(vps.calls).toHaveLength(0);
    } finally {
      release.close();
    }
  });

  it("refuses to adopt a cutover prepared for a different release", async () => {
    prepareEnvelope({ targetSha: vps.preSha });
    publish(launchCandidate(vps.targetSha));
    const release = build(vps.config, { now, certification: certification() });
    try {
      await expect(runCutoverCommand(cli(release), ["deploy", vps.targetSha, CUTOVER], OWNER))
        .rejects.toThrow("CUTOVER_ENVELOPE_TARGET_MISMATCH");
      expect(release.authority.deploymentGate().deploymentSessionId).toBeNull();
      expect(release.envelopes.isConsumed(CUTOVER)).toBe(false);
    } finally {
      release.close();
    }
  });

  it("refuses a cutover id that was never prepared", async () => {
    publish(launchCandidate(vps.targetSha));
    const release = build(vps.config, { now, certification: certification() });
    try {
      await expect(runCutoverCommand(cli(release), ["deploy", vps.targetSha, "never-prepared"], OWNER))
        .rejects.toThrow("CUTOVER_ENVELOPE_NOT_FOUND");
      expect(release.authority.deploymentGate().deploymentSessionId).toBeNull();
    } finally {
      release.close();
    }
  });

  it("refuses a second deploy of an already adopted cutover and leaves its session alone", async () => {
    prepareEnvelope();
    publish(launchCandidate(vps.targetSha));
    convergeOnTarget();
    const first = build(vps.config, { now, certification: certification() });
    let sessionId: string;
    try {
      await runCutoverCommand(cli(first), ["deploy", vps.targetSha, CUTOVER], OWNER);
      sessionId = first.authority.deploymentGate().deploymentSessionId!;
    } finally {
      first.close();
    }

    const second = build(vps.config, { now, certification: certification() });
    try {
      // One handoff, one session. A second deploy must not mint a rival owner
      // of the same closed gate, and must not restart the one that exists -
      // that is what `resume` is for.
      await expect(runCutoverCommand(cli(second), ["deploy", vps.targetSha, CUTOVER], OWNER))
        .rejects.toThrow("CUTOVER_ALREADY_ADOPTED");
      expect(second.authority.deploymentGate().deploymentSessionId).toBe(sessionId);
      expect(second.sessions.read(sessionId)?.state).toBe("DEPLOYING");
    } finally {
      second.close();
    }
  });
});
