import { describe, expect, it } from "vitest";
import { BootstrapCutoverPreparation, type PreparationPorts } from "../../src/release/cutover-preparation";
import type { CutoverEnvelope } from "../../src/release/cutover-envelope";
import type { PreDeploySnapshot } from "../../src/release/deploy-session";
import { withSurface } from "../support/deploy-snapshot";

const target = "a".repeat(40);
const before: PreDeploySnapshot = { runtime: { frontend: "b".repeat(40), admin: "c".repeat(40), commerce: "b".repeat(40), worker: "d".repeat(40) }, controlPlane: { productionDeployRefSha: "b".repeat(40) } };
const archive = { ref: "prelaunch-2026-09-20.sqlite", sha256: "e".repeat(64) };
const now = new Date("2026-09-20T00:00:00.000Z");
const request = { targetSha: target, expiresAt: "2026-09-20T06:00:00.000Z", cutoverId: "cutover-1", adoptionNonce: "nonce-1" };

const predecessor = (options: {
  blockers?: readonly string[];
  archiveFails?: string;
  topologies?: PreDeploySnapshot[];
  gateOpensDuringArchive?: boolean;
  written?: CutoverEnvelope;
} = {}) => {
  const log: string[] = [];
  const stored = new Map<string, CutoverEnvelope>();
  if (options.written) stored.set(options.written.cutoverId, options.written);
  const queue = [...(options.topologies ?? [before, before])];
  let last = before;
  let gateClosed = false;

  const ports: PreparationPorts = {
    clock: () => now,
    fence: {
      async ensureClosed() { log.push("fence-close"); gateClosed = true; },
      async isClosed() { log.push("fence-proof"); return gateClosed; },
    },
    quiescer: { async ensureQuiesced() { log.push("quiesce"); } },
    census: {
      async inspect() {
        log.push("census");
        return { admitted: !options.blockers?.length, blockers: options.blockers ?? [], evidenceDigest: "f".repeat(64) };
      },
    },
    archiver: {
      async archiveAndVerify() {
        log.push("archive");
        if (options.gateOpensDuringArchive) gateClosed = false;
        if (options.archiveFails) throw new Error(options.archiveFails);
        return archive;
      },
    },
    topology: { async observe() { last = queue.shift() ?? last; log.push("observe"); return last; } },
    envelopes: {
      async read(id) { return stored.get(id); },
      async writeOnce(envelope) { log.push("write-envelope"); stored.set(envelope.cutoverId, envelope); },
    },
  };
  return { log, stored, preparation: new BootstrapCutoverPreparation(ports) };
};

