import { describe, expect, it } from "vitest";
import { cleanupKey, ensureCatalogueClean, type CatalogueCleanupPorts } from "../../src/certification/cleanup";
import { InMemoryCertificationRunStore, type CertificationRun } from "../../src/certification/run";
import type { OccurrenceView } from "../../src/certification/evidence";

const base: CertificationRun = {
  runId: "run", revision: 1, releaseSha: "a".repeat(40), phase: "REFUND_EMAIL_DELIVERED", direction: "FINANCIAL_EFFECT_POSSIBLE",
  startedAt: "2026-09-20T00:00:00.000Z", occurrenceId: "occ",
};

const catalogue = (start: Partial<OccurrenceView> = {}, options: { failClose?: boolean } = {}) => {
  const patches: { patch: string; revision: number; key: string }[] = [];
  let occurrence: OccurrenceView = { id: "occ", sales_status: "OPEN", visibility: "PUBLISHED", admin_revision: 7, ...start };
  const ports: CatalogueCleanupPorts = {
    async occurrence() { return occurrence; },
    async patchOccurrence(_id, patch, revision, _reason, key) {
      patches.push({ patch: `${Object.keys(patch)[0]}=${Object.values(patch)[0]}`, revision, key });
      if (options.failClose && patch.sales_status) throw new Error("admin refused the close");
      occurrence = { ...occurrence, ...patch, admin_revision: Number(occurrence.admin_revision) + 1 };
      return occurrence;
    },
    async occurrenceIsPubliclyVisible() { return occurrence.visibility === "PUBLISHED"; },
    async tourIncludes() { return occurrence.visibility === "PUBLISHED"; },
  };
  return { ports, patches, current: () => occurrence };
};

describe("catalogue cleanup", () => {
  it("converges on closed and hidden using the revision it reads now", () => {
    // This is not a repeated historical request, it is a safety invariant: the
    // goal is a state, so re-deriving the current revision each time is right.
    const { ports, patches } = catalogue();
    const runs = new InMemoryCertificationRunStore();
    const run = runs.create(base);

    return ensureCatalogueClean(runs, ports, run).then((cleaned) => {
      expect(patches).toEqual([
        { patch: "sales_status=CLOSED", revision: 7, key: cleanupKey("run", "close-sales") },
        { patch: "visibility=HIDDEN", revision: 8, key: cleanupKey("run", "hide-occurrence") },
      ]);
      expect(cleaned.direction).toBe("CATALOGUE_CLEAN");
    });
  });

  it("arms the direction before it destroys anything", async () => {
    // A crash between the close and the hide must leave a run no later resume
    // will decide to reopen.
    const { ports, patches } = catalogue({}, { failClose: true });
    const runs = new InMemoryCertificationRunStore();
    const run = runs.create(base);

    await expect(ensureCatalogueClean(runs, ports, run)).rejects.toThrow("admin refused the close");

    expect(patches).toHaveLength(1);
    expect(runs.load("run")?.direction).toBe("CLEANUP_STARTED");
  });

  it("does nothing to a catalogue that is already shut", async () => {
    const { ports, patches } = catalogue({ sales_status: "CLOSED", visibility: "HIDDEN" });
    const runs = new InMemoryCertificationRunStore();
    const run = runs.create(base);

    expect((await ensureCatalogueClean(runs, ports, run)).direction).toBe("CATALOGUE_CLEAN");
    expect(patches).toEqual([]);
  });

  it("will not call a catalogue clean while it is still publicly reachable", async () => {
    // Read live, never from the record: an external reopen after a crash has
    // to be caught here rather than papered over.
    const { ports } = catalogue({ sales_status: "CLOSED", visibility: "HIDDEN" });
    const leaking: CatalogueCleanupPorts = { ...ports, async tourIncludes() { return true; } };
    const runs = new InMemoryCertificationRunStore();
    const run = runs.create(base);

    await expect(ensureCatalogueClean(runs, leaking, run)).rejects.toThrow("CERTIFICATION_HIDDEN_OCCURRENCE_STILL_IN_TOUR");
    expect(runs.load("run")?.direction).toBe("CLEANUP_STARTED");
  });
});
