import type Database from "better-sqlite3";
import type { DeploySession } from "./deploy-session";

/**
 * One step an armed session was carried forward by.
 *
 * The session's own `targetSha` and `candidateId` stay what the cutover first
 * set out to deploy. Each revision here moved it on, from `fromSha` to
 * `targetSha`, as an explicit, admitted release. See
 * docs/release/FORWARD_SUPERSESSION.md.
 */
export type ForwardTarget = {
  readonly sessionId: string;
  readonly revision: number;
  readonly fromSha: string;
  readonly targetSha: string;
  readonly candidateId: string;
  readonly ciEvidence: string;
  readonly createdAt: string;
};

/**
 * What a session is deploying now: SHA and candidate from the same revision,
 * always together.
 *
 * Revision 0 is the session's own target. A reader that took the newest SHA
 * from one place and the candidate from another could certify one release
 * against another's expectation, which is why nothing decides on a bare SHA.
 */
export type ReleaseBinding = {
  readonly revision: number;
  readonly targetSha: string;
  readonly candidateId: string | undefined;
};

export const releaseBinding = (session: DeploySession, targets: readonly ForwardTarget[]): ReleaseBinding => {
  const latest = targets.at(-1);
  return latest
    ? { revision: latest.revision, targetSha: latest.targetSha, candidateId: latest.candidateId }
    : { revision: 0, targetSha: session.targetSha, candidateId: session.candidateId };
};

type ForwardTargetRow = {
  session_id: string; revision: number; from_sha: string; target_sha: string;
  candidate_id: string; ci_evidence: string; created_at: string;
};

const toForwardTarget = (row: ForwardTargetRow): ForwardTarget => ({
  sessionId: row.session_id, revision: row.revision, fromSha: row.from_sha, targetSha: row.target_sha,
  candidateId: row.candidate_id, ciEvidence: row.ci_evidence, createdAt: row.created_at,
});

/** Every revision of a session, in order. Empty on a database that predates forward supersession. */
export const readForwardTargets = (db: Database.Database, sessionId: string): ForwardTarget[] => {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'deploy_session_forward_targets'").get();
  if (!exists) return [];
  return (db.prepare(`SELECT session_id, revision, from_sha, target_sha, candidate_id, ci_evidence, created_at
    FROM deploy_session_forward_targets WHERE session_id = ? ORDER BY revision`).all(sessionId) as ForwardTargetRow[]).map(toForwardTarget);
};

/**
 * The current binding read straight from the database, for the parts of the
 * system that hold a connection rather than a session object - the runtime's
 * certification endpoint and the certification driver.
 */
export const currentBindingIn = (db: Database.Database, sessionId: string): ReleaseBinding | undefined => {
  const session = db.prepare("SELECT target_sha, candidate_id FROM deploy_sessions WHERE id = ?")
    .get(sessionId) as { target_sha: string; candidate_id: string | null } | undefined;
  if (!session) return undefined;
  const latest = readForwardTargets(db, sessionId).at(-1);
  return latest
    ? { revision: latest.revision, targetSha: latest.targetSha, candidateId: latest.candidateId }
    : { revision: 0, targetSha: session.target_sha, candidateId: session.candidate_id ?? undefined };
};
