import type Database from "better-sqlite3";
import {
  NON_TERMINAL, TERMINAL,
  type DeploymentGateView, type DeploySession, type DeploySessionPatch, type DeploySessionState,
  assertSnapshot, type DeploymentObservation, type PreDeploySnapshot, type ReleaseAuthorityStore, type TerminalState,
} from "./deploy-session";

/**
 * The durable half of the release authority.
 *
 * Every mutation here is one guarded UPDATE, and `changes === 1` is the only
 * proof that this caller owned the session at the instant it wrote. Reading the
 * lease and then acting on it is two steps, and two runners can both pass the
 * read - so ownership, the lease and the legal source states are all in the
 * WHERE clause, never in an `if` above it.
 *
 * The schema carries what an adapter must not be trusted with: at most one
 * non-terminal session, a terminal session that admits no update at all, the
 * one-way bits, and the frozen identity. This file is where the rules that
 * need a caller's identity live; the ones that do not are below it, in SQL.
 */

type Row = {
  id: string; owner_id: string; mode: string; target_sha: string; candidate_id: string;
  state: string; rollback_authority: string; mutation_observed: number; deployment_gate_closed: number;
  created_at: string; lease_expires_at: string;
  pre_deploy_topology: string; observed_topology: string | null;
  adopted_cutover_id: string | null; adopted_envelope_sha256: string | null;
  predecessor_database_ref: string | null; predecessor_database_sha256: string | null;
  bootstrap_rollback_id: string | null;
};

const COLUMNS = `id, owner_id, mode, target_sha, candidate_id, state, rollback_authority,
  mutation_observed, deployment_gate_closed, created_at, lease_expires_at,
  pre_deploy_topology, observed_topology, adopted_cutover_id, adopted_envelope_sha256,
  predecessor_database_ref, predecessor_database_sha256, bootstrap_rollback_id`;

const optional = <T>(value: T | null | undefined): T | undefined => (value === null ? undefined : value);

/**
 * The column is still called `pre_deploy_topology`, and it now holds both
 * layers. A stored value carrying only the four surfaces predates the deploy
 * pointer being part of the snapshot: it is refused rather than completed with
 * an assumed pointer, because guessing where the control plane was is exactly
 * the reading that makes a safe abort unsafe.
 */
const readSnapshot = (stored: string): PreDeploySnapshot => {
  let parsed: PreDeploySnapshot;
  try {
    parsed = JSON.parse(stored) as PreDeploySnapshot;
  } catch {
    throw new Error("DEPLOY_SNAPSHOT_MALFORMED");
  }
  assertSnapshot(parsed);
  return parsed;
};

const toSession = (row: Row): DeploySession => ({
  id: row.id,
  ownerId: row.owner_id,
  mode: row.mode as DeploySession["mode"],
  targetSha: row.target_sha,
  candidateId: row.candidate_id,
  state: row.state as DeploySessionState,
  rollbackAuthority: row.rollback_authority as DeploySession["rollbackAuthority"],
  mutationObserved: row.mutation_observed === 1,
  createdAt: row.created_at,
  leaseExpiresAt: row.lease_expires_at,
  preDeployTopology: readSnapshot(row.pre_deploy_topology),
  observedTopology: row.observed_topology ? readSnapshot(row.observed_topology) : undefined,
  adoptedCutoverId: optional(row.adopted_cutover_id),
  adoptedEnvelopeSha256: optional(row.adopted_envelope_sha256),
  predecessorDatabaseRef: optional(row.predecessor_database_ref),
  predecessorDatabaseSha256: optional(row.predecessor_database_sha256),
  bootstrapRollbackId: optional(row.bootstrap_rollback_id),
});

export class SqliteReleaseAuthorityStore implements ReleaseAuthorityStore {
  constructor(private readonly db: Database.Database) {}

