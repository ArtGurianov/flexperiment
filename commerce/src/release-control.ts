import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { canonicalLegalManifest, parseLegalManifest, type LegalManifest } from "./legal-manifest";

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
  worker_observed_at: string | null;
  worker_last_successful_sweep_at: string | null;
  source_legal_manifest_sha256: string | null;
  source_legal_publish_time: string | null;
};

const diagnosticMigrationVersions = ["0031_participant_age_band.sql", "0032_release_sales_gate.sql", "0033_runtime_release_evidence.sql"] as const;

export const requiredMigrationsByExpectedMigration: Record<string, readonly string[]> = {
  "0033_runtime_release_evidence.sql": ["0032_release_sales_gate.sql", "0033_runtime_release_evidence.sql"],
  "0034_worker_sweep_evidence.sql": ["0031_participant_age_band.sql", "0032_release_sales_gate.sql", "0033_runtime_release_evidence.sql", "0034_worker_sweep_evidence.sql"],
};

const requiredMigrationsFor = (migration: string) => requiredMigrationsByExpectedMigration[migration];
const migrationReadinessFailure = (migration: string, appliedVersions: readonly string[]) => {
  const required = requiredMigrationsFor(migration);
  if (!required) return "UNKNOWN_EXPECTED_MIGRATION";
  const applied = new Set(appliedVersions);
  const missing = required.find((version) => !applied.has(version));
  return missing ? `REQUIRED_MIGRATION_NOT_APPLIED_${missing}` : undefined;
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
  const migrationFailure = migrationReadinessFailure(request.expected.migration, evidence.migration_versions);
  if (migrationFailure) return migrationFailure;
  if (evidence.legal_version !== request.expected.legal_version) return "LEGAL_VERSION_MISMATCH";
  if (evidence.legal_manifest_sha256 !== request.expected.legal_manifest_sha256) return "LEGAL_MANIFEST_MISMATCH";
  if (!evidence.legal_publish_time || evidence.legal_publish_time === "PENDING_AUTHORITATIVE_PUBLISH_TIMESTAMP" || Number.isNaN(Date.parse(evidence.legal_publish_time))) return "LEGAL_PUBLISH_TIME_INVALID";
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
      return expected ? { complete: true, expected, reopened_at: eventRow.created_at } : { complete: false, expected: null, reopened_at: null };
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
      if (!requiredMigrationsFor(request.expected.migration)) throw new ReleaseControlError("UNKNOWN_EXPECTED_MIGRATION");
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
      if (!requiredMigrationsFor(request.expected.migration)) throw new ReleaseControlError("UNKNOWN_EXPECTED_MIGRATION");
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
  const worker = workerTable ? db.prepare("SELECT source_commit, observed_at FROM runtime_release_evidence WHERE unit = 'WORKER'").get() as { source_commit: string; observed_at: string } | undefined : undefined;
  const required_migrations = Object.fromEntries(diagnosticMigrationVersions.map((version) => [version, Boolean(db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version))]));
  const migration_versions = (db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: string }>).map(({ version }) => version);
  const base = { source_commit: input.sourceCommit?.trim() || null, required_migrations, migration_versions, worker_source_commit: worker?.source_commit ?? null, worker_observed_at: worker?.observed_at ?? null, worker_last_successful_sweep_at: null, source_legal_manifest_sha256: null, source_legal_publish_time: null };
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
