import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { publishableReleaseClass, runCutoverCommand } from "../../../scripts/release/cutover-runner";
import type { HistoricalCandidate } from "../../src/release/candidate";
import { FileReleaseCandidateStore } from "../../src/release/candidate-store";
import type { ProductionRelease } from "../../src/release/production-runner";

/**
 * The launch machinery is retired (2026-09-24), and what it leaves behind is
 * history: LAUNCH_BASELINE candidates stay readable and the launch session
 * stays on record, but neither can be acted on again. Refusals come before
 * the journal, a lease or the orchestrator is touched.
 */

const LAUNCH = "a".repeat(40);

const launchCandidate: HistoricalCandidate = {
  id: LAUNCH,
  sha: LAUNCH,
  releaseClass: "LAUNCH_BASELINE",
  expectation: {
    schemaInventory: `inventory-sha256:${"1".repeat(64)}`,
    legalVersion: "2026-09-20.1",
    legalManifestSha256: "2".repeat(64),
  },
};

type Session = { id: string; ownerId: string; launch?: true };

const release = (store: FileReleaseCandidateStore, session?: Session, takeOver: () => void = () => {}) => ({
  candidates: store,
  journal: { record: vi.fn() },
  sessions: {
    read: vi.fn(() => session),
    yieldLease: vi.fn(),
    takeOverExpiredLease: vi.fn(takeOver),
  },
  orchestrator: {
    runMaintenanceCutover: vi.fn(),
    runRolling: vi.fn(),
    rollback: vi.fn(async () => ({ kind: "ROLLED_BACK", session: { id: session?.id ?? "none" } })),
  },
}) as unknown as ProductionRelease & {
  journal: { record: ReturnType<typeof vi.fn> };
  sessions: { takeOverExpiredLease: ReturnType<typeof vi.fn> };
  orchestrator: { runMaintenanceCutover: ReturnType<typeof vi.fn>; runRolling: ReturnType<typeof vi.fn>; rollback: ReturnType<typeof vi.fn> };
};

let directory: string;
let store: FileReleaseCandidateStore;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "release-candidates-"));
  store = new FileReleaseCandidateStore(directory);
});
/** As production's publication wrote it, before the class was retired. */
const writeLaunchCandidate = () =>
  writeFileSync(join(directory, `${LAUNCH}.json`), `${JSON.stringify(launchCandidate, null, 2)}\n`);

describe("the retired launch machinery", () => {
  it("keeps a launch candidate readable, and refuses to deploy it before anything is recorded", async () => {
    writeLaunchCandidate();
    const runner = release(store);
    expect(store.readHistorical(LAUNCH)).toEqual(launchCandidate);

    await expect(runCutoverCommand(runner, ["deploy", LAUNCH], "owner")).rejects.toThrow("LAUNCH_BASELINE_RETIRED");
    expect(runner.journal.record).not.toHaveBeenCalled();
    expect(runner.orchestrator.runMaintenanceCutover).not.toHaveBeenCalled();
    expect(runner.orchestrator.runRolling).not.toHaveBeenCalled();
  });

  it("no longer knows the launch-only commands", async () => {
    const runner = release(store);
    await expect(runCutoverCommand(runner, ["prepare-bootstrap", LAUNCH, "2026-09-25T00:00:00.000Z"], "owner"))
      .rejects.toThrow("RELEASE_COMMAND_UNKNOWN: prepare-bootstrap");
    await expect(runCutoverCommand(runner, ["rollback-prepared", "cutover-1"], "owner"))
      .rejects.toThrow("RELEASE_COMMAND_UNKNOWN: rollback-prepared");
  });

  it("refuses to roll back the launch session, before claiming its lease", async () => {
    const runner = release(store, { id: "launch-session", ownerId: "someone-else", launch: true });
    await expect(runCutoverCommand(runner, ["rollback", "launch-session"], "owner")).rejects.toThrow("LAUNCH_SESSION_NOT_ROLLBACKABLE");
    expect(runner.sessions.takeOverExpiredLease).not.toHaveBeenCalled();
    expect(runner.orchestrator.rollback).not.toHaveBeenCalled();
  });
});

describe("rollback from a different process", () => {
  it("claims a lease its holder stood down from, then rolls back", async () => {
    const runner = release(store, { id: "session-1", ownerId: "the-deploy" });
    await expect(runCutoverCommand(runner, ["rollback", "session-1"], "the-rollback")).resolves.toBe(11);
    expect(runner.sessions.takeOverExpiredLease).toHaveBeenCalledWith("session-1", "the-rollback");
    expect(runner.orchestrator.rollback).toHaveBeenCalledWith("session-1", "the-rollback");
  });

  it("refuses a lease somebody still holds, and rolls nothing back", async () => {
    const runner = release(store, { id: "session-1", ownerId: "a-live-deploy" }, () => { throw new Error("DEPLOY_SESSION_LEASE_ACTIVE"); });
    await expect(runCutoverCommand(runner, ["rollback", "session-1"], "the-rollback"))
      .rejects.toThrow("DEPLOY_SESSION_HELD_BY_ANOTHER_RUNNER: session-1 is held by a-live-deploy");
    expect(runner.orchestrator.rollback).not.toHaveBeenCalled();
  });

  it("does not claim what it already owns", async () => {
    const runner = release(store, { id: "session-1", ownerId: "the-rollback" });
    await expect(runCutoverCommand(runner, ["rollback", "session-1"], "the-rollback")).resolves.toBe(11);
    expect(runner.sessions.takeOverExpiredLease).not.toHaveBeenCalled();
  });
});

describe("what may be published", () => {
  it("is only MAINTENANCE_REQUIRED: the deploy mode is derived, never chosen", () => {
    expect(publishableReleaseClass("MAINTENANCE_REQUIRED")).toBe("MAINTENANCE_REQUIRED");
    // Naming ROLLING_COMPATIBLE would be choosing to skip the fence and the
    // certification, and nothing can prove a candidate compatible yet.
    expect(() => publishableReleaseClass("ROLLING_COMPATIBLE")).toThrow("ROLLING_COMPATIBLE_REQUIRES_COMPATIBILITY_PROOF");
    expect(() => publishableReleaseClass("LAUNCH_BASELINE")).toThrow("LAUNCH_BASELINE_RETIRED");
    expect(() => publishableReleaseClass(undefined)).toThrow("RELEASE_CLASS_INVALID: absent");
  });
});
