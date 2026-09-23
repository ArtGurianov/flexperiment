import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCutoverCommand } from "../../../scripts/release/cutover-runner";
import type { ReleaseCandidate } from "../../src/release/candidate";
import { FileReleaseCandidateStore } from "../../src/release/candidate-store";
import { buildProductionRelease, type ProductionRelease } from "../../src/release/production-runner";
import { git, harness } from "../support/production-runner-harness";

const CURRENT = "a".repeat(40);
const STALE = "b".repeat(40);

const candidate = (sha: string): ReleaseCandidate => ({
  id: sha,
  sha,
  releaseClass: "LAUNCH_BASELINE",
  expectation: {
    schemaInventory: `inventory-sha256:${"1".repeat(64)}`,
    legalVersion: "2026-09-20.1",
    legalManifestSha256: "2".repeat(64),
  },
});

type Mutations = ReturnType<typeof mutationSpies>;
const mutationSpies = () => ({
  prepare: vi.fn(async ({ targetSha }: { targetSha: string }) => ({
    envelope: { cutoverId: "cutover-1" }, alreadyPrepared: false, targetSha,
  })),
  deploy: vi.fn(async () => ({ kind: "AWAITING_OPERATOR", session: { id: "session-1", state: "FENCED" } })),
});

const release = (
  store: FileReleaseCandidateStore,
  admit: (value: ReleaseCandidate) => Promise<void>,
  mutations: Mutations,
): ProductionRelease => ({
  candidates: store,
  launchBaselineAdmission: { admit: vi.fn(admit) },
  bootstrapPreparation: { prepare: mutations.prepare },
  journal: { record: vi.fn() },
  sessions: { yieldLease: vi.fn() },
  orchestrator: {
    runMaintenanceCutover: mutations.deploy,
    runRolling: vi.fn(() => { throw new Error("rolling path must not run"); }),
  },
}) as unknown as ProductionRelease;

let directory: string;
let store: FileReleaseCandidateStore;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "release-candidates-"));
  store = new FileReleaseCandidateStore(directory);
});

const artifactHash = (sha: string) => createHash("sha256").update(readFileSync(join(directory, `${sha}.json`))).digest("hex");
const refuseStale = async (value: ReleaseCandidate) => {
  if (value.sha !== CURRENT) throw new Error("LAUNCH_BASELINE_MUST_BE_MAIN_TIP");
};

