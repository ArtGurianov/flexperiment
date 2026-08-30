import { createHash, randomUUID } from "node:crypto";
import { isMigrationFilenameExpectation, isMigrationInventoryExpectation, migrationInventoryExpectation } from "./release-expectation";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import { canonicalLegalManifest, parseLegalManifest, type LegalManifest } from "./legal-manifest";
import { parseUtcTimestamp } from "./utc-timestamp";
import { assertAppliedMigrationPrefix, candidateExpectedMigration, isTerminalPhase, parsePostActivationEmailProviderDefectEvidence, parsePreActivationDefectEvidence, preActivationDefectClasses, reconcileHeadWithProjection, releaseStateHash, replayReleaseGenerationChain, runtimeReadinessActionableErrorClasses, type GenerationHead, type ReleasePhase, type RuntimeReadinessActionableErrorClass, type V2Event } from "./release-generation";
import { evaluateCertificationEvidence } from "./certification-evidence";
import { pricePromo } from "./promo-pricing";

export type ReleaseMode = "CONTROLLED_CUTOVER" | "ROLLING";
export type ReleaseExpectations = {
  source_commit: string;
  migration: string;
  legal_version: string;
  legal_manifest_sha256: string;
  legal_hashes: Record<"PUBLIC_OFFER" | "PRIVACY_POLICY" | "PD_CONSENT" | "CHECKOUT_DISCLOSURE", string>;
};
export type ReleaseControlRequest = { release_id: string; mode: ReleaseMode; expected: ReleaseExpectations };
export type ReleaseControlStatus = {
  sales_paused: boolean;
  owner_release_id: string | null;
  owner_mode: ReleaseMode | null;
  expected: Omit<ReleaseExpectations, "legal_hashes"> | null;
  acquired_at: string | null;
  paused_at: string | null;
  reopened_at: string | null;
};
export type ReleaseCompletion = {
  complete: boolean;
  expected: ReleaseExpectations | null;
  reopened_at: string | null;
};
/**
 * A deliberately non-generic bridge for the one paused production generation
 * which predates RUNTIME_READINESS_DEFECT replay support. Do not reuse these
 * constants for a future recovery path.
 */
export const gen2BootstrapAdoption = {
  release_id: "promo-codes-v0:b01f217ffd2a798fd32aa3d88e125a2e460bd39f",
  from_generation: 2,
  from_source_commit: "631876c16d03bf593d2a383ef89099b1f9d435ca",
  to_generation: 3,
  to_source_commit: "4ae2e047ef9236a22cb8bcd5f4dc9127d282d6ca",
  target_replay_sha256: "27036ae4f14b0188a14e4fc8130443a70627c1effb8ded9b6a9e270d23e94ffc",
} as const;
/**
 * Bound to the exact deployed-but-defective generation 3 candidate. Unlike
 * gen2BootstrapAdoption this classifies the same generation in place; it
 * never changes candidate_generation or source_commit, and the already-
 * deployed runtime can still replay the resulting ledger afterward.
 */
export const gen3ReadinessClassification = {
  release_id: "promo-codes-v0:b01f217ffd2a798fd32aa3d88e125a2e460bd39f",
  generation: 3,
  source_commit: "4ae2e047ef9236a22cb8bcd5f4dc9127d282d6ca",
  from_phase: "PAUSED",
  phase_sequence: 0,
  readiness_component: "PROVIDER_READINESS",
  error_class: "PROVIDER_BAD_REQUEST",
  error_code: "HTTP_400",
} as const;
/**
 * Bound to the exact certified gen4/R2 history and its own recorded
 * certification evidence. Unlike gen3ReadinessClassification this appends
 * two events in one transaction (PUBLIC_FRONTEND_DEFECT then
 * CANDIDATE_SUPERSEDED): the target runtime must already understand the
 * defect edge before it exists in production history, so this bridge must
 * only ever run built from that target runtime's own commit.
 */
export const gen4PublicFrontendRecoveryBridge = {
  release_id: "promo-codes-v0:b01f217ffd2a798fd32aa3d88e125a2e460bd39f",
  from_generation: 4,
  from_source_commit: "5bdbb1a16505fc1711ba8eccdcdd64c6fc1451d9",
  from_phase: "CERTIFIED",
  from_phase_sequence: 4,
  to_generation: 5,
  to_source_commit: "97678cc19d2549146b0d4999466a4cded9320208",
  defect: {
    component: "PUBLIC_FRONTEND",
    error_class: "STATIC_ROUTING",
    error_code: "NESTED_TRAILING_SLASH_403",
    probe_path: "/legal/public-offer/",
    http_status: 403,
    observed_frontend_source_commit: "4ae2e047ef9236a22cb8bcd5f4dc9127d282d6ca",
  },
  certification: {
    lease_id: "e6cd4cd5-bb5c-41cd-8fd9-fe55be495eee",
    occurrence_id: "768ebffe-90cc-4f4a-85c4-4864f0ac3b3a",
    promo_id: "9c379dae-2528-49ed-b45c-927214861718",
    expected_idempotency_key_hash: "2541e4acf822ec6b0c8557915bbe7092e8a8c8a5f8944fb1bc9e8bf0cf622cd1",
    lease_expires_at: "2026-08-27T12:10:41.003Z",
    order_id: "11a8efe2-8d9a-4869-b0f8-f770292ed246",
    payment_id: "b51bde32-1de0-4088-a64a-fe2e34f77f10",
    refund_id: "bc82e297-f067-4eac-99b7-536263f25d7b",
    price_kopecks: 101,
    discount_kopecks: 1,
    amount_kopecks: 100,
    captured_kopecks: 100,
    refunded_kopecks: 100,
  },
  fixture: {
    visibility: "HIDDEN",
    sales_status: "CLOSED",
    fulfillment_status: "SCHEDULED",
    price_kopecks: 101,
  },
  target_replay_sha256: "088bc22ca1aafe40b3c075998a94588275093b10e1646b7cefddc3be01bff6c6",
} as const;
export type CandidateAcquireRequest = { head: GenerationHead };
export type CandidateAdoptRequest = { head: GenerationHead; expected_generation: number; from_sha: string; expected_state_hash: string };
export type CandidatePhaseRequest = { release_id: string; candidate_generation: number; expected_state_hash: string; from_phase: ReleasePhase; phase_sequence: number; to_phase: Exclude<ReleasePhase, "COMPLETE"> };
/**
 * Recovery for a defect discovered AFTER certification and BEFORE activation.
 *
 * That window had no controller path in either direction, which is a stranded
 * state rather than a missing convenience:
 *
 *   abort                       refuses any generation that was ever CERTIFIED
 *   runtime-readiness defect    only classifies a PAUSED generation
 *   replacement adoption        requires RECOVERY_REQUIRED
 *
 * So a candidate that certified cleanly and then failed its activation
 * preconditions could go neither forward nor back, while attempt authority was
 * still safely LEGACY and nothing irreversible had happened. This transition is
 * deliberately narrower than weakening abort: it exists only while the store is
 * still on LEGACY and the dispatch fence still belongs to this release, so it
 * cannot be used to walk back anything that has actually moved.
 */
export type PreActivationDefectRequest = {
  release_id: string;
  candidate_generation: number;
  expected_state_hash: string;
  defect_class: "ACTIVATION_REFUSAL" | "CERTIFICATION_DISPATCH_TARGET_INVALID";
  defect_code: string;
};

/**
 * A distinct recovery edge after authority has moved.  It carries no provider
 * claim from the controller: the runtime resolves all failure facts from its
 * own exact certification-order rows inside the release-control transaction.
 */
export type PostActivationEmailProviderDefectRequest = {
  release_id: string;
  candidate_generation: number;
  expected_state_hash: string;
  expected_authority_revision: number;
};

export type PostActivationAuthoritySnapshot = {
  attempt_authority: "LEGACY" | "ATTEMPT";
  email_dispatch_paused: boolean;
  dispatch_owner_release_id: string | null;
  dispatch_owner_generation: number | null;
  revision: number;
  drained: boolean;
};

export type PostActivationEmailProviderDefectReader = () => {
  order_id: string | null;
  unfenced_at: string | null;
  ticket_attempt: {
    outbox_id: string;
    attempt_id: string | null;
    attempt_no: number | null;
    outcome: string | null;
    started_at: string | null;
    failure_code: string | null;
    provider_error_code: string | null;
  } | null;
  exact: boolean;
};

/**
 * Injected and evaluated INSIDE the transaction.
 *
 * Returns the durable defect code when the certification dispatch target is
 * unusable, or null when it is fine. A classification rather than raw rows, so
 * this module still keeps no knowledge of the outbox tables - but read under
 * the same BEGIN IMMEDIATE that appends the ledger edge, because the
 * message-level state it describes is deliberately NOT serialized by the
 * dispatch fence: seam 4 permits suppression and supersession throughout.
 */
export type CertificationDispatchTargetReader = () => string | null;

/** Injected, so this module keeps no knowledge of the outbox tables. */
export type OutboxAuthoritySnapshot = {
  attempt_authority: "LEGACY" | "ATTEMPT";
  email_dispatch_paused: boolean;
  dispatch_owner_release_id: string | null;
};

export type RuntimeReadinessDefectRequest = {
  release_id: string;
  candidate_generation: number;
  expected_state_hash: string;
  readiness_component: "PROVIDER_READINESS";
  error_class: RuntimeReadinessActionableErrorClass;
  error_code: string;
};
export type CandidateCompleteRequest = { release_id: string; candidate_generation: number; expected_state_hash: string };
export type CandidateAbortRequest = { release_id: string; candidate_generation: number; expected_state_hash: string; reason: string };
export type CandidateHeadSnapshot = { schema_version: 2; head: GenerationHead | null; state_hash: string | null };
export type CertificationLeaseRequest = {
  release_id: string;
  candidate_generation: number;
  expected_state_hash: string;
  occurrence_id: string;
  promo_id: string;
  expected_idempotency_key_hash: string;
  lease_seconds: number;
};
export type CertificationEvidenceRequest = {
  release_id: string;
  candidate_generation: number;
  expected_state_hash: string;
  order_id: string;
};
export type CertificationRetryRequest = { release_id: string; candidate_generation: number; expected_state_hash: string; retry_reason: "OPERATIONAL" };
export type CertificationOrderContext = { occurrence_id: string; promo_id: string | null; idempotency_key_hash?: string };
export type ReleaseRuntimeEvidence = {
  source_commit: string | null;
  required_migrations: Record<string, boolean>;
  migration_versions: string[];
  legal_version: string | null;
  legal_manifest_sha256: string | null;
  legal_hashes: ReleaseExpectations["legal_hashes"] | null;
  legal_publish_time: string | null;
  current_legal_copies_match: boolean;
  worker_source_commit: string | null;
  worker_started_at: string | null;
  worker_observed_at: string | null;
  worker_last_successful_sweep_at: string | null;
  source_legal_manifest_sha256: string | null;
  source_legal_publish_time: string | null;
  migration_source_hashes?: Record<string, string> | null;
};

export const diagnosticCutoverMigrations = ["0031_participant_age_band.sql", "0032_release_sales_gate.sql", "0033_runtime_release_evidence.sql", "0034_worker_sweep_evidence.sql"] as const;
const requiredMigrationsByExpectedMigration: Record<string, readonly string[]> = {
  "0033_runtime_release_evidence.sql": ["0032_release_sales_gate.sql", "0033_runtime_release_evidence.sql"],
  "0034_worker_sweep_evidence.sql": diagnosticCutoverMigrations,
  "0035_promo_codes_v0.sql": [...diagnosticCutoverMigrations, "0035_promo_codes_v0.sql"],
  "0036_tochka_provider_error_evidence.sql": [...diagnosticCutoverMigrations, "0035_promo_codes_v0.sql", "0036_tochka_provider_error_evidence.sql"],
  // The sales-availability cutover left this as the durable expectation. The
  // generic controller now acquires with the inventory form instead, but a
  // filename-form acquire for 0038 must still be possible for manual recovery.
  "0038_occurrence_availability_notifications.sql": [...diagnosticCutoverMigrations, "0035_promo_codes_v0.sql", "0036_tochka_provider_error_evidence.sql", "0037_emergency_sales_gate.sql", "0038_occurrence_availability_notifications.sql"],
};
export const requiredMigrationsFor = (expectedMigration: string): readonly string[] | undefined => requiredMigrationsByExpectedMigration[expectedMigration];
export { migrationInventoryExpectation } from "./release-expectation";
const supportedMigrationExpectation = (expectedMigration: string): boolean =>
  requiredMigrationsFor(expectedMigration) !== undefined || isMigrationInventoryExpectation(expectedMigration);
export const WORKER_EVIDENCE_MAX_AGE_MS = 90_000;

export const workerEvidenceIsFresh = (workerSourceCommit: string | null, workerObservedAt: string | null, expectedSourceCommit: string, currentTime = Date.now()): boolean => {
  if (workerSourceCommit !== expectedSourceCommit || !workerObservedAt) return false;
  const observedAt = parseUtcTimestamp(workerObservedAt);
  return !Number.isNaN(observedAt) && observedAt >= currentTime - WORKER_EVIDENCE_MAX_AGE_MS && observedAt <= currentTime + 5_000;
};

export const workerSweepEvidenceIsFresh = (workerSourceCommit: string | null, workerStartedAt: string | null, workerSweepAt: string | null, expectedSourceCommit: string, currentTime = Date.now()): boolean => {
  if (!workerStartedAt || !workerEvidenceIsFresh(workerSourceCommit, workerSweepAt, expectedSourceCommit, currentTime)) return false;
  const startedAt = parseUtcTimestamp(workerStartedAt);
  const sweepAt = workerSweepAt ? parseUtcTimestamp(workerSweepAt) : Number.NaN;
  return !Number.isNaN(startedAt) && !Number.isNaN(sweepAt) && sweepAt >= startedAt;
};

export class ReleaseControlError extends Error {
  constructor(readonly code: string, readonly status: 409 | 503 = 409) { super(code); }
}

type GateRow = {
  sales_paused: number;
  owner_release_id: string | null;
  owner_mode: ReleaseMode | null;
  expected_source_commit: string | null;
  expected_migration: string | null;
  expected_legal_version: string | null;
  expected_legal_manifest_sha256: string | null;
  acquired_at: string | null;
  paused_at: string | null;
  reopened_at: string | null;
};

type ReopenedEvent = { details_json: string; created_at: string };

