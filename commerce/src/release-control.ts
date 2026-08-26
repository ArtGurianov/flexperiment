import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import { canonicalLegalManifest, parseLegalManifest, type LegalManifest } from "./legal-manifest";
import { parseUtcTimestamp } from "./utc-timestamp";

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
};

export const diagnosticCutoverMigrations = ["0031_participant_age_band.sql", "0032_release_sales_gate.sql", "0033_runtime_release_evidence.sql", "0034_worker_sweep_evidence.sql"] as const;
const requiredMigrationsByExpectedMigration: Record<string, readonly string[]> = {
  "0033_runtime_release_evidence.sql": ["0032_release_sales_gate.sql", "0033_runtime_release_evidence.sql"],
  "0034_worker_sweep_evidence.sql": diagnosticCutoverMigrations,
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

  assertNewOrdersOpen() {
    const gate = row(this.db);
    if (!gate) throw new ReleaseControlError("RELEASE_CONTROL_UNAVAILABLE", 503);
    if (gate.sales_paused === 1) throw new ReleaseControlError("SALES_TEMPORARILY_PAUSED", 503);
  }

  acquire(request: ReleaseControlRequest) {
    const transaction = this.db.transaction(() => {
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
  const base = { source_commit: input.sourceCommit?.trim() || null, required_migrations: requiredMigrations, migration_versions: migrationVersions, worker_source_commit: worker?.source_commit ?? null, worker_started_at: worker?.started_at ?? null, worker_observed_at: worker?.observed_at ?? null, worker_last_successful_sweep_at: worker?.last_successful_sweep_at ?? null, source_legal_manifest_sha256: sourceLegal.sha256, source_legal_publish_time: sourceLegal.publishTime };
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