describe("cutover runner launch-baseline admission", () => {
  it("keeps a stale historical artifact readable but refuses prepare-bootstrap without mutations", async () => {
    store.publish(candidate(STALE));
    const before = artifactHash(STALE);
    const mutations = mutationSpies();
    const runner = release(store, refuseStale, mutations);

    expect(store.get(STALE)).toEqual(candidate(STALE));
    await expect(runCutoverCommand(runner, ["prepare-bootstrap", STALE, "2026-09-22T00:00:00.000Z"], "owner"))
      .rejects.toThrow("LAUNCH_BASELINE_MUST_BE_MAIN_TIP");

    expect(mutations.prepare).not.toHaveBeenCalled();
    expect(artifactHash(STALE)).toBe(before);
  });

  it("refuses a stale initial deploy before journal, session, ref, database, gate or Coolify work", async () => {
    store.publish(candidate(STALE));
    const mutations = mutationSpies();
    const runner = release(store, refuseStale, mutations);

    await expect(runCutoverCommand(runner, ["deploy", STALE], "owner"))
      .rejects.toThrow("LAUNCH_BASELINE_MUST_BE_MAIN_TIP");
    expect(runner.journal.record).not.toHaveBeenCalled();
    expect(mutations.deploy).not.toHaveBeenCalled();
  });

  it("leaves the real DB, gates, sessions, deploy ref and Coolify adapter unchanged on refusal", async () => {
    const root = mkdtempSync(join(tmpdir(), "release-runner-"));
    const vps = await harness(root);
    const migrations = join(vps.config.deployRef.worktree, "commerce/migrations");
    const legal = join(vps.config.deployRef.worktree, "commerce/legal");
    mkdirSync(migrations, { recursive: true });
    mkdirSync(legal, { recursive: true });
    copyFileSync("commerce/migrations/0001_launch_baseline.sql", join(migrations, "0001_launch_baseline.sql"));
    copyFileSync("commerce/legal/production-manifest.json", join(legal, "production-manifest.json"));
    git(vps.config.deployRef.worktree, "add", "commerce");
    git(vps.config.deployRef.worktree, "commit", "-m", "new main");
    git(vps.config.deployRef.worktree, "push", "origin", "main");
    const current = git(vps.config.deployRef.worktree, "rev-parse", "HEAD");
    const stale = vps.targetSha;
    const candidateStore = new FileReleaseCandidateStore(vps.config.candidateDirectory);
    candidateStore.publish(candidate(stale));

    const snapshot = () => ({
      database: createHash("sha256").update(readFileSync(vps.config.databasePath)).digest("hex"),
      emergencyGate: vps.db.prepare("SELECT sales_paused, revision FROM emergency_sales_gate WHERE singleton = 1").get(),
      sessions: vps.db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(deployment_gate_closed), 0) AS closed FROM deploy_sessions").get(),
      deployRef: git(vps.config.deployRef.worktree, "ls-remote", "origin", "refs/heads/production-deploy"),
      coolifyCalls: [...vps.calls],
      artifact: createHash("sha256").update(readFileSync(join(vps.config.candidateDirectory, `${stale}.json`))).digest("hex"),
    });
    const before = snapshot();
    const runner = buildProductionRelease(vps.config);
    try {
      await expect(runCutoverCommand(runner, ["deploy", stale], "owner"))
        .rejects.toThrow(`LAUNCH_BASELINE_MUST_BE_MAIN_TIP: ${stale} != ${current}`);
    } finally {
      runner.close();
      expect(snapshot()).toEqual(before);
      await vps.close();
    }
  });

  it("uses the same guard for current prepare-bootstrap and initial deploy", async () => {
    store.publish(candidate(CURRENT));
    const mutations = mutationSpies();
    const runner = release(store, refuseStale, mutations);

    await expect(runCutoverCommand(runner, ["prepare-bootstrap", CURRENT, "2026-09-22T00:00:00.000Z"], "owner")).resolves.toBe(0);
    // The launch deploy names the cutover it is finishing; the guard it goes
    // through is still the same one the preparation used.
    await expect(runCutoverCommand(runner, ["deploy", CURRENT, "cutover-1"], "owner")).resolves.toBe(13);
    expect(runner.launchBaselineAdmission.admit).toHaveBeenCalledTimes(2);
    expect(runner.launchBaselineAdmission.admit).toHaveBeenNthCalledWith(1, candidate(CURRENT));
    expect(runner.launchBaselineAdmission.admit).toHaveBeenNthCalledWith(2, candidate(CURRENT));
  });

  it("reads the artifact first but admits against a main change observed immediately afterwards", async () => {
    store.publish(candidate(STALE));
    let tip = STALE;
    const get = vi.spyOn(store, "get").mockImplementation((id) => {
      const value = FileReleaseCandidateStore.prototype.get.call(store, id);
      tip = CURRENT;
      return value;
    });
    const mutations = mutationSpies();
    const runner = release(store, async (value) => {
      if (value.sha !== tip) throw new Error("LAUNCH_BASELINE_MUST_BE_MAIN_TIP");
    }, mutations);

    await expect(runCutoverCommand(runner, ["deploy", STALE], "owner"))
      .rejects.toThrow("LAUNCH_BASELINE_MUST_BE_MAIN_TIP");
    expect(get).toHaveBeenCalledWith(STALE);
    expect(mutations.deploy).not.toHaveBeenCalled();
  });

  it("refuses edited candidate bytes before admission or mutation", async () => {
    store.publish(candidate(CURRENT));
    writeFileSync(join(directory, `${CURRENT}.json`), JSON.stringify({ ...candidate(CURRENT), sha: "invalid" }));
    const mutations = mutationSpies();
    const runner = release(store, refuseStale, mutations);

    await expect(runCutoverCommand(runner, ["deploy", CURRENT], "owner"))
      .rejects.toThrow("RELEASE_CANDIDATE_INVALID");
    expect(runner.launchBaselineAdmission.admit).not.toHaveBeenCalled();
    expect(mutations.deploy).not.toHaveBeenCalled();
  });

  it("does not apply current-main admission to recovery of a durable mutated session", async () => {
    const mutations = mutationSpies();
    const runner = release(store, async () => { throw new Error("must not re-admit recovery"); }, mutations);
    runner.orchestrator.resume = vi.fn(async () => ({
      session: { id: "session-1", state: "RECOVERY_REQUIRED", targetSha: STALE },
      plan: { kind: "ROLLBACK_REQUIRED" },
    })) as never;

    await expect(runCutoverCommand(runner, ["resume", "session-1"], "owner")).resolves.toBe(12);
    expect(runner.launchBaselineAdmission.admit).not.toHaveBeenCalled();
    expect(runner.orchestrator.resume).toHaveBeenCalledWith("session-1", "owner");
  });
});
