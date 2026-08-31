import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  EPOCH_B_CANONICAL_MANIFEST_SHA256,
  EPOCH_B_LEGAL_VERSION,
  EPOCH_B_RELEASE_ID,
  EPOCH_B_RUNTIME_R,
  canonicalEpochBPublishTime,
  createEpochBPromotionArtifact,
  epochBPromotionArtifactReason,
  parseEpochBLegalDraft,
  reconcileEpochB,
} from "../src/epoch-b-notification-activation";
import { migrationInventoryExpectation } from "../src/release-expectation";

const migrationVersions = ["0038_occurrence_availability_notifications.sql"];
const freshTimestamp = new Date().toISOString();
const expected = (source = EPOCH_B_RUNTIME_R, legal = "2026-08-26.1") => ({
  source_commit: source,
  migration: migrationInventoryExpectation(migrationVersions),
  legal_version: legal,
  legal_manifest_sha256: legal === EPOCH_B_LEGAL_VERSION ? EPOCH_B_CANONICAL_MANIFEST_SHA256 : "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  legal_hashes: { PUBLIC_OFFER: "a", PRIVACY_POLICY: "b", PD_CONSENT: "c", CHECKOUT_DISCLOSURE: "d" },
});
const requestR = { release_id: EPOCH_B_RELEASE_ID, mode: "CONTROLLED_CUTOVER" as const, expected: expected() };
const requestLegalB = { release_id: EPOCH_B_RELEASE_ID, mode: "CONTROLLED_CUTOVER" as const, expected: expected(EPOCH_B_RUNTIME_R, EPOCH_B_LEGAL_VERSION) };
const requestP = { release_id: EPOCH_B_RELEASE_ID, mode: "CONTROLLED_CUTOVER" as const, expected: expected("1111111111111111111111111111111111111111", EPOCH_B_LEGAL_VERSION) };
const epochARequest = { ...requestR, release_id: "epoch-a-dormant-notifications:80e152259628719af20d363a76ed6b991d67482a" };
const completion = (request: typeof requestR, complete = true) => ({ complete, expected: complete ? request.expected : null, reopened_at: null });
const status = (request: typeof requestR | typeof requestP | undefined, paused = Boolean(request)) => ({
  sales_paused: paused,
  owner_release_id: request?.release_id ?? null,
  owner_mode: request?.mode ?? null,
  expected: request?.expected ?? null,
  acquired_at: null,
  paused_at: null,
  reopened_at: null,
});
const runtime = (request: typeof requestR | typeof requestP) => ({
  source_commit: request.expected.source_commit,
  migration_versions: migrationVersions,
  required_migrations: {},
  worker_source_commit: request.expected.source_commit,
  worker_started_at: freshTimestamp,
  worker_observed_at: freshTimestamp,
  worker_last_successful_sweep_at: freshTimestamp,
  legal_version: request.expected.legal_version,
  legal_manifest_sha256: request.expected.legal_manifest_sha256,
  legal_hashes: request.expected.legal_hashes,
  legal_publish_time: freshTimestamp,
  source_legal_manifest_sha256: request.expected.legal_manifest_sha256,
  source_legal_publish_time: freshTimestamp,
  current_legal_copies_match: true,
});

