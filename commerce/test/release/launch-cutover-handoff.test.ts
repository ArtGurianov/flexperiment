import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
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
import { buildProductionRelease, type ProductionRelease } from "../../src/release/production-runner";
import { harness, recordInstance, type Harness } from "../support/production-runner-harness";

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
    const release = buildProductionRelease(launchConfig(), { now });
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
    const processA = buildProductionRelease(launchConfig(), { now, certification: certification() });
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
    const processB = buildProductionRelease(launchConfig(), { now, certification: certification() });
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

    const processA = buildProductionRelease(launchConfig(), { now, certification: certification() });
    let sessionId = "";
    try {
      expect(await runCutoverCommand(cli(processA), ["deploy", vps.targetSha, CUTOVER], OWNER)).toBe(12);
      sessionId = processA.authority.deploymentGate().deploymentSessionId!;
    } finally { processA.close(); }

    const processB = buildProductionRelease(launchConfig(), { now, certification: certification() });
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
    const processA = buildProductionRelease(launchConfig(), { now, certification: certification() });
    let sessionId = "";
    try {
      expect(await runCutoverCommand(cli(processA), ["deploy", vps.targetSha, CUTOVER], OWNER)).toBe(12);
      sessionId = processA.authority.deploymentGate().deploymentSessionId!;
    } finally { processA.close(); }

    const resumer = buildProductionRelease(launchConfig(), { now, certification: certification() });
    try {
      expect(await runCutoverCommand(cli(resumer), ["resume", sessionId], "resuming-runner")).toBe(12);
    } finally { resumer.close(); }

    const processC = buildProductionRelease(launchConfig(), { now, certification: certification() });
    try {
      expect(() => processC.sessions.takeOverExpiredLease(sessionId, "yet-another-runner")).not.toThrow();
    } finally { processC.close(); }
  });

  it("still makes a live lease wait, so a running holder is never evicted", async () => {
    // Standing down is the holder's to do. A session whose owner has not stood
    // down and whose lease has not lapsed belongs to that owner, and no other
    // process may take it - which is what keeps the stand-down above from
    // becoming a way to steal a session out from under a running deploy.
    const release = buildProductionRelease(launchConfig(), { now, certification: certification() });
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
    const processA = buildProductionRelease(launchConfig(), { now });
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
    const processB = buildProductionRelease(launchConfig(), {
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
    const release = buildProductionRelease({
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
    const release = buildProductionRelease(vps.config, { now, certification: certification() });
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
    const release = buildProductionRelease(vps.config, { now, certification: certification() });
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
    const release = buildProductionRelease(vps.config, { now, certification: certification() });
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
    const release = buildProductionRelease(vps.config, { now, certification: certification() });
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
    const release = buildProductionRelease(vps.config, { now, certification: certification() });
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
    const release = buildProductionRelease(vps.config, { now, certification: certification() });
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
    const first = buildProductionRelease(vps.config, { now, certification: certification() });
    let sessionId: string;
    try {
      await runCutoverCommand(cli(first), ["deploy", vps.targetSha, CUTOVER], OWNER);
      sessionId = first.authority.deploymentGate().deploymentSessionId!;
    } finally {
      first.close();
    }

    const second = buildProductionRelease(vps.config, { now, certification: certification() });
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
