import type Database from "better-sqlite3";

export type RestrictiveOverride = {
  readonly operationId: string;
  readonly courseRef: string;
  readonly scope: { readonly level: "COURSE" | "SECTION" | "LESSON"; readonly ref: string };
  readonly expected: { readonly kind: "EFFECTIVE_VISIBILITY" | "FREE_PREVIEW"; readonly value: "UNLISTED" | "FALSE" };
  readonly deadlineAt: string;
  readonly platformEpoch: string;
};

export class OverrideProofError extends Error {
  constructor(readonly code: string) { super(code); }
}

export function createRestrictiveOverride(db: Database.Database, override: RestrictiveOverride) {
  const existing = db.prepare(`SELECT course_ref,scope_level,scope_ref,expected_kind,expected_value,deadline_at,platform_epoch
    FROM access_overrides WHERE operation_id=?`).get(override.operationId) as {
      course_ref: string; scope_level: string; scope_ref: string; expected_kind: string;
      expected_value: string; deadline_at: string; platform_epoch: string;
    } | undefined;
  if (existing) {
    const matches = existing.course_ref === override.courseRef && existing.scope_level === override.scope.level &&
      existing.scope_ref === override.scope.ref && existing.expected_kind === override.expected.kind &&
      existing.expected_value === override.expected.value && existing.deadline_at === override.deadlineAt &&
      existing.platform_epoch === override.platformEpoch;
    if (!matches) throw new OverrideProofError("OPERATION_ID_REUSED");
    return { created: false as const };
  }
  db.prepare(`INSERT INTO access_overrides
      (operation_id,course_ref,scope_level,scope_ref,expected_kind,expected_value,deadline_at,platform_epoch)
      VALUES (?,?,?,?,?,?,?,?)`).run(
    override.operationId, override.courseRef, override.scope.level, override.scope.ref,
    override.expected.kind, override.expected.value, override.deadlineAt, override.platformEpoch,
  );
  return { created: true as const };
}

export function listPendingOverrides(db: Database.Database) {
  return db.prepare(`SELECT operation_id AS operationId, course_ref AS courseRef, deadline_at AS deadlineAt,
    platform_epoch AS platformEpoch, created_at AS createdAt, orphaned_at AS orphanedAt
    FROM access_overrides WHERE state='PENDING' ORDER BY created_at`).all() as Array<{
      operationId: string; courseRef: string; deadlineAt: string; platformEpoch: string;
      createdAt: string; orphanedAt: string | null;
    }>;
}

export type RollbackReleaseProof = {
  readonly checkedAt: string;
  readonly currentPlatformEpoch: string;
  readonly committedRecordExists: boolean;
  readonly operationInFlight: boolean;
  readonly transactionEnded: boolean;
};

export function releaseRolledBackOverride(db: Database.Database, operationId: string, proof: RollbackReleaseProof) {
  const row = db.prepare("SELECT state, deadline_at, platform_epoch FROM access_overrides WHERE operation_id = ?").get(operationId) as {
    state: string; deadline_at: string; platform_epoch: string;
  } | undefined;
  if (!row || row.state !== "PENDING") throw new OverrideProofError("OVERRIDE_NOT_PENDING");
  if (Date.parse(proof.checkedAt) < Date.parse(row.deadline_at)) throw new OverrideProofError("OVERRIDE_DEADLINE_NOT_REACHED");
  if (proof.committedRecordExists) throw new OverrideProofError("COMMITTED_OPERATION_EXISTS");
  if (!proof.transactionEnded) throw new OverrideProofError("TRANSACTION_END_NOT_PROVEN");
  if (row.platform_epoch === proof.currentPlatformEpoch && proof.operationInFlight) throw new OverrideProofError("OPERATION_STILL_IN_FLIGHT");
  const evidence = JSON.stringify(proof);
  db.prepare(`UPDATE access_overrides SET state='RELEASED_ROLLED_BACK', resolved_at=?, resolution_evidence_json=?, attention_reason=NULL
    WHERE operation_id=? AND state='PENDING'`).run(proof.checkedAt, evidence, operationId);
}

export function flagOrphanedOverrides(db: Database.Database, now: string, ageMilliseconds = 60 * 60 * 1000): string[] {
  const rows = db.prepare("SELECT operation_id, created_at FROM access_overrides WHERE state='PENDING' AND orphaned_at IS NULL").all() as Array<{ operation_id: string; created_at: string }>;
  const orphaned = rows.filter(({ created_at }) => Date.parse(now) - Date.parse(created_at) >= ageMilliseconds).map(({ operation_id }) => operation_id);
  const update = db.prepare("UPDATE access_overrides SET orphaned_at=?, attention_reason='ORPHANED' WHERE operation_id=? AND state='PENDING'");
  const run = db.transaction(() => orphaned.forEach((id) => update.run(now, id)));
  run.immediate();
  return orphaned;
}