describe("Epoch B legal activation policy", () => {
  it("binds the literal reviewed draft to B canonical legal identity", () => {
    const { raw, manifest } = parseEpochBLegalDraft(readFileSync("commerce/legal/production-manifest.2026-08-28.1.draft.json"));
    expect(raw.version).toBe(EPOCH_B_LEGAL_VERSION);
    expect(manifest.documents.PRIVACY_POLICY.sha256).toBe("642d11458733e8c1e5bfb28d0cde7f917a276dfcb3e32dc52adc34fac6326339");
  });

  it("accepts only a parseable non-placeholder durable publication timestamp", () => {
    expect(canonicalEpochBPublishTime("2026-08-31 01:02:03")).toBe("2026-08-31T01:02:03Z");
    expect(canonicalEpochBPublishTime("PENDING_AUTHORITATIVE_PUBLISH_TIMESTAMP")).toBeUndefined();
    expect(canonicalEpochBPublishTime("not-a-timestamp")).toBeUndefined();
  });

  it("reconstructs one exact direct-child P from the durable timestamp without a candidate checkout", () => {
    const objectDirectory = mkdtempSync(join(tmpdir(), "flexperiment-epoch-b-test-objects-"));
    const originalObjects = process.env.GIT_OBJECT_DIRECTORY;
    const originalAlternates = process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
    try {
      const repositoryObjects = execFileSync("git", ["rev-parse", "--git-path", "objects"], { encoding: "utf8" }).trim();
      process.env.GIT_OBJECT_DIRECTORY = objectDirectory;
      process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = repositoryObjects;
      const effectiveAt = "2026-08-31 01:02:03";
      const first = createEpochBPromotionArtifact({ base: EPOCH_B_RUNTIME_R, effectiveAt });
      const second = createEpochBPromotionArtifact({ base: EPOCH_B_RUNTIME_R, effectiveAt });
      expect(first).toBe(second);
      expect(epochBPromotionArtifactReason(first, effectiveAt)).toBeUndefined();
      expect(execFileSync("git", ["rev-list", "--parents", "-n", "1", first], { encoding: "utf8" }).trim().split(/\s+/)).toEqual([first, EPOCH_B_RUNTIME_R]);
    } finally {
      if (originalObjects === undefined) delete process.env.GIT_OBJECT_DIRECTORY; else process.env.GIT_OBJECT_DIRECTORY = originalObjects;
      if (originalAlternates === undefined) delete process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES; else process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = originalAlternates;
      rmSync(objectDirectory, { recursive: true, force: true });
    }
  });

  it("allows fresh acquisition only from completed Epoch A, open R, and dormant pre-B legal state", () => {
    const input = {
      stage: "prepare" as const, requestR, requestLegalB, status: status(undefined), epochARequest, epochACompletion: completion(epochARequest), epochBCompletion: completion(requestR, false),
      runtime: runtime(requestR), legal: { version: "2026-08-26.1", occurrenceNotificationsAvailable: false }, pointer: EPOCH_B_RUNTIME_R,
    };
    expect(reconcileEpochB(input)).toEqual({ action: "ACQUIRE_AND_PAUSE" });
    expect(reconcileEpochB({ ...input, legal: { version: EPOCH_B_LEGAL_VERSION, occurrenceNotificationsAvailable: true } })).toEqual({ action: "BLOCKED", reason: "EPOCH_B_FRESH_ADOPTION_FORBIDDEN" });
    expect(reconcileEpochB({ ...input, epochACompletion: completion(epochARequest, false) })).toEqual({ action: "BLOCKED", reason: "EPOCH_B_EPOCH_A_NOT_COMPLETE" });
  });

  it("keeps same-owner pre-publication recovery distinct from active P recovery", () => {
    const base = {
      stage: "prepare" as const, requestR, requestLegalB, status: status(requestR), epochARequest, epochACompletion: completion(epochARequest), epochBCompletion: completion(requestR, false), pointer: EPOCH_B_RUNTIME_R,
      runtime: runtime(requestR),
    };
    expect(reconcileEpochB({ ...base, legal: { version: "2026-08-26.1", occurrenceNotificationsAvailable: false } })).toEqual({ action: "BIND_LEGAL_B" });
    expect(reconcileEpochB({ ...base, status: status(requestLegalB), runtime: runtime(requestR), legal: { version: "2026-08-26.1", occurrenceNotificationsAvailable: false } })).toEqual({ action: "PUBLISH_LEGAL_B" });
    expect(reconcileEpochB({ ...base, requestP, status: status(requestLegalB), runtime: runtime(requestR), legal: { version: EPOCH_B_LEGAL_VERSION, occurrenceNotificationsAvailable: false } })).toEqual({ action: "PROMOTE_PUBLISHED_LEGAL" });
    expect(reconcileEpochB({ ...base, requestP, status: status(requestP), runtime: runtime(requestR), legal: { version: EPOCH_B_LEGAL_VERSION, occurrenceNotificationsAvailable: false }, pointer: EPOCH_B_RUNTIME_R })).toEqual({ action: "DEPLOY_OR_CONVERGE" });
    expect(reconcileEpochB({ ...base, requestP, status: status(requestP), runtime: runtime(requestR), legal: { version: EPOCH_B_LEGAL_VERSION, occurrenceNotificationsAvailable: false }, pointer: requestP.expected.source_commit })).toEqual({ action: "DEPLOY_OR_CONVERGE" });
    expect(reconcileEpochB({ ...base, requestP, status: status(requestP), runtime: runtime(requestP), legal: { version: EPOCH_B_LEGAL_VERSION, occurrenceNotificationsAvailable: true }, pointer: requestP.expected.source_commit })).toEqual({ action: "READY_TO_COMPLETE" });
    expect(reconcileEpochB({ ...base, stage: "complete", requestP, status: status(requestP), runtime: runtime(requestP), legal: { version: EPOCH_B_LEGAL_VERSION, occurrenceNotificationsAvailable: true }, pointer: requestP.expected.source_commit })).toEqual({ action: "READY_TO_COMPLETE" });
  });
});
