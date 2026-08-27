import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import { canonicalLegalManifest, parseLegalManifest, type LegalManifest } from "./legal-manifest";
import { parseUtcTimestamp } from "./utc-timestamp";
import { assertAppliedMigrationPrefix, candidateExpectedMigration, reconcileHeadWithProjection, releaseStateHash, replayReleaseGenerationChain, runtimeReadinessErrorClasses, type GenerationHead, type ReleasePhase, type RuntimeReadinessErrorClass, type V2Event } from "./release-generation";
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
export type CandidateAcquireRequest = { head: GenerationHead };
export type CandidateAdoptRequest = { head: GenerationHead; expected_generation: number; from_sha: string; expected_state_hash: string };
export type CandidatePhaseRequest = { release_id: string; candidate_generation: number; expected_state_hash: string; from_phase: ReleasePhase; phase_sequence: number; to_phase: Exclude<ReleasePhase, "COMPLETE"> };
export type RuntimeReadinessDefectRequest = {
  release_id: string;
  candidate_generation: number;
  expected_state_hash: string;
  readiness_component: "PROVIDER_READINESS";
  error_class: RuntimeReadinessErrorClass;
  error_code: string;
};
export type CandidateCompleteRequest = { release_id: string; candidate_generation: number; expected_state_hash: string };
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
};
export const requiredMigrationsFor = (expectedMigration: string): readonly string[] | undefined => requiredMigrationsByExpectedMigration[expectedMigration];
const migrationInventoryPrefix = "inventory-sha256:";
export const migrationInventoryExpectation = (versions: readonly string[]): string =>
  `${migrationInventoryPrefix}${createHash("sha256").update([...versions].sort().join("\n")).digest("hex")}`;
const isMigrationInventoryExpectation = (expectedMigration: string): boolean =>
  new RegExp(`^${migrationInventoryPrefix}[a-f0-9]{64}$`).test(expectedMigration);
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

