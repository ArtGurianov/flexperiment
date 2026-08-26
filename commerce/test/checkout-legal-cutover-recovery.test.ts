import { describe, expect, it } from "vitest";
import { checkoutLegalCutoverRecovery } from "../src/checkout-legal-cutover-recovery";
import type { ReleaseControlStatus } from "../src/release-control";

const candidateSourceCommit = "a".repeat(40);
const repairSourceCommit = "d".repeat(40);
const promotionSourceCommit = "b".repeat(40);
const releaseId = `checkout-legal-${candidateSourceCommit}`;
const status = (overrides: Partial<ReleaseControlStatus> = {}): ReleaseControlStatus => ({
  sales_paused: false,
  owner_release_id: null,
  owner_mode: null,
  expected: null,
  acquired_at: null,
  paused_at: null,
  reopened_at: null,
  ...overrides,
});

describe("checkout/legal cutover recovery", () => {
  type RecoveryInput = Omit<Parameters<typeof checkoutLegalCutoverRecovery>[0], "previousLegalVersion" | "activeLegalVersion" | "currentLegalCopiesMatch"> & Partial<Pick<Parameters<typeof checkoutLegalCutoverRecovery>[0], "previousLegalVersion" | "activeLegalVersion" | "currentLegalCopiesMatch">>;
  const recovery = (input: RecoveryInput) => checkoutLegalCutoverRecovery({
    previousLegalVersion: "2026-08-25.1",
    activeLegalVersion: "2026-08-26.1",
    currentLegalCopiesMatch: true,
    ...input,
  });

  it("reuses the exact durable promotion request after a post-promotion failure", () => {
    expect(recovery({
      releaseId,
      candidateSourceCommit,
      candidateLegalVersion: "2026-08-26.1",
      status: status({
        sales_paused: true,
        owner_release_id: releaseId,
        expected: { source_commit: promotionSourceCommit, migration: "0034_worker_sweep_evidence.sql", legal_version: "2026-08-26.1", legal_manifest_sha256: "c".repeat(64) },
      }),
    })).toEqual({ mode: "RESUMING_PROMOTION", promotionSourceCommit });
  });

  it("adopts only an explicit same-owner repair before legal publication", () => {
    expect(recovery({
      releaseId,
      candidateSourceCommit,
      candidateLegalVersion: "2026-08-26.1",
      activeLegalVersion: "2026-08-25.1",
      repairSourceCommit,
      status: status({
        sales_paused: true,
        owner_release_id: releaseId,
        expected: { source_commit: candidateSourceCommit, migration: "0034_worker_sweep_evidence.sql", legal_version: "2026-08-26.1", legal_manifest_sha256: "c".repeat(64) },
      }),
    })).toEqual({ mode: "ADOPTING_PREPUBLICATION_REPAIR", repairSourceCommit });
  });

  it("reuses the exact durable repair before and after its candidate deployment", () => {
    const durableRepair = status({
      sales_paused: true,
      owner_release_id: releaseId,
      expected: { source_commit: repairSourceCommit, migration: "0034_worker_sweep_evidence.sql", legal_version: "2026-08-26.1", legal_manifest_sha256: "c".repeat(64) },
    });
    expect(recovery({
      releaseId,
      candidateSourceCommit,
      candidateLegalVersion: "2026-08-26.1",
      activeLegalVersion: "2026-08-25.1",
      status: durableRepair,
    })).toEqual({ mode: "RESUMING_PREPUBLICATION_REPAIR", repairSourceCommit });
    expect(recovery({
      releaseId,
      candidateSourceCommit,
      candidateLegalVersion: "2026-08-26.1",
      activeLegalVersion: "2026-08-25.1",
      repairSourceCommit: "e".repeat(40),
      status: durableRepair,
    })).toEqual({ mode: "BLOCKED", reason: "DURABLE_REPAIR_SOURCE_MISMATCH" });
    expect(recovery({
      releaseId,
      candidateSourceCommit,
      candidateLegalVersion: "2026-08-26.1",
      activeLegalVersion: "2026-08-26.1",
      repairSourceCommit,
      status: durableRepair,
    })).toEqual({ mode: "RESUMING_POSTPUBLICATION_REPAIR", repairSourceCommit });
  });

  it("rejects a new or foreign repair once candidate legal is active", () => {
    const durableCandidate = status({
      sales_paused: true,
      owner_release_id: releaseId,
      expected: { source_commit: candidateSourceCommit, migration: "0034_worker_sweep_evidence.sql", legal_version: "2026-08-26.1", legal_manifest_sha256: "c".repeat(64) },
    });
    expect(recovery({
      releaseId,
      candidateSourceCommit,
      candidateLegalVersion: "2026-08-26.1",
      repairSourceCommit,
      status: durableCandidate,
    })).toEqual({ mode: "BLOCKED", reason: "NEW_REPAIR_AFTER_LEGAL_PUBLICATION" });
    expect(recovery({
      releaseId,
      candidateSourceCommit,
      candidateLegalVersion: "2026-08-26.1",
      repairSourceCommit: "e".repeat(40),
      status: status({
        sales_paused: true,
        owner_release_id: releaseId,
        expected: { source_commit: repairSourceCommit, migration: "0034_worker_sweep_evidence.sql", legal_version: "2026-08-26.1", legal_manifest_sha256: "c".repeat(64) },
      }),
    })).toEqual({ mode: "BLOCKED", reason: "DURABLE_REPAIR_SOURCE_MISMATCH" });
  });

  it("accepts mismatched current legal copies only after candidate legal is active", () => {
    const durableRepair = status({
      sales_paused: true,
      owner_release_id: releaseId,
      expected: { source_commit: repairSourceCommit, migration: "0034_worker_sweep_evidence.sql", legal_version: "2026-08-26.1", legal_manifest_sha256: "c".repeat(64) },
    });
    expect(recovery({
      releaseId,
      candidateSourceCommit,
      candidateLegalVersion: "2026-08-26.1",
      activeLegalVersion: "2026-08-25.1",
      currentLegalCopiesMatch: false,
      status: durableRepair,
    })).toEqual({ mode: "BLOCKED", reason: "PREPUBLICATION_CURRENT_LEGAL_COPIES_MISMATCH" });
    expect(recovery({
      releaseId,
      candidateSourceCommit,
      candidateLegalVersion: "2026-08-26.1",
      activeLegalVersion: "2026-08-26.1",
      currentLegalCopiesMatch: false,
      repairSourceCommit,
      status: durableRepair,
    })).toEqual({ mode: "RESUMING_POSTPUBLICATION_REPAIR", repairSourceCommit });
  });

  it("allows candidate acquire only from a fresh unowned state or the same candidate request", () => {
    expect(recovery({ releaseId, candidateSourceCommit, candidateLegalVersion: "2026-08-26.1", status: status() })).toEqual({ mode: "CANDIDATE" });
    expect(recovery({
      releaseId,
      candidateSourceCommit,
      candidateLegalVersion: "2026-08-26.1",
      status: status({ sales_paused: true, owner_release_id: releaseId, expected: { source_commit: candidateSourceCommit, migration: "0034_worker_sweep_evidence.sql", legal_version: "2026-08-26.1", legal_manifest_sha256: "c".repeat(64) } }),
    })).toEqual({ mode: "CANDIDATE" });
  });

  it("fails closed for another owner, an unowned pause, or a mismatched durable release", () => {
    expect(recovery({ releaseId, candidateSourceCommit, candidateLegalVersion: "2026-08-26.1", status: status({ sales_paused: true, owner_release_id: "other" }) })).toEqual({ mode: "BLOCKED", reason: "RELEASE_CONTROL_OWNED" });
    expect(recovery({ releaseId, candidateSourceCommit, candidateLegalVersion: "2026-08-26.1", status: status({ sales_paused: true }) })).toEqual({ mode: "BLOCKED", reason: "PAUSED_WITHOUT_OWNER" });
    expect(recovery({ releaseId, candidateSourceCommit, candidateLegalVersion: "2026-08-26.1", status: status({ sales_paused: true, owner_release_id: releaseId, expected: { source_commit: promotionSourceCommit, migration: "0034_worker_sweep_evidence.sql", legal_version: "2026-08-25.1", legal_manifest_sha256: "c".repeat(64) } }) })).toEqual({ mode: "BLOCKED", reason: "DURABLE_OWNER_MISMATCH" });
  });
});