const documentIds = ["PUBLIC_OFFER", "PRIVACY_POLICY", "PD_CONSENT", "CHECKOUT_DISCLOSURE"] as const;
const event = (db: Database.Database, releaseId: string, action: "ACQUIRED" | "PAUSED" | "REOPENED", details: unknown) =>
  db.prepare("INSERT INTO release_sales_gate_events(id, release_id, action, details_json) VALUES (?, ?, ?, ?)")
    .run(randomUUID(), releaseId, action, JSON.stringify(details));

const row = (db: Database.Database) => db.prepare(`SELECT sales_paused, owner_release_id, owner_mode,
  expected_source_commit, expected_migration, expected_legal_version, expected_legal_manifest_sha256,
  acquired_at, paused_at, reopened_at FROM release_sales_gate WHERE singleton = 1`).get() as GateRow | undefined;

const status = (gate: GateRow): ReleaseControlStatus => ({
  sales_paused: gate.sales_paused === 1,
  owner_release_id: gate.owner_release_id,
  owner_mode: gate.owner_mode,
  expected: gate.expected_source_commit && gate.expected_migration && gate.expected_legal_version && gate.expected_legal_manifest_sha256
    ? { source_commit: gate.expected_source_commit, migration: gate.expected_migration, legal_version: gate.expected_legal_version, legal_manifest_sha256: gate.expected_legal_manifest_sha256 }
    : null,
  acquired_at: gate.acquired_at,
  paused_at: gate.paused_at,
  reopened_at: gate.reopened_at,
});

const sameExpectations = (gate: GateRow, request: ReleaseControlRequest) =>
  gate.owner_release_id === request.release_id
  && gate.owner_mode === request.mode
  && gate.expected_source_commit === request.expected.source_commit
  && gate.expected_migration === request.expected.migration
  && gate.expected_legal_version === request.expected.legal_version
  && gate.expected_legal_manifest_sha256 === request.expected.legal_manifest_sha256;

/**
 * A non-v2 (legacy/generic) owner's coarse lifecycle is exactly
 * ACQUIRED -> PAUSED -> REOPENED, ordered by rowid (never timestamps),
 * each step optional but only reachable from the previous one, no repeats,
 * and no event after the terminal REOPENED. This proves a foreign gate
 * owner is a genuine generic deployment in a state consistent with the
 * projection - not merely a release_id that happens not to be a v2 release
 * (see "completed v2 + garbage owner" - that must still be corrupt).
 * updateExpectations() intentionally does not append a new ACQUIRED/PAUSED
 * event when it changes a paused owner's expected source/migration, so this
 * only checks coarse ownership/pause state, never the frozen expected
 * payload of the original event.
 */
const reconcileLegacyOwnerWithProjection = (actions: readonly string[], salesPaused: boolean): string | undefined => {
  let state: "NONE" | "ACQUIRED" | "PAUSED" | "REOPENED" = "NONE";
  for (const action of actions) {
    if (action === "ACQUIRED" && state === "NONE") state = "ACQUIRED";
    else if (action === "PAUSED" && state === "ACQUIRED") state = "PAUSED";
    else if (action === "REOPENED" && state === "PAUSED") state = "REOPENED";
    else return "RELEASE_STATE_CORRUPT";
  }
  if (state === "ACQUIRED") return salesPaused ? "RELEASE_STATE_CORRUPT" : undefined;
  if (state === "PAUSED") return salesPaused ? undefined : "RELEASE_STATE_CORRUPT";
  return "RELEASE_STATE_CORRUPT";
};

/**
 * Runtime evidence carries two independent views of what's applied:
 * `required_migrations` is a bounded map (only ever populated for the fixed
 * diagnosticCutoverMigrations set - see releaseRuntimeEvidence()), while
 * `migration_versions` is the complete applied-migration inventory. A
 * version can be legitimately applied and correctly reported while absent
 * from `required_migrations` simply because it postdates that fixed set
 * (e.g. 0035/0036) - `required_migrations[version] === true` is therefore
 * sufficient positive evidence on its own, but its absence or `false` is
 * NOT sufficient negative evidence: `migration_versions` is the complete
 * applied-migration inventory, so it must also be checked before concluding
 * a version was not applied. evaluateCandidateReopenGate() already used the
 * correct OR; evaluateReopenGate() used only the map and was unconditionally
 * broken for any expected migration beyond the diagnostic set (see the
 * 2026-08-28 run 33139603447 regression - reproduced exactly in the test
 * suite). Shared here so the two gates cannot drift again.
 */
export const migrationApplied = (evidence: ReleaseRuntimeEvidence, version: string): boolean =>
  evidence.required_migrations[version] === true || evidence.migration_versions.includes(version);

export const evaluateReopenGate = (request: ReleaseControlRequest, evidence: ReleaseRuntimeEvidence): string | undefined => {
  if (evidence.source_commit !== request.expected.source_commit) return "SOURCE_COMMIT_MISMATCH";
  const requiredMigrations = requiredMigrationsFor(request.expected.migration);
  const inventoryExpectation = isMigrationInventoryExpectation(request.expected.migration);
  if (!requiredMigrations && !inventoryExpectation) return "UNKNOWN_EXPECTED_MIGRATION";
  if (requiredMigrations?.some((version) => !migrationApplied(evidence, version))) return "REQUIRED_MIGRATION_NOT_APPLIED";
  if (requiredMigrations && !evidence.migration_versions.includes(request.expected.migration)) return "EXPECTED_MIGRATION_NOT_APPLIED";
  if (inventoryExpectation && migrationInventoryExpectation(evidence.migration_versions) !== request.expected.migration) return "MIGRATION_INVENTORY_MISMATCH";
  if (inventoryExpectation || requiredMigrations?.includes("0034_worker_sweep_evidence.sql")) {
    if (!evidence.worker_source_commit || !evidence.worker_started_at || !evidence.worker_observed_at) return "WORKER_NOT_READY";
    if (evidence.worker_source_commit !== request.expected.source_commit) return "WORKER_SOURCE_COMMIT_MISMATCH";
    if (!workerEvidenceIsFresh(evidence.worker_source_commit, evidence.worker_observed_at, request.expected.source_commit)) return "WORKER_EVIDENCE_STALE";
    if (!evidence.worker_last_successful_sweep_at) return "WORKER_SUCCESSFUL_SWEEP_UNAVAILABLE";
    if (!workerSweepEvidenceIsFresh(evidence.worker_source_commit, evidence.worker_started_at, evidence.worker_last_successful_sweep_at, request.expected.source_commit)) return "WORKER_SUCCESSFUL_SWEEP_INVALID";
  }
  if (evidence.legal_version !== request.expected.legal_version) return "LEGAL_VERSION_MISMATCH";
  if (evidence.legal_manifest_sha256 !== request.expected.legal_manifest_sha256) return "LEGAL_MANIFEST_MISMATCH";
  if (!evidence.legal_publish_time || evidence.legal_publish_time === "PENDING_AUTHORITATIVE_PUBLISH_TIMESTAMP" || Number.isNaN(parseUtcTimestamp(evidence.legal_publish_time))) return "LEGAL_PUBLISH_TIME_INVALID";
  if (!evidence.current_legal_copies_match) return "CURRENT_LEGAL_COPIES_MISMATCH";
  if (!evidence.legal_hashes) return "LEGAL_HASHES_UNAVAILABLE";
  for (const id of documentIds) if (evidence.legal_hashes[id] !== request.expected.legal_hashes[id]) return `LEGAL_HASH_MISMATCH_${id}`;
  return undefined;
};

/** Candidate generations may append 0036+; the generic legacy controller may not. */
const evaluateCandidateReopenGate = (request: ReleaseControlRequest, evidence: ReleaseRuntimeEvidence): string | undefined => {
  const migration = request.expected.migration;
  if (!isMigrationFilenameExpectation(migration)) return "UNKNOWN_EXPECTED_MIGRATION";
  if (evidence.source_commit !== request.expected.source_commit) return "SOURCE_COMMIT_MISMATCH";
  if (![...diagnosticCutoverMigrations, migration].every((version) => migrationApplied(evidence, version))) return "REQUIRED_MIGRATION_NOT_APPLIED";
  if (!evidence.migration_versions.includes(migration)) return "EXPECTED_MIGRATION_NOT_APPLIED";
  if (!evidence.worker_source_commit || !evidence.worker_started_at || !evidence.worker_observed_at) return "WORKER_NOT_READY";
  if (!workerEvidenceIsFresh(evidence.worker_source_commit, evidence.worker_observed_at, request.expected.source_commit)) return "WORKER_EVIDENCE_STALE";
  if (!evidence.worker_last_successful_sweep_at || !workerSweepEvidenceIsFresh(evidence.worker_source_commit, evidence.worker_started_at, evidence.worker_last_successful_sweep_at, request.expected.source_commit)) return "WORKER_SUCCESSFUL_SWEEP_INVALID";
  if (evidence.legal_version !== request.expected.legal_version) return "LEGAL_VERSION_MISMATCH";
  if (evidence.legal_manifest_sha256 !== request.expected.legal_manifest_sha256) return "LEGAL_MANIFEST_MISMATCH";
  if (!evidence.legal_publish_time || Number.isNaN(parseUtcTimestamp(evidence.legal_publish_time))) return "LEGAL_PUBLISH_TIME_INVALID";
  if (!evidence.current_legal_copies_match || !evidence.legal_hashes) return "CURRENT_LEGAL_COPIES_MISMATCH";
  for (const id of documentIds) if (evidence.legal_hashes[id] !== request.expected.legal_hashes[id]) return `LEGAL_HASH_MISMATCH_${id}`;
  return undefined;
};

export class ReleaseSalesGate {
  constructor(private readonly db: Database.Database) {}

  status() {
    const gate = row(this.db);
    if (!gate) throw new ReleaseControlError("RELEASE_CONTROL_UNAVAILABLE", 503);
    return status(gate);
  }

  completion(releaseId: string): ReleaseCompletion {
    const gate = row(this.db);
    if (!gate) throw new ReleaseControlError("RELEASE_CONTROL_UNAVAILABLE", 503);
    const eventRow = this.db.prepare("SELECT details_json, created_at FROM release_sales_gate_events WHERE release_id = ? AND action = 'REOPENED' ORDER BY created_at DESC LIMIT 1").get(releaseId) as ReopenedEvent | undefined;
    if (!eventRow) return { complete: false, expected: null, reopened_at: null };
    try {
      const expected = (JSON.parse(eventRow.details_json) as { expected?: ReleaseExpectations }).expected;
      if (!expected) return { complete: false, expected: null, reopened_at: null };
      return { complete: true, expected, reopened_at: eventRow.created_at };
    } catch { return { complete: false, expected: null, reopened_at: null }; }
  }

  /**
   * Shared ownership-consistency check between the current legacy/generic
   * gate row and the v2 candidate-generation ledger. Used identically by
   * assertNewOrdersOpen() (checkout-path enforcement) and candidateHead()
   * (audit/read path) so the two readers can never again diverge on what
   * counts as a consistent vs corrupt combination of owner + v2 history -
   * that divergence (candidateHead() assuming a non-null owner always means
   * exactly one still-active v2 candidate) is what let a legitimate
   * completed-v2-epoch + ordinary-generic-owner production state be
   * misclassified as corrupt here while assertNewOrdersOpen() already
   * accepted it correctly.
   *
   * Throws RELEASE_STATE_CORRUPT on any inconsistency; otherwise returns
   * normally. Deliberately says nothing about sales_paused gating, active-head
   * selection, or historical-head selection - callers own that.
   */
  private reconcileGateOwnership(gate: GateRow, byRelease: ReadonlyMap<string, V2Event[]>, active: readonly GenerationHead[]): void {
    if (byRelease.size && gate.owner_release_id === null) {
      if (active.length || gate.sales_paused === 1) throw new ReleaseControlError("RELEASE_STATE_CORRUPT", 503);
    } else if (gate.owner_release_id !== null && active.length) {
      if (active.length !== 1 || reconcileHeadWithProjection(active[0], { owner_release_id: gate.owner_release_id, sales_paused: gate.sales_paused === 1, expected_source_commit: gate.expected_source_commit, expected_migration: gate.expected_migration, expected_legal_version: gate.expected_legal_version, expected_legal_manifest_sha256: gate.expected_legal_manifest_sha256 })) throw new ReleaseControlError("RELEASE_STATE_CORRUPT", 503);
    } else if (gate.owner_release_id !== null) {
      // A completed v2 release's own reconcile invariant (its owner must be
      // null) still applies specifically to its own release_id: it must
      // never itself reappear as the gate's owner.
      if (byRelease.has(gate.owner_release_id)) throw new ReleaseControlError("RELEASE_STATE_CORRUPT", 503);
      // Any other owner is a distinct, allowed mode - a completed v2 head
      // remains historical integrity evidence but no longer owns the coarse
      // projection once superseded - but it must be a *proven* generic
      // owner, not merely a release_id that happens not to be a v2 release:
      // reconcile its own coarse ACQUIRED/PAUSED/REOPENED history against
      // this exact projection.
      const ownerActions = (this.db.prepare("SELECT action FROM release_sales_gate_events WHERE release_id = ? ORDER BY rowid ASC").all(gate.owner_release_id) as { action: string }[]).map((row) => row.action);
      if (reconcileLegacyOwnerWithProjection(ownerActions, gate.sales_paused === 1)) throw new ReleaseControlError("RELEASE_STATE_CORRUPT", 503);
    }
  }

  /**
   * One exact release's head, whatever phase it is in - terminal included.
   *
   * candidateHead() answers "what is the live candidate", so it excludes
   * terminal phases and its historical fallback selects only COMPLETE. That is
   * right for its callers and wrong for recovery: once abort commits, the
   * aborted epoch becomes unreadable, and a later controller run cannot resolve
   * the very epoch it is trying to finish cleaning up after - it cannot even
   * reconcile its own lost abort response.
   *
   * Rather than distort those semantics, this replays exactly the requested
   * release's chain. Read-only, and it makes no claim about which candidate is
   * live.
   */
  releaseHead(releaseId: string): CandidateHeadSnapshot {
    const events = this.db.prepare("SELECT rowid AS seq, release_id, action, details_json FROM release_sales_gate_events WHERE release_id = ? ORDER BY rowid ASC").all(releaseId) as V2Event[];
    const v2 = events.filter((event) => {
      try { return (JSON.parse(event.details_json) as { schema_version?: unknown }).schema_version === 2; }
      catch { return false; }
    });
    // 409 rather than widening the shared status union for one reader; the
    // named code carries the meaning.
    if (!v2.length) throw new ReleaseControlError("RELEASE_HEAD_NOT_FOUND");
    const replay = replayReleaseGenerationChain(v2);
    if (replay.corrupt) throw new ReleaseControlError("RELEASE_STATE_CORRUPT", 503);
    if (!replay.head) throw new ReleaseControlError("RELEASE_HEAD_NOT_FOUND");
    return { schema_version: 2, head: replay.head, state_hash: releaseStateHash(replay.head) };
  }

