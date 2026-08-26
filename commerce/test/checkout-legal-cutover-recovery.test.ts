import { describe, expect, it } from "vitest";
import { checkoutLegalCutoverRecovery } from "../src/checkout-legal-cutover-recovery";
import type { ReleaseControlStatus } from "../src/release-control";

const candidateSourceCommit = "a".repeat(40);
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
  it("reuses the exact durable promotion request after a post-promotion failure", () => {
    expect(checkoutLegalCutoverRecovery({
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

  it("allows candidate acquire only from a fresh unowned state or the same candidate request", () => {
    expect(checkoutLegalCutoverRecovery({ releaseId, candidateSourceCommit, candidateLegalVersion: "2026-08-26.1", status: status() })).toEqual({ mode: "CANDIDATE" });
    expect(checkoutLegalCutoverRecovery({
      releaseId,
      candidateSourceCommit,
      candidateLegalVersion: "2026-08-26.1",
      status: status({ sales_paused: true, owner_release_id: releaseId, expected: { source_commit: candidateSourceCommit, migration: "0034_worker_sweep_evidence.sql", legal_version: "2026-08-26.1", legal_manifest_sha256: "c".repeat(64) } }),
    })).toEqual({ mode: "CANDIDATE" });
  });

  it("fails closed for another owner, an unowned pause, or a mismatched durable release", () => {
    expect(checkoutLegalCutoverRecovery({ releaseId, candidateSourceCommit, candidateLegalVersion: "2026-08-26.1", status: status({ sales_paused: true, owner_release_id: "other" }) })).toEqual({ mode: "BLOCKED", reason: "RELEASE_CONTROL_OWNED" });
    expect(checkoutLegalCutoverRecovery({ releaseId, candidateSourceCommit, candidateLegalVersion: "2026-08-26.1", status: status({ sales_paused: true }) })).toEqual({ mode: "BLOCKED", reason: "PAUSED_WITHOUT_OWNER" });
    expect(checkoutLegalCutoverRecovery({ releaseId, candidateSourceCommit, candidateLegalVersion: "2026-08-26.1", status: status({ sales_paused: true, owner_release_id: releaseId, expected: { source_commit: promotionSourceCommit, migration: "0034_worker_sweep_evidence.sql", legal_version: "2026-08-25.1", legal_manifest_sha256: "c".repeat(64) } }) })).toEqual({ mode: "BLOCKED", reason: "DURABLE_OWNER_MISMATCH" });
  });
});
