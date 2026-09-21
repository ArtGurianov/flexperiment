import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProductionReleaseConfig, loadReadOnlyReleaseConfig, ReleaseConfigError } from "../../src/release/production-config";
import { buildProductionRelease, buildReadOnlyRelease, holdSalesOnSignal, ReleaseRunnerLock } from "../../src/release/production-runner";
import Database from "better-sqlite3";
import { harness, recordInstance, type Harness } from "../support/production-runner-harness";
import { TEST_CAPABILITY_KEY } from "../support/certification-secret";

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

  it("refuses to build a certification driver where nobody is watching", () => {
    // The composition is what enforces attendance. `certificationFor` opens the
    // controlling terminal, and a test runner has none - which is exactly the
    // position an unattended dispatch is in. It is built lazily, so a command
    // that never certifies never asks for one.
    const release = buildProductionRelease(vps.config, { now });
    try {
      const candidate = {
        id: vps.targetSha, sha: vps.targetSha, releaseClass: "LAUNCH_BASELINE" as const,
        expectation: { schemaInventory: "inventory-sha256:" + "0".repeat(64), legalVersion: "v", legalManifestSha256: "e".repeat(64) },
      };
      expect(() => release.certificationFor(candidate)).toThrow("CERTIFICATION_REQUIRES_ATTENDED_TERMINAL");
      // Nothing was touched by the refusal.
      expect(release.authority.deploymentGate().closed).toBe(false);
      expect(vps.calls).toEqual([]);
    } finally {
      release.close();
    }
  });

  it("refuses to certify a session whose candidate was never published", async () => {
    // The release a session is for is read back from the session, never
    // restated, so a cutover cannot be certified against a different release
    // than it deployed.
    const release = buildProductionRelease(vps.config, { now });
    try {
      await expect(release.ports.certification!.issueCapability("no-such-session"))
        .rejects.toThrow("RELEASE_CANDIDATE_NOT_PUBLISHED");
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
    FLEXPERIMENT_RELEASE_CANDIDATE_DIR: vps.config.candidateDirectory,
    CERTIFICATION_ADMIN_BASE_URL: vps.config.certification.adminBaseUrl,
    CERTIFICATION_PUBLIC_BASE_URL: vps.config.certification.publicBaseUrl,
    CERTIFICATION_ADMIN_TOKEN: "certification-token",
    CERTIFICATION_CAPABILITY_KEY: TEST_CAPABILITY_KEY,
    CERTIFICATION_CITY_SLUG: "test-city",
    CERTIFICATION_OCCURRENCE_SCOPE: vps.config.certification.occurrenceScopePath,
    CERTIFICATION_CHECKOUT_BODY: vps.config.certification.checkoutBodyPath,
    COOLIFY_API_URL: vps.config.coolify.apiUrl,
    COOLIFY_TOKEN: "test-token",
    COOLIFY_SERVER_UUID: "server-1",
    COOLIFY_APPLICATION_FRONTEND: "app-frontend",
    COOLIFY_APPLICATION_ADMIN: "app-admin",
    COOLIFY_APPLICATION_COMMERCE: "app-commerce",
    COOLIFY_APPLICATION_COMMERCE_ID: "3",
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

describe("looking at production is a different program from changing it", () => {
  const readOnlyEnv = () => ({
    FLEXPERIMENT_RELEASE_DATABASE: vps.config.databasePath,
    FLEXPERIMENT_FRONTEND_RELEASE_URL: vps.config.topology.frontendReleaseUrl,
    FLEXPERIMENT_ADMIN_RELEASE_URL: vps.config.topology.adminReleaseUrl,
    FLEXPERIMENT_DEPLOY_REF_REMOTE: vps.config.deployRef.remote,
    FLEXPERIMENT_DEPLOY_REF_WORKTREE: vps.config.deployRef.worktree,
  });

  it("observes both layers with no writer in the composition at all", async () => {
    recordInstance(vps.db, "COMMERCE", "api-1", vps.preSha, NOW);
    recordInstance(vps.db, "WORKER", "worker-1", vps.preSha, NOW, NOW.toISOString());

    const release = buildReadOnlyRelease(loadReadOnlyReleaseConfig(readOnlyEnv() as unknown as NodeJS.ProcessEnv), { now });
    try {
      expect(await release.topology.observe()).toEqual({
        runtime: { frontend: vps.preSha, admin: vps.preSha, commerce: vps.preSha, worker: vps.preSha },
        controlPlane: { productionDeployRefSha: vps.preSha },
      });
      // Safety by construction: there is no object here that could deploy,
      // roll back, move the pointer, issue a capability or rename a database.
      expect(Object.keys(release).sort()).toEqual(["close", "evidence", "topology"]);
      expect("compareAndSet" in (release.topology as unknown as Record<string, unknown>)).toBe(false);
    } finally {
      release.close();
    }
  });

  it("needs none of the writer configuration to start", () => {
    // Every Coolify variable, the archive directory, the lock and the journal
    // are absent, and the read side still loads. If it needed them, an operator
    // would have to put a deploy token on the host to run a read.
    const config = loadReadOnlyReleaseConfig(readOnlyEnv() as unknown as NodeJS.ProcessEnv);
    expect(Object.keys(config).sort()).toEqual(["databasePath", "deployRef", "topology"]);
    expect(JSON.stringify(config)).not.toContain("token");
  });

  it("ignores writer variables that happen to be exported", () => {
    // Picking up a token that is merely present in the environment is how a
    // read-only command quietly becomes one that could have written.
    const polluted = { ...readOnlyEnv(), COOLIFY_TOKEN: "leaked", COOLIFY_API_URL: vps.config.coolify.apiUrl };
    expect(JSON.stringify(loadReadOnlyReleaseConfig(polluted as unknown as NodeJS.ProcessEnv))).not.toContain("leaked");
  });

  it("opens the database read-only, so a defect in a reader cannot write", () => {
    const release = buildReadOnlyRelease(loadReadOnlyReleaseConfig(readOnlyEnv() as unknown as NodeJS.ProcessEnv), { now });
    try {
      const write = () => new Database(vps.config.databasePath, { readonly: true })
        .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES ('x', 'y')").run();
      expect(write).toThrow(/readonly/i);
    } finally {
      release.close();
    }
  });
});

describe("the predecessor bridge is present only while there is a predecessor", () => {
  it("is absent on a launched database, so no later release can reach for it", () => {
    // The harness migrates the database, so the launch lineage is already
    // there. The bridge is not gated by a flag - it is simply not in the
    // composition.
    const release = buildProductionRelease({ ...vps.config, predecessor: {
      expectedSha: "7".repeat(40), expectedLedgerLength: 61,
      commerceReadyUrl: "https://commerce.invalid/readyz",
    } }, { now });
    try {
      expect(release.ports.predecessor).toBeUndefined();
    } finally {
      release.close();
    }
  });

  it("is absent when no predecessor is configured at all", () => {
    const release = buildProductionRelease(vps.config, { now });
    try {
      expect(release.ports.predecessor).toBeUndefined();
      expect(vps.config.predecessor).toBeUndefined();
    } finally {
      release.close();
    }
  });
});