export const evaluateReopenGate = (request: ReleaseControlRequest, evidence: ReleaseRuntimeEvidence): string | undefined => {
  if (evidence.source_commit !== request.expected.source_commit) return "SOURCE_COMMIT_MISMATCH";
  const requiredMigrations = requiredMigrationsFor(request.expected.migration);
  const inventoryExpectation = isMigrationInventoryExpectation(request.expected.migration);
  if (!requiredMigrations && !inventoryExpectation) return "UNKNOWN_EXPECTED_MIGRATION";
  if (requiredMigrations?.some((version) => evidence.required_migrations[version] !== true)) return "REQUIRED_MIGRATION_NOT_APPLIED";
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
  if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(migration)) return "UNKNOWN_EXPECTED_MIGRATION";
  if (evidence.source_commit !== request.expected.source_commit) return "SOURCE_COMMIT_MISMATCH";
  if (![...diagnosticCutoverMigrations, migration].every((version) => evidence.required_migrations[version] === true || evidence.migration_versions.includes(version))) return "REQUIRED_MIGRATION_NOT_APPLIED";
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
    const active = replays.flatMap(({ replay }) => replay.head && replay.head.phase !== "COMPLETE" ? [replay.head] : []);
    const projection = {
      owner_release_id: gate.owner_release_id, sales_paused: gate.sales_paused === 1,
      expected_source_commit: gate.expected_source_commit, expected_migration: gate.expected_migration,
      expected_legal_version: gate.expected_legal_version, expected_legal_manifest_sha256: gate.expected_legal_manifest_sha256,
    };
    if (gate.owner_release_id !== null) {
      if (active.length !== 1 || reconcileHeadWithProjection(active[0], projection)) throw new ReleaseControlError("RELEASE_STATE_CORRUPT", 503);
      return { schema_version: 2, head: active[0], state_hash: releaseStateHash(active[0]) };
    }
    if (gate.sales_paused === 1 || active.length) throw new ReleaseControlError("RELEASE_STATE_CORRUPT", 503);
    const completed = replays
      .filter(({ replay }) => replay.head?.phase === "COMPLETE")
      .sort((left, right) => (right.events.at(-1)?.seq ?? 0) - (left.events.at(-1)?.seq ?? 0));
    const head = completed.at(0)?.replay.head;
    if (!head) return { schema_version: 2, head: null, state_hash: null };
    if (reconcileHeadWithProjection(head, projection)) throw new ReleaseControlError("RELEASE_STATE_CORRUPT", 503);
    return { schema_version: 2, head, state_hash: releaseStateHash(head) };
  }

  private v2Head(releaseId: string) {
    const events = this.db.prepare("SELECT rowid AS seq, release_id, action, details_json FROM release_sales_gate_events WHERE release_id = ? ORDER BY rowid ASC").all(releaseId) as V2Event[];
    const replay = replayReleaseGenerationChain(events);
    if (replay.corrupt || !replay.head) throw new ReleaseControlError(replay.corrupt === undefined ? "RELEASE_STATE_STALE" : "RELEASE_STATE_CORRUPT", replay.corrupt ? 503 : 409);
    return replay.head;
  }

  private v2Event(releaseId: string, action: "ACQUIRED" | "PAUSED" | "REOPENED", kind: "CANDIDATE_ACQUIRED" | "CANDIDATE_SUPERSEDED" | "PHASE_CHANGED" | "RUNTIME_READINESS_DEFECT", details: Record<string, unknown>) {
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
    for (const releaseId of ids) { const replay = this.v2Head(releaseId); if (replay.phase !== "COMPLETE") throw new ReleaseControlError("RELEASE_CONTROL_V2_REQUIRED"); }
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

  changeCandidatePhase(input: CandidatePhaseRequest) {
    const transaction = () => this.immediate(() => {
      const gate = row(this.db); if (!gate) throw new ReleaseControlError("RELEASE_CONTROL_UNAVAILABLE", 503);
      const current = this.v2Head(input.release_id);
      if (gate.owner_release_id !== current.release_id) throw new ReleaseControlError("RELEASE_CANDIDATE_SUPERSEDED");
      if (current.candidate_generation !== input.candidate_generation || current.phase !== input.from_phase || current.phase_sequence !== input.phase_sequence || releaseStateHash(current) !== input.expected_state_hash) throw new ReleaseControlError("RELEASE_STATE_STALE");
      if (input.to_phase === "CERTIFICATION_ONLY" || input.to_phase === "CERTIFICATION_IN_FLIGHT" || input.to_phase === "CERTIFIED" || current.phase === "CERTIFICATION_IN_FLIGHT") throw new ReleaseControlError("CERTIFICATION_TRANSITION_REQUIRES_EVIDENCE");
      if (current.phase === "PAUSED" && input.to_phase === "RECOVERY_REQUIRED") throw new ReleaseControlError("RUNTIME_READINESS_DEFECT_EVIDENCE_REQUIRED");
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

  markRuntimeReadinessDefect(input: RuntimeReadinessDefectRequest, runtimeEvidence: () => ReleaseRuntimeEvidence) {
    return this.immediate(() => {
      const gate = row(this.db); if (!gate) throw new ReleaseControlError("RELEASE_CONTROL_UNAVAILABLE", 503);
      const current = this.v2Head(input.release_id);
      if (gate.owner_release_id !== current.release_id || gate.sales_paused !== 1 || current.phase !== "PAUSED" || current.certification || current.candidate_generation !== input.candidate_generation || releaseStateHash(current) !== input.expected_state_hash) throw new ReleaseControlError("RELEASE_STATE_STALE");
      if (input.readiness_component !== "PROVIDER_READINESS" || !runtimeReadinessErrorClasses.includes(input.error_class) || !/^[A-Z0-9_]{1,80}$/.test(input.error_code)) throw new ReleaseControlError("RUNTIME_READINESS_DEFECT_INVALID");
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
    const active = heads.flatMap((replay) => replay.head && replay.head.phase !== "COMPLETE" ? [replay.head] : []);
    if (byRelease.size && gate.owner_release_id === null) {
      if (active.length || gate.sales_paused === 1) throw new ReleaseControlError("RELEASE_STATE_CORRUPT", 503);
    } else if (gate.owner_release_id !== null && active.length) {
      if (active.length !== 1 || reconcileHeadWithProjection(active[0], { owner_release_id: gate.owner_release_id, sales_paused: gate.sales_paused === 1, expected_source_commit: gate.expected_source_commit, expected_migration: gate.expected_migration, expected_legal_version: gate.expected_legal_version, expected_legal_manifest_sha256: gate.expected_legal_manifest_sha256 })) throw new ReleaseControlError("RELEASE_STATE_CORRUPT", 503);
    } else if (byRelease.size && gate.owner_release_id !== null) throw new ReleaseControlError("RELEASE_STATE_CORRUPT", 503);
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