describe("bootstrap cutover preparation", () => {
  it("publishes the envelope last, after everything it vouches for", async () => {
    const { log, preparation } = predecessor();

    const result = await preparation.prepare(request);

    expect(result.alreadyPrepared).toBe(false);
    // The envelope is the moment the lineage is handed over, so every proof it
    // carries has to already exist when it appears.
    expect(log).toEqual(["fence-close", "observe", "quiesce", "census", "archive", "observe", "fence-proof", "write-envelope"]);
    expect(result.envelope).toMatchObject({
      cutoverId: "cutover-1", targetSha: target, mode: "MAINTENANCE_CUTOVER",
      preDeployTopology: before, predecessorDatabase: archive,
    });
  });

  it("never reaches the archiver when the final census finds a blocker", async () => {
    const { log, stored, preparation } = predecessor({ blockers: ["city_interest_requests"] });

    await expect(preparation.prepare(request)).rejects.toThrow("FINAL_CENSUS_BLOCKED: city_interest_requests");
    expect(log).not.toContain("archive");
    expect(stored.size).toBe(0);
  });

  it("publishes nothing when the archive fails", async () => {
    const { stored, preparation } = predecessor({ archiveFails: "RESTORE_PROBE_FAILED" });
    await expect(preparation.prepare(request)).rejects.toThrow("RESTORE_PROBE_FAILED");
    expect(stored.size).toBe(0);
  });

  it("refuses to pair an archive with a topology that moved underneath it", async () => {
    // Otherwise the snapshot and the vector describe two different predecessor
    // states, and the successor would inherit a handoff that never existed.
    const drifted = withSurface(before, "worker", target);
    const { stored, preparation } = predecessor({ topologies: [before, drifted] });

    await expect(preparation.prepare(request)).rejects.toThrow("PREDECESSOR_TOPOLOGY_DRIFTED");
    expect(stored.size).toBe(0);
  });

  it("refuses to publish if the predecessor gate was opened while it worked", async () => {
    // A backup taken behind a gate that is now open is not the quiet snapshot
    // it is about to be treated as.
    const { stored, preparation } = predecessor({ gateOpensDuringArchive: true });

    await expect(preparation.prepare(request)).rejects.toThrow("PREDECESSOR_GATE_NOT_CLOSED");
    expect(stored.size).toBe(0);
  });

  it("leaves sales closed on every failure and reopens nothing by itself", async () => {
    const { log, preparation } = predecessor({ blockers: ["orders"] });
    await expect(preparation.prepare(request)).rejects.toThrow("FINAL_CENSUS_BLOCKED");
    // An availability failure, deliberately: abandoning the cutover is an
    // operator's decision made outside this protocol.
    expect(log).not.toContain("fence-open");
  });

  it("returns the same envelope without a second census or archive after a crash", async () => {
    const first = predecessor();
    const { envelope } = await first.preparation.prepare(request);

    // The crash worth surviving: written, then the runner died before hearing so.
    const retry = predecessor({ written: envelope });
    const result = await retry.preparation.prepare(request);

    expect(result).toEqual({ envelope, alreadyPrepared: true });
    expect(retry.log).toEqual([]);
  });

  it("is idempotent for a plain retry that does not restate the nonce", async () => {
    // The ordinary resume: same cutover, same target, same window, no nonce.
    // Minting a fresh one before the existing envelope was consulted turned
    // this into a mismatch.
    const first = predecessor();
    const { envelope } = await first.preparation.prepare(request);
    const retry = predecessor({ written: envelope });

    const result = await retry.preparation.prepare({
      targetSha: request.targetSha, expiresAt: request.expiresAt, cutoverId: request.cutoverId,
    });

    expect(result).toEqual({ envelope, alreadyPrepared: true });
    expect(retry.log).toEqual([]);
  });

  it("refuses a retry that moves the window, which is a different preparation", async () => {
    const first = predecessor();
    const { envelope } = await first.preparation.prepare(request);
    const retry = predecessor({ written: envelope });

    await expect(retry.preparation.prepare({ ...request, expiresAt: "2026-09-20T12:00:00.000Z" }))
      .rejects.toThrow("CUTOVER_ENVELOPE_IDENTITY_MISMATCH");
    expect(retry.log).toEqual([]);
  });

  it("refuses a cutover id already used by a different preparation", async () => {
    const first = predecessor();
    const { envelope } = await first.preparation.prepare(request);
    const retry = predecessor({ written: envelope });

    await expect(retry.preparation.prepare({ ...request, targetSha: "9".repeat(40) }))
      .rejects.toThrow("CUTOVER_ENVELOPE_IDENTITY_MISMATCH");
  });

  it("validates its input before touching the predecessor at all", async () => {
    const { log, preparation } = predecessor();

    await expect(preparation.prepare({ ...request, expiresAt: "2026-09-19T00:00:00.000Z" }))
      .rejects.toThrow("CUTOVER_ENVELOPE_EXPIRY_INVALID");
    await expect(preparation.prepare({ ...request, targetSha: "not-a-sha" }))
      .rejects.toThrow("CUTOVER_TARGET_SHA_INVALID");
    expect(log).toEqual([]);
  });
});
