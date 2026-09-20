import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProductionReleaseConfig, ReleaseConfigError } from "../../src/release/production-config";
import { buildProductionRelease, holdSalesOnSignal, ReleaseRunnerError, ReleaseRunnerLock } from "../../src/release/production-runner";
import { harness, recordInstance, type Harness } from "../support/production-runner-harness";

const NOW = new Date("2026-09-20T12:00:00.000Z");
const now = () => NOW;

let root: string;
let vps: Harness;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "release-runner-"));
  vps = await harness(root);
});
afterEach(async () => { await vps.close(); });

const journal = (path: string) => readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

describe("the production composition root", () => {
  it("builds every port and reads production through them", async () => {
    recordInstance(vps.db, "COMMERCE", "api-1", vps.preSha, NOW);
    recordInstance(vps.db, "WORKER", "worker-1", vps.preSha, NOW, NOW.toISOString());

    const release = buildProductionRelease(vps.config, { now });
    try {
      // The whole point of the root: an observation that came out of a real
      // git remote, a real HTTP surface and a real database, not a fixture.
      expect(await release.ports.topology.observe()).toEqual({
        runtime: { frontend: vps.preSha, admin: vps.preSha, commerce: vps.preSha, worker: vps.preSha },
        controlPlane: { productionDeployRefSha: vps.preSha },
      });
      const evidence = await release.ports.evidence.read();
      expect(evidence.commerce?.sourceCommit).toBe(vps.preSha);
      expect(evidence.schema.lineage).toBe("SUPPORTED");
    } finally {
      release.close();
    }
  });

  it("refuses a maintenance cutover before touching anything when certification is unwired", async () => {
    recordInstance(vps.db, "COMMERCE", "api-1", vps.preSha, NOW);
    recordInstance(vps.db, "WORKER", "worker-1", vps.preSha, NOW, NOW.toISOString());
    const release = buildProductionRelease(vps.config, { now });
    try {
      const candidate = { id: "c-1", sha: vps.targetSha, releaseClass: "LAUNCH_BASELINE" as const,
        expectation: { schemaInventory: "x", legalVersion: "v", legalManifestSha256: "e".repeat(64) } };

      await expect(release.orchestrator.runMaintenanceCutover({ ownerId: "runner", candidate }))
        .rejects.toThrow("CUTOVER_REQUIRES_CERTIFICATION_DRIVER");

      // Refused before the first mutation: no session, no closed gate, and the
      // pointer still where production left it. A partially wired root must
      // cost a refusal, never a half-run cutover.
      expect(release.authority.deploymentGate().closed).toBe(false);
      expect(await release.deployRef.read()).toBe(vps.preSha);
      expect(vps.calls).toEqual([]);
    } finally {
      release.close();
    }
  });

  it("drives a real deployment through the wired Coolify and git adapters", async () => {
    recordInstance(vps.db, "COMMERCE", "api-1", vps.preSha, NOW);
    recordInstance(vps.db, "WORKER", "worker-1", vps.preSha, NOW, NOW.toISOString());
    const release = buildProductionRelease(vps.config, { now });
    try {
      await release.deployment.deploy(vps.targetSha);
      // The pointer moved first, and the three applications were each asked to
      // deploy and then followed to a terminal state.
      expect(await release.deployRef.read()).toBe(vps.targetSha);
      expect(vps.calls.filter((call) => call === "POST /api/v1/deploy").length).toBe(3);
      expect(journal(vps.config.journalPath).some((line) => line.event === "deployment.progress")).toBe(true);
    } finally {
      release.close();
    }
  });

  it("writes an envelope that survives the database being replaced", () => {
    const release = buildProductionRelease(vps.config, { now });
    try {
      expect(existsSync(vps.config.envelopeDirectory)).toBe(true);
      // The envelope directory is outside the database file, which is the only
      // reason a handoff can outlive the lineage boundary at all.
      expect(vps.config.envelopeDirectory.startsWith(root)).toBe(true);
      expect(vps.config.envelopeDirectory).not.toContain(vps.config.databasePath);
    } finally {
      release.close();
    }
  });
});

