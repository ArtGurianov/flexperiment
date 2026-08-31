import { describe, expect, it } from "vitest";
import { EPOCH_A_PRE_B_LEGAL_VERSION, EPOCH_A_RELEASE_ID, EPOCH_A_RUNTIME_SHA, epochADormantLegalEvidence, reconcileEpochA } from "../src/epoch-a-runtime-promotion";
import { migrationInventoryExpectation, type ReleaseControlRequest, type ReleaseRuntimeEvidence } from "../src/release-control";

const request: ReleaseControlRequest = {
  release_id: EPOCH_A_RELEASE_ID,
  mode: "CONTROLLED_CUTOVER",
  expected: {
    source_commit: EPOCH_A_RUNTIME_SHA,
    migration: migrationInventoryExpectation(["0038_occurrence_availability_notifications.sql"]),
    legal_version: EPOCH_A_PRE_B_LEGAL_VERSION,
    legal_manifest_sha256: "a".repeat(64),
    legal_hashes: { PUBLIC_OFFER: "b".repeat(64), PRIVACY_POLICY: "c".repeat(64), PD_CONSENT: "d".repeat(64), CHECKOUT_DISCLOSURE: "e".repeat(64) },
  },
};

const runtime: ReleaseRuntimeEvidence = {
  source_commit: EPOCH_A_RUNTIME_SHA,
  required_migrations: {}, migration_versions: ["0038_occurrence_availability_notifications.sql"],
  legal_version: EPOCH_A_PRE_B_LEGAL_VERSION, legal_manifest_sha256: "a".repeat(64), legal_hashes: request.expected.legal_hashes,
  legal_publish_time: "2026-08-26T00:00:00.000Z", current_legal_copies_match: true,
  worker_source_commit: EPOCH_A_RUNTIME_SHA, worker_started_at: "2026-08-31T00:00:00.000Z", worker_observed_at: new Date().toISOString(), worker_last_successful_sweep_at: new Date().toISOString(),
  source_legal_manifest_sha256: "f".repeat(64), source_legal_publish_time: "2026-08-26T00:00:00.000Z",
};

const incomplete = { complete: false, expected: null, reopened_at: null };
const legal = { version: EPOCH_A_PRE_B_LEGAL_VERSION, occurrenceNotificationsAvailable: false };

describe("Epoch A runtime promotion", () => {
  it("does not let a paused same-owner run reopen during prepare", () => {
    expect(reconcileEpochA({ stage: "prepare", request, status: { sales_paused: true, owner_release_id: request.release_id, owner_mode: "CONTROLLED_CUTOVER", expected: request.expected, acquired_at: null, paused_at: null, reopened_at: null }, runtime, completion: incomplete, legal })).toEqual({ action: "READY_TO_COMPLETE" });
  });

  it("requires a separate complete action and rejects a foreign owner", () => {
    expect(reconcileEpochA({ stage: "complete", request, status: { sales_paused: false, owner_release_id: null, owner_mode: null, expected: null, acquired_at: null, paused_at: null, reopened_at: null }, runtime, completion: incomplete, legal })).toEqual({ action: "BLOCKED", reason: "EPOCH_A_COMPLETE_REQUIRES_PAUSED_OWNER" });
    expect(reconcileEpochA({ stage: "prepare", request, status: { sales_paused: true, owner_release_id: "another-owner", owner_mode: "CONTROLLED_CUTOVER", expected: request.expected, acquired_at: null, paused_at: null, reopened_at: null }, runtime, completion: incomplete, legal })).toEqual({ action: "BLOCKED", reason: "EPOCH_A_FOREIGN_RELEASE_OWNER" });
  });

  it("treats future legal publication or an active notification capability as a blocking compatibility defect", () => {
    expect(epochADormantLegalEvidence({ runtime, publicLegalVersion: "2026-08-28.1", occurrenceNotificationsAvailable: false })).toBe("EPOCH_A_FUTURE_LEGAL_RELEASE_ACTIVE");
    expect(epochADormantLegalEvidence({ runtime, publicLegalVersion: EPOCH_A_PRE_B_LEGAL_VERSION, occurrenceNotificationsAvailable: true })).toBe("EPOCH_A_NOTIFICATION_CAPABILITY_NOT_DORMANT");
  });
});
