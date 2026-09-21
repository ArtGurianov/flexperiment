import { describe, expect, it, vi } from "vitest";
import type { ProductionRelease } from "../../src/release/production-runner";
import { runCutoverCommand } from "../../../scripts/release/cutover-runner";

const release = (failure?: Error) => ({
  sessions: { read: vi.fn(() => { throw new Error("restored predecessor has no successor session row"); }) },
  bootstrapRollback: {
    isStarted: () => true,
    async rollback() {
      if (failure) throw failure;
      return { stage: "COMPLETED", intent: { rollbackId: "rollback-1" } };
    },
  },
  journal: { record: vi.fn() },
  orchestrator: { rollback: vi.fn(() => { throw new Error("same-lineage path must not run"); }) },
}) as unknown as ProductionRelease;

describe("cutover runner cross-lineage rollback exit contract", () => {
  it("returns 11 only after the external receipt is completed", async () => {
    expect(await runCutoverCommand(release(), ["rollback", "session-1"], "owner")).toBe(11);
  });

  it("returns recovery-required 12 after a started rollback fails", async () => {
    expect(await runCutoverCommand(release(new Error("PARTIAL_COOLIFY")), ["rollback", "session-1"], "owner")).toBe(12);
  });
});