  candidateHead(): CandidateHeadSnapshot {
    const gate = row(this.db);
    if (!gate) throw new ReleaseControlError("RELEASE_CONTROL_UNAVAILABLE", 503);
    const events = this.db.prepare("SELECT rowid AS seq, release_id, action, details_json FROM release_sales_gate_events ORDER BY rowid ASC").all() as V2Event[];
    const byRelease = new Map<string, V2Event[]>();
    for (const event of events) {
      try { if ((JSON.parse(event.details_json) as { schema_version?: unknown }).schema_version !== 2) continue; }
      catch { continue; }
      byRelease.set(event.release_id, [...(byRelease.get(event.release_id) ?? []), event]);
    }
    const replays = [...byRelease.values()].map((releaseEvents) => ({ events: releaseEvents, replay: replayReleaseGenerationChain(releaseEvents) }));
    if (replays.some(({ replay }) => replay.corrupt)) throw new ReleaseControlError("RELEASE_STATE_CORRUPT", 503);
    const active = replays.flatMap(({ replay }) => replay.head && !isTerminalPhase(replay.head.phase) ? [replay.head] : []);
    this.reconcileGateOwnership(gate, byRelease, active);
    const completedHead = () => {
      const completed = replays
        .filter(({ replay }) => replay.head?.phase === "COMPLETE")
        .sort((left, right) => (right.events.at(-1)?.seq ?? 0) - (left.events.at(-1)?.seq ?? 0));
      return completed.at(0)?.replay.head ?? null;
    };
    if (gate.owner_release_id !== null) {
      if (active.length === 1) return { schema_version: 2, head: active[0], state_hash: releaseStateHash(active[0]) };
      // active.length === 0 here (reconcileGateOwnership already proved the
      // owner is either a legitimately reconciled generic deployment, or
      // there is no v2 history at all). A completed v2 epoch, once
      // superseded by an ordinary generic deploy, remains readable as
      // historical authoritative evidence - it is not reconciled against the
      // *current* generic owner's expectations, which belong to a different,
      // unrelated deployment.
      const head = completedHead();
      return head ? { schema_version: 2, head, state_hash: releaseStateHash(head) } : { schema_version: 2, head: null, state_hash: null };
    }
    if (gate.sales_paused === 1 || active.length) throw new ReleaseControlError("RELEASE_STATE_CORRUPT", 503);
    const head = completedHead();
    if (!head) return { schema_version: 2, head: null, state_hash: null };
    const projection = {
      owner_release_id: gate.owner_release_id, sales_paused: gate.sales_paused === 1,
      expected_source_commit: gate.expected_source_commit, expected_migration: gate.expected_migration,
      expected_legal_version: gate.expected_legal_version, expected_legal_manifest_sha256: gate.expected_legal_manifest_sha256,
    };
    if (reconcileHeadWithProjection(head, projection)) throw new ReleaseControlError("RELEASE_STATE_CORRUPT", 503);
    return { schema_version: 2, head, state_hash: releaseStateHash(head) };
  }

  private v2Head(releaseId: string) {
    const events = this.db.prepare("SELECT rowid AS seq, release_id, action, details_json FROM release_sales_gate_events WHERE release_id = ? ORDER BY rowid ASC").all(releaseId) as V2Event[];
    const replay = replayReleaseGenerationChain(events);
    if (replay.corrupt || !replay.head) throw new ReleaseControlError(replay.corrupt === undefined ? "RELEASE_STATE_STALE" : "RELEASE_STATE_CORRUPT", replay.corrupt ? 503 : 409);
    return replay.head;
  }

  private v2Event(releaseId: string, action: "ACQUIRED" | "PAUSED" | "REOPENED", kind: "CANDIDATE_ACQUIRED" | "CANDIDATE_SUPERSEDED" | "PHASE_CHANGED" | "RUNTIME_READINESS_DEFECT" | "PRE_ACTIVATION_DEFECT" | "POST_ACTIVATION_EMAIL_PROVIDER_DEFECT", details: Record<string, unknown>) {
    event(this.db, releaseId, action, { schema_version: 2, kind, ...details });
  }

  private expectedForHead(head: GenerationHead): ReleaseExpectations {
    const baseline = head.legal_baseline as Partial<ReleaseExpectations>;
    if (!baseline || typeof baseline.legal_version !== "string" || typeof baseline.legal_manifest_sha256 !== "string" || !baseline.legal_hashes) throw new ReleaseControlError("RELEASE_STATE_CORRUPT", 503);
    return { source_commit: head.source_commit, migration: candidateExpectedMigration(head), legal_version: baseline.legal_version, legal_manifest_sha256: baseline.legal_manifest_sha256, legal_hashes: baseline.legal_hashes };
  }

  private assertProposedV2Event(releaseId: string, proposed: Omit<V2Event, "seq" | "release_id">) {
    const events = this.db.prepare("SELECT rowid AS seq, release_id, action, details_json FROM release_sales_gate_events WHERE release_id = ? ORDER BY rowid ASC").all(releaseId) as V2Event[];
    const replay = replayReleaseGenerationChain([...events, { ...proposed, seq: (events.at(-1)?.seq ?? 0) + 1, release_id: releaseId }]);
    if (replay.corrupt) throw new ReleaseControlError("RELEASE_STATE_STALE");
  }

  private assertLegacyMutationAllowed() {
    const events = this.db.prepare("SELECT rowid AS seq, release_id, action, details_json FROM release_sales_gate_events ORDER BY rowid ASC").all() as V2Event[];
    const ids = new Set<string>();
    for (const event of events) { try { if ((JSON.parse(event.details_json) as { schema_version?: unknown }).schema_version === 2) ids.add(event.release_id); } catch { /* forensic legacy row */ } }
    for (const releaseId of ids) { const replay = this.v2Head(releaseId); if (!isTerminalPhase(replay.phase)) throw new ReleaseControlError("RELEASE_CONTROL_V2_REQUIRED"); }
  }

  private immediate<T>(operation: () => T): T {
    const transaction = this.db.transaction(operation);
    return transaction.immediate();
  }

  private certificationTableAvailable() {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'release_certification_allowlist'").get());
  }

  private requireCertificationTable() {
    if (!this.certificationTableAvailable()) throw new ReleaseControlError("CERTIFICATION_ALLOWLIST_UNAVAILABLE");
  }

  private certificationLeaseFor(current: GenerationHead, context: CertificationOrderContext) {
    this.requireCertificationTable();
    if (current.phase !== "CERTIFICATION_ONLY" || !current.certification) throw new ReleaseControlError("SALES_TEMPORARILY_PAUSED", 503);
    const binding = current.certification;
    if (binding.status !== "ACTIVE" || binding.occurrence_id !== context.occurrence_id || binding.promo_id !== context.promo_id || (context.idempotency_key_hash !== undefined && binding.expected_idempotency_key_hash !== context.idempotency_key_hash)) throw new ReleaseControlError("SALES_TEMPORARILY_PAUSED", 503);
    const lease = this.db.prepare(`SELECT * FROM release_certification_allowlist
      WHERE lease_id = ? AND owner_release_id = ? AND candidate_generation = ? AND expected_source_commit = ?
        AND occurrence_id = ? AND promo_id = ?`).get(
      binding.lease_id, current.release_id, current.candidate_generation, current.source_commit,
      context.occurrence_id, context.promo_id,
    ) as Record<string, unknown> | undefined;
    if (!lease || lease.status !== "ACTIVE" || lease.expected_idempotency_key_hash !== binding.expected_idempotency_key_hash || (context.idempotency_key_hash !== undefined && lease.expected_idempotency_key_hash !== context.idempotency_key_hash) || String(lease.lease_expires_at) !== binding.lease_expires_at || Number.isNaN(parseUtcTimestamp(String(lease.lease_expires_at))) || parseUtcTimestamp(String(lease.lease_expires_at)) <= Date.now()) throw new ReleaseControlError("SALES_TEMPORARILY_PAUSED", 503);
    return lease;
  }

  acquireCandidate(input: CandidateAcquireRequest) {
    const transaction = () => this.immediate(() => {
      const gate = row(this.db); const head = input.head;
      if (!gate) throw new ReleaseControlError("RELEASE_CONTROL_UNAVAILABLE", 503);
      const existing = this.db.prepare("SELECT 1 FROM release_sales_gate_events WHERE release_id = ? AND details_json LIKE '%\"schema_version\":2%' LIMIT 1").get(head.release_id);
      if (existing) {
        const current = this.v2Head(head.release_id);
        if (releaseStateHash(current) !== releaseStateHash(head)) throw new ReleaseControlError("RELEASE_STATE_STALE");
        return { ...status(gate), head: current };
      }
      if (gate.owner_release_id) throw new ReleaseControlError("RELEASE_CONTROL_OWNED");
      if (head.candidate_generation !== 1 || head.phase !== "PAUSED" || head.phase_sequence !== 0) throw new ReleaseControlError("RELEASE_STATE_STALE");
      const valid = replayReleaseGenerationChain([{ seq: 1, release_id: head.release_id, action: "ACQUIRED", details_json: JSON.stringify({ schema_version: 2, kind: "CANDIDATE_ACQUIRED", head }) }]);
      if (valid.corrupt) throw new ReleaseControlError("RELEASE_STATE_STALE");
      const expected = this.expectedForHead(head);
      const changed = this.db.prepare(`UPDATE release_sales_gate SET owner_release_id = ?, owner_mode = 'CONTROLLED_CUTOVER', sales_paused = 1,
        expected_source_commit = ?, expected_migration = ?, expected_legal_version = ?, expected_legal_manifest_sha256 = ?, paused_at = datetime('now'), updated_at = datetime('now') WHERE singleton = 1 AND owner_release_id IS NULL`).run(head.release_id, expected.source_commit, expected.migration, expected.legal_version, expected.legal_manifest_sha256);
      if (changed.changes !== 1) throw new ReleaseControlError("RELEASE_CONTROL_OWNED");
      this.v2Event(head.release_id, "ACQUIRED", "CANDIDATE_ACQUIRED", { head });
      return { ...status(row(this.db)!), head };
    });
    return transaction();
  }