describe("what the runner refuses to start without", () => {
  const complete = () => ({
    FLEXPERIMENT_RELEASE_DATABASE: vps.config.databasePath,
    FLEXPERIMENT_RELEASE_ARCHIVE_DIR: vps.config.archiveDirectory,
    FLEXPERIMENT_RELEASE_ENVELOPE_DIR: vps.config.envelopeDirectory,
    FLEXPERIMENT_RELEASE_LOCK: vps.config.lockPath,
    FLEXPERIMENT_RELEASE_JOURNAL: vps.config.journalPath,
    COOLIFY_API_URL: vps.config.coolify.apiUrl,
    COOLIFY_TOKEN: "test-token",
    COOLIFY_APPLICATION_FRONTEND: "app-frontend",
    COOLIFY_APPLICATION_ADMIN: "app-admin",
    COOLIFY_APPLICATION_COMMERCE: "app-commerce",
    FLEXPERIMENT_FRONTEND_RELEASE_URL: vps.config.topology.frontendReleaseUrl,
    FLEXPERIMENT_ADMIN_RELEASE_URL: vps.config.topology.adminReleaseUrl,
    FLEXPERIMENT_DEPLOY_REF_REMOTE: vps.config.deployRef.remote,
    FLEXPERIMENT_DEPLOY_REF_WORKTREE: vps.config.deployRef.worktree,
  });

  it("names every missing component at once, not one per run", () => {
    const partial = complete();
    delete (partial as Record<string, unknown>).COOLIFY_TOKEN;
    delete (partial as Record<string, unknown>).FLEXPERIMENT_RELEASE_LOCK;
    delete (partial as Record<string, unknown>).COOLIFY_APPLICATION_ADMIN;

    // Each start that gets further is a process that takes the lock, reads the
    // pointer and could open a session before failing on the next absent field.
    try {
      loadProductionReleaseConfig(partial as unknown as NodeJS.ProcessEnv);
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as ReleaseConfigError).code).toBe("RELEASE_RUNNER_CONFIGURATION_INCOMPLETE");
      expect((error as Error).message).toContain("FLEXPERIMENT_RELEASE_LOCK");
      expect((error as Error).message).toContain("COOLIFY_TOKEN");
      expect((error as Error).message).toContain("COOLIFY_APPLICATION_ADMIN");
    }
  });

  it("refuses three applications that are not three", () => {
    const collapsed = { ...complete(), COOLIFY_APPLICATION_ADMIN: "app-frontend" };
    expect(() => loadProductionReleaseConfig(collapsed as unknown as NodeJS.ProcessEnv)).toThrow("must be distinct");
  });

  it("refuses a topology endpoint a network could rewrite", () => {
    const plain = { ...complete(), FLEXPERIMENT_FRONTEND_RELEASE_URL: "http://example.invalid/release.json" };
    expect(() => loadProductionReleaseConfig(plain as unknown as NodeJS.ProcessEnv)).toThrow("must be https, or loopback");
  });

  it("refuses to build when the database it was pointed at is not there", () => {
    expect(() => buildProductionRelease({ ...vps.config, databasePath: join(root, "absent.sqlite") }, { now }))
      .toThrow("RELEASE_RUNNER_PATH_MISSING");
    // And the lock was never taken, so the next attempt is not blocked by it.
    expect(existsSync(vps.config.lockPath)).toBe(false);
  });

  it("keeps the token and the remote credential out of the journal", () => {
    const credentialed = { ...vps.config, deployRef: { ...vps.config.deployRef, remote: "https://user:s3cret@git.example.invalid/repo.git" } };
    const release = buildProductionRelease(credentialed, { now });
    try {
      const written = readFileSync(vps.config.journalPath, "utf8");
      expect(written).not.toContain("test-token");
      expect(written).not.toContain("s3cret");
      expect(written).toContain("git.example.invalid");
    } finally {
      release.close();
    }
  });
});

describe("one cutover at a time", () => {
  it("refuses a second runner while the first is alive", () => {
    const first = ReleaseRunnerLock.acquire(vps.config.lockPath, now);
    try {
      expect(() => ReleaseRunnerLock.acquire(vps.config.lockPath, now)).toThrow("RELEASE_RUNNER_LOCKED");
    } finally {
      first.release();
    }
    // Released, so the next runner may start.
    ReleaseRunnerLock.acquire(vps.config.lockPath, now).release();
  });

  it("claims a lock whose holder is gone, because the session is the real authority", () => {
    // A killed runner must not be recoverable only by an operator deleting a
    // file, at the moment the fence is up and sales are shut. Ownership is
    // still decided by the deploy session's lease, not by this.
    mkdirSync(dirname(vps.config.lockPath), { recursive: true });
    writeFileSync(vps.config.lockPath, JSON.stringify({ pid: 2 ** 30, acquiredAt: NOW.toISOString() }));
    ReleaseRunnerLock.acquire(vps.config.lockPath, now).release();
  });

  it("treats an unreadable lock as held rather than as absent", () => {
    mkdirSync(dirname(vps.config.lockPath), { recursive: true });
    writeFileSync(vps.config.lockPath, "not json");
    expect(() => ReleaseRunnerLock.acquire(vps.config.lockPath, now)).toThrow("RELEASE_RUNNER_LOCKED");
  });

  it("frees the lock when the build fails after taking it", () => {
    expect(() => buildProductionRelease({ ...vps.config, coolify: { ...vps.config.coolify, token: " " } }, { now }))
      .toThrow("COOLIFY_TOKEN_MISSING");
    expect(existsSync(vps.config.lockPath)).toBe(false);
  });
});

describe("what a signal may and may not do", () => {
  it("records the interruption, releases the lock, and never opens sales", () => {
    const release = buildProductionRelease(vps.config, { now });
    const codes: number[] = [];
    const handler = holdSalesOnSignal(release, ((code: number) => { codes.push(code); }) as (code: number) => never);
    try {
      handler("SIGTERM");

      expect(codes).toEqual([130]);
      const lines = journal(vps.config.journalPath);
      expect(lines.at(-1)).toMatchObject({ event: "runner.interrupted", signal: "SIGTERM" });
      // The lock is gone so a resume can run; nothing touched the gate.
      expect(existsSync(vps.config.lockPath)).toBe(false);
      // A second signal must not double-release or double-record.
      handler("SIGINT");
      expect(codes).toEqual([130]);
      expect(journal(vps.config.journalPath).filter((line) => line.event === "runner.interrupted").length).toBe(1);
    } finally {
      process.removeListener("SIGTERM", handler);
      process.removeListener("SIGINT", handler);
    }
  });
});
