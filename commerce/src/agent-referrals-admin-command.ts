import type Database from "better-sqlite3";
import { canonicalV2, sha256 } from "./crypto";
import type { AdminPrincipal } from "./agent-referrals-partner-identity";

/**
 * PR-C2 step 2b: durable command identity for the ADMIN realm's
 * agent-referrals commands, on the existing `admin_command_idempotency`
 * table - no new storage, and the same contract domain.ts's own
 * withAdminCommandV2Core implements for the commerce core.
 *
 * It exists as a shared helper because PR-F's recordVerifiedTaxTreatment had
 * to hand-inline that whole pattern (lookup, fingerprint compare, stored
 * response, the ordering rule) inside its own function, and six more
 * commands were about to copy it. One copy of a replay contract is hard
 * enough to keep right; seven is a matter of time.
 *
 * Two differences from domain.ts's version, both deliberate:
 *
 * 1. `entityIdOf` instead of `result.id`. That helper is typed `T extends
 *    Row` and writes `String(created.id)` into a NOT NULL entity_id, which
 *    four of these six commands cannot satisfy - they return
 *    { activation_event_id }, { hold_id }, { verification_event_id },
 *    { distribution_id }. Each names its own durable entity explicitly
 *    rather than the column being widened to nullable for their sake: the
 *    entity is real in every case, it simply is not called `id`.
 *
 * 2. It takes a transaction BODY, never opening one itself, so the business
 *    writes and the idempotency record always land together.
 *
 * `admin_id` is folded into the fingerprint here rather than being passed
 * per call: the admin key namespace is (command, key_hash), shared across
 * admins, so one admin reusing another's key must meet a fingerprint
 * mismatch (409) rather than be handed someone else's response. That is a
 * property of the namespace, not a per-command choice.
 */

export class AdminCommandIdempotencyError extends Error {
  constructor(readonly code: string, readonly status = 409, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export type AdminCommandResult<T> = { response: T; replayed: boolean };

type AdminCommandInput<T> = {
  db: Database.Database;
  admin: AdminPrincipal;
  /** Stable semantic command name, never a URL. */
  command: string;
  idempotencyKey: string;
  /** Resource ids from the path plus the normalized body. `admin_id` and `command` are added here. */
  request: Record<string, unknown>;
  /** Names the durable entity this result represents. Called ONLY on a fresh execution, never on a replay. */
  entityIdOf: (result: T) => string;
  /** The command body. Must NOT open a transaction of its own. */
  execute: () => T;
};

const requireKey = (idempotencyKey: string): string => {
  const trimmed = (idempotencyKey ?? "").trim();
  if (trimmed.length < 16 || trimmed.length > 200) {
    throw new AdminCommandIdempotencyError("IDEMPOTENCY_KEY_INVALID", 400, `${trimmed.length} chars`);
  }
  return trimmed;
};

export const withAdminCommandInTransaction = <T>(input: AdminCommandInput<T>): AdminCommandResult<T> => {
  const { db, admin, command, request, entityIdOf, execute } = input;
  const keyHash = sha256(requireKey(input.idempotencyKey));
  const fingerprint = sha256(canonicalV2({ command, admin_id: admin.admin_id, ...request }));

  // Checked BEFORE identity resolution, suspension gates and every business
  // rule below. A replay reflects authority proven and consumed at the time
  // of the ORIGINAL call; nothing that happened since - a suspension, a
  // destruction, a supersession - may turn that into a failure or into a
  // different mutation.
  const existing = db.prepare("SELECT canonical_request_hash, response_json FROM admin_command_idempotency WHERE command = ? AND idempotency_key_hash = ?")
    .get(command, keyHash) as { canonical_request_hash: string; response_json: string | null } | undefined;
  if (existing) {
    if (existing.canonical_request_hash !== fingerprint) throw new AdminCommandIdempotencyError("IDEMPOTENCY_CONFLICT", 409, command);
    if (!existing.response_json) throw new AdminCommandIdempotencyError("IDEMPOTENCY_CONTRACT_SUPERSEDED", 409, command);
    return { response: JSON.parse(existing.response_json) as T, replayed: true };
  }

  const response = execute();
  const entityId = entityIdOf(response);
  // Fail closed before the record is written: a blank entity_id would make
  // the row unusable as evidence of WHAT the command produced, and the
  // column's NOT NULL alone would not catch an empty string.
  if (!entityId.trim()) throw new AdminCommandIdempotencyError("ADMIN_COMMAND_ENTITY_ID_MISSING", 500, command);

  db.prepare("INSERT INTO admin_command_idempotency(command, idempotency_key_hash, canonical_request_hash, entity_id, response_json) VALUES (?, ?, ?, ?, ?)")
    .run(command, keyHash, fingerprint, entityId, JSON.stringify(response));
  return { response, replayed: false };
};