  adoptCandidate(input: CandidateAdoptRequest) {
    const transaction = () => this.immediate(() => {
      const gate = row(this.db); if (!gate) throw new ReleaseControlError("RELEASE_CONTROL_UNAVAILABLE", 503);
      const current = this.v2Head(input.head.release_id);
      if (gate.owner_release_id !== current.release_id) throw new ReleaseControlError("RELEASE_CANDIDATE_SUPERSEDED");
      if (current.phase !== "RECOVERY_REQUIRED" || current.candidate_generation !== input.expected_generation || current.source_commit !== input.from_sha || releaseStateHash(current) !== input.expected_state_hash) throw new ReleaseControlError("RELEASE_STATE_STALE");
      const applied = (this.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: string }>).map((row) => row.version);
      const migrationError = assertAppliedMigrationPrefix(applied, current.migration_inventory, input.head.migration_inventory);
      if (migrationError) throw new ReleaseControlError(migrationError as "RELEASE_STATE_STALE");
      if (input.head.candidate_generation !== current.candidate_generation + 1 || input.head.phase !== "PAUSED" || input.head.phase_sequence !== 0) throw new ReleaseControlError("RELEASE_STATE_STALE");
      const expected = this.expectedForHead(input.head);
      const details = { schema_version: 2, kind: "CANDIDATE_SUPERSEDED", from_generation: current.candidate_generation, from_sha: current.source_commit, head: input.head };
      this.assertProposedV2Event(current.release_id, { action: "PAUSED", details_json: JSON.stringify(details) });
      const changed = this.db.prepare("UPDATE release_sales_gate SET expected_source_commit = ?, expected_migration = ?, expected_legal_version = ?, expected_legal_manifest_sha256 = ?, sales_paused = 1, updated_at = datetime('now') WHERE singleton = 1 AND owner_release_id = ? AND sales_paused = 1").run(expected.source_commit, expected.migration, expected.legal_version, expected.legal_manifest_sha256, current.release_id);
      if (changed.changes !== 1) throw new ReleaseControlError("RELEASE_CANDIDATE_SUPERSEDED");
      if (this.certificationTableAvailable()) this.db.prepare("UPDATE release_certification_allowlist SET status = 'REVOKED', revoked_at = datetime('now') WHERE owner_release_id = ? AND status = 'ACTIVE'").run(current.release_id);
      this.v2Event(current.release_id, "PAUSED", "CANDIDATE_SUPERSEDED", { from_generation: current.candidate_generation, from_sha: current.source_commit, head: input.head });
      return { ...status(row(this.db)!), head: input.head };
    });
    return transaction();
  }

  /**
   * Offline-only, self-disabling bridge. It cannot accept a caller-selected
   * generation or source and must run while the old runtime is stopped: after
   * the first appended event, that runtime could not replay the ledger.
   */
  bootstrapGenerationTwoAdoption(input: { expected_state_hash: string }) {
    return this.immediate(() => {
      const gate = row(this.db); if (!gate) throw new ReleaseControlError("RELEASE_CONTROL_UNAVAILABLE", 503);
      const current = this.v2Head(gen2BootstrapAdoption.release_id);
      if (current.candidate_generation === gen2BootstrapAdoption.to_generation && current.source_commit === gen2BootstrapAdoption.to_source_commit && current.phase === "PAUSED" && current.phase_sequence === 0 && !current.certification) throw new ReleaseControlError("GEN2_BOOTSTRAP_ADOPT_ALREADY_APPLIED");
      if (gate.owner_release_id !== gen2BootstrapAdoption.release_id || gate.sales_paused !== 1 || current.release_id !== gen2BootstrapAdoption.release_id || current.candidate_generation !== gen2BootstrapAdoption.from_generation || current.source_commit !== gen2BootstrapAdoption.from_source_commit || current.phase !== "PAUSED" || current.phase_sequence !== 0 || current.certification || releaseStateHash(current) !== input.expected_state_hash) throw new ReleaseControlError("GEN2_BOOTSTRAP_ADOPT_PRECONDITION_FAILED");
      const applied = (this.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: string }>).map((row) => row.version);
      const replacementInventory = { files: Object.fromEntries(readdirSync(resolve(process.cwd(), "commerce/migrations")).filter((name) => name.endsWith(".sql")).sort().map((name) => [name, createHash("sha256").update(readFileSync(resolve(process.cwd(), "commerce/migrations", name))).digest("hex")])) };
      if (assertAppliedMigrationPrefix(applied, current.migration_inventory, replacementInventory) || Object.keys(replacementInventory.files).length !== Object.keys(current.migration_inventory.files).length || Object.entries(current.migration_inventory.files).some(([name, hash]) => replacementInventory.files[name] !== hash)) throw new ReleaseControlError("GEN2_BOOTSTRAP_ADOPT_MIGRATION_PREFIX_INVALID");
      const defectHead = { ...current, phase: "RECOVERY_REQUIRED" as const, phase_sequence: current.phase_sequence + 1 };
      const runtime_readiness_defect = {
        reason: "RUNTIME_READINESS_DEFECT" as const,
        readiness_component: "PROVIDER_READINESS" as const,
        error_class: "PROVIDER_BAD_REQUEST" as const,
        error_code: "HTTP_400",
        source_commit: current.source_commit,
      };
      const next = {
        ...current,
        candidate_generation: gen2BootstrapAdoption.to_generation,
        source_commit: gen2BootstrapAdoption.to_source_commit,
        migration_inventory: replacementInventory,
        phase: "PAUSED" as const,
        phase_sequence: 0,
      };
      const expected = this.expectedForHead(next);
      const events = this.db.prepare("SELECT rowid AS seq, release_id, action, details_json FROM release_sales_gate_events WHERE release_id = ? ORDER BY rowid ASC").all(current.release_id) as V2Event[];
      const defect = { seq: (events.at(-1)?.seq ?? 0) + 1, release_id: current.release_id, action: "PAUSED" as const, details_json: JSON.stringify({ schema_version: 2, kind: "RUNTIME_READINESS_DEFECT", from_phase: current.phase, from_phase_sequence: current.phase_sequence, head: defectHead, runtime_readiness_defect }) };
      const supersede = { seq: defect.seq + 1, release_id: current.release_id, action: "PAUSED" as const, details_json: JSON.stringify({ schema_version: 2, kind: "CANDIDATE_SUPERSEDED", from_generation: current.candidate_generation, from_sha: current.source_commit, head: next }) };
      const replay = replayReleaseGenerationChain([...events, defect, supersede]);
      if (replay.corrupt || releaseStateHash(replay.head ?? defectHead) !== releaseStateHash(next)) throw new ReleaseControlError("GEN2_BOOTSTRAP_ADOPT_REPLAY_FAILED");
      if (reconcileHeadWithProjection(next, {
        owner_release_id: current.release_id, sales_paused: true,
        expected_source_commit: expected.source_commit, expected_migration: expected.migration,
        expected_legal_version: expected.legal_version, expected_legal_manifest_sha256: expected.legal_manifest_sha256,
      })) throw new ReleaseControlError("GEN2_BOOTSTRAP_ADOPT_PROJECTION_FAILED");
      const changed = this.db.prepare(`UPDATE release_sales_gate SET expected_source_commit = ?, expected_migration = ?, expected_legal_version = ?, expected_legal_manifest_sha256 = ?, sales_paused = 1, updated_at = datetime('now')
        WHERE singleton = 1 AND owner_release_id = ? AND sales_paused = 1 AND expected_source_commit = ?`).run(
        expected.source_commit, expected.migration, expected.legal_version, expected.legal_manifest_sha256,
        current.release_id, current.source_commit,
      );
      if (changed.changes !== 1) throw new ReleaseControlError("GEN2_BOOTSTRAP_ADOPT_PRECONDITION_FAILED");
      event(this.db, current.release_id, "PAUSED", JSON.parse(defect.details_json));
      event(this.db, current.release_id, "PAUSED", JSON.parse(supersede.details_json));
      const persistedHead = this.v2Head(current.release_id);
      const persistedGate = row(this.db);
      if (!persistedGate || releaseStateHash(persistedHead) !== releaseStateHash(next) || reconcileHeadWithProjection(persistedHead, {
        owner_release_id: persistedGate.owner_release_id,
        sales_paused: persistedGate.sales_paused === 1,
        expected_source_commit: persistedGate.expected_source_commit,
        expected_migration: persistedGate.expected_migration,
        expected_legal_version: persistedGate.expected_legal_version,
        expected_legal_manifest_sha256: persistedGate.expected_legal_manifest_sha256,
      })) throw new ReleaseControlError("GEN2_BOOTSTRAP_ADOPT_FINAL_VALIDATION_FAILED");
      return { ...status(persistedGate), head: persistedHead, state_hash: releaseStateHash(persistedHead) };
    });
  }

  /**
   * Offline-only, self-disabling classifier. It cannot accept a caller-
   * selected release/generation/source/error: every field but the freshly
   * read state hash is bound to gen3ReadinessClassification. Unlike
   * bootstrapGenerationTwoAdoption this does not change candidate_generation
   * or source_commit, so the already-deployed defective runtime can still
   * replay the resulting ledger without redeployment.
   */
  classifyGenerationThreeReadinessDefect(input: { expected_state_hash: string }, runtimeEvidence: () => ReleaseRuntimeEvidence) {
    return this.immediate(() => {
      const gate = row(this.db); if (!gate) throw new ReleaseControlError("RELEASE_CONTROL_UNAVAILABLE", 503);
      const current = this.v2Head(gen3ReadinessClassification.release_id);
      if (current.candidate_generation === gen3ReadinessClassification.generation && current.source_commit === gen3ReadinessClassification.source_commit && current.phase === "RECOVERY_REQUIRED") throw new ReleaseControlError("GEN3_CLASSIFY_ALREADY_APPLIED");
      if (gate.owner_release_id !== gen3ReadinessClassification.release_id || gate.sales_paused !== 1 || current.release_id !== gen3ReadinessClassification.release_id || current.candidate_generation !== gen3ReadinessClassification.generation || current.source_commit !== gen3ReadinessClassification.source_commit || current.phase !== gen3ReadinessClassification.from_phase || current.phase_sequence !== gen3ReadinessClassification.phase_sequence || current.certification || releaseStateHash(current) !== input.expected_state_hash) throw new ReleaseControlError("GEN3_CLASSIFY_PRECONDITION_FAILED");
      const expected = this.expectedForHead(current);
      const evidence = runtimeEvidence();
      const migrationsMatch = evidence.migration_versions.length === Object.keys(current.migration_inventory.files).length
        && evidence.migration_versions.every((version) => current.migration_inventory.files[version] !== undefined)
        && Object.entries(current.migration_inventory.files).every(([version, hash]) => evidence.migration_source_hashes?.[version] === hash);
      const expectedMigrationApplied = evidence.required_migrations[expected.migration] === true || evidence.migration_versions.includes(expected.migration);
      if (evidence.source_commit !== current.source_commit || evidence.worker_source_commit !== current.source_commit || !expectedMigrationApplied || !migrationsMatch) throw new ReleaseControlError("GEN3_CLASSIFY_CANDIDATE_NOT_DEPLOYED");
      const head = { ...current, phase: "RECOVERY_REQUIRED" as const, phase_sequence: current.phase_sequence + 1 };
      const runtime_readiness_defect = {
        reason: "RUNTIME_READINESS_DEFECT" as const,
        readiness_component: gen3ReadinessClassification.readiness_component,
        error_class: gen3ReadinessClassification.error_class,
        error_code: gen3ReadinessClassification.error_code,
        source_commit: current.source_commit,
      };
      const events = this.db.prepare("SELECT rowid AS seq, release_id, action, details_json FROM release_sales_gate_events WHERE release_id = ? ORDER BY rowid ASC").all(current.release_id) as V2Event[];
      const proposed = { seq: (events.at(-1)?.seq ?? 0) + 1, release_id: current.release_id, action: "PAUSED" as const, details_json: JSON.stringify({ schema_version: 2, kind: "RUNTIME_READINESS_DEFECT", from_phase: current.phase, from_phase_sequence: current.phase_sequence, head, runtime_readiness_defect }) };
      const replay = replayReleaseGenerationChain([...events, proposed]);
      if (replay.corrupt || releaseStateHash(replay.head ?? head) !== releaseStateHash(head)) throw new ReleaseControlError("GEN3_CLASSIFY_REPLAY_FAILED");
      if (reconcileHeadWithProjection(head, {
        owner_release_id: current.release_id, sales_paused: true,
        expected_source_commit: expected.source_commit, expected_migration: expected.migration,
        expected_legal_version: expected.legal_version, expected_legal_manifest_sha256: expected.legal_manifest_sha256,
      })) throw new ReleaseControlError("GEN3_CLASSIFY_PROJECTION_FAILED");
      event(this.db, current.release_id, "PAUSED", JSON.parse(proposed.details_json));
      const persistedHead = this.v2Head(current.release_id);
      const persistedGate = row(this.db);
      if (!persistedGate || releaseStateHash(persistedHead) !== releaseStateHash(head) || reconcileHeadWithProjection(persistedHead, {
        owner_release_id: persistedGate.owner_release_id,
        sales_paused: persistedGate.sales_paused === 1,
        expected_source_commit: persistedGate.expected_source_commit,
        expected_migration: persistedGate.expected_migration,
        expected_legal_version: persistedGate.expected_legal_version,
        expected_legal_manifest_sha256: persistedGate.expected_legal_manifest_sha256,
      })) throw new ReleaseControlError("GEN3_CLASSIFY_FINAL_VALIDATION_FAILED");
      return { ...status(persistedGate), head: persistedHead, state_hash: releaseStateHash(persistedHead) };
    });
  }

  /**
   * Offline-only, self-disabling bridge. It cannot accept a caller-selected
   * release/generation/source/defect/certification: every field but the
   * freshly read state hash is bound to gen4PublicFrontendRecoveryBridge. It
   * appends PUBLIC_FRONTEND_DEFECT then CANDIDATE_SUPERSEDED in one
   * transaction so no operational window exists where a runtime that cannot
   * replay the new event kind is ever asked to.
   */
  bridgeGenerationFourToFive(input: { expected_state_hash: string }) {
    return this.immediate(() => {
      const gate = row(this.db); if (!gate) throw new ReleaseControlError("RELEASE_CONTROL_UNAVAILABLE", 503);
      const bridge = gen4PublicFrontendRecoveryBridge;
      const current = this.v2Head(bridge.release_id);
      if (current.candidate_generation === bridge.to_generation && current.source_commit === bridge.to_source_commit && current.phase === "PAUSED" && current.phase_sequence === 0 && !current.certification) throw new ReleaseControlError("GEN4_BRIDGE_ALREADY_APPLIED");
      if (
        gate.owner_release_id !== bridge.release_id || gate.sales_paused !== 1 ||
        current.release_id !== bridge.release_id ||
        current.candidate_generation !== bridge.from_generation ||
        current.source_commit !== bridge.from_source_commit ||
        current.phase !== bridge.from_phase ||
        current.phase_sequence !== bridge.from_phase_sequence ||
        !current.certification ||
        current.certification.lease_id !== bridge.certification.lease_id ||
        current.certification.occurrence_id !== bridge.certification.occurrence_id ||
        current.certification.promo_id !== bridge.certification.promo_id ||
        current.certification.expected_idempotency_key_hash !== bridge.certification.expected_idempotency_key_hash ||
        current.certification.lease_expires_at !== bridge.certification.lease_expires_at ||
        current.certification.status !== "CONSUMED" ||
        releaseStateHash(current) !== input.expected_state_hash
      ) throw new ReleaseControlError("GEN4_BRIDGE_PRECONDITION_FAILED");

      // Cross-check the durable financial and fixture evidence directly
      // against live rows, rather than trusting the word CERTIFIED alone.
      const lease = this.db.prepare(`SELECT status, consumed_order_id FROM release_certification_allowlist
        WHERE lease_id = ? AND owner_release_id = ? AND candidate_generation = ? AND expected_source_commit = ? AND occurrence_id = ? AND promo_id = ?`).get(
        bridge.certification.lease_id, bridge.release_id, bridge.from_generation, bridge.from_source_commit, bridge.certification.occurrence_id, bridge.certification.promo_id,
      ) as { status: string; consumed_order_id: string | null } | undefined;
      if (!lease || lease.status !== "CONSUMED" || lease.consumed_order_id !== bridge.certification.order_id) throw new ReleaseControlError("GEN4_BRIDGE_EVIDENCE_MISMATCH");
      const promo = this.db.prepare("SELECT status FROM promo_codes WHERE id = ?").get(bridge.certification.promo_id) as { status: string } | undefined;
      if (!promo || promo.status !== "DISABLED") throw new ReleaseControlError("GEN4_BRIDGE_EVIDENCE_MISMATCH");
      const occurrence = this.db.prepare("SELECT visibility, sales_status, fulfillment_status, price_kopecks FROM occurrences WHERE id = ?").get(bridge.certification.occurrence_id) as { visibility: string; sales_status: string; fulfillment_status: string; price_kopecks: number } | undefined;
      if (!occurrence || occurrence.visibility !== bridge.fixture.visibility || occurrence.sales_status !== bridge.fixture.sales_status || occurrence.fulfillment_status !== bridge.fixture.fulfillment_status || Number(occurrence.price_kopecks) !== bridge.fixture.price_kopecks) throw new ReleaseControlError("GEN4_BRIDGE_EVIDENCE_MISMATCH");
      const order = this.db.prepare("SELECT occurrence_id, amount_kopecks, discount_value_snapshot FROM orders WHERE id = ?").get(bridge.certification.order_id) as { occurrence_id: string; amount_kopecks: number; discount_value_snapshot: number | null } | undefined;
      if (!order || order.occurrence_id !== bridge.certification.occurrence_id || Number(order.amount_kopecks) !== bridge.certification.amount_kopecks || Number(order.discount_value_snapshot) !== bridge.certification.discount_kopecks) throw new ReleaseControlError("GEN4_BRIDGE_EVIDENCE_MISMATCH");
      const payment = this.db.prepare("SELECT id, order_id, captured_amount_kopecks FROM payments WHERE id = ?").get(bridge.certification.payment_id) as { id: string; order_id: string; captured_amount_kopecks: number } | undefined;
      if (!payment || payment.order_id !== bridge.certification.order_id || Number(payment.captured_amount_kopecks) !== bridge.certification.captured_kopecks) throw new ReleaseControlError("GEN4_BRIDGE_EVIDENCE_MISMATCH");
      const refund = this.db.prepare("SELECT id, payment_id, status, amount_kopecks FROM refunds WHERE id = ?").get(bridge.certification.refund_id) as { id: string; payment_id: string; status: string; amount_kopecks: number } | undefined;
      if (!refund || refund.payment_id !== bridge.certification.payment_id || refund.status !== "SUCCEEDED" || Number(refund.amount_kopecks) !== bridge.certification.refunded_kopecks) throw new ReleaseControlError("GEN4_BRIDGE_EVIDENCE_MISMATCH");
      // Terminal-state proof, not just arithmetic: this must be the payment's
      // only refund activity, with nothing else still unresolved.
      const otherRefunds = this.db.prepare(`SELECT COUNT(*) AS count FROM refunds WHERE payment_id = ? AND id != ?`).get(bridge.certification.payment_id, bridge.certification.refund_id) as { count: number };
      if (Number(otherRefunds.count) !== 0) throw new ReleaseControlError("GEN4_BRIDGE_EVIDENCE_MISMATCH");
      if (Number(payment.captured_amount_kopecks) - Number(refund.amount_kopecks) !== 0) throw new ReleaseControlError("GEN4_BRIDGE_EVIDENCE_MISMATCH");

      // F/R3 never touch migrations, so gen5's inventory must still equal
      // gen4's, and it must still equal what is actually applied.
      const applied = (this.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: string }>).map((row) => row.version);
      if (applied.length !== Object.keys(current.migration_inventory.files).length || applied.some((name) => current.migration_inventory.files[name] === undefined)) throw new ReleaseControlError("GEN4_BRIDGE_MIGRATION_MISMATCH");
      const onDiskHashes = Object.fromEntries(readdirSync(resolve(process.cwd(), "commerce/migrations")).filter((name) => name.endsWith(".sql")).sort().map((name) => [name, createHash("sha256").update(readFileSync(resolve(process.cwd(), "commerce/migrations", name))).digest("hex")]));
      if (Object.entries(current.migration_inventory.files).some(([name, hash]) => onDiskHashes[name] !== hash)) throw new ReleaseControlError("GEN4_BRIDGE_MIGRATION_MISMATCH");

      const recoveryHead = { ...current, phase: "RECOVERY_REQUIRED" as const, phase_sequence: current.phase_sequence + 1 };
      const public_frontend_defect = {
        reason: "PUBLIC_FRONTEND_DEFECT" as const,
        component: bridge.defect.component,
        error_class: bridge.defect.error_class,
        error_code: bridge.defect.error_code,
        probe_path: bridge.defect.probe_path,
        http_status: bridge.defect.http_status,
        observed_frontend_source_commit: bridge.defect.observed_frontend_source_commit,
        source_commit: current.source_commit,
      };
      const gen5Head = {
        release_id: current.release_id,
        candidate_generation: bridge.to_generation,
        source_commit: bridge.to_source_commit,
        migration_inventory: current.migration_inventory,
        legal_baseline: current.legal_baseline,
        release_family: current.release_family,
        checkout_contract_version: current.checkout_contract_version,
        admin_contract_version: current.admin_contract_version,
        phase: "PAUSED" as const,
        phase_sequence: 0,
      };
      const events = this.db.prepare("SELECT rowid AS seq, release_id, action, details_json FROM release_sales_gate_events WHERE release_id = ? ORDER BY rowid ASC").all(current.release_id) as V2Event[];
      const defectEvent = { seq: (events.at(-1)?.seq ?? 0) + 1, release_id: current.release_id, action: "PAUSED" as const, details_json: JSON.stringify({ schema_version: 2, kind: "PUBLIC_FRONTEND_DEFECT", from_phase: current.phase, from_phase_sequence: current.phase_sequence, head: recoveryHead, public_frontend_defect }) };
      const supersedeEvent = { seq: defectEvent.seq + 1, release_id: current.release_id, action: "PAUSED" as const, details_json: JSON.stringify({ schema_version: 2, kind: "CANDIDATE_SUPERSEDED", from_generation: recoveryHead.candidate_generation, from_sha: recoveryHead.source_commit, head: gen5Head }) };
      const replay = replayReleaseGenerationChain([...events, defectEvent, supersedeEvent]);
      if (replay.corrupt || releaseStateHash(replay.head ?? gen5Head) !== releaseStateHash(gen5Head)) throw new ReleaseControlError("GEN4_BRIDGE_REPLAY_FAILED");
      const expected = this.expectedForHead(gen5Head);
      if (reconcileHeadWithProjection(gen5Head, {
        owner_release_id: current.release_id, sales_paused: true,
        expected_source_commit: expected.source_commit, expected_migration: expected.migration,
        expected_legal_version: expected.legal_version, expected_legal_manifest_sha256: expected.legal_manifest_sha256,
      })) throw new ReleaseControlError("GEN4_BRIDGE_PROJECTION_FAILED");
      const changed = this.db.prepare(`UPDATE release_sales_gate SET expected_source_commit = ?, expected_migration = ?, expected_legal_version = ?, expected_legal_manifest_sha256 = ?, sales_paused = 1, updated_at = datetime('now')
        WHERE singleton = 1 AND owner_release_id = ? AND sales_paused = 1 AND expected_source_commit = ?`).run(
        expected.source_commit, expected.migration, expected.legal_version, expected.legal_manifest_sha256,
        current.release_id, current.source_commit,
      );
      if (changed.changes !== 1) throw new ReleaseControlError("GEN4_BRIDGE_PRECONDITION_FAILED");
      event(this.db, current.release_id, "PAUSED", JSON.parse(defectEvent.details_json));
      event(this.db, current.release_id, "PAUSED", JSON.parse(supersedeEvent.details_json));
      const persistedHead = this.v2Head(current.release_id);
      const persistedGate = row(this.db);
      if (!persistedGate || releaseStateHash(persistedHead) !== releaseStateHash(gen5Head) || reconcileHeadWithProjection(persistedHead, {
        owner_release_id: persistedGate.owner_release_id,
        sales_paused: persistedGate.sales_paused === 1,
        expected_source_commit: persistedGate.expected_source_commit,
        expected_migration: persistedGate.expected_migration,
        expected_legal_version: persistedGate.expected_legal_version,
        expected_legal_manifest_sha256: persistedGate.expected_legal_manifest_sha256,
      })) throw new ReleaseControlError("GEN4_BRIDGE_FINAL_VALIDATION_FAILED");
      return { ...status(persistedGate), head: persistedHead, state_hash: releaseStateHash(persistedHead) };
    });
  }

  changeCandidatePhase(input: CandidatePhaseRequest) {
    const transaction = () => this.immediate(() => {
      const gate = row(this.db); if (!gate) throw new ReleaseControlError("RELEASE_CONTROL_UNAVAILABLE", 503);
      const current = this.v2Head(input.release_id);
      if (gate.owner_release_id !== current.release_id) throw new ReleaseControlError("RELEASE_CANDIDATE_SUPERSEDED");
      if (current.candidate_generation !== input.candidate_generation || current.phase !== input.from_phase || current.phase_sequence !== input.phase_sequence || releaseStateHash(current) !== input.expected_state_hash) throw new ReleaseControlError("RELEASE_STATE_STALE");
      if (input.to_phase === "CERTIFICATION_ONLY" || input.to_phase === "CERTIFICATION_IN_FLIGHT" || input.to_phase === "CERTIFIED" || current.phase === "CERTIFICATION_IN_FLIGHT") throw new ReleaseControlError("CERTIFICATION_TRANSITION_REQUIRES_EVIDENCE");
      if (current.phase === "PAUSED" && input.to_phase === "RECOVERY_REQUIRED") throw new ReleaseControlError("RUNTIME_READINESS_DEFECT_EVIDENCE_REQUIRED");
      if (current.phase === "CERTIFIED" && input.to_phase === "RECOVERY_REQUIRED") throw new ReleaseControlError("PUBLIC_FRONTEND_DEFECT_EVIDENCE_REQUIRED");
      let certification = current.certification;
      if (current.phase === "CERTIFICATION_ONLY" && current.certification?.status === "ACTIVE") {
        this.requireCertificationTable();
        const revoked = this.db.prepare("UPDATE release_certification_allowlist SET status = 'REVOKED', revoked_at = datetime('now') WHERE lease_id = ? AND status = 'ACTIVE'").run(current.certification.lease_id);
        if (revoked.changes !== 1) throw new ReleaseControlError("RELEASE_STATE_STALE");
        certification = { ...current.certification, status: "REVOKED" };
      }
      const head = { ...current, phase: input.to_phase, phase_sequence: current.phase_sequence + 1, certification };
      this.assertProposedV2Event(current.release_id, { action: "PAUSED", details_json: JSON.stringify({ schema_version: 2, kind: "PHASE_CHANGED", from_phase: current.phase, from_phase_sequence: current.phase_sequence, head }) });
      this.v2Event(current.release_id, "PAUSED", "PHASE_CHANGED", { from_phase: current.phase, from_phase_sequence: current.phase_sequence, head });
      return { ...status(row(this.db)!), head };
    });
    return transaction();
  }

  /**
   * The last PRE_ACTIVATION_DEFECT evidence in the ledger, if the most recent
   * transition into recovery was one. Deliberately "the last transition", not
   * "any such event ever": a generation recovered twice through different edges
   * must not report the older one.
   */
  private lastPreActivationDefect(releaseId: string): { defect_class: string; defect_code: string; source_commit: string } | null {
    const events = this.db.prepare("SELECT details_json FROM release_sales_gate_events WHERE release_id = ? ORDER BY rowid DESC").all(releaseId) as Array<{ details_json: string }>;
    for (const event of events) {
      let envelope: { kind?: unknown; pre_activation_defect?: unknown };
      try { envelope = JSON.parse(event.details_json) as typeof envelope; } catch { continue; }
      if (envelope.kind !== "PRE_ACTIVATION_DEFECT") {
        // Any other transition-carrying event means the recovery currently in
        // effect was not this one.
        if (typeof envelope.kind === "string") return null;
        continue;
      }
      const evidence = envelope.pre_activation_defect;
      if (!parsePreActivationDefectEvidence(evidence, (evidence as { source_commit?: string } | null)?.source_commit ?? "")) return null;
      const parsed = evidence as { defect_class: string; defect_code: string; source_commit: string };
      return { defect_class: parsed.defect_class, defect_code: parsed.defect_code, source_commit: parsed.source_commit };
    }
    return null;
  }

  /** The most recent recovery edge, used only for loss-response replay. */
  private lastPostActivationEmailProviderDefect(releaseId: string): Record<string, unknown> | null {
    const events = this.db.prepare("SELECT details_json FROM release_sales_gate_events WHERE release_id = ? ORDER BY rowid DESC").all(releaseId) as Array<{ details_json: string }>;
    for (const event of events) {
      let envelope: { kind?: unknown; post_activation_email_provider_defect?: unknown };
      try { envelope = JSON.parse(event.details_json) as typeof envelope; } catch { continue; }
      if (envelope.kind !== "POST_ACTIVATION_EMAIL_PROVIDER_DEFECT") {
        if (typeof envelope.kind === "string") return null;
        continue;
      }
      const evidence = envelope.post_activation_email_provider_defect;
      const source = (evidence as { source_commit?: unknown } | null)?.source_commit;
      return typeof source === "string" && parsePostActivationEmailProviderDefectEvidence(evidence, source)
        ? evidence as Record<string, unknown> : null;
    }
    return null;
  }

  /**
   * Atomically records the exact terminal UniSender refusal and advances only
   * CERTIFIED -> RECOVERY_REQUIRED.  Re-fencing is deliberately a prior,
   * separately durable containment act; this transaction refuses unless that
   * containment still belongs to the same ATTEMPT epoch and is drained.
   */
  markPostActivationEmailProviderDefect(
    input: PostActivationEmailProviderDefectRequest,
    authorityReader: () => PostActivationAuthoritySnapshot,
    defectReader: PostActivationEmailProviderDefectReader,
  ) {
    return this.immediate(() => {
      const gate = row(this.db); if (!gate) throw new ReleaseControlError("RELEASE_CONTROL_UNAVAILABLE", 503);
      const current = this.v2Head(input.release_id);

      // A lost response after the committed ledger edge is reconciled from the
      // ledger. It never replays a mutable provider query and never appends a
      // second recovery event.
      if (current.phase === "RECOVERY_REQUIRED") {
        if (current.candidate_generation !== input.candidate_generation || releaseStateHash(current) !== input.expected_state_hash) throw new ReleaseControlError("RELEASE_STATE_STALE");
        const recorded = this.lastPostActivationEmailProviderDefect(current.release_id);
        if (!recorded || recorded.source_commit !== current.source_commit) throw new ReleaseControlError("POST_ACTIVATION_EMAIL_PROVIDER_DEFECT_NOT_RECORDED");
        return { ...status(gate), head: current, recorded_defect: recorded };
      }

      if (gate.owner_release_id !== current.release_id || gate.sales_paused !== 1
        || current.candidate_generation !== input.candidate_generation || releaseStateHash(current) !== input.expected_state_hash
        || current.phase !== "CERTIFIED" || current.certification?.status !== "CONSUMED") {
        throw new ReleaseControlError("POST_ACTIVATION_EMAIL_PROVIDER_DEFECT_STATE_INVALID");
      }

      // This is read inside BEGIN IMMEDIATE with the ledger append. It binds
      // the resulting RECOVERY_REQUIRED state to a fence that still contains
      // the broken ATTEMPT data plane, rather than to a stale workflow read.
      const authority = authorityReader();
      if (authority.attempt_authority !== "ATTEMPT") throw new ReleaseControlError("POST_ACTIVATION_EMAIL_PROVIDER_DEFECT_AUTHORITY_INVALID");
      if (!authority.email_dispatch_paused || authority.dispatch_owner_release_id !== current.release_id || authority.dispatch_owner_generation !== null) {
        throw new ReleaseControlError("POST_ACTIVATION_EMAIL_PROVIDER_DEFECT_FENCE_NOT_OWNED");
      }
      if (authority.revision !== input.expected_authority_revision) throw new ReleaseControlError("POST_ACTIVATION_EMAIL_PROVIDER_DEFECT_AUTHORITY_REVISION_STALE");
      if (!authority.drained) throw new ReleaseControlError("POST_ACTIVATION_EMAIL_PROVIDER_DEFECT_DISPATCH_NOT_DRAINED");

      const observed = defectReader();
      if (!observed.exact || !observed.order_id || !observed.unfenced_at || !observed.ticket_attempt?.attempt_id
        || !observed.ticket_attempt.started_at) throw new ReleaseControlError("POST_ACTIVATION_EMAIL_PROVIDER_DEFECT_EVIDENCE_INVALID");

      const head = { ...current, phase: "RECOVERY_REQUIRED" as const, phase_sequence: current.phase_sequence + 1 };
      const post_activation_email_provider_defect = {
        reason: "POST_ACTIVATION_EMAIL_PROVIDER_DEFECT" as const,
        order_id: observed.order_id,
        outbox_id: observed.ticket_attempt.outbox_id,
        attempt_id: observed.ticket_attempt.attempt_id,
        message_type: "TICKET" as const,
        unfenced_at: observed.unfenced_at,
        started_at: observed.ticket_attempt.started_at,
        outcome: "KNOWN_FAILED" as const,
        failure_code: "UNISENDER_HTTP_REJECTED" as const,
        provider_error_code: "1588" as const,
        source_commit: current.source_commit,
      };
      const details = { schema_version: 2, kind: "POST_ACTIVATION_EMAIL_PROVIDER_DEFECT" as const, from_phase: current.phase, from_phase_sequence: current.phase_sequence, head, post_activation_email_provider_defect };
      this.assertProposedV2Event(current.release_id, { action: "PAUSED", details_json: JSON.stringify(details) });
      // One append contains both the defect evidence and resulting phase. If
      // this transaction aborts, neither can become durable on its own.
      this.v2Event(current.release_id, "PAUSED", "POST_ACTIVATION_EMAIL_PROVIDER_DEFECT", { from_phase: current.phase, from_phase_sequence: current.phase_sequence, head, post_activation_email_provider_defect });
      return { ...status(row(this.db)!), head, recorded_defect: post_activation_email_provider_defect };
    });
  }

  markPreActivationDefect(
    input: PreActivationDefectRequest,
    runtimeEvidence: () => ReleaseRuntimeEvidence,
    outboxAuthority: () => OutboxAuthoritySnapshot,
    dispatchTarget: CertificationDispatchTargetReader,
  ) {
    return this.immediate(() => {
      const gate = row(this.db); if (!gate) throw new ReleaseControlError("RELEASE_CONTROL_UNAVAILABLE", 503);
      const current = this.v2Head(input.release_id);

      // Replay reconciliation, bound to PROVENANCE and not merely to the phase.
      //
      // A generation can reach RECOVERY_REQUIRED through three different edges.
      // Reconciling on phase alone would report a runtime-readiness or
      // public-frontend recovery as a successful replay of an activation defect
      // that was never recorded - which is exactly the audit property the
      // separate ledger kind exists to preserve.
      //
      // Reconciled from the LEDGER and nothing else. Re-deriving the target
      // classification here would make a committed transition unreplayable the
      // moment the thing it recorded got repaired: classify TARGET_MISSING,
      // lose the response, the mail appears, retry - and the retry would refuse
      // because the target is now valid, for a transition that has already
      // happened.
      if (current.phase === "RECOVERY_REQUIRED") {
        if (current.candidate_generation !== input.candidate_generation || releaseStateHash(current) !== input.expected_state_hash) throw new ReleaseControlError("RELEASE_STATE_STALE");
        const recorded = this.lastPreActivationDefect(current.release_id);
        if (!recorded) throw new ReleaseControlError("PRE_ACTIVATION_DEFECT_NOT_RECORDED");
        if (recorded.defect_class !== input.defect_class || recorded.source_commit !== current.source_commit) {
          throw new ReleaseControlError("PRE_ACTIVATION_DEFECT_EVIDENCE_CONFLICT");
        }
        // A derived class carries no caller-supplied code to compare; the
        // recorded one is the answer.
        if (input.defect_class === "ACTIVATION_REFUSAL" && recorded.defect_code !== input.defect_code) {
          throw new ReleaseControlError("PRE_ACTIVATION_DEFECT_EVIDENCE_CONFLICT");
        }
        return { ...status(gate), head: current, recorded_defect: recorded };
      }

      if (gate.owner_release_id !== current.release_id || gate.sales_paused !== 1) throw new ReleaseControlError("RELEASE_STATE_STALE");
      if (current.candidate_generation !== input.candidate_generation || releaseStateHash(current) !== input.expected_state_hash) throw new ReleaseControlError("RELEASE_STATE_STALE");
      // The window this exists for, and nothing wider. A generation that has
      // not certified already has abort and readiness classification.
      if (current.phase !== "CERTIFIED" || current.certification?.status !== "CONSUMED") throw new ReleaseControlError("PRE_ACTIVATION_DEFECT_PHASE_INVALID");
      if (!(preActivationDefectClasses as readonly string[]).includes(input.defect_class)) throw new ReleaseControlError("PRE_ACTIVATION_DEFECT_INVALID");
      // A code is required only for the class that names one. The derived class
      // legitimately arrives without it, because the store supplies it below.
      if (input.defect_class === "ACTIVATION_REFUSAL" && !/^[A-Z0-9_]{1,80}$/.test(input.defect_code)) throw new ReleaseControlError("PRE_ACTIVATION_DEFECT_INVALID");
      if (input.defect_class !== "ACTIVATION_REFUSAL" && input.defect_code && !/^[A-Z0-9_]{1,80}$/.test(input.defect_code)) throw new ReleaseControlError("PRE_ACTIVATION_DEFECT_INVALID");

      // The candidate under recovery must be the one actually deployed.
      const evidence = runtimeEvidence();
      if (evidence.source_commit !== current.source_commit || evidence.worker_source_commit !== current.source_commit) throw new ReleaseControlError("PRE_ACTIVATION_DEFECT_CANDIDATE_NOT_DEPLOYED");

      // The load-bearing gate. Nothing irreversible may have happened: the
      // store is still LEGACY, and the fence that stopped mail is still this
      // release's to release. Once authority has moved, recovery means a
      // forward path, never this one.
      const authority = outboxAuthority();
      if (authority.attempt_authority !== "LEGACY") throw new ReleaseControlError("PRE_ACTIVATION_DEFECT_AUTHORITY_ALREADY_ACTIVATED");
      if (!authority.email_dispatch_paused || authority.dispatch_owner_release_id !== current.release_id) throw new ReleaseControlError("PRE_ACTIVATION_DEFECT_FENCE_NOT_OWNED");

      // Evaluated HERE, not by the caller before the transaction opened. The
      // fence does not serialize message-level changes, so evidence read
      // outside this transaction can be stale by the time the edge is appended.
      let defectCode = input.defect_code;
      if (input.defect_class === "CERTIFICATION_DISPATCH_TARGET_INVALID") {
        const observed = dispatchTarget();
        if (!observed) throw new ReleaseControlError("PRE_ACTIVATION_DEFECT_TARGET_IS_VALID");
        if (input.defect_code && input.defect_code !== observed) throw new ReleaseControlError("PRE_ACTIVATION_DEFECT_CODE_NOT_DERIVED");
        defectCode = observed;
      }

      const head = { ...current, phase: "RECOVERY_REQUIRED" as const, phase_sequence: current.phase_sequence + 1 };
      const pre_activation_defect = { reason: "PRE_ACTIVATION_DEFECT" as const, defect_class: input.defect_class, defect_code: defectCode, source_commit: current.source_commit };
      const details = { schema_version: 2, kind: "PRE_ACTIVATION_DEFECT" as const, from_phase: current.phase, from_phase_sequence: current.phase_sequence, head, pre_activation_defect };
      this.assertProposedV2Event(current.release_id, { action: "PAUSED", details_json: JSON.stringify(details) });
      this.v2Event(current.release_id, "PAUSED", "PRE_ACTIVATION_DEFECT", { from_phase: current.phase, from_phase_sequence: current.phase_sequence, head, pre_activation_defect });
      return { ...status(row(this.db)!), head };
    });
  }

  markRuntimeReadinessDefect(input: RuntimeReadinessDefectRequest, runtimeEvidence: () => ReleaseRuntimeEvidence) {
    return this.immediate(() => {
      const gate = row(this.db); if (!gate) throw new ReleaseControlError("RELEASE_CONTROL_UNAVAILABLE", 503);
      const current = this.v2Head(input.release_id);
      if (gate.owner_release_id !== current.release_id || gate.sales_paused !== 1 || current.phase !== "PAUSED" || current.certification || current.candidate_generation !== input.candidate_generation || releaseStateHash(current) !== input.expected_state_hash) throw new ReleaseControlError("RELEASE_STATE_STALE");
      if (input.readiness_component !== "PROVIDER_READINESS" || !runtimeReadinessActionableErrorClasses.includes(input.error_class) || !/^[A-Z0-9_]{1,80}$/.test(input.error_code)) throw new ReleaseControlError("RUNTIME_READINESS_DEFECT_INVALID");
      const expected = this.expectedForHead(current);
      const evidence = runtimeEvidence();
      const migrationsMatch = evidence.migration_versions.length === Object.keys(current.migration_inventory.files).length
        && evidence.migration_versions.every((version) => current.migration_inventory.files[version] !== undefined)
        && Object.entries(current.migration_inventory.files).every(([version, hash]) => evidence.migration_source_hashes?.[version] === hash);
      const expectedMigrationApplied = evidence.required_migrations[expected.migration] === true || evidence.migration_versions.includes(expected.migration);
      if (evidence.source_commit !== current.source_commit || evidence.worker_source_commit !== current.source_commit || !expectedMigrationApplied || !migrationsMatch) throw new ReleaseControlError("RUNTIME_READINESS_CANDIDATE_NOT_DEPLOYED");
      const head = { ...current, phase: "RECOVERY_REQUIRED" as const, phase_sequence: current.phase_sequence + 1 };
      const runtime_readiness_defect = { reason: "RUNTIME_READINESS_DEFECT" as const, readiness_component: input.readiness_component, error_class: input.error_class, error_code: input.error_code, source_commit: current.source_commit };
      const details = { schema_version: 2, kind: "RUNTIME_READINESS_DEFECT" as const, from_phase: current.phase, from_phase_sequence: current.phase_sequence, head, runtime_readiness_defect };
      this.assertProposedV2Event(current.release_id, { action: "PAUSED", details_json: JSON.stringify(details) });
      this.v2Event(current.release_id, "PAUSED", "RUNTIME_READINESS_DEFECT", { from_phase: current.phase, from_phase_sequence: current.phase_sequence, head, runtime_readiness_defect });
      return { ...status(row(this.db)!), head };
    });
  }

  /**
   * The safe pre-mutation exit. Without it the only way out of an acquired
   * generation was `complete`, which demands a real certification order - so a
   * candidate abandoned at PAUSED held the gate closed until someone paid 1
   * rouble. That cost a 12-hour production pause on 2026-08-28.
   *
   * Deliberately narrow: reachable only before anything irreversible, and it
   * proves the world has not moved underneath the generation rather than
   * assuming it. It clears the release gate only - the emergency gate is a
   * separate authority and an abort must never reopen sales an operator
   * stopped.
   */
  abortCandidate(input: CandidateAbortRequest, runtimeEvidence: () => ReleaseRuntimeEvidence) {
    return this.immediate(() => {
      const gate = row(this.db); if (!gate) throw new ReleaseControlError("RELEASE_CONTROL_UNAVAILABLE", 503);
      const current = this.v2Head(input.release_id);

      // Replay reconciliation: an already-aborted generation reports success,
      // but only for that exact generation. A stale abort must not succeed just
      // because some later generation was aborted.
      if (current.phase === "ABORTED") {
        if (current.candidate_generation !== input.candidate_generation || releaseStateHash(current) !== input.expected_state_hash) throw new ReleaseControlError("RELEASE_STATE_STALE");
        if (gate.owner_release_id !== null || gate.sales_paused !== 0) throw new ReleaseControlError("RELEASE_STATE_CORRUPT", 503);
        return { ...status(gate), head: current };
      }

      if (current.candidate_generation !== input.candidate_generation || releaseStateHash(current) !== input.expected_state_hash) throw new ReleaseControlError("RELEASE_STATE_STALE");
      if (gate.owner_release_id !== current.release_id || gate.sales_paused !== 1) throw new ReleaseControlError("RELEASE_STATE_STALE");

      // Certified or beyond: the money already moved and a promotion may be in
      // flight. Recovery owns that, not abort.
      const priorEvents = this.db.prepare("SELECT details_json FROM release_sales_gate_events WHERE release_id = ? ORDER BY rowid ASC").all(current.release_id) as Array<{ details_json: string }>;
      const everCertified = priorEvents.some((event) => { try { return (JSON.parse(event.details_json) as { head?: { phase?: unknown } }).head?.phase === "CERTIFIED"; } catch { return false; } });
      if (everCertified) throw new ReleaseControlError("RELEASE_ABORT_ALREADY_CERTIFIED");
      if (current.phase !== "PAUSED" && current.phase !== "DEPLOYED_READ_ONLY") throw new ReleaseControlError("RELEASE_ABORT_NOT_REVERSIBLE");

      // The world must still be what it was when this generation was acquired.
      const evidence = runtimeEvidence();
      // source_commit and migration_inventory are immutable within a
      // generation - the replay rejects any event that changes them - so the
      // current head still carries the acquire-time values.
      if (evidence.source_commit !== current.source_commit) throw new ReleaseControlError("RELEASE_ABORT_PRODUCTION_CHANGED");
      // Symmetric with the expectation authority: compare the canonical
      // inventory, not the absence of one named migration.
      if (migrationInventoryExpectation(evidence.migration_versions) !== migrationInventoryExpectation(Object.keys(current.migration_inventory.files))) throw new ReleaseControlError("RELEASE_ABORT_MIGRATION_STATE_CHANGED");

      const head = { ...current, phase: "ABORTED" as const, phase_sequence: current.phase_sequence + 1 };
      const details = { schema_version: 2, kind: "PHASE_CHANGED" as const, from_phase: current.phase, from_phase_sequence: current.phase_sequence, head, abort: { reason: input.reason } };
      this.assertProposedV2Event(current.release_id, { action: "REOPENED", details_json: JSON.stringify(details) });
      const changed = this.db.prepare(`UPDATE release_sales_gate SET sales_paused = 0, owner_release_id = NULL, owner_mode = NULL,
        reopened_at = datetime('now'), updated_at = datetime('now')
        WHERE singleton = 1 AND owner_release_id = ? AND sales_paused = 1`).run(current.release_id);
      if (changed.changes !== 1) throw new ReleaseControlError("RELEASE_CANDIDATE_SUPERSEDED");
      this.v2Event(current.release_id, "REOPENED", "PHASE_CHANGED", { from_phase: current.phase, from_phase_sequence: current.phase_sequence, head, abort: { reason: input.reason } });
      return { ...status(row(this.db)!), head };
    });
  }

  completeCandidate(input: CandidateCompleteRequest, runtimeEvidence: () => ReleaseRuntimeEvidence) {
    const transaction = () => this.immediate(() => {
      const gate = row(this.db)!; const current = this.v2Head(input.release_id);
      if (gate.owner_release_id !== current.release_id || current.phase !== "CERTIFIED" || current.candidate_generation !== input.candidate_generation || releaseStateHash(current) !== input.expected_state_hash) throw new ReleaseControlError("RELEASE_STATE_STALE");
      this.requireCertificationTable();
      if (!current.certification || current.certification.status !== "CONSUMED") throw new ReleaseControlError("CERTIFICATION_CLEANUP_INCOMPLETE");
      const lease = this.db.prepare(`SELECT consumed_order_id FROM release_certification_allowlist
        WHERE lease_id = ? AND owner_release_id = ? AND candidate_generation = ? AND expected_source_commit = ?
          AND occurrence_id = ? AND promo_id = ? AND status = 'CONSUMED'`).get(
        current.certification.lease_id, current.release_id, current.candidate_generation, current.source_commit,
        current.certification.occurrence_id, current.certification.promo_id,
      ) as { consumed_order_id: string | null } | undefined;
      const fixture = this.db.prepare("SELECT visibility, sales_status, fulfillment_status, price_kopecks FROM occurrences WHERE id = ?").get(current.certification.occurrence_id) as Record<string, unknown> | undefined;
      const promo = this.db.prepare("SELECT status, discount_type, discount_value FROM promo_codes WHERE id = ?").get(current.certification.promo_id) as Record<string, unknown> | undefined;
      if (!lease?.consumed_order_id || !fixture || fixture.visibility !== "HIDDEN" || fixture.sales_status !== "CLOSED" || fixture.fulfillment_status !== "SCHEDULED" || Number(fixture.price_kopecks) !== 101 || !promo || promo.status !== "DISABLED" || promo.discount_type !== "FIXED" || Number(promo.discount_value) !== 1) throw new ReleaseControlError("CERTIFICATION_CLEANUP_INCOMPLETE");
      const expected = this.expectedForHead(current); const evidence = runtimeEvidence(); const reason = evaluateCandidateReopenGate({ release_id: current.release_id, mode: "CONTROLLED_CUTOVER", expected }, evidence);
      if (reason) throw new ReleaseControlError(reason);
      const sourceHashes = evidence.migration_source_hashes;
      if (!sourceHashes || Object.keys(sourceHashes).length !== Object.keys(current.migration_inventory.files).length || Object.entries(current.migration_inventory.files).some(([name, hash]) => sourceHashes[name] !== hash)) throw new ReleaseControlError("MIGRATION_SOURCE_HASH_MISMATCH");
      const head = { ...current, phase: "COMPLETE" as const, phase_sequence: current.phase_sequence + 1 };
      this.assertProposedV2Event(current.release_id, { action: "REOPENED", details_json: JSON.stringify({ schema_version: 2, kind: "PHASE_CHANGED", from_phase: current.phase, from_phase_sequence: current.phase_sequence, head, expected }) });
      const changed = this.db.prepare("UPDATE release_sales_gate SET sales_paused = 0, owner_release_id = NULL, owner_mode = NULL, reopened_at = datetime('now'), updated_at = datetime('now') WHERE singleton = 1 AND owner_release_id = ? AND sales_paused = 1").run(current.release_id);
      if (changed.changes !== 1) throw new ReleaseControlError("RELEASE_CANDIDATE_SUPERSEDED");
      this.v2Event(current.release_id, "REOPENED", "PHASE_CHANGED", { from_phase: current.phase, from_phase_sequence: current.phase_sequence, head, expected });
      return { ...status(row(this.db)!), head };
    });
    return transaction();
  }

  activateCertificationLease(input: CertificationLeaseRequest) {
    return this.immediate(() => {
      this.requireCertificationTable();
      const gate = row(this.db); if (!gate) throw new ReleaseControlError("RELEASE_CONTROL_UNAVAILABLE", 503);
      const current = this.v2Head(input.release_id);
      if (gate.owner_release_id !== current.release_id || current.phase !== "DEPLOYED_READ_ONLY" || current.candidate_generation !== input.candidate_generation || releaseStateHash(current) !== input.expected_state_hash) throw new ReleaseControlError("RELEASE_STATE_STALE");
      if (current.certification?.status === "CONSUMED" && (current.certification.occurrence_id === input.occurrence_id || current.certification.promo_id === input.promo_id)) throw new ReleaseControlError("CERTIFICATION_FRESH_FIXTURE_REQUIRED");
      const historicalFixture = this.db.prepare(`SELECT 1 FROM release_certification_allowlist
        WHERE owner_release_id = ? AND status = 'CONSUMED' AND (occurrence_id = ? OR promo_id = ?) LIMIT 1`).get(current.release_id, input.occurrence_id, input.promo_id);
      if (historicalFixture) throw new ReleaseControlError("CERTIFICATION_FRESH_FIXTURE_REQUIRED");
      if (!/^[a-f0-9]{64}$/.test(input.expected_idempotency_key_hash) || !Number.isInteger(input.lease_seconds) || input.lease_seconds < 180 || input.lease_seconds > 300) throw new ReleaseControlError("CERTIFICATION_LEASE_INVALID");
      const occurrence = this.db.prepare("SELECT id, visibility, sales_status, fulfillment_status, price_kopecks FROM occurrences WHERE id = ?").get(input.occurrence_id) as Record<string, unknown> | undefined;
      const promo = this.db.prepare("SELECT id, status, discount_type, discount_value FROM promo_codes WHERE id = ?").get(input.promo_id) as Record<string, unknown> | undefined;
      if (!occurrence || !promo) throw new ReleaseControlError("CERTIFICATION_SCOPE_NOT_FOUND");
      let pricing: { discountKopecks: number; finalAmountKopecks: number } | undefined;
      try { pricing = pricePromo(Number(occurrence.price_kopecks), promo.discount_type, promo.discount_value); } catch { throw new ReleaseControlError("CERTIFICATION_FIXTURE_INVALID"); }
      if (occurrence.visibility !== "HIDDEN" || occurrence.sales_status !== "CLOSED" || occurrence.fulfillment_status !== "SCHEDULED" || Number(occurrence.price_kopecks) !== 101 || promo.status !== "ACTIVE" || promo.discount_type !== "FIXED" || Number(promo.discount_value) !== 1 || pricing.discountKopecks !== 1 || pricing.finalAmountKopecks !== 100) throw new ReleaseControlError("CERTIFICATION_FIXTURE_INVALID");
      this.db.prepare("UPDATE release_certification_allowlist SET status = 'EXPIRED' WHERE status = 'ACTIVE' AND lease_expires_at <= ?").run(new Date().toISOString());
      const active = this.db.prepare("SELECT 1 FROM release_certification_allowlist WHERE status = 'ACTIVE' LIMIT 1").get();
      if (active) throw new ReleaseControlError("CERTIFICATION_LEASE_ALREADY_ACTIVE");
      const leaseId = randomUUID(); const leaseExpiresAt = new Date(Date.now() + input.lease_seconds * 1_000).toISOString();
      const binding = { lease_id: leaseId, occurrence_id: input.occurrence_id, promo_id: input.promo_id, expected_idempotency_key_hash: input.expected_idempotency_key_hash, lease_expires_at: leaseExpiresAt, status: "ACTIVE" };
      const head = { ...current, phase: "CERTIFICATION_ONLY" as const, phase_sequence: current.phase_sequence + 1, certification: binding };
      this.assertProposedV2Event(current.release_id, { action: "PAUSED", details_json: JSON.stringify({ schema_version: 2, kind: "PHASE_CHANGED", from_phase: current.phase, from_phase_sequence: current.phase_sequence, head }) });
      this.db.prepare(`INSERT INTO release_certification_allowlist(lease_id, owner_release_id, candidate_generation, expected_source_commit, occurrence_id, promo_id, expected_idempotency_key_hash, lease_expires_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`).run(leaseId, current.release_id, current.candidate_generation, current.source_commit, input.occurrence_id, input.promo_id, input.expected_idempotency_key_hash, leaseExpiresAt);
      this.v2Event(current.release_id, "PAUSED", "PHASE_CHANGED", { from_phase: current.phase, from_phase_sequence: current.phase_sequence, head });
      return { ...status(row(this.db)!), head, lease: binding };
    });
  }

  consumeCertificationLease(context: CertificationOrderContext, orderId: string) {
    this.requireCertificationTable();
    const gate = row(this.db); if (!gate) throw new ReleaseControlError("RELEASE_CONTROL_UNAVAILABLE", 503);
    const current = gate.owner_release_id ? this.v2Head(gate.owner_release_id) : undefined;
    if (!current || gate.sales_paused !== 1 || gate.owner_release_id !== current.release_id) throw new ReleaseControlError("SALES_TEMPORARILY_PAUSED", 503);
    const lease = this.certificationLeaseFor(current, context);
    if (context.idempotency_key_hash === undefined) throw new ReleaseControlError("SALES_TEMPORARILY_PAUSED", 503);
    const timestamp = new Date().toISOString();
    const consumed = this.db.prepare(`UPDATE release_certification_allowlist SET status = 'CONSUMED', consumed_at = ?, consumed_order_id = ?
      WHERE lease_id = ? AND owner_release_id = ? AND candidate_generation = ? AND expected_source_commit = ?
        AND occurrence_id = ? AND promo_id = ? AND expected_idempotency_key_hash = ?
        AND status = 'ACTIVE' AND lease_expires_at > ?`).run(
      timestamp, orderId, lease.lease_id, current.release_id, current.candidate_generation, current.source_commit,
      context.occurrence_id, context.promo_id, context.idempotency_key_hash, timestamp,
    );
    if (consumed.changes !== 1) throw new ReleaseControlError("SALES_TEMPORARILY_PAUSED", 503);
    const head = { ...current, phase: "CERTIFICATION_IN_FLIGHT" as const, phase_sequence: current.phase_sequence + 1, certification: { ...current.certification!, status: "CONSUMED" } };
    this.assertProposedV2Event(current.release_id, { action: "PAUSED", details_json: JSON.stringify({ schema_version: 2, kind: "PHASE_CHANGED", from_phase: current.phase, from_phase_sequence: current.phase_sequence, head }) });
    this.v2Event(current.release_id, "PAUSED", "PHASE_CHANGED", { from_phase: current.phase, from_phase_sequence: current.phase_sequence, head });
    return head;
  }

  private recoverCertificationDefect(current: GenerationHead, reason: string, orderId: string, paymentId?: string) {
    const head = { ...current, phase: "RECOVERY_REQUIRED" as const, phase_sequence: current.phase_sequence + 1, certification: { ...current.certification!, status: "CONSUMED" as const } };
    const certification_defect = { reason, order_id: orderId, ...(paymentId ? { payment_id: paymentId } : {}) };
    this.assertProposedV2Event(current.release_id, { action: "PAUSED", details_json: JSON.stringify({ schema_version: 2, kind: "PHASE_CHANGED", from_phase: current.phase, from_phase_sequence: current.phase_sequence, head, certification_defect }) });
    this.v2Event(current.release_id, "PAUSED", "PHASE_CHANGED", { from_phase: current.phase, from_phase_sequence: current.phase_sequence, head, certification_defect });
    return { ...status(row(this.db)!), head, certification_defect };
  }

  certifyCandidate(input: CertificationEvidenceRequest) {
    return this.immediate(() => {
      this.requireCertificationTable();
      const gate = row(this.db); if (!gate) throw new ReleaseControlError("RELEASE_CONTROL_UNAVAILABLE", 503);
      const current = this.v2Head(input.release_id);
      if (gate.owner_release_id !== current.release_id || current.phase !== "CERTIFICATION_IN_FLIGHT" || current.candidate_generation !== input.candidate_generation || releaseStateHash(current) !== input.expected_state_hash || !current.certification) throw new ReleaseControlError("RELEASE_STATE_STALE");
      const lease = this.db.prepare(`SELECT occurrence_id, promo_id, consumed_order_id FROM release_certification_allowlist
        WHERE lease_id = ? AND owner_release_id = ? AND candidate_generation = ? AND expected_source_commit = ?
          AND occurrence_id = ? AND promo_id = ? AND status = 'CONSUMED'`).get(
        current.certification.lease_id, current.release_id, current.candidate_generation, current.source_commit,
        current.certification.occurrence_id, current.certification.promo_id,
      ) as { occurrence_id: string; promo_id: string; consumed_order_id: string | null } | undefined;
      const evidence = this.db.prepare(`SELECT o.id AS order_id, o.occurrence_id, o.promo_id_snapshot, o.price_kopecks_snapshot, o.discount_kopecks_snapshot, o.amount_kopecks,
        p.id AS payment_id, p.status AS payment_status, p.captured_amount_kopecks,
        r.id AS refund_id, r.amount_kopecks AS refunded_amount_kopecks
        FROM orders o JOIN payments p ON p.order_id = o.id
        LEFT JOIN refunds r ON r.payment_id = p.id AND r.status = 'SUCCEEDED'
        WHERE o.id = ?`).all(input.order_id) as Record<string, unknown>[];
      if (evidence.length === 0) return this.recoverCertificationDefect(current, "CERTIFICATION_ORDER_NOT_FOUND", input.order_id);
      if (evidence.length !== 1) return this.recoverCertificationDefect(current, "CERTIFICATION_REFUND_EVIDENCE_AMBIGUOUS", input.order_id);
      const rowEvidence = evidence[0];
      const refundStates = this.db.prepare("SELECT status FROM refunds WHERE payment_id = ?").all(rowEvidence.payment_id) as Array<{ status: string }>;
      if (refundStates.some((refund) => ["REQUESTED", "SUBMITTING", "SUBMIT_UNKNOWN", "RECONCILING", "REVIEW_REQUIRED"].includes(refund.status))) throw new ReleaseControlError("CERTIFICATION_PAYMENT_REFUND_MISSING");
      const refundCount = this.db.prepare("SELECT COUNT(*) AS count FROM refunds WHERE payment_id = ?").get(rowEvidence.payment_id) as { count: number };
      if (Number(refundCount.count) === 0) {
        if (["CANCELLED", "EXPIRED"].includes(String(rowEvidence.payment_status))) throw new ReleaseControlError("CERTIFICATION_RETRY_REQUIRED");
        if (String(rowEvidence.payment_status) !== "REFUNDED") throw new ReleaseControlError("CERTIFICATION_PAYMENT_REFUND_MISSING");
        return this.recoverCertificationDefect(current, "CERTIFICATION_CAPTURE_REFUND_INCOMPLETE", input.order_id, String(rowEvidence.payment_id));
      }
      if (Number(refundCount.count) !== 1) return this.recoverCertificationDefect(current, "CERTIFICATION_REFUND_EVIDENCE_AMBIGUOUS", input.order_id, String(rowEvidence.payment_id));
      const result = evaluateCertificationEvidence({
        occurrence_id: String(rowEvidence.occurrence_id), expected_occurrence_id: lease?.occurrence_id ?? "",
        promo_id_snapshot: rowEvidence.promo_id_snapshot === null ? null : String(rowEvidence.promo_id_snapshot), expected_promo_id: lease?.promo_id ?? "",
        order_id: String(rowEvidence.order_id), expected_order_id: lease?.consumed_order_id ?? null,
        payment_id: String(rowEvidence.payment_id), refund_id: rowEvidence.refund_id === null ? null : String(rowEvidence.refund_id),
        price_kopecks_snapshot: rowEvidence.price_kopecks_snapshot, discount_kopecks_snapshot: rowEvidence.discount_kopecks_snapshot,
        amount_kopecks: rowEvidence.amount_kopecks, payment_status: rowEvidence.payment_status,
        captured_amount_kopecks: rowEvidence.captured_amount_kopecks, refunded_amount_kopecks: rowEvidence.refunded_amount_kopecks,
      });
      if (!result.certified) {
        if (result.reason === "CERTIFICATION_CAPTURE_REFUND_INCOMPLETE" && String(rowEvidence.payment_status) !== "REFUNDED") throw new ReleaseControlError("CERTIFICATION_PAYMENT_REFUND_MISSING");
        const defectReason = result.reason === "CERTIFICATION_PAYMENT_REFUND_MISSING" ? "CERTIFICATION_CAPTURE_REFUND_INCOMPLETE" : result.reason;
        return this.recoverCertificationDefect(current, defectReason, input.order_id, String(rowEvidence.payment_id));
      }
      const head = { ...current, phase: "CERTIFIED" as const, phase_sequence: current.phase_sequence + 1, certification: { ...current.certification, status: "CONSUMED" as const } };
      this.assertProposedV2Event(current.release_id, { action: "PAUSED", details_json: JSON.stringify({ schema_version: 2, kind: "PHASE_CHANGED", from_phase: current.phase, from_phase_sequence: current.phase_sequence, head, certification_evidence: result.evidence }) });
      this.v2Event(current.release_id, "PAUSED", "PHASE_CHANGED", { from_phase: current.phase, from_phase_sequence: current.phase_sequence, head, certification_evidence: result.evidence });
      return { ...status(row(this.db)!), head, evidence: result.evidence };
    });
  }

  retryCertification(input: CertificationRetryRequest) {
    return this.immediate(() => {
      this.requireCertificationTable();
      const gate = row(this.db); if (!gate) throw new ReleaseControlError("RELEASE_CONTROL_UNAVAILABLE", 503);
      const current = this.v2Head(input.release_id);
      if (gate.owner_release_id !== current.release_id || current.phase !== "CERTIFICATION_IN_FLIGHT" || current.candidate_generation !== input.candidate_generation || releaseStateHash(current) !== input.expected_state_hash || current.certification?.status !== "CONSUMED") throw new ReleaseControlError("RELEASE_STATE_STALE");
      const lease = this.db.prepare(`SELECT consumed_order_id FROM release_certification_allowlist
        WHERE lease_id = ? AND owner_release_id = ? AND candidate_generation = ? AND expected_source_commit = ?
          AND occurrence_id = ? AND promo_id = ? AND status = 'CONSUMED'`).get(
        current.certification.lease_id, current.release_id, current.candidate_generation, current.source_commit,
        current.certification.occurrence_id, current.certification.promo_id,
      ) as { consumed_order_id: string | null } | undefined;
      const payment = lease?.consumed_order_id ? this.db.prepare("SELECT id, state, status FROM payments WHERE order_id = ?").get(lease.consumed_order_id) as { id: string; state: string; status: string } | undefined : undefined;
      const refunds = payment ? this.db.prepare("SELECT status FROM refunds WHERE payment_id = ?").all(payment.id) as Array<{ status: string }> : [];
      if (!lease?.consumed_order_id || !payment || !["CANCELLED", "EXPIRED"].includes(payment.status) || (payment.status === "CANCELLED" && payment.state !== "CREATE_FAILED") || refunds.length > 0) throw new ReleaseControlError("CERTIFICATION_RETRY_BLOCKED");
      const head = { ...current, phase: "DEPLOYED_READ_ONLY" as const, phase_sequence: current.phase_sequence + 1, certification: { ...current.certification, status: "CONSUMED" as const } };
      const certification_retry = { reason: input.retry_reason, order_id: lease.consumed_order_id, payment_id: payment.id, payment_state: payment.state, payment_status: payment.status };
      this.assertProposedV2Event(current.release_id, { action: "PAUSED", details_json: JSON.stringify({ schema_version: 2, kind: "PHASE_CHANGED", from_phase: current.phase, from_phase_sequence: current.phase_sequence, head, certification_retry }) });
      this.v2Event(current.release_id, "PAUSED", "PHASE_CHANGED", { from_phase: current.phase, from_phase_sequence: current.phase_sequence, head, certification_retry });
      return { ...status(row(this.db)!), head, certification_retry };
    });
  }

  assertNewOrdersOpen(context?: CertificationOrderContext) {
    const gate = row(this.db);
    if (!gate) throw new ReleaseControlError("RELEASE_CONTROL_UNAVAILABLE", 503);
    const allEvents = this.db.prepare("SELECT rowid AS seq, release_id, action, details_json FROM release_sales_gate_events ORDER BY rowid ASC").all() as V2Event[];
    const byRelease = new Map<string, V2Event[]>();
    for (const event of allEvents) {
      try { if ((JSON.parse(event.details_json) as { schema_version?: unknown }).schema_version !== 2) continue; }
      catch { continue; }
      byRelease.set(event.release_id, [...(byRelease.get(event.release_id) ?? []), event]);
    }
    const heads = [...byRelease.values()].map((events) => replayReleaseGenerationChain(events));
    if (heads.some((replay) => replay.corrupt)) throw new ReleaseControlError("RELEASE_STATE_CORRUPT", 503);
    const active = heads.flatMap((replay) => replay.head && !isTerminalPhase(replay.head.phase) ? [replay.head] : []);
    this.reconcileGateOwnership(gate, byRelease, active);
    if (gate.sales_paused !== 1) return undefined;
    if (!context || active.length !== 1) throw new ReleaseControlError("SALES_TEMPORARILY_PAUSED", 503);
    return this.certificationLeaseFor(active[0], context);
  }

  acquire(request: ReleaseControlRequest) {
    const transaction = this.db.transaction(() => {
      this.assertLegacyMutationAllowed();
      const gate = row(this.db);
      if (!gate) throw new ReleaseControlError("RELEASE_CONTROL_UNAVAILABLE", 503);
      if (!supportedMigrationExpectation(request.expected.migration)) throw new ReleaseControlError("UNKNOWN_EXPECTED_MIGRATION");
      if (sameExpectations(gate, request)) return status(gate);
      if (gate.owner_release_id) throw new ReleaseControlError("RELEASE_CONTROL_OWNED");
      const changed = this.db.prepare(`UPDATE release_sales_gate SET owner_release_id = ?, owner_mode = ?,
        expected_source_commit = ?, expected_migration = ?, expected_legal_version = ?, expected_legal_manifest_sha256 = ?,
        acquired_at = datetime('now'), updated_at = datetime('now')
        WHERE singleton = 1 AND owner_release_id IS NULL AND sales_paused = 0`).run(
        request.release_id, request.mode, request.expected.source_commit, request.expected.migration,
        request.expected.legal_version, request.expected.legal_manifest_sha256,
      );
      if (!changed.changes) throw new ReleaseControlError("RELEASE_CONTROL_OWNED");
      event(this.db, request.release_id, "ACQUIRED", { mode: request.mode, expected: request.expected });
      return this.status();
    });
    return transaction();
  }

  pause(request: ReleaseControlRequest) {
    const transaction = this.db.transaction(() => {
      this.assertLegacyMutationAllowed();
      const gate = row(this.db);
      if (!gate) throw new ReleaseControlError("RELEASE_CONTROL_UNAVAILABLE", 503);
      if (!sameExpectations(gate, request)) throw new ReleaseControlError("RELEASE_CONTROL_OWNER_MISMATCH");
      if (gate.sales_paused === 1) return status(gate);
      const changed = this.db.prepare(`UPDATE release_sales_gate SET sales_paused = 1, paused_at = datetime('now'), updated_at = datetime('now')
        WHERE singleton = 1 AND sales_paused = 0 AND owner_release_id = ?`).run(request.release_id);
      if (!changed.changes) throw new ReleaseControlError("RELEASE_CONTROL_OWNER_MISMATCH");
      event(this.db, request.release_id, "PAUSED", { expected: request.expected });
      return this.status();
    });
    return transaction();
  }

  updateExpectations(request: ReleaseControlRequest) {
    const transaction = this.db.transaction(() => {
      this.assertLegacyMutationAllowed();
      const gate = row(this.db);
      if (!gate) throw new ReleaseControlError("RELEASE_CONTROL_UNAVAILABLE", 503);
      if (!supportedMigrationExpectation(request.expected.migration)) throw new ReleaseControlError("UNKNOWN_EXPECTED_MIGRATION");
      if (gate.owner_release_id !== request.release_id || gate.sales_paused !== 1) throw new ReleaseControlError("RELEASE_CONTROL_OWNER_MISMATCH");
      const changed = this.db.prepare(`UPDATE release_sales_gate SET owner_mode = ?, expected_source_commit = ?, expected_migration = ?,
        expected_legal_version = ?, expected_legal_manifest_sha256 = ?, updated_at = datetime('now')
        WHERE singleton = 1 AND sales_paused = 1 AND owner_release_id = ?`).run(
        request.mode, request.expected.source_commit, request.expected.migration,
        request.expected.legal_version, request.expected.legal_manifest_sha256, request.release_id,
      );
      if (!changed.changes) throw new ReleaseControlError("RELEASE_CONTROL_OWNER_MISMATCH");
      return this.status();
    });
    return transaction();
  }

  assertPausedOwner(request: ReleaseControlRequest) {
    const gate = row(this.db);
    if (!gate) throw new ReleaseControlError("RELEASE_CONTROL_UNAVAILABLE", 503);
    if (!sameExpectations(gate, request) || gate.sales_paused !== 1) throw new ReleaseControlError("RELEASE_CONTROL_OWNER_MISMATCH");
  }

  reopen(request: ReleaseControlRequest, evidence: ReleaseRuntimeEvidence) {
    this.assertLegacyMutationAllowed();
    const reason = evaluateReopenGate(request, evidence);
    if (reason) throw new ReleaseControlError(reason);
    const transaction = this.db.transaction(() => {
      const gate = row(this.db);
      if (!gate) throw new ReleaseControlError("RELEASE_CONTROL_UNAVAILABLE", 503);
      if (!sameExpectations(gate, request) || gate.sales_paused !== 1) throw new ReleaseControlError("RELEASE_CONTROL_OWNER_MISMATCH");
      const changed = this.db.prepare(`UPDATE release_sales_gate SET sales_paused = 0, owner_release_id = NULL, owner_mode = NULL,
        reopened_at = datetime('now'), updated_at = datetime('now')
        WHERE singleton = 1 AND sales_paused = 1 AND owner_release_id = ?`).run(request.release_id);
      if (!changed.changes) throw new ReleaseControlError("RELEASE_CONTROL_OWNER_MISMATCH");
      event(this.db, request.release_id, "REOPENED", { expected: request.expected, evidence });
      return this.status();
    });
    return transaction();
  }
}