  acquire(session: DeploySession): DeploySession {
    if (!session.preDeployTopology) throw new Error("PRE_DEPLOY_TOPOLOGY_REQUIRED");
    const expected = session.mode === "MAINTENANCE_CUTOVER" ? "FENCED" : "DEPLOYING";
    if (session.state !== expected) throw new Error("DEPLOY_SESSION_INITIAL_STATE_INVALID");
    if (this.get(session.id)) throw new Error("DEPLOY_SESSION_ALREADY_EXISTS");
    if (session.adoptedCutoverId && this.findByAdoptedCutover(session.adoptedCutoverId)) {
      throw new Error("CUTOVER_ALREADY_ADOPTED");
    }
    try {
      this.db.prepare(`INSERT INTO deploy_sessions(${COLUMNS}) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        session.id, session.ownerId, session.mode, session.targetSha, session.candidateId,
        session.state, session.rollbackAuthority, session.mutationObserved ? 1 : 0,
        // The gate follows from the mode, not from a caller's flag.
        session.mode === "MAINTENANCE_CUTOVER" ? 1 : 0,
        session.createdAt, session.leaseExpiresAt,
        JSON.stringify(session.preDeployTopology), session.observedTopology ? JSON.stringify(session.observedTopology) : null,
        session.adoptedCutoverId ?? null, session.adoptedEnvelopeSha256 ?? null,
        session.predecessorDatabaseRef ?? null, session.predecessorDatabaseSha256 ?? null,
        session.bootstrapRollbackId ?? null,
      );
    } catch (error) {
      // The partial unique index is the authority on "one live session", not a
      // check this adapter performed a moment earlier.
      if (String(error).includes("deploy_sessions_single_non_terminal_idx")) throw new Error("DEPLOY_SESSION_ALREADY_ACTIVE");
      // Matched on the constraint, not on a column name: the adoption CHECK
      // also mentions `adopted_cutover_id`, and reporting a malformed handoff
      // as an already-adopted one sends the caller looking for a session that
      // does not exist.
      if (String(error).includes("UNIQUE constraint failed: deploy_sessions.adopted_cutover_id")) {
        throw new Error("CUTOVER_ALREADY_ADOPTED");
      }
      throw error;
    }
    return this.required(session.id);
  }

  get(id: string): DeploySession | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM deploy_sessions WHERE id = ?`).get(id) as Row | undefined;
    return row ? toSession(row) : undefined;
  }

  findByAdoptedCutover(cutoverId: string): DeploySession | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM deploy_sessions WHERE adopted_cutover_id = ?`).get(cutoverId) as Row | undefined;
    return row ? toSession(row) : undefined;
  }

  deploymentGate(): DeploymentGateView {
    const row = this.db.prepare("SELECT id FROM deploy_sessions WHERE deployment_gate_closed = 1").get() as { id: string } | undefined;
    return { closed: row !== undefined, deploymentSessionId: row?.id ?? null };
  }

  recordTopology(id: string, ownerId: string, now: Date, kind: "PRE_DEPLOY" | "OBSERVED", observation: DeploymentObservation): DeploySession {
    // `pre_deploy_topology` is written once, at acquisition, and frozen by the
    // schema thereafter. There is no session without one, so this arm exists
    // only to say the same thing the trigger would, in the caller's language.
    if (kind === "PRE_DEPLOY") throw new Error("PRE_DEPLOY_TOPOLOGY_ALREADY_RECORDED");
    return this.write(id, ownerId, now, NON_TERMINAL, { observedTopology: observation });
  }

  transitionNonTerminal(id: string, ownerId: string, now: Date, from: readonly DeploySessionState[], patch: DeploySessionPatch): DeploySession {
    if (patch.state && TERMINAL.has(patch.state)) throw new Error("TERMINAL_STATE_REQUIRES_SETTLE");
    return this.write(id, ownerId, now, from, patch);
  }

  settle(id: string, ownerId: string, now: Date, from: readonly DeploySessionState[], state: TerminalState): DeploySession {
    const session = this.required(id);
    const ownsGate = session.mode === "MAINTENANCE_CUTOVER";
    const gate = this.deploymentGate();
    if (ownsGate && gate.deploymentSessionId !== id) throw new Error("DEPLOYMENT_GATE_NOT_OWNED");
    if (!ownsGate && gate.deploymentSessionId === id) throw new Error("ROLLING_SESSION_OWNS_NO_GATE");
    // Settling and opening the gate are one write. Splitting them is what left
    // a SUCCEEDED session with sales still shut, and the schema refuses that
    // combination outright - so the adapter cannot produce it even in halves.
    return this.write(id, ownerId, now, from, { state }, "deployment_gate_closed = 0");
  }

  renewOwnedLease(id: string, ownerId: string, now: Date, leaseExpiresAt: string): DeploySession {
    return this.write(id, ownerId, now, NON_TERMINAL, { leaseExpiresAt });
  }

  reserveBootstrapRollback(id: string, ownerId: string, now: Date, rollbackId: string): DeploySession {
    const session = this.required(id);
    if (session.bootstrapRollbackId) {
      if (session.bootstrapRollbackId !== rollbackId) throw new Error("BOOTSTRAP_ROLLBACK_ALREADY_RESERVED");
      // Idempotent is not unauthenticated: the repeat still has to prove it
      // holds the lease, or a runner that lost it reads success and carries on.
      return this.write(id, ownerId, now, ["DEPLOYING", "RECOVERY_REQUIRED"], { state: "RECOVERY_REQUIRED" });
    }
    if (!session.adoptedCutoverId) throw new Error("BOOTSTRAP_ROLLBACK_NOT_A_CUTOVER_SESSION");
    if (session.rollbackAuthority !== "OLD_LINEAGE_ALLOWED") throw new Error("OLD_LINEAGE_ROLLBACK_FORBIDDEN");
    if (this.deploymentGate().deploymentSessionId !== id) throw new Error("DEPLOYMENT_GATE_NOT_OWNED");
    return this.write(id, ownerId, now, ["DEPLOYING", "RECOVERY_REQUIRED"], {
      bootstrapRollbackId: rollbackId,
      state: "RECOVERY_REQUIRED",
    });
  }

  assertBootstrapRollbackOwned(id: string, ownerId: string, now: Date, rollbackId: string): DeploySession {
    const session = this.write(id, ownerId, now, NON_TERMINAL, {});
    if (session.bootstrapRollbackId !== rollbackId) throw new Error("BOOTSTRAP_ROLLBACK_NOT_RESERVED");
    return session;
  }

  takeOverExpiredLease(id: string, newOwnerId: string, now: Date, leaseExpiresAt: string): DeploySession {
    const session = this.required(id);
    if (TERMINAL.has(session.state)) throw new Error("DEPLOY_SESSION_TERMINAL");
    // The lapse is decided by the same statement that acts on it. A caller that
    // read an expired lease a moment ago proves nothing about now.
    const moved = this.db.prepare(`UPDATE deploy_sessions SET owner_id = ?, lease_expires_at = ?
      WHERE id = ? AND lease_expires_at <= ? AND state NOT IN ('SAFE_ABORTED', 'SUCCEEDED', 'ROLLED_BACK')`)
      .run(newOwnerId, leaseExpiresAt, id, now.toISOString());
    if (moved.changes !== 1) throw new Error("DEPLOY_SESSION_LEASE_NOT_EXPIRED");
    return this.required(id);
  }

  /**
   * One guarded UPDATE. Owner, lease and legal source state are all conditions
   * of the write, so `changes === 1` means this caller owned an eligible
   * session at the instant it wrote - and nothing weaker.
   */
  private write(
    id: string, ownerId: string, now: Date, from: readonly DeploySessionState[],
    patch: DeploySessionPatch, extra?: string,
  ): DeploySession {
    const assignments: string[] = [];
    const values: (string | number)[] = [];
    if (patch.ownerId !== undefined) { assignments.push("owner_id = ?"); values.push(patch.ownerId); }
    if (patch.state !== undefined) { assignments.push("state = ?"); values.push(patch.state); }
    if (patch.rollbackAuthority !== undefined) { assignments.push("rollback_authority = ?"); values.push(patch.rollbackAuthority); }
    if (patch.mutationObserved !== undefined) { assignments.push("mutation_observed = ?"); values.push(patch.mutationObserved ? 1 : 0); }
    if (patch.leaseExpiresAt !== undefined) { assignments.push("lease_expires_at = ?"); values.push(patch.leaseExpiresAt); }
    if (patch.observedTopology !== undefined) { assignments.push("observed_topology = ?"); values.push(JSON.stringify(patch.observedTopology)); }
    if (patch.bootstrapRollbackId !== undefined) { assignments.push("bootstrap_rollback_id = ?"); values.push(patch.bootstrapRollbackId); }
    if (extra) assignments.push(extra);
    // A patch that changes nothing still has to prove ownership, so it writes
    // the lease back to itself rather than skipping the guarded statement.
    if (!assignments.length) assignments.push("lease_expires_at = lease_expires_at");

    const placeholders = from.map(() => "?").join(", ");
    const changed = this.db.prepare(`UPDATE deploy_sessions SET ${assignments.join(", ")}
      WHERE id = ? AND owner_id = ? AND lease_expires_at > ? AND state IN (${placeholders})`)
      .run(...values, id, ownerId, now.toISOString(), ...from);

    if (changed.changes !== 1) this.explainRefusal(id, ownerId, now, from);
    return this.required(id);
  }

  /**
   * Only reached when the guarded write already refused. The diagnosis reads
   * the row afterwards, which is exactly why it may not be the authority: it
   * says why this attempt lost, and the loss itself was decided in SQL.
   */
  private explainRefusal(id: string, ownerId: string, now: Date, from: readonly DeploySessionState[]): never {
    const session = this.get(id);
    if (!session) throw new Error("DEPLOY_SESSION_NOT_FOUND");
    if (session.ownerId !== ownerId) throw new Error("DEPLOY_SESSION_NOT_OWNER");
    if (Date.parse(session.leaseExpiresAt) <= now.getTime()) throw new Error("DEPLOY_SESSION_LEASE_EXPIRED");
    throw new Error(`DEPLOY_SESSION_TRANSITION_INVALID:${session.state}`);
  }

  private required(id: string): DeploySession {
    const session = this.get(id);
    if (!session) throw new Error("DEPLOY_SESSION_NOT_FOUND");
    return session;
  }
}
