import { describe, expect, it } from "vitest";
import { assertAppliedMigrationPrefix, candidateExpectedMigration, reconcileHeadWithProjection, releaseStateHash, replayReleaseGenerationChain, type GenerationHead } from "../src/release-generation";

const head = { release_id: "promo-codes-v0:abcdef1", candidate_generation: 1, source_commit: "abcdef1", migration_inventory: { files: { "0035_promo_codes_v0.sql": "a".repeat(64) } }, legal_baseline: { legal_version: "v1", legal_manifest_sha256: "b".repeat(64), legal_hashes: {} }, release_family: "promo-codes-v0", checkout_contract_version: "promo-codes-v0", admin_contract_version: "promo-codes-v0", phase: "PAUSED" as const, phase_sequence: 0 };
describe("v2 release generation chain", () => {
  it("uses rowid sequence rather than timestamps and rejects an invalid fork", () => {
    const acquired = { seq: 2, release_id: head.release_id, action: "ACQUIRED" as const, details_json: JSON.stringify({ schema_version: 2, kind: "CANDIDATE_ACQUIRED", head }) };
    const phaseHead = { ...head, phase: "DEPLOYED_READ_ONLY" as const, phase_sequence: 1 };
    const changed = { seq: 1, release_id: head.release_id, action: "PAUSED" as const, details_json: JSON.stringify({ schema_version: 2, kind: "PHASE_CHANGED", from_phase: "PAUSED", from_phase_sequence: 0, head: phaseHead }) };
    expect(replayReleaseGenerationChain([acquired, changed]).corrupt).toBe("V2_CHAIN_MUST_START_WITH_ACQUIRE");
    expect(replayReleaseGenerationChain([acquired]).head).toEqual(head);
    expect(releaseStateHash(head)).not.toBe(releaseStateHash(phaseHead));
  });

  it("rejects an acquired head that smuggles in a certification binding", () => {
    const invalidHead = { ...head, certification: { lease_id: "lease-1", occurrence_id: "occurrence-1", promo_id: "promo-1", expected_idempotency_key_hash: "a".repeat(64), lease_expires_at: "2030-01-01T00:00:00.000Z", status: "ACTIVE" } };
    const acquired = { seq: 1, release_id: head.release_id, action: "ACQUIRED" as const, details_json: JSON.stringify({ schema_version: 2, kind: "CANDIDATE_ACQUIRED", head: invalidHead }) };
    expect(replayReleaseGenerationChain([acquired]).corrupt).toBe("INVALID_CANDIDATE_ACQUIRED");
  });

  it("rejects skipped phase edges and projection fail-open", () => {
    const acquired = { seq: 1, release_id: head.release_id, action: "ACQUIRED" as const, details_json: JSON.stringify({ schema_version: 2, kind: "CANDIDATE_ACQUIRED", head }) };
    const illegal = { ...head, phase: "CERTIFIED" as const, phase_sequence: 1 };
    const changed = { seq: 2, release_id: head.release_id, action: "PAUSED" as const, details_json: JSON.stringify({ schema_version: 2, kind: "PHASE_CHANGED", from_phase: "PAUSED", from_phase_sequence: 0, head: illegal }) };
    expect(replayReleaseGenerationChain([acquired, changed]).corrupt).toBe("INVALID_PHASE_CHANGE");
    expect(reconcileHeadWithProjection(head, { owner_release_id: null, sales_paused: false })).toBe("RELEASE_STATE_CORRUPT");
  });

  it("preserves only the ledger-applied migration prefix across recovery", () => {
    const old = { files: { "0001.sql": "a".repeat(64), "0002.sql": "b".repeat(64) } };
    const replacement = { files: { "0001.sql": "a".repeat(64), "0002.sql": "c".repeat(64), "0003.sql": "d".repeat(64) } };
    expect(assertAppliedMigrationPrefix(["0001.sql"], old, replacement)).toBeUndefined();
    expect(assertAppliedMigrationPrefix(["0001.sql", "0002.sql"], old, replacement)).toBe("APPLIED_MIGRATION_HASH_CHANGED");
    expect(assertAppliedMigrationPrefix(["0003.sql"], old, replacement)).toBe("APPLIED_MIGRATION_LEDGER_NOT_PREFIX");
  });

  it("derives the projection migration from each candidate inventory", () => {
    expect(candidateExpectedMigration({ ...head, migration_inventory: { files: { "0035_promo_codes_v0.sql": "a".repeat(64), "0036_promo_repair.sql": "b".repeat(64) } } })).toBe("0036_promo_repair.sql");
  });

  it("fails closed when a projection legal expectation differs from its head", () => {
    expect(reconcileHeadWithProjection(head, { owner_release_id: head.release_id, sales_paused: true, expected_source_commit: head.source_commit, expected_migration: "0035_promo_codes_v0.sql", expected_legal_version: "other", expected_legal_manifest_sha256: "b".repeat(64) })).toBe("RELEASE_STATE_CORRUPT");
  });

  it("allows only the evidence-owned certification binding lifecycle and a revoked retry", () => {
    const acquired = { seq: 1, release_id: head.release_id, action: "ACQUIRED" as const, details_json: JSON.stringify({ schema_version: 2, kind: "CANDIDATE_ACQUIRED", head }) };
    const deployed = { ...head, phase: "DEPLOYED_READ_ONLY" as const, phase_sequence: 1 };
    const active = { lease_id: "lease-1", occurrence_id: "occurrence-1", promo_id: "promo-1", expected_idempotency_key_hash: "a".repeat(64), lease_expires_at: "2030-01-01T00:00:00.000Z", status: "ACTIVE" as const };
    const certificationOnly = { ...deployed, phase: "CERTIFICATION_ONLY" as const, phase_sequence: 2, certification: active };
    const revoked = { ...certificationOnly, phase: "DEPLOYED_READ_ONLY" as const, phase_sequence: 3, certification: { ...active, status: "REVOKED" as const } };
    const retried = { ...revoked, phase: "CERTIFICATION_ONLY" as const, phase_sequence: 4, certification: { ...active, lease_id: "lease-2", status: "ACTIVE" as const } };
    const phaseEvent = (seq: number, from: GenerationHead, next: GenerationHead) => ({ seq, release_id: head.release_id, action: "PAUSED" as const, details_json: JSON.stringify({ schema_version: 2, kind: "PHASE_CHANGED", from_phase: from.phase, from_phase_sequence: from.phase_sequence, head: next }) });
    expect(replayReleaseGenerationChain([acquired, phaseEvent(2, head, deployed), phaseEvent(3, deployed, certificationOnly), phaseEvent(4, certificationOnly, revoked), phaseEvent(5, revoked, retried)]).head).toEqual(retried);
    const unreversed = { ...certificationOnly, phase: "DEPLOYED_READ_ONLY" as const, phase_sequence: 3 };
    expect(replayReleaseGenerationChain([acquired, phaseEvent(2, head, deployed), phaseEvent(3, deployed, certificationOnly), phaseEvent(4, certificationOnly, unreversed)]).corrupt).toBe("INVALID_CERTIFICATION_STATUS_TRANSITION");
    const changedScope = { ...certificationOnly, phase: "CERTIFICATION_IN_FLIGHT" as const, phase_sequence: 3, certification: { ...active, promo_id: "other", status: "CONSUMED" as const } };
    expect(replayReleaseGenerationChain([acquired, phaseEvent(2, head, deployed), phaseEvent(3, deployed, certificationOnly), phaseEvent(4, certificationOnly, changedScope)]).corrupt).toBe("CERTIFICATION_BINDING_MUTATED");
    const inFlight = { ...certificationOnly, phase: "CERTIFICATION_IN_FLIGHT" as const, phase_sequence: 3, certification: { ...active, status: "CONSUMED" as const } };
    const retry = { ...inFlight, phase: "DEPLOYED_READ_ONLY" as const, phase_sequence: 4 };
    expect(replayReleaseGenerationChain([acquired, phaseEvent(2, head, deployed), phaseEvent(3, deployed, certificationOnly), phaseEvent(4, certificationOnly, inFlight), phaseEvent(5, inFlight, retry)]).corrupt).toBe("INVALID_CERTIFICATION_STATUS_TRANSITION");
    const retryEvent = { seq: 5, release_id: head.release_id, action: "PAUSED" as const, details_json: JSON.stringify({ schema_version: 2, kind: "PHASE_CHANGED", from_phase: inFlight.phase, from_phase_sequence: inFlight.phase_sequence, head: retry, certification_retry: { reason: "OPERATIONAL", order_id: "order-1", payment_id: "payment-1", payment_state: "CREATE_FAILED", payment_status: "CANCELLED" } }) };
    expect(replayReleaseGenerationChain([acquired, phaseEvent(2, head, deployed), phaseEvent(3, deployed, certificationOnly), phaseEvent(4, certificationOnly, inFlight), retryEvent]).head).toEqual(retry);
    const staleRetry = { ...retry, phase: "CERTIFICATION_ONLY" as const, phase_sequence: 5, certification: { ...active, lease_id: "lease-3", status: "ACTIVE" as const } };
    expect(replayReleaseGenerationChain([acquired, phaseEvent(2, head, deployed), phaseEvent(3, deployed, certificationOnly), phaseEvent(4, certificationOnly, inFlight), retryEvent, phaseEvent(6, retry, staleRetry)]).corrupt).toBe("CERTIFICATION_BINDING_MUTATED");
    const activeB = { ...active, lease_id: "lease-b", occurrence_id: "occurrence-b", promo_id: "promo-b" };
    const certificationOnlyB = { ...retry, phase: "CERTIFICATION_ONLY" as const, phase_sequence: 5, certification: activeB };
    const inFlightB = { ...certificationOnlyB, phase: "CERTIFICATION_IN_FLIGHT" as const, phase_sequence: 6, certification: { ...activeB, status: "CONSUMED" as const } };
    const retryB = { ...inFlightB, phase: "DEPLOYED_READ_ONLY" as const, phase_sequence: 7 };
    const retryBEvent = { seq: 8, release_id: head.release_id, action: "PAUSED" as const, details_json: JSON.stringify({ schema_version: 2, kind: "PHASE_CHANGED", from_phase: inFlightB.phase, from_phase_sequence: inFlightB.phase_sequence, head: retryB, certification_retry: { reason: "OPERATIONAL", order_id: "order-b", payment_id: "payment-b", payment_state: "CREATE_FAILED", payment_status: "CANCELLED" } }) };
    const reusedA = { ...retryB, phase: "CERTIFICATION_ONLY" as const, phase_sequence: 8, certification: { ...active, lease_id: "lease-a-again", status: "ACTIVE" as const } };
    expect(replayReleaseGenerationChain([acquired, phaseEvent(2, head, deployed), phaseEvent(3, deployed, certificationOnly), phaseEvent(4, certificationOnly, inFlight), retryEvent, phaseEvent(6, retry, certificationOnlyB), phaseEvent(7, certificationOnlyB, inFlightB), retryBEvent, phaseEvent(9, retryB, reusedA)]).corrupt).toBe("CERTIFICATION_BINDING_MUTATED");
    const recoveredAfterRetry = { ...retry, phase: "RECOVERY_REQUIRED" as const, phase_sequence: 5 };
    expect(replayReleaseGenerationChain([acquired, phaseEvent(2, head, deployed), phaseEvent(3, deployed, certificationOnly), phaseEvent(4, certificationOnly, inFlight), retryEvent, phaseEvent(6, retry, recoveredAfterRetry)]).head).toEqual(recoveredAfterRetry);
    const certified = { ...inFlight, phase: "CERTIFIED" as const, phase_sequence: 4 };
    expect(replayReleaseGenerationChain([acquired, phaseEvent(2, head, deployed), phaseEvent(3, deployed, certificationOnly), phaseEvent(4, certificationOnly, inFlight), phaseEvent(5, inFlight, certified)]).corrupt).toBe("INVALID_CERTIFICATION_STATUS_TRANSITION");
    const certifiedEvent = { seq: 5, release_id: head.release_id, action: "PAUSED" as const, details_json: JSON.stringify({ schema_version: 2, kind: "PHASE_CHANGED", from_phase: inFlight.phase, from_phase_sequence: inFlight.phase_sequence, head: certified, certification_evidence: { occurrence_id: active.occurrence_id, promo_id: active.promo_id, order_id: "order-1", payment_id: "payment-1", refund_id: "refund-1", price_kopecks: 101, discount_kopecks: 1, amount_kopecks: 100, captured_kopecks: 100, refunded_kopecks: 100 } }) };
    expect(replayReleaseGenerationChain([acquired, phaseEvent(2, head, deployed), phaseEvent(3, deployed, certificationOnly), phaseEvent(4, certificationOnly, inFlight), certifiedEvent]).head).toEqual(certified);
  });
});