export const releaseRuntimeEvidence = (db: Database.Database, input: { sourceCommit: string | undefined; currentLegalCopiesMatch: (manifest: LegalManifest) => boolean }): ReleaseRuntimeEvidence => {
  const active = db.prepare("SELECT version, effective_at, manifest_json FROM legal_releases WHERE active = 1").get() as { version: string; effective_at: string; manifest_json: string } | undefined;
  const workerTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runtime_release_evidence'").get();
  const supportsSweepEvidence = workerTable && db.prepare("PRAGMA table_info(runtime_release_evidence)").all().some((column) => (column as { name: string }).name === "last_successful_sweep_at");
  const workerSql = `SELECT source_commit, started_at, observed_at, ${supportsSweepEvidence ? "last_successful_sweep_at" : "NULL AS last_successful_sweep_at"} FROM runtime_release_evidence WHERE unit = 'WORKER'`;
  const worker = workerTable
    ? (db.prepare(workerSql).get() as { source_commit: string; started_at: string; observed_at: string; last_successful_sweep_at: string | null } | undefined)
    : undefined;
  const requiredMigrations = Object.fromEntries(diagnosticCutoverMigrations.map((version) => [version, Boolean(db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version))]));
  const migrationVersions = (db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: string }>).map(({ version }) => version);
  const sourceLegal = (() => {
    try {
      const raw = readFileSync(resolve(process.cwd(), "commerce/legal/production-manifest.json"));
      const parsed = JSON.parse(raw.toString("utf8")) as { publish_time?: string };
      return { sha256: createHash("sha256").update(raw).digest("hex"), publishTime: parsed.publish_time ?? null };
    } catch { return { sha256: null, publishTime: null }; }
  })();
  const migrationSourceHashes = (() => {
    try {
      const directory = resolve(process.cwd(), "commerce/migrations");
      return Object.fromEntries(readdirSync(directory).filter((name) => name.endsWith(".sql")).sort().map((name) => [name, createHash("sha256").update(readFileSync(resolve(directory, name))).digest("hex")]));
    } catch { return null; }
  })();
  const base = { source_commit: input.sourceCommit?.trim() || null, required_migrations: requiredMigrations, migration_versions: migrationVersions, worker_source_commit: worker?.source_commit ?? null, worker_started_at: worker?.started_at ?? null, worker_observed_at: worker?.observed_at ?? null, worker_last_successful_sweep_at: worker?.last_successful_sweep_at ?? null, source_legal_manifest_sha256: sourceLegal.sha256, source_legal_publish_time: sourceLegal.publishTime, migration_source_hashes: migrationSourceHashes };
  if (!active) return { ...base, legal_version: null, legal_manifest_sha256: null, legal_hashes: null, legal_publish_time: null, current_legal_copies_match: false };
  try {
    const manifest = parseLegalManifest(JSON.parse(active.manifest_json));
    const legalHashes = Object.fromEntries(documentIds.map((id) => [id, manifest.documents[id].sha256])) as ReleaseExpectations["legal_hashes"];
    return {
      ...base,
      legal_version: active.version,
      legal_manifest_sha256: createHash("sha256").update(canonicalLegalManifest(manifest)).digest("hex"),
      legal_hashes: legalHashes,
      legal_publish_time: active.effective_at,
      current_legal_copies_match: input.currentLegalCopiesMatch(manifest),
    };
  } catch {
    return { ...base, legal_version: active.version, legal_manifest_sha256: null, legal_hashes: null, legal_publish_time: active.effective_at, current_legal_copies_match: false };
  }
};
