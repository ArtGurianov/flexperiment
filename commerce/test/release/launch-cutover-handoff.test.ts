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
  // What preparation actually does to the Compose application: it stops it.
  // Modelling that is the difference between this suite and the one that was
  // green while production refused with COMPOSE_ROLLBACK_CONTAINERS_MISSING.
  vps.compose.stop();
  return envelope;
};

/** The successor is already serving the target: what a converged deploy looks like. */
const convergeOnTarget = () => {
  vps.serving.frontend = vps.targetSha;
  vps.serving.admin = vps.targetSha;
  vps.compose.addImage(vps.targetSha);
  vps.compose.start(vps.targetSha);
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
    }, { now, certification: certification(), composeRollbackEvidence: vps.compose });
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
    const release = buildProductionRelease(vps.config, { now, certification: certification(), composeRollbackEvidence: vps.compose });
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
    const release = buildProductionRelease(vps.config, { now, certification: certification(), composeRollbackEvidence: vps.compose });
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

  it("refuses a launch deploy that names no prepared cutover, before any mutation", async () => {
    prepareEnvelope();
    publish(launchCandidate(vps.targetSha));
    const release = buildProductionRelease(vps.config, { now, certification: certification(), composeRollbackEvidence: vps.compose });
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
    const release = buildProductionRelease(vps.config, { now, certification: certification(), composeRollbackEvidence: vps.compose });
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
    const release = buildProductionRelease(vps.config, { now, certification: certification(), composeRollbackEvidence: vps.compose });
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
    const first = buildProductionRelease(vps.config, { now, certification: certification(), composeRollbackEvidence: vps.compose });
    let sessionId: string;
    try {
      await runCutoverCommand(cli(first), ["deploy", vps.targetSha, CUTOVER], OWNER);
      sessionId = first.authority.deploymentGate().deploymentSessionId!;
    } finally {
      first.close();
    }

    const second = buildProductionRelease(vps.config, { now, certification: certification(), composeRollbackEvidence: vps.compose });
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
